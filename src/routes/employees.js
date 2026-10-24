'use strict';

const { makeResourceRouter } = require('./resource');

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
});
