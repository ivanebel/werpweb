'use strict';

const { query } = require('../db');

const DEFAULTS = {
  company_name: 'Your Company',
  company_email: '',
  company_phone: '',
  company_address: '',
  company_tax_id: '',
  currency: 'USD',
  default_tax_rate: '0',
  invoice_footer: '',
  fiscal_year_start: '01-01',
  date_format: 'MMM d, yyyy',
};

let cache = { data: null, loadedAt: 0 };
const TTL_MS = 30_000;

async function getSettings(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.loadedAt < TTL_MS) return cache.data;

  const rows = await query('SELECT skey, svalue FROM settings');
  const data = { ...DEFAULTS };
  for (const row of rows) data[row.skey] = row.svalue;
  cache = { data, loadedAt: now };
  return data;
}

async function updateSettings(values) {
  const entries = Object.entries(values).filter(([key]) => Object.prototype.hasOwnProperty.call(DEFAULTS, key));
  for (const [skey, svalue] of entries) {
    await query(
      'INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)',
      [skey, svalue ?? ''],
    );
  }
  cache = { data: null, loadedAt: 0 };
  return getSettings(true);
}

module.exports = { getSettings, updateSettings, DEFAULTS };
