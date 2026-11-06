/**
 * Integration checks for the employee attendance report.
 *
 * Creates a temporary employee, shift, assignment and attendance records,
 * verifies the report totals and removes everything at the end.
 *
 *   npm run test:employee-report
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const db = require('../src/db/index.js');
const { buildEmployeeReport } = require('../src/lib/employeeReport.js');

await db.initDb();
const pool = db.getPool();
const conn = await pool.getConnection();
const suffix = `${Date.now()}`.slice(-7);

let employeeId = null;
let shiftId = null;

const insertAttendance = async (values) => {
  await conn.query(
    `INSERT INTO attendance_records
       (employee_id, work_date, clock_in, clock_out, shift_id, shift_name,
        scheduled_start, scheduled_end, expected_minutes, worked_minutes,
        late_minutes, early_leave_minutes, overtime_minutes, grace_minutes,
        early_leave_grace_minutes, punctuality, source, punch_count)
     VALUES (?, ?, ?, ?, ?, 'Report test shift', '09:00:00', '17:00:00', ?, ?, ?, ?, ?, 10, 10, ?, 'manual', ?)`,
    [
      employeeId,
      values.date,
      values.clockIn || null,
      values.clockOut || null,
      shiftId,
      values.expectedMinutes,
      values.workedMinutes,
      values.lateMinutes || 0,
      values.earlyLeaveMinutes || 0,
      values.overtimeMinutes || 0,
      values.punctuality,
      values.punchCount || 2,
    ],
  );
};

try {
  const [employee] = await conn.query(
    `INSERT INTO employees
       (employee_no, clock_id, first_name, last_name, job_title, department,
        employment_type, hire_date, status)
     VALUES (?, ?, 'Report', 'Tester', 'Technician', 'Operations', 'full_time', '2020-01-01', 'active')`,
    [`QA-REP-${suffix}`, `QA-REP-CLOCK-${suffix}`],
  );
  employeeId = employee.insertId;

  const [shift] = await conn.query(
    `INSERT INTO shifts (name, start_time, end_time, work_days, grace_minutes, early_leave_grace_minutes, status)
     VALUES (?, '09:00:00', '17:00:00', 'mon,tue,wed,thu,fri', 10, 10, 'active')`,
    [`QA Report Shift ${suffix}`],
  );
  shiftId = shift.insertId;

  await conn.query(
    `INSERT INTO employee_shift_assignments (employee_id, shift_id, effective_from)
     VALUES (?, ?, '2020-01-01')`,
    [employeeId, shiftId],
  );

  await insertAttendance({ date: '2020-03-02', clockIn: '2020-03-02 09:00:00', clockOut: '2020-03-02 17:00:00', expectedMinutes: 480, workedMinutes: 480, punctuality: 'on_time' });
  await insertAttendance({ date: '2020-03-03', clockIn: '2020-03-03 09:15:00', clockOut: '2020-03-03 17:00:00', expectedMinutes: 480, workedMinutes: 465, lateMinutes: 15, punctuality: 'late' });
  await insertAttendance({ date: '2020-03-04', clockIn: '2020-03-04 09:00:00', expectedMinutes: 480, workedMinutes: null, punctuality: 'incomplete', punchCount: 1 });
  await insertAttendance({ date: '2020-03-06', clockIn: '2020-03-06 09:00:00', clockOut: '2020-03-06 16:30:00', expectedMinutes: 480, workedMinutes: 450, earlyLeaveMinutes: 30, punctuality: 'early_leave' });
  await insertAttendance({ date: '2020-03-07', clockIn: '2020-03-07 10:00:00', clockOut: '2020-03-07 12:00:00', expectedMinutes: 0, workedMinutes: 120, punctuality: 'unscheduled' });

  const report = await buildEmployeeReport(employeeId, '2020-03-02', '2020-03-08');

  assert.equal(report.calendarDays, 7, 'calendar days cover the full range');
  assert.equal(report.scheduledDays, 5, 'only Monday to Friday are scheduled');
  assert.equal(report.expectedMinutes, 2400, 'expected hours are five eight-hour shifts');
  assert.equal(report.daysRegistered, 5, 'all registered attendance rows are counted');
  assert.equal(report.workedMinutes, 1515, 'worked minutes include all attendance records');
  assert.equal(report.absentDays, 1, 'the scheduled Thursday without a record is an absence');
  assert.equal(report.lateCount, 1, 'only lateness beyond the grace period is counted');
  assert.equal(report.lateMinutes, 15, 'late minutes are summed');
  assert.equal(report.earlyLeaveCount, 1, 'early departure is counted');
  assert.equal(report.earlyLeaveMinutes, 30, 'early leave minutes are summed');
  assert.deepEqual(
    report.records.map((record) => record.work_date),
    ['2020-03-02', '2020-03-03', '2020-03-04', '2020-03-06', '2020-03-07'],
    'attendance rows are ordered by work date',
  );

  console.log('All employee report checks passed.');
} finally {
  try {
    if (employeeId) await conn.query('DELETE FROM attendance_records WHERE employee_id = ?', [employeeId]);
    if (employeeId) await conn.query('DELETE FROM employee_shift_assignments WHERE employee_id = ?', [employeeId]);
    if (shiftId) await conn.query('DELETE FROM shifts WHERE id = ?', [shiftId]);
    if (employeeId) await conn.query('DELETE FROM employees WHERE id = ?', [employeeId]);
  } finally {
    conn.release();
    await db.closeDb();
  }
}
