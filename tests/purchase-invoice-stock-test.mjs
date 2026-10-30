/**
 * Integration checks for receiving purchase invoices without posting stock.
 *
 * Requires the app to be running:
 *   npm run test:purchase-stock
 *
 * Creates its own supplier, product and purchase invoices, then removes them.
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
  if (condition) {
    console.log('PASS', name);
  } else {
    failures += 1;
    console.log('FAIL', name, extra);
  }
}

const today = new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString(36).slice(-7);
let supplierId = 0;
let productId = 0;
const invoiceIds = [];

async function makeInvoice(status, quantity) {
  const [invoice] = await db.query(
    `INSERT INTO purchase_invoices
       (bill_no, supplier_id, invoice_date, status, subtotal, tax_total, total, amount_paid)
     VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
    [`QA-STOCK-${stamp}-${invoiceIds.length + 1}`, supplierId, today, status, quantity * 10, quantity * 10],
  );
  invoiceIds.push(invoice.insertId);
  await db.query(
    `INSERT INTO purchase_invoice_items
       (invoice_id, product_id, description, quantity, unit_price, tax_rate, line_total)
     VALUES (?, ?, 'Stock test line', ?, 10, 0, ?)`,
    [invoice.insertId, productId, quantity, quantity * 10],
  );
  return invoice.insertId;
}

async function productStock() {
  const row = await one('SELECT stock_qty FROM products WHERE id = ?', [productId]);
  return Number(row.stock_qty);
}

async function movementCount(invoiceId) {
  const row = await one(
    `SELECT COUNT(*) AS count FROM stock_movements
      WHERE reference_type = 'purchase_invoice' AND reference_id = ?`,
    [invoiceId],
  );
  return Number(row.count);
}

async function cleanup() {
  try {
    if (invoiceIds.length) {
      const marks = invoiceIds.map(() => '?').join(',');
      await q(
        `DELETE FROM stock_movements
          WHERE reference_type = 'purchase_invoice' AND reference_id IN (${marks})`,
        invoiceIds,
      );
      await q(`DELETE FROM purchase_invoice_items WHERE invoice_id IN (${marks})`, invoiceIds);
      await q(`DELETE FROM purchase_invoices WHERE id IN (${marks})`, invoiceIds);
    }
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
    [`QA-STOCK-S-${stamp}`, `QA Stock Supplier ${stamp}`],
  );
  supplierId = supplier.insertId;
  const [product] = await db.query(
    `INSERT INTO products
       (sku, name, type, unit, cost_gross_price, cost_price, stock_qty, track_stock, status)
     VALUES (?, ?, 'raw_material', 'unit', 10, 10, 100, 1, 'active')`,
    [`QA-STOCK-P-${stamp}`, `QA Stock Product ${stamp}`],
  );
  productId = product.insertId;
  ok('test supplier and product created', Boolean(supplierId && productId));

  // ------------------------------------------------- receive without stock
  {
    const invoiceId = await makeInvoice('draft', 5);
    const before = await productStock();
    const res = await post(`/purchases/${invoiceId}/status`, {
      status: 'received',
      skip_stock: '1',
    });
    const row = await one(
      'SELECT status, stock_posted, stock_skipped FROM purchase_invoices WHERE id = ?',
      [invoiceId],
    );
    ok('no-stock receive redirects', res.status === 302, `${res.status}`);
    ok('invoice is received', row.status === 'received', row.status);
    ok('stock was not posted', Number(row.stock_posted) === 0, String(row.stock_posted));
    ok('invoice records skipped stock', Number(row.stock_skipped) === 1, String(row.stock_skipped));
    ok('product stock unchanged', (await productStock()) === before, `${before} -> ${await productStock()}`);
    ok('no stock movement created', (await movementCount(invoiceId)) === 0);
  }

  // ---------------------------------------------- normal receive still posts
  {
    const invoiceId = await makeInvoice('draft', 3);
    const before = await productStock();
    const res = await post(`/purchases/${invoiceId}/status`, { status: 'received' });
    const row = await one(
      'SELECT status, stock_posted, stock_skipped FROM purchase_invoices WHERE id = ?',
      [invoiceId],
    );
    ok('normal receive redirects', res.status === 302, `${res.status}`);
    ok('normal receive posts stock', Number(row.stock_posted) === 1, String(row.stock_posted));
    ok('normal receive is not skipped', Number(row.stock_skipped) === 0, String(row.stock_skipped));
    ok('normal receive increases stock', (await productStock()) === before + 3, `${before} -> ${await productStock()}`);
    ok('normal receive creates a movement', (await movementCount(invoiceId)) === 1);
  }

  // ------------------------------------- create already received, no stock
  {
    const before = await productStock();
    const res = await post('/purchases', {
      bill_no: `00001-${String(Number.parseInt(stamp, 36) % 100000000).padStart(8, '0')}`,
      document_type_code: '1',
      supplier_id: String(supplierId),
      invoice_date: today,
      due_date: today,
      status: 'received',
      skip_stock: '1',
      packing_slip_no: '',
      notes: 'Historical invoice test',
      discount_total: '0',
      amount_paid: '0',
      item_product_id: [String(productId)],
      item_description: ['Historical stock test'],
      item_quantity: ['2'],
      item_unit_price: ['10'],
      item_tax_rate: ['0'],
    });
    const location = res.headers.get('location') || '';
    const invoiceId = Number((location.match(/\/purchases\/(\d+)/) || [])[1]);
    if (invoiceId) invoiceIds.push(invoiceId);
    const row = invoiceId
      ? await one('SELECT status, stock_posted, stock_skipped FROM purchase_invoices WHERE id = ?', [invoiceId])
      : null;
    ok('historical create redirects', res.status === 302 && Boolean(invoiceId), `${res.status} ${location}`);
    ok('historical create is received', row && row.status === 'received', row && row.status);
    ok('historical create skips stock', row && Number(row.stock_skipped) === 1 && Number(row.stock_posted) === 0);
    ok('historical create leaves stock unchanged', (await productStock()) === before);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL unexpected error', error.message);
  console.log(error.stack);
} finally {
  await cleanup();
  await db.end();
  console.log(failures ? `${failures} purchase stock check(s) failed.` : 'All purchase stock checks passed.');
  process.exitCode = failures ? 1 : 0;
}
