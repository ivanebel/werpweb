'use strict';

const { makeResourceRouter } = require('./resource');

const statusOptions = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const fields = [
  { name: 'company_name', label: 'Carrier company', type: 'text', required: true, full: true, section: 'Carrier', maxLength: 120 },
  { name: 'status', label: 'Status', type: 'select', options: statusOptions, default: 'active', section: 'Carrier' },
  { name: 'driver_name', label: 'Driver name', type: 'text', section: 'Driver', maxLength: 120 },
  { name: 'driver_id', label: 'Driver ID / DNI', type: 'text', section: 'Driver', maxLength: 40, help: 'National identity document or equivalent.' },
  { name: 'license_plate', label: 'License plate', type: 'text', section: 'Vehicle', maxLength: 20 },
  { name: 'phone', label: 'Phone', type: 'text', section: 'Contact', maxLength: 40 },
  { name: 'email', label: 'Email', type: 'email', section: 'Contact', maxLength: 180 },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true, section: 'Notes', maxLength: 500 },
];

module.exports = makeResourceRouter({
  key: 'carriers',
  basePath: '/carriers',
  title: 'Carriers',
  singular: 'Carrier',
  table: 'carriers',
  titleField: 'company_name',
  indexSubtitle: 'Manage transport companies, drivers and vehicle details used on packing slips.',
  searchFields: ['t.company_name', 't.driver_name', 't.driver_id', 't.license_plate', 't.phone', 't.email'],
  filters: [{ name: 'status', label: 'Status', options: statusOptions }],
  orderBy: 't.company_name ASC',
  fields,
  columns: [
    { key: 'company_name', label: 'Carrier company', type: 'primary' },
    { key: 'driver_name', label: 'Driver name' },
    { key: 'driver_id', label: 'Driver ID / DNI' },
    { key: 'license_plate', label: 'License plate' },
    { key: 'phone', label: 'Phone' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
});
