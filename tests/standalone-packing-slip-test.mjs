/**
 * Integration checks for standalone packing slips (no sales order).
 *
 * Requires the app to be running:
 *   npm run test:standalone-packing-slip
 *
 * Creates its own supplier, customer, CAI and packing slip, then removes them.
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
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
    else sp.append(k, String(v));
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

const today = new Date().toISOString().slice(0, 10);
const suffix = String(Date.now()).slice(-5);
const caiNumber = `QA-CAI-${suffix}-${Date.now()}`;
let customerId = 0;
let supplierId = 0;
let caiId = 0;
let deliveryId = 0;

async function cleanup() {
  try {
    if (deliveryId) {
      await q("DELETE FROM stock_movements WHERE reference_type = 'delivery' AND reference_id = ?", [deliveryId]);
      await q('DELETE FROM deliveries WHERE id = ?', [deliveryId]);
    }
    if (caiId) await q('DELETE FROM cai_authorizations WHERE id = ?', [caiId]);
    if (customerId) await q('DELETE FROM customers WHERE id = ?', [customerId]);
    if (supplierId) await q('DELETE FROM suppliers WHERE id = ?', [supplierId]);
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
  csrf = (dashboardHtml.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  ok('csrf token', Boolean(csrf));

  const [customer] = await db.query(
    `INSERT INTO customers (customer_no, company_name, status, payment_terms)
     VALUES (?, ?, 'active', 'Net 30')`,
    [`QA-STAND-C-${suffix}`, `QA Standalone Customer ${suffix}`],
  );
  customerId = customer.insertId;
  const [supplier] = await db.query(
    `INSERT INTO suppliers (supplier_no, company_name, status, payment_terms)
     VALUES (?, ?, 'active', 'Net 30')`,
    [`QA-STAND-S-${suffix}`, `QA Standalone Supplier ${suffix}`],
  );
  supplierId = supplier.insertId;
  const [cai] = await db.query(
    `INSERT INTO cai_authorizations (cai_number, prefix, range_start, range_end, next_number, status, notes, created_by)
     VALUES (?, ?, 1, 5, 1, 'active', 'QA standalone packing slip', 1)`,
    [caiNumber, suffix],
  );
  caiId = cai.insertId;
  ok('test data created', Boolean(customerId && supplierId && caiId));

  {
    const res = await post('/deliveries/standalone', {
      delivery_date: today,
      recipient: `supplier:${supplierId}`,
      carrier_id: '',
      carrier_driver_name: 'QA Driver',
      carrier_driver_id: 'QA-1',
      carrier_license_plate: 'QA123QA',
      tracking_number: '',
      cot: '',
      notes: 'Standalone packing slip test',
      item_description: ['Laptop for repair'],
      item_quantity: ['1'],
      item_unit: ['unit'],
      slip_pallets: ['0'],
      slip_boxes: ['0'],
      slip_units: ['1'],
      slip_weight_kg: ['2.5'],
      lot_number: [''],
      expiry_date: [''],
    });
    const location = res.headers.get('location') || '';
    deliveryId = Number((location.match(/\/deliveries\/(\d+)/) || [])[1]);
    const row = deliveryId
      ? await one('SELECT * FROM deliveries WHERE id = ?', [deliveryId])
      : null;
    const item = deliveryId
      ? await one('SELECT * FROM delivery_items WHERE delivery_id = ?', [deliveryId])
      : null;
    ok('standalone packing slip created', res.status === 302 && Boolean(deliveryId), `${res.status} ${location}`);
    ok('standalone has no sales order', row && row.sales_order_id === null);
    ok('supplier is the recipient', row && Number(row.supplier_id) === supplierId && row.customer_id === null);
    ok('packing slip number assigned', row && Boolean(row.packing_slip_no), row && row.packing_slip_no);
    ok('manual line stored', item && item.product_id === null && item.description === 'Laptop for repair' && Number(item.quantity) === 1);
    ok('standalone starts pending without stock', row && row.status === 'pending' && Number(row.stock_posted) === 0);
  }

  {
    const show = await get(`/deliveries/${deliveryId}`);
    ok('standalone detail renders', show.status === 200, `${show.status}`);
    const print = await get(`/deliveries/${deliveryId}/print`);
    ok('standalone packing slip prints', print.status === 200, `${print.status}`);
    const packing = await get(`/deliveries/${deliveryId}/packing`);
    ok('standalone packing quantities render', packing.status === 200, `${packing.status}`);
    const palletSlips = await get(`/deliveries/${deliveryId}/pallet-slips`);
    ok('standalone pallet slips render', palletSlips.status === 200, `${palletSlips.status}`);
  }

  {
    const res = await post(`/deliveries/${deliveryId}`, {
      delivery_date: today,
      recipient: `customer:${customerId}`,
      carrier_id: '',
      carrier_driver_name: 'QA Driver',
      carrier_driver_id: 'QA-1',
      carrier_license_plate: 'QA123QA',
      tracking_number: '',
      cot: '',
      notes: 'Updated standalone packing slip',
      item_description: ['Machine for calibration'],
      item_quantity: ['2'],
      item_unit: ['unit'],
      slip_pallets: ['0'],
      slip_boxes: ['0'],
      slip_units: ['2'],
      slip_weight_kg: ['4'],
      lot_number: [''],
      expiry_date: [''],
    });
    const row = await one('SELECT * FROM deliveries WHERE id = ?', [deliveryId]);
    const items = await q('SELECT * FROM delivery_items WHERE delivery_id = ?', [deliveryId]);
    ok('standalone edit redirects', res.status === 302, `${res.status}`);
    ok('recipient can change to a customer', Number(row.customer_id) === customerId && row.supplier_id === null);
    ok('lines can be replaced', items.length === 1 && items[0].description === 'Machine for calibration' && Number(items[0].quantity) === 2);
  }

  {
    const res = await post(`/deliveries/${deliveryId}/status`, { status: 'shipped' });
    const row = await one('SELECT status, stock_posted FROM deliveries WHERE id = ?', [deliveryId]);
    const movements = await one(
      "SELECT COUNT(*) AS count FROM stock_movements WHERE reference_type = 'delivery' AND reference_id = ?",
      [deliveryId],
    );
    ok('standalone can be shipped', res.status === 302 && row.status === 'shipped', `${res.status} ${row.status}`);
    ok('shipping does not post stock', Number(row.stock_posted) === 0 && Number(movements.count) === 0);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL unexpected error', error.message);
  console.log(error.stack);
} finally {
  await cleanup();
  await db.end();
  console.log(failures ? `${failures} standalone packing slip check(s) failed.` : 'All standalone packing slip checks passed.');
  process.exitCode = failures ? 1 : 0;
}
