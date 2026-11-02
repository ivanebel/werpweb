/**
 * Integration checks for customer and supplier account statements.
 *
 * Requires the app to be running:
 *   npm run test:statement
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
const statements = require('../src/lib/accountStatement');

const jar = new Map();
let csrf = '';
let failures = 0;
const stamp = Date.now().toString(36).slice(-7);
const today = new Date().toISOString().slice(0, 10);
const oldDate = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
let customerId = 0;
let supplierId = 0;
const salesInvoiceIds = [];
const purchaseInvoiceIds = [];
const paymentIds = [];

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
    sp.append(k, String(v));
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

async function insertSalesInvoice({ date, total, documentType = 1 }) {
  const [result] = await db.query(
    `INSERT INTO sales_invoices
       (invoice_no, document_type_code, customer_id, invoice_date, due_date, status,
        subtotal, discount_total, tax_total, total, amount_paid)
     VALUES (?, ?, ?, ?, ?, 'sent', ?, 0, 0, ?, 0)`,
    [
      `QA-ST-${stamp}-${salesInvoiceIds.length + 1}`,
      documentType,
      customerId,
      date,
      date,
      total,
      total,
    ],
  );
  salesInvoiceIds.push(result.insertId);
  return result.insertId;
}

async function insertPurchaseInvoice({ date, total }) {
  const [result] = await db.query(
    `INSERT INTO purchase_invoices
       (bill_no, document_type_code, supplier_id, invoice_date, due_date, status,
        subtotal, discount_total, tax_total, total, amount_paid)
     VALUES (?, 1, ?, ?, ?, 'received', ?, 0, 0, ?, 0)`,
    [
      `QA-ST-${stamp}-${purchaseInvoiceIds.length + 1}`,
      supplierId,
      date,
      date,
      total,
      total,
    ],
  );
  purchaseInvoiceIds.push(result.insertId);
  return result.insertId;
}

async function insertPayment({ direction, partyId, date, method, withholding = 0 }) {
  const [result] = await db.query(
    `INSERT INTO payments
       (payment_no, direction, ${direction === 'customer' ? 'customer_id' : 'supplier_id'},
        payment_date, method_total, credit_total, debit_total, withholding_total, total_amount,
        applied_amount, unapplied_amount)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)`,
    [
      `QA-ST-${stamp}-${paymentIds.length + 1}`,
      direction,
      partyId,
      date,
      method,
      withholding,
      method + withholding,
      method + withholding,
    ],
  );
  paymentIds.push(result.insertId);
  return result.insertId;
}

async function cleanup() {
  try {
    if (paymentIds.length) {
      await q(`DELETE FROM payments WHERE id IN (${paymentIds.map(() => '?').join(',')})`, paymentIds);
    }
    if (salesInvoiceIds.length) {
      await q(`DELETE FROM sales_invoices WHERE id IN (${salesInvoiceIds.map(() => '?').join(',')})`, salesInvoiceIds);
    }
    if (purchaseInvoiceIds.length) {
      await q(`DELETE FROM purchase_invoices WHERE id IN (${purchaseInvoiceIds.map(() => '?').join(',')})`, purchaseInvoiceIds);
    }
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
    `INSERT INTO customers (customer_no, company_name, status, payment_terms, credit_limit)
     VALUES (?, ?, 'active', 'Net 30', 0)`,
    [`QA-ST-C-${stamp}`, `QA Statement Customer ${stamp}`],
  );
  customerId = customer.insertId;
  const [supplier] = await db.query(
    `INSERT INTO suppliers (supplier_no, company_name, status, payment_terms)
     VALUES (?, ?, 'active', 'Net 30')`,
    [`QA-ST-S-${stamp}`, `QA Statement Supplier ${stamp}`],
  );
  supplierId = supplier.insertId;

  await insertSalesInvoice({ date: oldDate, total: 50 });
  await insertSalesInvoice({ date: today, total: 100 });
  await insertSalesInvoice({ date: today, total: 20, documentType: 3 });
  await insertPayment({ direction: 'customer', partyId: customerId, date: today, method: 30, withholding: 5 });

  await insertPurchaseInvoice({ date: today, total: 80 });
  await insertPayment({ direction: 'supplier', partyId: supplierId, date: today, method: 20 });

  await appDb.initDb();
  const slashRange = statements.statementRange('01/11/2026', '02/11/2026');
  ok('dd/mm/yyyy query dates are parsed', slashRange.from === '2026-11-01' && slashRange.to === '2026-11-02');
  const customerStatement = await statements.loadAccountStatement('customer', customerId, from, today);
  ok('customer statement loads', Boolean(customerStatement));
  ok('customer opening balance includes earlier invoices', Number(customerStatement.openingBalance) === 50, `opening=${customerStatement.openingBalance}`);
  ok('customer charges include invoices', Number(customerStatement.charges) === 100, `charges=${customerStatement.charges}`);
  ok('customer payments include credit notes and payments', Number(customerStatement.payments) === 55, `payments=${customerStatement.payments}`);
  ok('customer closing balance is correct', Number(customerStatement.closingBalance) === 95, `closing=${customerStatement.closingBalance}`);
  ok('credit note is shown as a credit movement', customerStatement.rows.some((row) => row.is_credit && Number(row.payment) === 20));
  ok('payment uses cash plus withholdings', customerStatement.rows.some((row) => row.kind === 'payment' && Number(row.payment) === 35));

  const supplierStatement = await statements.loadAccountStatement('supplier', supplierId, from, today);
  ok('supplier statement loads', Boolean(supplierStatement));
  ok('supplier charges include bills', Number(supplierStatement.charges) === 80, `charges=${supplierStatement.charges}`);
  ok('supplier closing balance is correct', Number(supplierStatement.closingBalance) === 60, `closing=${supplierStatement.closingBalance}`);

  {
    const res = await get(`/customers/${customerId}/statement?from=${from}&to=${today}`);
    const html = await res.text();
    ok('customer statement page renders', res.status === 200 && html.includes(`QA Statement Customer ${stamp}`), `${res.status}`);
    ok('customer statement page shows running balance', html.includes('Opening balance') && html.includes('Closing balance'));
  }
  {
    const res = await get(`/suppliers/${supplierId}/statement?from=${from}&to=${today}`);
    ok('supplier statement page renders', res.status === 200, `${res.status}`);
  }
  {
    const res = await get(`/customers/${customerId}/statement/print?from=${from}&to=${today}`);
    const html = await res.text();
    ok('customer statement print page renders', res.status === 200 && html.includes('Print / Save PDF'), `${res.status}`);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL unexpected error', error.message);
  console.log(error.stack);
} finally {
  await cleanup();
  await db.end();
  await appDb.closeDb().catch(() => {});
  console.log(failures ? `${failures} account statement check(s) failed.` : 'All account statement checks passed.');
  process.exitCode = failures ? 1 : 0;
}
