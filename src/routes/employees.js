'use strict';

const { makeResourceRouter } = require('./resource');
const { query } = require('../db');
const { formatDuration, formatTime } = require('../lib/helpers');

const fields = [
  { name: 'employee_no', label: 'Employee no.', type: 'text', section: 'Employee', help: 'Leave blank to generate automatically.', maxLength: 30 },
  { name: 'status', label: 'Status', type: 'select', default: 'active', section: 'Employee', options: [
    { value: 'active', label: 'Active' },
    { value: 'on_leave', label: 'On leave' },
    { value: 'inactive', label: 'Inactive' },
  ] },
  { name: 'first_name', label: 'First name', type: 'text', required: true, section: 'Employee' },
  { name: 'last_name', label: 'Last name', type: 'text', required: true, section: 'Employee' },
  { name: 'email', label: 'Email', type: 'email', section: 'Contact' },
  { name: 'phone', label: 'Phone', type: 'tel', section: 'Contact' },
  { name: 'address', label: 'Address', type: 'text', full: true, section: 'Contact' },
  { name: 'job_title', label: 'Job title', type: 'text', section: 'Employment' },
  { name: 'department', label: 'Department', type: 'text', section: 'Employment' },
  { name: 'employment_type', label: 'Employment type', type: 'select', default: 'full_time', section: 'Employment', options: [
    { value: 'full_time', label: 'Full time' },
    { value: 'part_time', label: 'Part time' },
    { value: 'contract', label: 'Contract' },
    { value: 'intern', label: 'Intern' },
  ] },
  { name: 'hire_date', label: 'Hire date', type: 'date', section: 'Employment' },
  { name: 'end_date', label: 'End date', type: 'date', section: 'Employment' },
  { name: 'salary', label: 'Annual salary', type: 'decimal', min: 0, default: 0, section: 'Compensation' },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true, section: 'Notes' },
];

module.exports = makeResourceRouter({
  key: 'employees',
  basePath: '/employees',
  title: 'Employees',
  singular: 'Employee',
  table: 'employees',
  numberField: 'employee_no',
  number: { prefix: 'EMP', year: false, pad: 4 },
  titleField: 'full_name',
  searchFields: ['t.employee_no', 't.first_name', 't.last_name', 't.email', 't.job_title', 't.department'],
  filters: [{ name: 'status', label: 'Status', options: [
    { value: 'active', label: 'Active' },
    { value: 'on_leave', label: 'On leave' },
    { value: 'inactive', label: 'Inactive' },
  ] }],
  orderBy: 't.last_name ASC, t.first_name ASC',
  select: "t.*, CONCAT(t.first_name, ' ', t.last_name) AS full_name",
  fields,
  columns: [
    { key: 'full_name', label: 'Employee', type: 'primary', sub: 'employee_no' },
    { key: 'job_title', label: 'Job title' },
    { key: 'department', label: 'Department' },
    { key: 'employment_type', label: 'Type', type: 'status' },
    { key: 'email', label: 'Email' },
    { key: 'hire_date', label: 'Hired', type: 'date' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  relatedLoader: async (row) => {
    const assignments = await query(
      `SELECT a.*, s.name AS shift_name
         FROM employee_shift_assignments a
         JOIN shifts s ON s.id = a.shift_id
        WHERE a.employee_id = ?
        ORDER BY a.effective_from DESC`,
      [row.id],
    );
    const attendance = await query(
      `SELECT id, work_date, clock_in, clock_out, worked_minutes, punctuality
         FROM attendance_records
        WHERE employee_id = ?
        ORDER BY work_date DESC
        LIMIT 10`,
      [row.id],
    );
    return [
      {
        title: 'Shift assignments',
        href: '/shifts',
        columns: [
          { key: 'shift_name', label: 'Shift' },
          { key: 'effective_from', label: 'From', type: 'date' },
          { key: 'effective_to', label: 'To', type: 'date' },
          { key: 'tardiness', label: 'Tardiness grace', align: 'right' },
          { key: 'early_leave', label: 'Early-leave grace', align: 'right' },
        ],
        rows: assignments.map((assignment) => ({
          id: assignment.id,
          shift_name: assignment.shift_name,
          effective_from: assignment.effective_from,
          effective_to: assignment.effective_to || 'Open-ended',
          tardiness: assignment.grace_minutes_override !== null
            ? `${assignment.grace_minutes_override} min`
            : 'Shift default',
          early_leave: assignment.early_leave_grace_minutes_override !== null
            ? `${assignment.early_leave_grace_minutes_override} min`
            : 'Shift default',
        })),
        emptyText: 'No shift assigned yet.',
      },
      {
        title: 'Recent attendance',
        href: `/attendance?employee_id=${row.id}`,
        columns: [
          { key: 'work_date', label: 'Date', type: 'date' },
          { key: 'clock_in', label: 'Clock in' },
          { key: 'clock_out', label: 'Clock out' },
          { key: 'worked', label: 'Worked', align: 'right' },
          { key: 'punctuality', label: 'Punctuality', type: 'status' },
        ],
        rows: attendance.map((record) => ({
          id: record.id,
          work_date: record.work_date,
          clock_in: formatTime(record.clock_in) || '—',
          clock_out: record.clock_out ? formatTime(record.clock_out) : '—',
          worked: record.worked_minutes !== null ? formatDuration(record.worked_minutes) : '—',
          punctuality: record.punctuality,
        })),
        emptyText: 'No attendance records yet.',
      },
    ];
  },
});
