'use strict';

const express = require('express');
const { query, one } = require('../db');
const { todayISO, weekStartISO, addDaysISO } = require('../lib/helpers');
const {
  assignmentForDate,
  computeAttendance,
  scheduledWindow,
  shiftWorksOn,
} = require('../lib/attendance');

const router = express.Router();
const basePath = '/attendance';

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
    const scheduledAttendance = attendance.filter((record) => Number(record.expected_minutes) > 0).length;
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
        scheduledCount: scheduledAttendance,
        onTimeRate: scheduledAttendance ? (onTimeCount / scheduledAttendance) * 100 : 0,
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
    await query(
      `INSERT INTO attendance_records
         (employee_id, work_date, clock_in, clock_out, shift_id, shift_name,
          scheduled_start, scheduled_end, expected_minutes, worked_minutes,
          late_minutes, early_leave_minutes, overtime_minutes,
          grace_minutes, early_leave_grace_minutes, punctuality, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.notes,
        req.session.user.id,
      ],
    );
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

router.get('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const record = await one('SELECT * FROM attendance_records WHERE id = ? LIMIT 1', [req.params.id]);
    if (!record) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Attendance record') })), { status: 404 }));
    }
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
    await query(
      `UPDATE attendance_records
          SET employee_id = ?, work_date = ?, clock_in = ?, clock_out = ?,
              shift_id = ?, shift_name = ?, scheduled_start = ?, scheduled_end = ?,
              expected_minutes = ?, worked_minutes = ?, late_minutes = ?,
              early_leave_minutes = ?, overtime_minutes = ?, grace_minutes = ?,
              early_leave_grace_minutes = ?, punctuality = ?, notes = ?
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
        data.notes,
        record.id,
      ],
    );
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
