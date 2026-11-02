/**
 * Integration checks for weighted document lines.
 *
 * Requires the app to be running:
 *   npm run test:weighted-lines
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
const stamp = Date.now().toString(36).slice(-7);
const today = new Date().toISOString().slice(0, 10);
const displayDate = (iso) => {
  const [year, month, day] = String(iso).split('-');
  return `${day}/${month}/${year}`;
};
let supplierId = 0;
let productId = 0;
let orderId = 0;
let invoiceId = 0;

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

async function cleanup() {
  try {
    if (invoiceId) {
      await q("DELETE FROM stock_movements WHERE reference_type = 'purchase_invoice' AND reference_id = ?", [invoiceId]);
      await q('DELETE FROM purchase_invoices WHERE id = ?', [invoiceId]);
    }
    if (orderId) await q('DELETE FROM purchase_orders WHERE id = ?', [orderId]);
    if (productId) await q('DELETE FROM products WHERE id = ?', [productId]);
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

  const [supplier] = await db.query(
    `INSERT INTO suppliers (supplier_no, company_name, status, payment_terms)
     VALUES (?, ?, 'active', 'Net 30')`,
    [`QA-W-S-${stamp}`, `QA Weighted Supplier ${stamp}`],
  );
  supplierId = supplier.insertId;
  const [product] = await db.query(
    `INSERT INTO products
       (sku, name, type, unit, sold_by_weight, weight_kg, cost_gross_price, cost_price,
        sale_price, stock_qty, track_stock, status)
     VALUES (?, ?, 'raw_material', 'pcs', 1, 4, 10, 10, 0, 0, 1, 'active')`,
    [`QA-W-P-${stamp}`, `QA Weighted Block ${stamp}`],
  );
  productId = product.insertId;

  {
    const res = await post('/purchase-orders', {
      order_date: displayDate(today),
      expected_date: displayDate(today),
      status: 'draft',
      supplier_id: String(supplierId),
      discount_total: '0',
      notes: 'Weighted line test',
      item_product_id: [String(productId)],
      item_quantity: ['1'],
      item_unit_price: ['10'],
      item_tax_rate: ['21'],
      item_weight_per_unit: ['4'],
    });
    const location = res.headers.get('location') || '';
    orderId = Number((location.match(/\/purchase-orders\/(\d+)/) || [])[1]) || 0;
    const order = orderId ? await one('SELECT * FROM purchase_orders WHERE id = ?', [orderId]) : null;
    const line = orderId
      ? await one('SELECT * FROM purchase_order_items WHERE order_id = ? LIMIT 1', [orderId])
      : null;
    ok('weighted purchase order created', res.status === 302 && order && line, `${res.status} ${location}`);
    ok('weighted order calculates total weight', line && Number(line.weight_per_unit) === 4 && Number(line.total_weight) === 4);
    ok('weighted order line total uses net price plus VAT', line && Number(line.line_total) === 48.4 && Number(order.total) === 48.4, line && `line=${line.line_total} total=${order.total}`);
    ok('dd/mm/yyyy document dates are stored as ISO', order && String(order.order_date).slice(0, 10) === today);
  }

  {
    const res = await post('/purchases', {
      bill_no: `00001-${String((Number.parseInt(stamp, 36) % 100000000) + 1).padStart(8, '0')}`,
      document_type_code: '1',
      supplier_id: String(supplierId),
      invoice_date: displayDate(today),
      due_date: displayDate(today),
      status: 'received',
      packing_slip_no: '',
      notes: 'Weighted invoice test',
      discount_total: '0',
      amount_paid: '0',
      item_product_id: [String(productId)],
      item_quantity: ['1'],
      item_unit_price: ['10'],
      item_tax_rate: ['0'],
      item_weight_per_unit: ['4'],
    });
    const location = res.headers.get('location') || '';
    invoiceId = Number((location.match(/\/purchases\/(\d+)/) || [])[1]) || 0;
    const invoice = invoiceId ? await one('SELECT * FROM purchase_invoices WHERE id = ?', [invoiceId]) : null;
    const line = invoiceId
      ? await one('SELECT * FROM purchase_invoice_items WHERE invoice_id = ? LIMIT 1', [invoiceId])
      : null;
    const stock = productId ? await one('SELECT stock_qty FROM products WHERE id = ?', [productId]) : null;
    const movement = invoiceId
      ? await one("SELECT * FROM stock_movements WHERE reference_type = 'purchase_invoice' AND reference_id = ? LIMIT 1", [invoiceId])
      : null;
    ok('weighted purchase invoice created', res.status === 302 && invoice && line, `${res.status} ${location}`);
    ok('weighted invoice line total uses total weight', line && Number(line.total_weight) === 4 && Number(line.line_total) === 40 && Number(invoice.total) === 40);
    ok('stock is posted in product units', stock && Number(stock.stock_qty) === 1, stock && `stock=${stock.stock_qty}`);
    ok('stock movement cost is per product unit', movement && Number(movement.unit_cost) === 40, movement && `unit_cost=${movement.unit_cost}`);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL unexpected error', error.message);
  console.log(error.stack);
} finally {
  await cleanup();
  await db.end();
  console.log(failures ? `${failures} weighted line check(s) failed.` : 'All weighted line checks passed.');
  process.exitCode = failures ? 1 : 0;
}
