/**
 * Integration checks for the Machines page.
 *
 * Requires the app to be running:
 *   npm run test:machines
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const mysql = require('mysql2/promise');

const base = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'werp_erp',
  dateStrings: true,
});

const q = async (sql, params = []) => (await db.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

const jar = new Map();
let csrf = '';
let failures = 0;

function absorb(res) {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    redirect: 'manual',
    headers: { cookie: cookie(), ...(opts.headers || {}) },
  });
  absorb(res);
  return res;
}

function body(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.append(k, String(v));
  }
  sp.append('_csrf', csrf);
  return sp;
}

const post = (path, params) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body(params),
  });

const get = (path) => req(path, { method: 'GET' });

function ok(name, condition, extra = '') {
  if (condition) console.log('PASS', name);
  else {
    failures += 1;
    console.log('FAIL', name, extra);
  }
}

const suffix = Date.now().toString(36).slice(-7);
const name = `QA-MACHINE-${suffix}`;
const updatedName = `${name}-EDIT`;
let machineId = 0;

async function cleanup() {
  try {
    if (machineId) await q('DELETE FROM machines WHERE id = ?', [machineId]);
    await q('DELETE FROM machines WHERE name IN (?, ?)', [name, updatedName]);
  } catch (error) {
    console.log('CLEANUP WARNING', error.message);
  }
}

try {
  await cleanup();

  const loginPage = await get('/login');
  const loginHtml = await loginPage.text();
  csrf = (loginHtml.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const login = await post('/login', { email: 'admin@werp.local', password: 'Admin123!' });
  ok('login', login.status === 302, `${login.status}`);
  const dashboard = await get('/dashboard');
  const dashboardHtml = await dashboard.text();
  csrf = ((dashboardHtml.match(/name="csrf-token" content="([^"]+)"/) || [])[1]) || csrf;
  ok('csrf token', Boolean(csrf));

  {
    const res = await post('/manufacturing/machines', {
      name,
      full_name: 'QA Thermoformer TT-100',
      serial_number: 'QA-SERIAL-100',
      machine_type: 'thermoforming',
      status: 'active',
    });
    const location = res.headers.get('location') || '';
    machineId = Number((location.match(/\/manufacturing\/machines\/(\d+)\/edit/) || [])[1]);
    const row = machineId
      ? await one('SELECT * FROM machines WHERE id = ?', [machineId])
      : null;
    ok('machine created', res.status === 302 && Boolean(machineId), `${res.status} ${location}`);
    ok('machine fields saved', row
      && row.name === name
      && row.full_name === 'QA Thermoformer TT-100'
      && row.serial_number === 'QA-SERIAL-100'
      && row.machine_type === 'thermoforming'
      && row.status === 'active');
  }

  {
    const res = await post(`/manufacturing/machines/${machineId}`, {
      name: updatedName,
      full_name: 'QA Thermoformer TT-200',
      serial_number: '',
      machine_type: 'weighing_labeling',
      status: 'inactive',
    });
    const row = await one('SELECT * FROM machines WHERE id = ?', [machineId]);
    ok('machine updated', res.status === 302, `${res.status}`);
    ok('machine update saved', row
      && row.name === updatedName
      && row.full_name === 'QA Thermoformer TT-200'
      && row.serial_number === null
      && row.machine_type === 'weighing_labeling'
      && row.status === 'inactive');
  }

  {
    const res = await post(`/manufacturing/machines/${machineId}/status`, {});
    const row = await one('SELECT status FROM machines WHERE id = ?', [machineId]);
    ok('machine status toggled', res.status === 302 && row.status === 'active', `${res.status} ${row && row.status}`);
  }

  {
    const res = await get('/manufacturing/machines');
    const html = await res.text();
    ok('machines list renders', res.status === 200 && html.includes(updatedName), `${res.status}`);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL unexpected error', error.message);
  console.log(error.stack);
} finally {
  await cleanup();
  await db.end();
  console.log(failures ? `${failures} machine check(s) failed.` : 'All machine checks passed.');
  process.exitCode = failures ? 1 : 0;
}
