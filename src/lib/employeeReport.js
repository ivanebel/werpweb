'use strict';

const { query, one } = require('../db');
const { todayISO, addDaysISO } = require('./helpers');
const { assignmentForDate, scheduledWindow, shiftWorksOn } = require('./attendance');

/**
 * Build the data for an employee attendance report.
 *
 * Expected minutes come from the shift assignment effective on each scheduled
 * work day. Actual minutes come from the stored attendance records. Absences
 * are scheduled days before today that have no attendance record.
 */
async function buildEmployeeReport(employeeId, from, to) {
  const employee = await one('SELECT * FROM employees WHERE id = ? LIMIT 1', [employeeId]);
  if (!employee) return null;

  const assignments = await query(
    `SELECT a.effective_from, a.effective_to,
            a.grace_minutes_override, a.early_leave_grace_minutes_override,
            s.id AS shift_id, s.name AS shift_name, s.start_time, s.end_time,
            s.work_days, s.grace_minutes, s.early_leave_grace_minutes
       FROM employee_shift_assignments a
       JOIN shifts s ON s.id = a.shift_id
      WHERE a.employee_id = ?
        AND a.effective_from <= ?
        AND (a.effective_to IS NULL OR a.effective_to >= ?)
      ORDER BY a.effective_from`,
    [employeeId, to, from],
  );

  const records = await query(
    `SELECT id, work_date, clock_in, clock_out, worked_minutes, expected_minutes,
            late_minutes, early_leave_minutes, overtime_minutes,
            grace_minutes, early_leave_grace_minutes, punctuality, notes
       FROM attendance_records
      WHERE employee_id = ? AND work_date BETWEEN ? AND ?
      ORDER BY work_date, id`,
    [employeeId, from, to],
  );

  const attendanceDates = new Set(records.map((record) => String(record.work_date).slice(0, 10)));
  const today = todayISO();
  const hireDate = employee.hire_date ? String(employee.hire_date).slice(0, 10) : null;
  const endDate = employee.end_date ? String(employee.end_date).slice(0, 10) : null;

  let calendarDays = 0;
  let scheduledDays = 0;
  let expectedMinutes = 0;
  let absentDays = 0;

  for (let date = from; date <= to; date = addDaysISO(date, 1)) {
    calendarDays += 1;
    if (hireDate && date < hireDate) continue;
    if (endDate && date > endDate) continue;

    const assignment = assignmentForDate(assignments, date);
    if (!assignment || !shiftWorksOn(assignment, date)) continue;

    scheduledDays += 1;
    expectedMinutes += scheduledWindow(date, assignment.start_time, assignment.end_time).duration;
    if (date < today && !attendanceDates.has(date)) absentDays += 1;
  }

  let workedMinutes = 0;
  let lateCount = 0;
  let lateMinutes = 0;
  let earlyLeaveCount = 0;
  let earlyLeaveMinutes = 0;
  let overtimeMinutes = 0;

  for (const record of records) {
    workedMinutes += Number(record.worked_minutes || 0);
    const grace = Number(record.grace_minutes || 0);
    const earlyGrace = Number(record.early_leave_grace_minutes || 0);
    if (Number(record.late_minutes || 0) > grace) {
      lateCount += 1;
      lateMinutes += Number(record.late_minutes || 0);
    }
    if (Number(record.early_leave_minutes || 0) > earlyGrace) {
      earlyLeaveCount += 1;
      earlyLeaveMinutes += Number(record.early_leave_minutes || 0);
    }
    overtimeMinutes += Number(record.overtime_minutes || 0);
  }

  return {
    employee: {
      ...employee,
      full_name: `${employee.first_name} ${employee.last_name}`,
    },
    assignments,
    records,
    from,
    to,
    calendarDays,
    scheduledDays,
    daysRegistered: records.length,
    absentDays,
    workedMinutes,
    expectedMinutes,
    lateCount,
    lateMinutes,
    earlyLeaveCount,
    earlyLeaveMinutes,
    overtimeMinutes,
  };
}

module.exports = { buildEmployeeReport };
