'use strict';

const express = require('express');
const multer = require('multer');
const { query, one, withTransaction } = require('../db');
const { todayISO, weekStartISO, addDaysISO } = require('../lib/helpers');
const {
  assignmentForDate,
  computeAttendance,
  computeAttendanceFromPunches,
  scheduledWindow,
  shiftWorksOn,
} = require('../lib/attendance');
const {
  dateRange,
  normalizeTime,
  parseAttendanceFile,
  planAttendanceImport,
} = require('../lib/attendanceImport');

const router = express.Router();
const basePath = '/attendance';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const IMPORT_SESSION_MAX_AGE = 60 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
});

/**
 * Parses multipart bodies before the global CSRF middleware so the _csrf field
 * is available for the upload POST. Mounted by app.js on the preview path.
 */
function importUpload(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'The file is too large. Maximum size is 5 MB.'
      : 'Could not read the uploaded file.';
    req.flash('error', message);
    return res.redirect(`${basePath}/import`);
  });
}

function validDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime());
}

function normalizeDateTime(value) {
  const raw = String(value || '').replace('T', ' ').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const date = match[1];
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const parsed = new Date(`${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    date,
    db: `${date} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
    iso: `${date}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}Z`,
    dateObj: parsed,
  };
}

function datetimeLocalValue(value) {
  const raw = String(value || '').replace('T', ' ').slice(0, 19);
  return raw.length >= 16 ? `${raw.slice(0, 10)}T${raw.slice(11, 16)}` : '';
}

function toDbDateTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().replace('T', ' ').slice(0, 19);
}

async function savePunches(conn, recordId, punches, source) {
  await conn.query('DELETE FROM attendance_punches WHERE attendance_record_id = ?', [recordId]);
  if (!punches.length) return;
  await conn.query(
    'INSERT INTO attendance_punches (attendance_record_id, punch_at, source) VALUES ?',
    [punches.map((punch) => [recordId, punch, source])],
  );
}

async function writeImportedRecord(conn, { employeeId, date, metrics, punches, existingId, userId }) {
  const clockIn = toDbDateTime(metrics.clock_in);
  const clockOut = toDbDateTime(metrics.clock_out);
  const punchCount = punches.length;
  let recordId = existingId;
  let inserted = false;

  if (recordId) {
    await conn.query(
      `UPDATE attendance_records
          SET clock_in = ?, clock_out = ?, shift_id = ?, shift_name = ?,
              scheduled_start = ?, scheduled_end = ?, expected_minutes = ?,
              worked_minutes = ?, late_minutes = ?, early_leave_minutes = ?,
              overtime_minutes = ?, grace_minutes = ?, early_leave_grace_minutes = ?,
              punctuality = ?, source = 'import', punch_count = ?
        WHERE id = ?`,
      [
        clockIn,
        clockOut,
        metrics.shift_id,
        metrics.shift_name,
        metrics.scheduled_start,
        metrics.scheduled_end,
        metrics.expected_minutes,
        metrics.worked_minutes,
        metrics.late_minutes,
        metrics.early_leave_minutes,
        metrics.overtime_minutes,
        metrics.grace_minutes,
        metrics.early_leave_grace_minutes,
        metrics.punctuality,
        punchCount,
        recordId,
      ],
    );
  } else {
    const [result] = await conn.query(
      `INSERT INTO attendance_records
         (employee_id, work_date, clock_in, clock_out, shift_id, shift_name,
          scheduled_start, scheduled_end, expected_minutes, worked_minutes,
          late_minutes, early_leave_minutes, overtime_minutes,
          grace_minutes, early_leave_grace_minutes, punctuality,
          source, punch_count, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`,
      [
        employeeId,
        date,
        clockIn,
        clockOut,
        metrics.shift_id,
        metrics.shift_name,
        metrics.scheduled_start,
        metrics.scheduled_end,
        metrics.expected_minutes,
        metrics.worked_minutes,
        metrics.late_minutes,
        metrics.early_leave_minutes,
        metrics.overtime_minutes,
        metrics.grace_minutes,
        metrics.early_leave_grace_minutes,
        metrics.punctuality,
        punchCount,
        userId,
      ],
    );
    recordId = result.insertId;
    inserted = true;
  }

  await savePunches(conn, recordId, punches, 'import');
  return { recordId, inserted };
}

async function assignmentsForEmployees(ids, dateFrom, dateTo, conn = null) {
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT a.*, s.name AS shift_name, s.start_time, s.end_time, s.work_days,
                      s.grace_minutes, s.early_leave_grace_minutes
                 FROM employee_shift_assignments a
                 JOIN shifts s ON s.id = a.shift_id
                WHERE a.employee_id IN (${placeholders})
                  AND a.effective_from <= ?
                  AND (a.effective_to IS NULL OR a.effective_to >= ?)
                ORDER BY a.effective_from`;
  const params = [...ids, dateTo, dateFrom];
  const rows = conn ? (await conn.query(sql, params))[0] : await query(sql, params);
  for (const assignment of rows) {
    const key = String(assignment.employee_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(assignment);
  }
  return map;
}

async function employeeOptions(includeId = null) {
  return query(
    `SELECT id, employee_no, first_name, last_name, department, status
       FROM employees
      WHERE status <> 'inactive' ${includeId ? 'OR id = ?' : ''}
      ORDER BY last_name, first_name`,
    includeId ? [includeId] : [],
  );
}

async function assignmentFor(employeeId, date) {
  return one(
    `SELECT a.*, s.name AS shift_name, s.start_time, s.end_time, s.work_days,
            s.grace_minutes, s.early_leave_grace_minutes
       FROM employee_shift_assignments a
       JOIN shifts s ON s.id = a.shift_id
      WHERE a.employee_id = ?
        AND a.effective_from <= ?
        AND (a.effective_to IS NULL OR a.effective_to >= ?)
      ORDER BY a.effective_from DESC
      LIMIT 1`,
    [employeeId, date, date],
  );
}

async function renderForm(req, res, status, options) {
  const employees = await employeeOptions(options.record ? options.record.employee_id : options.row.employee_id || null);
  return res.status(status).render('attendance/form', {
    title: options.title,
    active: 'attendance',
    breadcrumbs: [
      { label: req.t('Attendance'), href: basePath },
      { label: options.title },
    ],
    mode: options.mode,
    action: options.action,
    row: options.row,
    record: options.record || null,
    errors: options.errors || {},
    employees,
  });
}

function renderImportPage(req, res, status, options = {}) {
  return res.status(status).render('attendance/import', {
    title: req.t('Import attendance'),
    active: 'attendance',
    breadcrumbs: [
      { label: req.t('Attendance'), href: basePath },
      { label: req.t('Import attendance') },
    ],
    errors: options.errors || [],
    warnings: options.warnings || [],
    maxFileSizeMb: Math.round(MAX_IMPORT_BYTES / (1024 * 1024)),
  });
}

async function validateAttendance(body, existingId = 0) {
  const errors = {};
  const employeeId = Number.parseInt(body.employee_id, 10);
  const employee = employeeId ? await one('SELECT id FROM employees WHERE id = ? LIMIT 1', [employeeId]) : null;
  const clockIn = normalizeDateTime(body.clock_in);
  const clockOut = normalizeDateTime(body.clock_out);

  if (!employee) errors.employee_id = 'Select an employee.';
  if (!clockIn) errors.clock_in = 'Valid clock-in date and time required.';
  if (body.clock_out && !clockOut) errors.clock_out = 'Valid clock-out date and time required.';
  if (clockIn && clockOut && clockOut.dateObj.getTime() <= clockIn.dateObj.getTime()) {
    errors.clock_out = 'Clock-out must be after clock-in.';
  }
  if (clockIn && employeeId) {
    const duplicate = await one(
      `SELECT id FROM attendance_records
        WHERE employee_id = ? AND work_date = ? ${existingId ? 'AND id <> ?' : ''} LIMIT 1`,
      existingId ? [employeeId, clockIn.date, existingId] : [employeeId, clockIn.date],
    );
    if (duplicate) {
      errors._form = ['This employee already has an attendance record for that date. Edit the existing record instead.'];
    }
  }

  return {
    errors,
    data: {
      employee_id: employeeId,
      work_date: clockIn ? clockIn.date : null,
      clock_in: clockIn ? clockIn.db : null,
      clock_out: clockOut ? clockOut.db : null,
      clock_in_iso: clockIn ? clockIn.iso : null,
      clock_out_iso: clockOut ? clockOut.iso : null,
      notes: String(body.notes || '').trim().slice(0, 500) || null,
    },
  };
}

router.get('/', async (req, res, next) => {
  try {
    const weekStart = weekStartISO(req.query.week || todayISO());
    const weekEnd = addDaysISO(weekStart, 6);
    const weekDays = Array.from({ length: 7 }, (_, index) => addDaysISO(weekStart, index));
    const today = todayISO();
    const selectedEmployeeId = Number.parseInt(req.query.employee_id, 10) || null;
    const employeeChoices = await employeeOptions();
    const employees = selectedEmployeeId
      ? employeeChoices.filter((employee) => employee.id === selectedEmployeeId)
      : employeeChoices;
    const employeeIds = employees.map((employee) => employee.id);
    const placeholders = employeeIds.map(() => '?').join(',');
    const assignments = employeeIds.length
      ? await query(
        `SELECT a.*, s.name AS shift_name, s.start_time, s.end_time, s.work_days,
                s.grace_minutes, s.early_leave_grace_minutes
           FROM employee_shift_assignments a
           JOIN shifts s ON s.id = a.shift_id
          WHERE a.employee_id IN (${placeholders})
            AND a.effective_from <= ?
            AND (a.effective_to IS NULL OR a.effective_to >= ?)
          ORDER BY a.effective_from`,
        [...employeeIds, weekEnd, weekStart],
      )
      : [];
    const attendance = employeeIds.length
      ? await query(
        `SELECT * FROM attendance_records
          WHERE employee_id IN (${placeholders})
            AND work_date BETWEEN ? AND ?
          ORDER BY work_date, id`,
        [...employeeIds, weekStart, weekEnd],
      )
      : [];
    const punchRows = employeeIds.length
      ? await query(
        `SELECT p.attendance_record_id, p.punch_at
           FROM attendance_punches p
           JOIN attendance_records r ON r.id = p.attendance_record_id
          WHERE r.employee_id IN (${placeholders})
            AND r.work_date BETWEEN ? AND ?
          ORDER BY p.punch_at, p.id`,
        [...employeeIds, weekStart, weekEnd],
      )
      : [];
    const punchesByRecord = new Map();
    for (const punch of punchRows) {
      const key = String(punch.attendance_record_id);
      if (!punchesByRecord.has(key)) punchesByRecord.set(key, []);
      punchesByRecord.get(key).push(punch.punch_at);
    }
    for (const record of attendance) {
      record.punches = punchesByRecord.get(String(record.id)) || [];
    }

    const assignmentsByEmployee = new Map();
    for (const assignment of assignments) {
      const key = String(assignment.employee_id);
      if (!assignmentsByEmployee.has(key)) assignmentsByEmployee.set(key, []);
      assignmentsByEmployee.get(key).push(assignment);
    }
    const attendanceByEmployeeDate = new Map(
      attendance.map((record) => [`${record.employee_id}:${String(record.work_date).slice(0, 10)}`, record]),
    );

    const grid = employees.map((employee) => ({
      ...employee,
      days: weekDays.map((date) => {
        const assignment = assignmentForDate(assignmentsByEmployee.get(String(employee.id)) || [], date);
        const record = attendanceByEmployeeDate.get(`${employee.id}:${date}`) || null;
        const scheduled = assignment ? shiftWorksOn(assignment, date) : false;
        return {
          date,
          assignment,
          record,
          scheduled,
          off: Boolean(assignment && !scheduled),
          absent: employee.status === 'active' && !record && scheduled && date < today,
          onLeave: employee.status === 'on_leave' && !record && scheduled,
          isToday: date === today,
        };
      }),
    }));

    const workedMinutes = attendance.reduce((sum, record) => sum + Number(record.worked_minutes || 0), 0);
    const lateCount = attendance.filter((record) => Number(record.late_minutes) > Number(record.grace_minutes)).length;
    const lateMinutes = attendance.reduce(
      (sum, record) => sum + (Number(record.late_minutes) > Number(record.grace_minutes) ? Number(record.late_minutes) : 0),
      0,
    );
    const earlyLeaveCount = attendance.filter((record) => Number(record.early_leave_minutes) > Number(record.early_leave_grace_minutes)).length;
    const earlyLeaveMinutes = attendance.reduce(
      (sum, record) => sum + (Number(record.early_leave_minutes) > Number(record.early_leave_grace_minutes) ? Number(record.early_leave_minutes) : 0),
      0,
    );
    const overtimeMinutes = attendance.reduce((sum, record) => sum + Number(record.overtime_minutes || 0), 0);
    const absentCount = grid.reduce((sum, employee) => sum + employee.days.filter((day) => day.absent).length, 0);
    const completeScheduledAttendance = attendance.filter((record) => ['on_time', 'late', 'early_leave', 'late_early'].includes(record.punctuality)).length;
    const onTimeCount = attendance.filter((record) => record.punctuality === 'on_time').length;
    const incompleteCount = attendance.filter((record) => record.punctuality === 'incomplete').length;
    const selectedEmployee = selectedEmployeeId
      ? employees.find((employee) => employee.id === selectedEmployeeId) || null
      : null;

    res.render('attendance/index', {
      title: req.t('Attendance'),
      active: 'attendance',
      breadcrumbs: [{ label: req.t('Attendance') }],
      weekStart,
      weekEnd,
      weekDays,
      today,
      employees: grid,
      employeeChoices,
      employeeFilterId: selectedEmployeeId,
      employeeFilterName: selectedEmployee ? `${selectedEmployee.first_name} ${selectedEmployee.last_name}` : null,
      prevWeek: addDaysISO(weekStart, -7),
      nextWeek: addDaysISO(weekStart, 7),
      thisWeek: weekStartISO(today),
      metrics: {
        headcount: employees.length,
        workedMinutes,
        lateCount,
        lateMinutes,
        earlyLeaveCount,
        earlyLeaveMinutes,
        overtimeMinutes,
        absentCount,
        onTimeCount,
        incompleteCount,
        scheduledCount: completeScheduledAttendance,
        onTimeRate: completeScheduledAttendance ? (onTimeCount / completeScheduledAttendance) * 100 : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const employeeId = Number.parseInt(req.query.employee_id, 10) || null;
    const date = validDate(req.query.date) ? String(req.query.date).slice(0, 10) : todayISO();
    const assignment = employeeId ? await assignmentFor(employeeId, date) : null;
    let clockIn = `${date}T09:00`;
    let clockOut = `${date}T17:00`;
    if (assignment && shiftWorksOn(assignment, date)) {
      const window = scheduledWindow(date, assignment.start_time, assignment.end_time);
      clockIn = window.start.toISOString().slice(0, 16);
      clockOut = window.end.toISOString().slice(0, 16);
    }
    await renderForm(req, res, 200, {
      title: req.t('Record time'),
      mode: 'create',
      action: basePath,
      row: { employee_id: employeeId || '', clock_in: clockIn, clock_out: clockOut, notes: '' },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = await validateAttendance(req.body);
    if (Object.keys(errors).length) {
      return renderForm(req, res, 422, {
        title: req.t('Record time'),
        mode: 'create',
        action: basePath,
        row: req.body,
        errors,
      });
    }
    const assignment = await assignmentFor(data.employee_id, data.work_date);
    const metrics = computeAttendance({
      workDate: data.work_date,
      clockIn: data.clock_in_iso,
      clockOut: data.clock_out_iso,
      assignment,
    });
    const punches = [data.clock_in, data.clock_out].filter(Boolean);
    await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO attendance_records
           (employee_id, work_date, clock_in, clock_out, shift_id, shift_name,
            scheduled_start, scheduled_end, expected_minutes, worked_minutes,
            late_minutes, early_leave_minutes, overtime_minutes,
            grace_minutes, early_leave_grace_minutes, punctuality,
            source, punch_count, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
        [
          data.employee_id,
          data.work_date,
          data.clock_in,
          data.clock_out,
          metrics.shift_id,
          metrics.shift_name,
          metrics.scheduled_start,
          metrics.scheduled_end,
          metrics.expected_minutes,
          metrics.worked_minutes,
          metrics.late_minutes,
          metrics.early_leave_minutes,
          metrics.overtime_minutes,
          metrics.grace_minutes,
          metrics.early_leave_grace_minutes,
          metrics.punctuality,
          punches.length,
          data.notes,
          req.session.user.id,
        ],
      );
      await savePunches(conn, result.insertId, punches, 'manual');
    });
    req.flash('success', 'Attendance recorded.');
    res.redirect(`${basePath}?week=${weekStartISO(data.work_date)}&employee_id=${data.employee_id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This employee already has an attendance record for that date.');
      return res.redirect(`${basePath}/new?employee_id=${req.body.employee_id || ''}`);
    }
    next(err);
  }
});

router.get('/import', (req, res) => {
  renderImportPage(req, res, 200);
});

router.post('/import/preview', async (req, res, next) => {
  try {
    const file = req.file;
    if (!file || !file.buffer) {
      req.flash('error', 'Choose a JSON file to import.');
      return res.redirect(`${basePath}/import`);
    }

    let payload;
    try {
      payload = JSON.parse(file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      return renderImportPage(req, res, 422, {
        errors: ['The uploaded file is not valid JSON.'],
      });
    }

    const parsed = parseAttendanceFile(payload);
    if (parsed.errors.length) {
      return renderImportPage(req, res, 422, {
        errors: parsed.errors,
        warnings: parsed.warnings,
      });
    }

    const clockEmployees = await query(
      `SELECT id, employee_no, first_name, last_name, status, clock_id
         FROM employees
        WHERE clock_id IS NOT NULL AND clock_id <> ''
        ORDER BY last_name, first_name`,
    );
    const employeeIds = clockEmployees.map((employee) => employee.id);
    const assignmentsByEmployee = await assignmentsForEmployees(employeeIds, parsed.dateFrom, parsed.dateTo);
    let existingKeys = new Set();
    if (employeeIds.length) {
      const placeholders = employeeIds.map(() => '?').join(',');
      const existing = await query(
        `SELECT employee_id, work_date FROM attendance_records
          WHERE employee_id IN (${placeholders})
            AND work_date BETWEEN ? AND ?`,
        [...employeeIds, parsed.dateFrom, parsed.dateTo],
      );
      existingKeys = new Set(existing.map((record) => `${record.employee_id}:${String(record.work_date).slice(0, 10)}`));
    }

    const plan = planAttendanceImport({
      parsed,
      employees: clockEmployees,
      assignmentsByEmployee,
      existingKeys,
    });

    req.session.attendanceImport = {
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      fileName: file.originalname || 'attendance.json',
      uploadedAt: Date.now(),
      matched: plan.matched.map((entry) => ({
        employeeId: entry.employee.id,
        records: entry.records,
      })),
      missingEmployeeIds: plan.missing.map((entry) => entry.employee.id),
      unmatchedCount: plan.stats.unmatchedCount,
    };

    res.render('attendance/import-preview', {
      title: req.t('Import preview'),
      active: 'attendance',
      breadcrumbs: [
        { label: req.t('Attendance'), href: basePath },
        { label: req.t('Import attendance'), href: `${basePath}/import` },
        { label: req.t('Preview') },
      ],
      fileName: file.originalname || 'attendance.json',
      plan,
      warnings: parsed.warnings,
      canImport: plan.stats.matchedCount > 0 && plan.stats.recordsToWrite > 0,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/import/confirm', async (req, res) => {
  const payload = req.session.attendanceImport;
  if (!payload || !Array.isArray(payload.matched) || !payload.dateFrom || !payload.dateTo) {
    req.flash('error', 'This import preview expired. Upload the file again.');
    return res.redirect(`${basePath}/import`);
  }
  if (!payload.uploadedAt || Date.now() - payload.uploadedAt > IMPORT_SESSION_MAX_AGE) {
    delete req.session.attendanceImport;
    req.flash('error', 'This import preview expired. Upload the file again.');
    return res.redirect(`${basePath}/import`);
  }

  try {
    const employeeIds = [...new Set([
      ...payload.matched.map((entry) => entry.employeeId),
      ...(payload.missingEmployeeIds || []),
    ])];
    const employees = employeeIds.length
      ? await query(
        `SELECT id, status FROM employees WHERE id IN (${employeeIds.map(() => '?').join(',')})`,
        employeeIds,
      )
      : [];
    const activeIds = new Set(employees.filter((employee) => employee.status !== 'inactive').map((employee) => employee.id));
    const assignmentsByEmployee = await assignmentsForEmployees(employeeIds, payload.dateFrom, payload.dateTo);
    const dates = dateRange(payload.dateFrom, payload.dateTo);
    const userId = req.session.user.id;

    const result = await withTransaction(async (conn) => {
      let existingRows = [];
      if (employeeIds.length) {
        const [rows] = await conn.query(
          `SELECT id, employee_id, work_date FROM attendance_records
            WHERE employee_id IN (${employeeIds.map(() => '?').join(',')})
              AND work_date BETWEEN ? AND ?`,
          [...employeeIds, payload.dateFrom, payload.dateTo],
        );
        existingRows = rows;
      }
      const existingByKey = new Map(
        existingRows.map((record) => [`${record.employee_id}:${String(record.work_date).slice(0, 10)}`, record.id]),
      );
      const touchedEmployees = new Set();
      const touchedDays = new Set();
      let recordsWritten = 0;
      let inserted = 0;
      let updated = 0;
      let incomplete = 0;

      const write = async (employeeId, date, times, assignment) => {
        if (times.length) {
          const metrics = computeAttendanceFromPunches({
            workDate: date,
            punches: times.map((time) => `${date}T${time}Z`),
            assignment,
          });
          if (!metrics) return;
          const key = `${employeeId}:${date}`;
          const written = await writeImportedRecord(conn, {
            employeeId,
            date,
            metrics,
            punches: times.map((time) => `${date} ${time}`),
            existingId: existingByKey.get(key),
            userId,
          });
          if (written.inserted) {
            inserted += 1;
            existingByKey.set(key, written.recordId);
          } else {
            updated += 1;
          }
          recordsWritten += 1;
          if (metrics.punctuality === 'incomplete') incomplete += 1;
          touchedEmployees.add(employeeId);
          touchedDays.add(date);
          return;
        }

        const metrics = computeAttendanceFromPunches({ workDate: date, punches: [], assignment });
        if (!metrics) return;
        const key = `${employeeId}:${date}`;
        const written = await writeImportedRecord(conn, {
          employeeId,
          date,
          metrics,
          punches: [],
          existingId: existingByKey.get(key),
          userId,
        });
        if (written.inserted) {
          inserted += 1;
          existingByKey.set(key, written.recordId);
        } else {
          updated += 1;
        }
        recordsWritten += 1;
        incomplete += 1;
        touchedEmployees.add(employeeId);
        touchedDays.add(date);
      };

      for (const entry of payload.matched) {
        if (!activeIds.has(entry.employeeId)) continue;
        const assignments = assignmentsByEmployee.get(String(entry.employeeId)) || [];
        for (const date of dates) {
          const assignment = assignmentForDate(assignments, date);
          const scheduled = assignment ? shiftWorksOn(assignment, date) : false;
          const times = ((entry.records && entry.records[date]) || [])
            .map((time) => normalizeTime(time))
            .filter(Boolean)
            .sort();
          if (!times.length && !scheduled) continue;
          await write(entry.employeeId, date, times, assignment);
        }
      }

      for (const employeeId of payload.missingEmployeeIds || []) {
        if (!activeIds.has(employeeId)) continue;
        const assignments = assignmentsByEmployee.get(String(employeeId)) || [];
        for (const date of dates) {
          const assignment = assignmentForDate(assignments, date);
          if (!assignment || !shiftWorksOn(assignment, date)) continue;
          await write(employeeId, date, [], assignment);
        }
      }

      return {
        recordsWritten,
        inserted,
        updated,
        incomplete,
        employees: touchedEmployees.size,
        days: touchedDays.size,
      };
    });

    delete req.session.attendanceImport;

    if (!result.recordsWritten) {
      req.flash('warning', 'Nothing to import. The file did not contain clock records or scheduled days.');
      return res.redirect(`${basePath}/import`);
    }

    const unmatched = Number(payload.unmatchedCount || 0);
    let message = 'Imported {records} records for {employees} employees ({inserted} new, {updated} updated).';
    if (result.incomplete && unmatched) {
      message = 'Imported {records} records for {employees} employees ({inserted} new, {updated} updated). {incomplete} days were marked incomplete and {unmatched} clock IDs were not matched.';
    } else if (result.incomplete) {
      message = 'Imported {records} records for {employees} employees ({inserted} new, {updated} updated). {incomplete} days were marked incomplete.';
    } else if (unmatched) {
      message = 'Imported {records} records for {employees} employees ({inserted} new, {updated} updated). {unmatched} clock IDs were not matched.';
    }
    req.flash('success', message, {
      records: result.recordsWritten,
      employees: result.employees,
      inserted: result.inserted,
      updated: result.updated,
      incomplete: result.incomplete,
      unmatched,
    });
    return res.redirect(`${basePath}?week=${weekStartISO(payload.dateFrom)}`);
  } catch (err) {
    console.error('[attendance import]', err);
    req.flash('error', 'The import could not be completed. No records were changed.');
    return res.redirect(`${basePath}/import`);
  }
});

router.post('/import/cancel', (req, res) => {
  delete req.session.attendanceImport;
  req.flash('info', 'Import cancelled.');
  res.redirect(`${basePath}/import`);
});

router.get('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const record = await one('SELECT * FROM attendance_records WHERE id = ? LIMIT 1', [req.params.id]);
    if (!record) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Attendance record') })), { status: 404 }));
    }
    const punches = await query(
      'SELECT punch_at FROM attendance_punches WHERE attendance_record_id = ? ORDER BY punch_at, id',
      [record.id],
    );
    record.punches = punches.map((punch) => punch.punch_at);
    await renderForm(req, res, 200, {
      title: req.t('Edit attendance'),
      mode: 'edit',
      action: `${basePath}/${record.id}`,
      record,
      row: {
        employee_id: record.employee_id,
        clock_in: datetimeLocalValue(record.clock_in),
        clock_out: datetimeLocalValue(record.clock_out),
        notes: record.notes || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const record = await one('SELECT * FROM attendance_records WHERE id = ? LIMIT 1', [req.params.id]);
    if (!record) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Attendance record') })), { status: 404 }));
    }
    const { errors, data } = await validateAttendance(req.body, record.id);
    if (Object.keys(errors).length) {
      return renderForm(req, res, 422, {
        title: req.t('Edit attendance'),
        mode: 'edit',
        action: `${basePath}/${record.id}`,
        record,
        row: req.body,
        errors,
      });
    }
    const assignment = await assignmentFor(data.employee_id, data.work_date);
    const metrics = computeAttendance({
      workDate: data.work_date,
      clockIn: data.clock_in_iso,
      clockOut: data.clock_out_iso,
      assignment,
    });
    const punches = [data.clock_in, data.clock_out].filter(Boolean);
    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE attendance_records
            SET employee_id = ?, work_date = ?, clock_in = ?, clock_out = ?,
                shift_id = ?, shift_name = ?, scheduled_start = ?, scheduled_end = ?,
                expected_minutes = ?, worked_minutes = ?, late_minutes = ?,
                early_leave_minutes = ?, overtime_minutes = ?, grace_minutes = ?,
                early_leave_grace_minutes = ?, punctuality = ?,
                source = 'manual', punch_count = ?, notes = ?
          WHERE id = ?`,
        [
          data.employee_id,
          data.work_date,
          data.clock_in,
          data.clock_out,
          metrics.shift_id,
          metrics.shift_name,
          metrics.scheduled_start,
          metrics.scheduled_end,
          metrics.expected_minutes,
          metrics.worked_minutes,
          metrics.late_minutes,
          metrics.early_leave_minutes,
          metrics.overtime_minutes,
          metrics.grace_minutes,
          metrics.early_leave_grace_minutes,
          metrics.punctuality,
          punches.length,
          data.notes,
          record.id,
        ],
      );
      await savePunches(conn, record.id, punches, 'manual');
    });
    req.flash('success', 'Attendance updated.');
    res.redirect(`${basePath}?week=${weekStartISO(data.work_date)}&employee_id=${data.employee_id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This employee already has an attendance record for that date.');
      return res.redirect(`${basePath}/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const record = await one('SELECT id, work_date FROM attendance_records WHERE id = ? LIMIT 1', [req.params.id]);
    if (!record) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Attendance record') })), { status: 404 }));
    }
    await query('DELETE FROM attendance_records WHERE id = ?', [record.id]);
    req.flash('success', 'Attendance deleted.');
    res.redirect(`${basePath}?week=${weekStartISO(record.work_date)}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.importUpload = importUpload;
