'use strict';

const express = require('express');
const { query, one, withTransaction } = require('../db');
const { todayISO, addDaysISO } = require('../lib/helpers');
const { shiftDurationMinutes, shiftDays } = require('../lib/attendance');

const router = express.Router();
const basePath = '/shifts';
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function textValue(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeTime(value) {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeWorkDays(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((day) => String(day || '').trim()).filter((day) => DAY_KEYS.includes(day)))];
}

function validDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime());
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

async function renderAssignmentForm(req, res, status, options) {
  const includeId = options.assignment
    ? options.assignment.employee_id
    : (options.row && options.row.employee_id) || null;
  const employees = await employeeOptions(includeId);
  return res.status(status).render('shifts/assignment-form', {
    title: options.title,
    active: 'shifts',
    breadcrumbs: [
      { label: req.t('Shifts'), href: basePath },
      { label: options.shift.name, href: `${basePath}/${options.shift.id}` },
      { label: options.title },
    ],
    shift: options.shift,
    assignment: options.assignment || null,
    row: options.row,
    errors: options.errors || {},
    employees,
    mode: options.mode,
    action: options.action,
  });
}

function validateShift(body, existing = null) {
  const errors = {};
  const name = String(body.name || '').trim().slice(0, 120);
  const startTime = normalizeTime(body.start_time);
  const endTime = normalizeTime(body.end_time);
  const workDays = normalizeWorkDays(body.work_days);
  const graceMinutes = Number.parseInt(body.grace_minutes, 10);
  const earlyLeaveGraceMinutes = Number.parseInt(body.early_leave_grace_minutes, 10);
  const status = ['active', 'inactive'].includes(body.status) ? body.status : 'active';
  const notes = textValue(body.notes, 500);

  if (!name) errors.name = 'Shift name is required.';
  if (!startTime) errors.start_time = 'Valid start time required.';
  if (!endTime) errors.end_time = 'Valid end time required.';
  if (!workDays.length) errors.work_days = 'Select at least one working day.';
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 1440) {
    errors.grace_minutes = 'Tardiness grace must be between 0 and 1440 minutes.';
  }
  if (!Number.isInteger(earlyLeaveGraceMinutes) || earlyLeaveGraceMinutes < 0 || earlyLeaveGraceMinutes > 1440) {
    errors.early_leave_grace_minutes = 'Early-leave grace must be between 0 and 1440 minutes.';
  }

  return {
    errors,
    data: {
      name,
      start_time: startTime,
      end_time: endTime,
      work_days: workDays.join(','),
      grace_minutes: graceMinutes,
      early_leave_grace_minutes: earlyLeaveGraceMinutes,
      status,
      notes,
    },
  };
}

async function validateAssignment(body, shift, existingId = 0) {
  const errors = {};
  const employeeId = Number.parseInt(body.employee_id, 10);
  const employee = employeeId ? await one('SELECT id FROM employees WHERE id = ? LIMIT 1', [employeeId]) : null;
  const effectiveFrom = String(body.effective_from || '').slice(0, 10);
  const effectiveTo = String(body.effective_to || '').slice(0, 10);
  const grace = String(body.grace_minutes_override || '').trim();
  const earlyGrace = String(body.early_leave_grace_minutes_override || '').trim();
  const notes = textValue(body.notes, 500);

  if (!employee) errors.employee_id = 'Select an employee.';
  if (!validDate(effectiveFrom)) errors.effective_from = 'Valid start date required.';
  if (effectiveTo && !validDate(effectiveTo)) errors.effective_to = 'Valid end date required.';
  if (validDate(effectiveFrom) && validDate(effectiveTo) && effectiveTo < effectiveFrom) {
    errors.effective_to = 'End date cannot be before the start date.';
  }

  let graceOverride = null;
  if (grace) {
    const parsed = Number.parseInt(grace, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1440) {
      errors.grace_minutes_override = 'Tardiness grace must be between 0 and 1440 minutes.';
    } else {
      graceOverride = parsed;
    }
  }
  let earlyGraceOverride = null;
  if (earlyGrace) {
    const parsed = Number.parseInt(earlyGrace, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1440) {
      errors.early_leave_grace_minutes_override = 'Early-leave grace must be between 0 and 1440 minutes.';
    } else {
      earlyGraceOverride = parsed;
    }
  }

  let overlaps = [];
  if (!Object.keys(errors).length) {
    overlaps = await query(
      `SELECT * FROM employee_shift_assignments
        WHERE employee_id = ? AND id <> ?
          AND effective_from <= COALESCE(?, '9999-12-31')
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from`,
      [employeeId, existingId, effectiveTo || null, effectiveFrom],
    );
  }

  return {
    errors,
    overlaps,
    data: {
      employee_id: employeeId,
      shift_id: shift.id,
      effective_from: effectiveFrom,
      effective_to: effectiveTo || null,
      grace_minutes_override: graceOverride,
      early_leave_grace_minutes_override: earlyGraceOverride,
      notes,
    },
  };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM employee_shift_assignments a
                WHERE a.shift_id = s.id AND a.effective_from <= CURDATE()
                  AND (a.effective_to IS NULL OR a.effective_to >= CURDATE())) AS active_assignments,
              (SELECT COUNT(*) FROM employee_shift_assignments a WHERE a.shift_id = s.id) AS total_assignments
         FROM shifts s
        ORDER BY s.status = 'active' DESC, s.name`,
    );
    res.render('shifts/index', {
      title: req.t('Shifts'),
      active: 'shifts',
      breadcrumbs: [{ label: req.t('Shifts') }],
      rows: rows.map((shift) => ({
        ...shift,
        days: shiftDays(shift),
        duration_minutes: shiftDurationMinutes(shift.start_time, shift.end_time),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/new', (req, res) => {
  res.render('shifts/form', {
    title: req.t('New shift'),
    active: 'shifts',
    breadcrumbs: [{ label: req.t('Shifts'), href: basePath }, { label: req.t('New shift') }],
    mode: 'create',
    action: basePath,
    shift: null,
    row: {
      name: '',
      start_time: '09:00',
      end_time: '17:00',
      work_days: 'mon,tue,wed,thu,fri',
      grace_minutes: 10,
      early_leave_grace_minutes: 10,
      status: 'active',
      notes: '',
    },
    errors: {},
  });
});

router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validateShift(req.body);
    if (!errors.name) {
      const duplicate = await one('SELECT id FROM shifts WHERE name = ? LIMIT 1', [data.name]);
      if (duplicate) errors.name = 'A shift with this name already exists.';
    }
    if (Object.keys(errors).length) {
      return res.status(422).render('shifts/form', {
        title: req.t('New shift'),
        active: 'shifts',
        breadcrumbs: [{ label: req.t('Shifts'), href: basePath }, { label: req.t('New shift') }],
        mode: 'create',
        action: basePath,
        shift: null,
        row: { ...req.body, work_days: data.work_days },
        errors,
      });
    }
    const id = await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO shifts
           (name, start_time, end_time, work_days, grace_minutes, early_leave_grace_minutes, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [data.name, data.start_time, data.end_time, data.work_days, data.grace_minutes, data.early_leave_grace_minutes, data.status, data.notes],
      );
      return result.insertId;
    });
    req.flash('success', 'Shift created.');
    res.redirect(`${basePath}/${id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const shift = await one('SELECT * FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    const assignments = await query(
      `SELECT a.*, e.first_name, e.last_name, e.employee_no, e.department,
              s.name AS shift_name
         FROM employee_shift_assignments a
         JOIN employees e ON e.id = a.employee_id
         JOIN shifts s ON s.id = a.shift_id
        WHERE a.shift_id = ?
        ORDER BY (a.effective_to IS NULL OR a.effective_to >= CURDATE()) DESC, a.effective_from DESC, e.last_name, e.first_name`,
      [shift.id],
    );
    res.render('shifts/show', {
      title: shift.name,
      active: 'shifts',
      breadcrumbs: [{ label: req.t('Shifts'), href: basePath }, { label: shift.name }],
      shift: {
        ...shift,
        days: shiftDays(shift),
        duration_minutes: shiftDurationMinutes(shift.start_time, shift.end_time),
      },
      assignments,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const shift = await one('SELECT * FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    res.render('shifts/form', {
      title: req.t('Edit shift'),
      active: 'shifts',
      breadcrumbs: [{ label: req.t('Shifts'), href: basePath }, { label: shift.name, href: `${basePath}/${shift.id}` }, { label: req.t('Edit') }],
      mode: 'edit',
      action: `${basePath}/${shift.id}`,
      shift,
      row: shift,
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const shift = await one('SELECT * FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    const { errors, data } = validateShift(req.body, shift);
    if (!errors.name) {
      const duplicate = await one('SELECT id FROM shifts WHERE name = ? AND id <> ? LIMIT 1', [data.name, shift.id]);
      if (duplicate) errors.name = 'A shift with this name already exists.';
    }
    if (Object.keys(errors).length) {
      return res.status(422).render('shifts/form', {
        title: req.t('Edit shift'),
        active: 'shifts',
        breadcrumbs: [{ label: req.t('Shifts'), href: basePath }, { label: shift.name, href: `${basePath}/${shift.id}` }, { label: req.t('Edit') }],
        mode: 'edit',
        action: `${basePath}/${shift.id}`,
        shift,
        row: { ...req.body, work_days: data.work_days },
        errors,
      });
    }
    await query(
      `UPDATE shifts
          SET name = ?, start_time = ?, end_time = ?, work_days = ?,
              grace_minutes = ?, early_leave_grace_minutes = ?, status = ?, notes = ?
        WHERE id = ?`,
      [data.name, data.start_time, data.end_time, data.work_days, data.grace_minutes, data.early_leave_grace_minutes, data.status, data.notes, shift.id],
    );
    req.flash('success', 'Shift updated.');
    res.redirect(`${basePath}/${shift.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const shift = await one('SELECT id FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    const assignments = Number((await one('SELECT COUNT(*) AS count FROM employee_shift_assignments WHERE shift_id = ?', [shift.id])).count || 0);
    if (assignments > 0) {
      req.flash('error', 'This shift has assigned employees and cannot be deleted. Mark it inactive instead.');
      return res.redirect(`${basePath}/${shift.id}`);
    }
    await query('DELETE FROM shifts WHERE id = ?', [shift.id]);
    req.flash('success', 'Shift deleted.');
    res.redirect(basePath);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/assignments/new', async (req, res, next) => {
  try {
    const shift = await one('SELECT * FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    await renderAssignmentForm(req, res, 200, {
      title: req.t('Assign employee'),
      mode: 'create',
      action: `${basePath}/${shift.id}/assignments`,
      shift,
      row: {
        employee_id: '',
        effective_from: todayISO(),
        effective_to: '',
        grace_minutes_override: '',
        early_leave_grace_minutes_override: '',
        notes: '',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/assignments', async (req, res, next) => {
  try {
    const shift = await one('SELECT * FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    const { errors, overlaps, data } = await validateAssignment(req.body, shift);
    const conflicting = overlaps.filter((assignment) => !(
      assignment.effective_to === null && String(assignment.effective_from).slice(0, 10) < data.effective_from
    ));
    if (conflicting.length) {
      errors._form = ['This employee already has a shift assignment in that period.'];
    }
    if (Object.keys(errors).length) {
      return renderAssignmentForm(req, res, 422, {
        title: req.t('Assign employee'),
        mode: 'create',
        action: `${basePath}/${shift.id}/assignments`,
        shift,
        row: req.body,
        errors,
      });
    }
    await withTransaction(async (conn) => {
      const [openAssignments] = await conn.query(
        `SELECT id FROM employee_shift_assignments
          WHERE employee_id = ? AND effective_to IS NULL AND effective_from < ?`,
        [data.employee_id, data.effective_from],
      );
      for (const assignment of openAssignments) {
        await conn.query('UPDATE employee_shift_assignments SET effective_to = ? WHERE id = ?', [addDaysISO(data.effective_from, -1), assignment.id]);
      }
      await conn.query(
        `INSERT INTO employee_shift_assignments
           (employee_id, shift_id, effective_from, effective_to,
            grace_minutes_override, early_leave_grace_minutes_override, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.employee_id,
          data.shift_id,
          data.effective_from,
          data.effective_to,
          data.grace_minutes_override,
          data.early_leave_grace_minutes_override,
          data.notes,
        ],
      );
    });
    req.flash('success', 'Employee assigned to shift.');
    res.redirect(`${basePath}/${shift.id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This employee already has an assignment starting on that date.');
      return res.redirect(`${basePath}/${req.params.id}/assignments/new`);
    }
    next(err);
  }
});

router.get('/:id(\\d+)/assignments/:assignmentId(\\d+)/edit', async (req, res, next) => {
  try {
    const shift = await one('SELECT * FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    const assignment = await one(
      'SELECT * FROM employee_shift_assignments WHERE id = ? AND shift_id = ? LIMIT 1',
      [req.params.assignmentId, shift.id],
    );
    if (!assignment) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift assignment') })), { status: 404 }));
    }
    await renderAssignmentForm(req, res, 200, {
      title: req.t('Edit assignment'),
      mode: 'edit',
      action: `${basePath}/${shift.id}/assignments/${assignment.id}`,
      shift,
      assignment,
      row: assignment,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/assignments/:assignmentId(\\d+)', async (req, res, next) => {
  try {
    const shift = await one('SELECT * FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    const assignment = await one(
      'SELECT * FROM employee_shift_assignments WHERE id = ? AND shift_id = ? LIMIT 1',
      [req.params.assignmentId, shift.id],
    );
    if (!assignment) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift assignment') })), { status: 404 }));
    }
    const { errors, overlaps, data } = await validateAssignment(req.body, shift, assignment.id);
    if (overlaps.length) {
      errors._form = ['This employee already has a shift assignment in that period.'];
    }
    if (Object.keys(errors).length) {
      return renderAssignmentForm(req, res, 422, {
        title: req.t('Edit assignment'),
        mode: 'edit',
        action: `${basePath}/${shift.id}/assignments/${assignment.id}`,
        shift,
        assignment,
        row: req.body,
        errors,
      });
    }
    await query(
      `UPDATE employee_shift_assignments
          SET employee_id = ?, shift_id = ?, effective_from = ?, effective_to = ?,
              grace_minutes_override = ?, early_leave_grace_minutes_override = ?, notes = ?
        WHERE id = ?`,
      [
        data.employee_id,
        data.shift_id,
        data.effective_from,
        data.effective_to,
        data.grace_minutes_override,
        data.early_leave_grace_minutes_override,
        data.notes,
        assignment.id,
      ],
    );
    req.flash('success', 'Shift assignment updated.');
    res.redirect(`${basePath}/${shift.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/assignments/:assignmentId(\\d+)/delete', async (req, res, next) => {
  try {
    const shift = await one('SELECT id FROM shifts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!shift) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift') })), { status: 404 }));
    }
    const assignment = await one(
      'SELECT id FROM employee_shift_assignments WHERE id = ? AND shift_id = ? LIMIT 1',
      [req.params.assignmentId, shift.id],
    );
    if (!assignment) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Shift assignment') })), { status: 404 }));
    }
    await query('DELETE FROM employee_shift_assignments WHERE id = ?', [assignment.id]);
    req.flash('success', 'Shift assignment removed.');
    res.redirect(`${basePath}/${shift.id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
