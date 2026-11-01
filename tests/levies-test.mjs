/**
 * Integration checks for the levy/withholding registry and purchase invoice levies.
 *
 * Requires the app to be running:
 *   npm run test:levies
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

const appDb = require('../src/db');
const taxesLib = require('../src/lib/taxes');

const jar = new Map();
let csrf = '';
let failures = 0;
const stamp = Date.now().toString(36).slice(-7);
const today = new Date().toISOString().slice(0, 10);
let supplierId = 0;
let productId = 0;
let levyA = 0;
let levyB = 0;
let withholdingId = 0;
let invoiceId = 0;
let jurisdictionId = 0;
let customerId = 0;
let salesInvoiceId = 0;

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
    if (salesInvoiceId) {
      await q('DELETE FROM sales_invoice_items WHERE invoice_id = ?', [salesInvoiceId]);
      await q('DELETE FROM sales_invoices WHERE id = ?', [salesInvoiceId]);
    }
    if (invoiceId) await q('DELETE FROM purchase_invoices WHERE id = ?', [invoiceId]);
    if (levyA) await q('DELETE FROM tax_levies WHERE id = ?', [levyA]);
    if (levyB) await q('DELETE FROM tax_levies WHERE id = ?', [levyB]);
    if (withholdingId) await q('DELETE FROM tax_levies WHERE id = ?', [withholdingId]);
    if (productId) await q('DELETE FROM products WHERE id = ?', [productId]);
    if (supplierId) await q('DELETE FROM suppliers WHERE id = ?', [supplierId]);
    if (customerId) await q('DELETE FROM customers WHERE id = ?', [customerId]);
    if (jurisdictionId) await q('DELETE FROM tax_jurisdictions WHERE id = ?', [jurisdictionId]);
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

  const registryPage = await get('/finance/taxes/levies');
  ok('levy registry renders', registryPage.status === 200, `${registryPage.status}`);

  const [jurisdiction] = await db.query(
    `INSERT INTO tax_jurisdictions (code, name, sales_share, iibb_rate, municipal_rate, status)
     VALUES (?, ?, 100, 10, 0, 'active')`,
    [`QA-J-${stamp}`.slice(0, 20), `QA Jurisdiction ${stamp}`.slice(0, 120)],
  );
  jurisdictionId = jurisdiction.insertId;

  {
    const res = await post('/finance/taxes/levies', {
      code: `QA${stamp.slice(-3)}A`.slice(0, 20),
      name: `QA IIBB perception A ${stamp}`,
      levy_type: 'levy',
      tax_type: 'iibb',
      jurisdiction_id: String(jurisdictionId),
      default_percentage: '2',
      expiry_date: '',
      status: 'active',
      notes: 'Automated levy test',
    });
    const row = await one('SELECT * FROM tax_levies WHERE name = ?', [`QA IIBB perception A ${stamp}`]);
    levyA = row ? row.id : 0;
    ok('IIBB levy created with jurisdiction', res.status === 302 && row && row.tax_type === 'iibb' && Number(row.jurisdiction_id) === jurisdictionId, `${res.status}`);
  }

  {
    const res = await post('/finance/taxes/levies', {
      code: `QA${stamp.slice(-3)}B`.slice(0, 20),
      name: `QA IIBB perception B ${stamp}`,
      levy_type: 'levy',
      tax_type: 'other',
      jurisdiction_id: '',
      default_percentage: '3',
      expiry_date: '2030-12-31',
      status: 'active',
      notes: '',
    });
    const row = await one('SELECT * FROM tax_levies WHERE name = ?', [`QA IIBB perception B ${stamp}`]);
    levyB = row ? row.id : 0;
    ok('second levy created', res.status === 302 && row && Number(row.default_percentage) === 3, `${res.status}`);
  }

  {
    const res = await post('/finance/taxes/levies', {
      code: `QA${stamp.slice(-3)}W`.slice(0, 20),
      name: `QA Withholding ${stamp}`,
      levy_type: 'withholding',
      tax_type: 'other',
      jurisdiction_id: '',
      default_percentage: '1.5',
      expiry_date: '',
      status: 'active',
      notes: '',
    });
    const row = await one('SELECT * FROM tax_levies WHERE name = ?', [`QA Withholding ${stamp}`]);
    withholdingId = row ? row.id : 0;
    ok('withholding created', res.status === 302 && row && row.levy_type === 'withholding', `${res.status}`);
  }

  {
    const res = await post(`/finance/taxes/levies/${levyA}`, {
      code: `QA${stamp.slice(-3)}A`.slice(0, 20),
      name: `QA IIBB perception A ${stamp}`,
      levy_type: 'levy',
      tax_type: 'iibb',
      jurisdiction_id: String(jurisdictionId),
      default_percentage: '2.5',
      expiry_date: '',
      status: 'active',
      notes: 'Updated levy test',
    });
    const row = await one('SELECT * FROM tax_levies WHERE id = ?', [levyA]);
    ok('levy updated', res.status === 302 && Number(row.default_percentage) === 2.5, `${res.status}`);
  }

  const [supplier] = await db.query(
    `INSERT INTO suppliers (supplier_no, company_name, status, payment_terms)
     VALUES (?, ?, 'active', 'Net 30')`,
    [`QA-LEVY-S-${stamp}`, `QA Levy Supplier ${stamp}`],
  );
  supplierId = supplier.insertId;
  const [product] = await db.query(
    `INSERT INTO products
       (sku, name, type, unit, cost_gross_price, cost_price, stock_qty, track_stock, status)
     VALUES (?, ?, 'raw_material', 'unit', 100, 100, 100, 1, 'active')`,
    [`QA-LEVY-P-${stamp}`, `QA Levy Product ${stamp}`],
  );
  productId = product.insertId;

  const invoiceBody = (percentA, percentB) => ({
    bill_no: `00001-${String(Number.parseInt(stamp, 36) % 100000000).padStart(8, '0')}`,
    document_type_code: '1',
    supplier_id: String(supplierId),
    invoice_date: today,
    due_date: today,
    status: 'draft',
    skip_stock: '1',
    packing_slip_no: '',
    notes: 'Levy invoice test',
    discount_total: '0',
    amount_paid: '0',
    item_product_id: [String(productId)],
    item_description: ['Levy test line'],
    item_quantity: ['1'],
    item_unit_price: ['100'],
    item_tax_rate: ['21'],
    levy_id: [String(levyA), String(levyB)],
    levy_percentage: [String(percentA), String(percentB)],
  });

  {
    const res = await post('/purchases', invoiceBody(2, 3));
    const location = res.headers.get('location') || '';
    invoiceId = Number((location.match(/\/purchases\/(\d+)/) || [])[1]) || 0;
    const row = invoiceId
      ? await one('SELECT * FROM purchase_invoices WHERE id = ?', [invoiceId])
      : null;
    const lines = invoiceId
      ? await q('SELECT * FROM purchase_invoice_levies WHERE invoice_id = ? ORDER BY sort_order', [invoiceId])
      : [];
    ok('purchase invoice with levies created', res.status === 302 && row, `${res.status} ${location}`);
    ok('invoice VAT is extracted from the tax-inclusive price', row && Number(row.subtotal) === 121 && Number(row.tax_total) === 21);
    ok('levies are calculated on the gross amount without VAT', lines.length === 2 && lines.every((line) => Number(line.base_amount) === 100));
    ok('levy amounts use their percentages', lines.length === 2 && Number(lines[0].amount) === 2 && Number(lines[1].amount) === 3);
    ok('invoice total includes VAT and levies', row && Number(row.levy_total) === 5 && Number(row.total) === 126);
    ok('invoice levy snapshots its tax type and jurisdiction', lines[0] && lines[0].tax_type === 'iibb' && Number(lines[0].jurisdiction_id) === jurisdictionId && lines[0].jurisdiction_name === `QA Jurisdiction ${stamp}`);
  }

  {
    const res = await post(`/purchases/${invoiceId}`, invoiceBody(4, 3));
    const row = await one('SELECT * FROM purchase_invoices WHERE id = ?', [invoiceId]);
    const lines = await q('SELECT * FROM purchase_invoice_levies WHERE invoice_id = ? ORDER BY sort_order', [invoiceId]);
    ok('invoice levies can be edited', res.status === 302 && Number(row.levy_total) === 7 && Number(row.total) === 128, `${res.status}`);
    ok('edited levy line is replaced', lines.length === 2 && Number(lines[0].amount) === 4 && Number(lines[1].amount) === 3);
  }

  {
    const res = await post(`/finance/taxes/levies/${levyA}/delete`, {});
    const row = await one('SELECT id FROM tax_levies WHERE id = ?', [levyA]);
    ok('a levy used by invoices cannot be deleted', res.status === 302 && Boolean(row));
  }

  {
    const res = await post(`/purchases/${invoiceId}/status`, { status: 'received', skip_stock: '1' });
    const row = await one('SELECT status FROM purchase_invoices WHERE id = ?', [invoiceId]);
    ok('levy invoice can be received without stock', res.status === 302 && row.status === 'received', `${res.status}`);
  }

  {
    const [customer] = await db.query(
      `INSERT INTO customers (customer_no, company_name, status, payment_terms)
       VALUES (?, ?, 'active', 'Net 30')`,
      [`QA-LEVY-C-${stamp}`, `QA Levy Customer ${stamp}`],
    );
    customerId = customer.insertId;
    const [sales] = await db.query(
      `INSERT INTO sales_invoices
         (invoice_no, document_type_code, customer_id, invoice_date, due_date, status,
          subtotal, discount_total, tax_total, total, amount_paid)
       VALUES (?, 1, ?, ?, ?, 'sent', 1210, 0, 210, 1210, 0)`,
      [`00001-${String((Number.parseInt(stamp, 36) % 100000000) + 1).padStart(8, '0')}`, customerId, today, today],
    );
    salesInvoiceId = sales.insertId;
    await db.query(
      `INSERT INTO sales_invoice_items
         (invoice_id, product_id, description, quantity, unit_price, tax_rate, line_total)
       VALUES (?, ?, 'IIBB test sale', 1, 1210, 21, 1210)`,
      [salesInvoiceId, productId],
    );

    await appDb.initDb();
    const report = await taxesLib.buildTaxReport(today, today);
    const iibbRow = report.iibb.rows.find((row) => Number(row.jurisdiction_id) === jurisdictionId);
    ok('IIBB levy is credited to its jurisdiction', iibbRow && Math.abs(Number(iibbRow.levies) - 4) < 0.005, iibbRow && `levies=${iibbRow.levies}`);
    ok('IIBB net subtracts the jurisdiction levy', iibbRow && Math.abs(Number(iibbRow.net) - (Number(iibbRow.calculated) - 4)) < 0.005, iibbRow && `calculated=${iibbRow.calculated} net=${iibbRow.net}`);
    ok('non-IIBB levy is treated as another prepaid tax', Math.abs(Number(report.levies.other) - 3) < 0.005, `other=${report.levies.other}`);
  }

  {
    const page = await get(`/finance/taxes?from=${today}&to=${today}`);
    const html = await page.text();
    ok('tax report renders', page.status === 200, `${page.status}`);
    ok('tax report includes purchase levies', html.includes(`QA IIBB perception A ${stamp}`) && html.includes('Purchase levies'));
  }

  {
    const res = await post(`/finance/taxes/levies/${withholdingId}/delete`, {});
    const row = await one('SELECT id FROM tax_levies WHERE id = ?', [withholdingId]);
    ok('an unused withholding can be deleted', res.status === 302 && !row);
    withholdingId = 0;
  }
} catch (error) {
  failures += 1;
  console.log('FAIL unexpected error', error.message);
  console.log(error.stack);
} finally {
  await cleanup();
  await db.end();
  await appDb.closeDb().catch(() => {});
  console.log(failures ? `${failures} levy check(s) failed.` : 'All levy checks passed.');
  process.exitCode = failures ? 1 : 0;
}
