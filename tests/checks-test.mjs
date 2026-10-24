/**
 * Integration test for the check portfolio and payment/check integration.
 *
 * Start the app first, then run:
 *   npm run test:checks
 *
 * The test uses the database configured in .env and creates its own customer,
 * supplier, invoices, payments and checks. Everything it creates is removed at
 * the end, even when an assertion fails.
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

async function text(path) {
  const res = await get(path);
  return { status: res.status, html: await res.text(), headers: res.headers };
}

function ok(name, condition, extra = '') {
  if (condition) {
    console.log('PASS', name);
  } else {
    failures += 1;
    console.log('FAIL', name, extra);
  }
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const today = new Date().toISOString().slice(0, 10);
const daysFromNow = (days) => {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const stamp = Date.now().toString(36).slice(-7);

let customerId = 0;
let supplierId = 0;
const salesInvoiceIds = [];
const purchaseInvoiceIds = [];
const paymentIds = [];
const checkIds = [];

async function makeSale(total, status, dueDate) {
  const [res] = await db.query(
    `INSERT INTO sales_invoices
       (invoice_no, customer_id, invoice_date, due_date, status, subtotal, total, amount_paid)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [`INV-QA-CHK-${stamp}-${salesInvoiceIds.length + 1}`, customerId, today, dueDate, status, total, total],
  );
  salesInvoiceIds.push(res.insertId);
  return res.insertId;
}

async function makePurchase(total, status, dueDate) {
  const [res] = await db.query(
    `INSERT INTO purchase_invoices
       (bill_no, supplier_id, invoice_date, due_date, status, subtotal, total, amount_paid)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [`BILL-QA-CHK-${stamp}-${purchaseInvoiceIds.length + 1}`, supplierId, today, dueDate, status, total, total],
  );
  purchaseInvoiceIds.push(res.insertId);
  return res.insertId;
}

async function cleanup() {
  try {
    if (checkIds.length) {
      await q(`DELETE FROM checks WHERE id IN (${checkIds.map(() => '?').join(',')})`, checkIds);
    }
    if (customerId || supplierId) {
      await q('DELETE FROM checks WHERE customer_id = ? OR supplier_id = ?', [customerId || 0, supplierId || 0]);
      await q('DELETE FROM payments WHERE customer_id = ? OR supplier_id = ?', [customerId || 0, supplierId || 0]);
    }
    if (salesInvoiceIds.length) {
      await q(
        `DELETE FROM sales_invoices WHERE id IN (${salesInvoiceIds.map(() => '?').join(',')})`,
        salesInvoiceIds,
      );
    }
    if (purchaseInvoiceIds.length) {
      await q(
        `DELETE FROM purchase_invoices WHERE id IN (${purchaseInvoiceIds.map(() => '?').join(',')})`,
        purchaseInvoiceIds,
      );
    }
    if (customerId) await q('DELETE FROM customers WHERE id = ?', [customerId]);
    if (supplierId) await q('DELETE FROM suppliers WHERE id = ?', [supplierId]);
  } catch (error) {
    console.log('CLEANUP WARNING', error.message);
  }
}

try {
  await cleanup();

  // ------------------------------------------------------------------ login
  {
    const loginPage = await get('/login');
    const html = await loginPage.text();
    csrf = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const login = await post('/login', { email: 'admin@werp.local', password: 'Admin123!' });
    ok('login', login.status === 302, `${login.status}`);
    const dashboard = await get('/dashboard');
    const dashboardHtml = await dashboard.text();
    csrf = (dashboardHtml.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    ok('csrf token', Boolean(csrf));
  }

  // ------------------------------------------------------------ test parties
  {
    const [customer] = await db.query(
      `INSERT INTO customers (customer_no, company_name, status, payment_terms)
       VALUES (?, ?, 'active', 'Net 30')`,
      [`QA-CHK-C-${stamp}`, `QA Checks Customer ${stamp}`],
    );
    customerId = customer.insertId;
    const [supplier] = await db.query(
      `INSERT INTO suppliers (supplier_no, company_name, status, payment_terms)
       VALUES (?, ?, 'active', 'Net 30')`,
      [`QA-CHK-S-${stamp}`, `QA Checks Supplier ${stamp}`],
    );
    supplierId = supplier.insertId;
    ok('test parties created', Boolean(customerId && supplierId));
  }

  // ------------------------------------------------------- checks CRUD pages
  {
    const list = await text('/checks');
    ok('checks list', list.status === 200 && list.html.includes('Checks') && list.html.includes('Open check value'), `${list.status}`);
    const form = await text('/checks/new');
    ok('check form', form.status === 200 && form.html.includes('Entry type') && form.html.includes('Available'), `${form.status}`);
  }

  // -------------------------------------------------------- manual lifecycle
  let manualCheckId = 0;
  {
    const create = await post('/checks', {
      entry_type: 'received',
      check_no: '',
      check_number: `QA-CHECK-${stamp}`,
      bank_name: 'QA Check Bank',
      drawer_name: `QA Drawer ${stamp}`,
      amount: '300.00',
      issue_date: today,
      due_date: daysFromNow(20),
      received_date: today,
      customer_id: String(customerId),
      supplier_id: '',
      status: 'available',
      deposited_bank: '',
      deposited_date: '',
      endorsed_date: '',
      settled_date: '',
      notes: 'Manual check lifecycle test.',
    });
    const location = create.headers.get('location') || '';
    manualCheckId = Number((location.match(/(\d+)$/) || [])[1]);
    checkIds.push(manualCheckId);
    ok('manual check create', create.status === 302 && Boolean(manualCheckId), `${create.status} ${location}`);

    const check = await one('SELECT * FROM checks WHERE id = ?', [manualCheckId]);
    ok(
      'manual check persisted',
      check && /^CHK-\d{4}-\d{4}$/.test(check.check_no) && check.entry_type === 'received' && check.status === 'available' && near(check.amount, 300),
      JSON.stringify(check),
    );

    const history = await q('SELECT event, from_status, to_status FROM check_history WHERE check_id = ? ORDER BY id', [manualCheckId]);
    ok('manual check created history', history.length === 1 && history[0].event === 'created' && history[0].to_status === 'available', JSON.stringify(history));

    const update = await post(`/checks/${manualCheckId}`, {
      entry_type: 'received',
      check_number: `QA-CHECK-${stamp}-UPDATED`,
      bank_name: 'QA Check Bank Updated',
      drawer_name: `QA Drawer ${stamp}`,
      amount: '350.00',
      issue_date: today,
      due_date: daysFromNow(25),
      received_date: today,
      customer_id: String(customerId),
      supplier_id: '',
      status: 'available',
      deposited_bank: '',
      deposited_date: '',
      endorsed_date: '',
      settled_date: '',
      notes: 'Manual check lifecycle test updated.',
    });
    ok('manual check update', update.status === 302, `${update.status}`);
    const updated = await one('SELECT amount, check_number, notes FROM checks WHERE id = ?', [manualCheckId]);
    ok(
      'manual check update persisted',
      updated && near(updated.amount, 350) && updated.check_number === `QA-CHECK-${stamp}-UPDATED`,
      JSON.stringify(updated),
    );

    const deposit = await post(`/checks/${manualCheckId}/status`, {
      status: 'deposited',
      status_date: today,
      deposited_bank: 'QA Deposit Bank',
      supplier_id: '',
      status_notes: 'Deposited by the integration test.',
    });
    ok('manual check deposit', deposit.status === 302, `${deposit.status}`);
    const deposited = await one('SELECT status, deposited_bank, deposited_date FROM checks WHERE id = ?', [manualCheckId]);
    ok(
      'manual check deposit persisted',
      deposited && deposited.status === 'deposited' && deposited.deposited_bank === 'QA Deposit Bank' && deposited.deposited_date === today,
      JSON.stringify(deposited),
    );

    const endorse = await post(`/checks/${manualCheckId}/status`, {
      status: 'endorsed',
      status_date: today,
      supplier_id: String(supplierId),
      status_notes: 'Endorsed by the integration test.',
    });
    ok('manual check endorse', endorse.status === 302, `${endorse.status}`);
    const endorsed = await one('SELECT status, supplier_id, endorsed_date FROM checks WHERE id = ?', [manualCheckId]);
    ok(
      'manual check endorse persisted',
      endorsed && endorsed.status === 'endorsed' && endorsed.supplier_id === supplierId && endorsed.endorsed_date === today,
      JSON.stringify(endorsed),
    );

    const historyAfter = await q('SELECT event, from_status, to_status FROM check_history WHERE check_id = ? ORDER BY id', [manualCheckId]);
    ok(
      'manual check status history',
      historyAfter.length === 4 &&
        historyAfter[1].event === 'updated' &&
        historyAfter[2].event === 'deposited' &&
        historyAfter[3].event === 'endorsed',
      JSON.stringify(historyAfter),
    );

    const remove = await post(`/checks/${manualCheckId}/delete`, {});
    ok('manual check delete', remove.status === 302, `${remove.status}`);
    ok('manual check deleted', !(await one('SELECT id FROM checks WHERE id = ?', [manualCheckId])));
    checkIds.splice(checkIds.indexOf(manualCheckId), 1);
  }

  // --------------------------------------- customer payment creates a check
  {
    const invoiceId = await makeSale(600, 'sent', daysFromNow(20));
    const create = await post('/payments', {
      direction: 'customer',
      party_id: String(customerId),
      payment_date: today,
      reference: `QA-CHK-RCP-${stamp}`,
      'method_type[]': ['own_check'],
      'method_amount[]': ['600'],
      'method_reference[]': [`CK-${stamp}`],
      'method_bank[]': ['QA Customer Bank'],
      'method_date[]': [today],
      'method_notes[]': ['Customer check integration test'],
      invoice_id: String(invoiceId),
      [`invoice_amount[${invoiceId}]`]: '600',
    });
    const location = create.headers.get('location') || '';
    const paymentId = Number((location.match(/(\d+)$/) || [])[1]);
    paymentIds.push(paymentId);
    ok('customer check payment create', create.status === 302 && Boolean(paymentId), `${create.status} ${location}`);

    const check = await one('SELECT * FROM checks WHERE received_payment_id = ?', [paymentId]);
    if (check) checkIds.push(check.id);
    ok(
      'customer payment creates available check',
      check &&
        check.entry_type === 'received' &&
        check.status === 'available' &&
        check.source === 'payment' &&
        near(check.amount, 600) &&
        check.customer_id === customerId,
      JSON.stringify(check),
    );
    const invoice = await one('SELECT amount_paid, status FROM sales_invoices WHERE id = ?', [invoiceId]);
    ok('customer invoice paid by check', invoice && near(invoice.amount_paid, 600) && invoice.status === 'paid', JSON.stringify(invoice));

    if (check) {
      const show = await text(`/payments/${paymentId}`);
      ok(
        'payment show lists linked check',
        show.status === 200 && show.html.includes(check.check_no) && show.html.includes(`/checks/${check.id}`),
        `${show.status}`,
      );
    }

    const reverse = await post(`/payments/${paymentId}/delete`, {});
    ok('customer check payment reverse', reverse.status === 302, `${reverse.status}`);
    ok('customer check removed on reverse', !(await one('SELECT id FROM checks WHERE received_payment_id = ?', [paymentId])));
    const restored = await one('SELECT amount_paid, status FROM sales_invoices WHERE id = ?', [invoiceId]);
    ok('customer invoice restored', restored && near(restored.amount_paid, 0) && restored.status !== 'paid', JSON.stringify(restored));
  }

  // ---------------------------------------- supplier payment creates a check
  {
    const invoiceId = await makePurchase(450, 'received', daysFromNow(20));
    const create = await post('/payments', {
      direction: 'supplier',
      party_id: String(supplierId),
      payment_date: today,
      reference: `QA-CHK-PMT-${stamp}`,
      'method_type[]': ['own_check'],
      'method_amount[]': ['450'],
      'method_reference[]': [`SCK-${stamp}`],
      'method_bank[]': ['QA Supplier Bank'],
      'method_date[]': [today],
      'method_notes[]': ['Supplier check integration test'],
      invoice_id: String(invoiceId),
      [`invoice_amount[${invoiceId}]`]: '450',
    });
    const location = create.headers.get('location') || '';
    const paymentId = Number((location.match(/(\d+)$/) || [])[1]);
    paymentIds.push(paymentId);
    ok('supplier check payment create', create.status === 302 && Boolean(paymentId), `${create.status} ${location}`);

    const check = await one('SELECT * FROM checks WHERE issued_payment_id = ?', [paymentId]);
    if (check) checkIds.push(check.id);
    ok(
      'supplier payment creates issued check',
      check &&
        check.entry_type === 'issued' &&
        check.status === 'endorsed' &&
        check.source === 'payment' &&
        near(check.amount, 450) &&
        check.supplier_id === supplierId,
      JSON.stringify(check),
    );

    const reverse = await post(`/payments/${paymentId}/delete`, {});
    ok('supplier check payment reverse', reverse.status === 302, `${reverse.status}`);
    ok('supplier check removed on reverse', !(await one('SELECT id FROM checks WHERE issued_payment_id = ?', [paymentId])));
  }

  // ------------------------------------ supplier payment links an available check
  {
    const invoiceId = await makePurchase(700, 'received', daysFromNow(20));
    const createCheck = await post('/checks', {
      entry_type: 'received',
      check_no: '',
      check_number: `QA-LINK-${stamp}`,
      bank_name: 'QA Link Bank',
      drawer_name: `QA Link Drawer ${stamp}`,
      amount: '700.00',
      issue_date: today,
      due_date: daysFromNow(20),
      received_date: today,
      customer_id: String(customerId),
      supplier_id: '',
      status: 'available',
      deposited_bank: '',
      deposited_date: '',
      endorsed_date: '',
      settled_date: '',
      notes: 'Available check for endorsement test.',
    });
    const linkCheckId = Number(((createCheck.headers.get('location') || '').match(/(\d+)$/) || [])[1]);
    checkIds.push(linkCheckId);
    ok('linkable check create', createCheck.status === 302 && Boolean(linkCheckId), `${createCheck.status}`);

    const create = await post('/payments', {
      direction: 'supplier',
      party_id: String(supplierId),
      payment_date: today,
      reference: `QA-CHK-END-${stamp}`,
      'method_type[]': ['endorsed_check'],
      'method_amount[]': ['700'],
      'method_reference[]': [`QA-LINK-${stamp}`],
      'method_bank[]': ['QA Link Bank'],
      'method_date[]': [today],
      'method_notes[]': ['Endorsement integration test'],
      'method_check_id[]': [String(linkCheckId)],
      invoice_id: String(invoiceId),
      [`invoice_amount[${invoiceId}]`]: '700',
    });
    const location = create.headers.get('location') || '';
    const paymentId = Number((location.match(/(\d+)$/) || [])[1]);
    paymentIds.push(paymentId);
    ok('endorsed check payment create', create.status === 302 && Boolean(paymentId), `${create.status} ${location}`);

    const linked = await one('SELECT * FROM checks WHERE id = ?', [linkCheckId]);
    ok(
      'available check endorsed',
      linked &&
        linked.status === 'endorsed' &&
        linked.supplier_id === supplierId &&
        linked.issued_payment_id === paymentId &&
        linked.received_payment_id === null,
      JSON.stringify(linked),
    );
    const linkedHistory = await q('SELECT event, from_status, to_status FROM check_history WHERE check_id = ? ORDER BY id', [linkCheckId]);
    ok(
      'endorsement history',
      linkedHistory.some((line) => line.event === 'endorsed' && line.from_status === 'available' && line.to_status === 'endorsed'),
      JSON.stringify(linkedHistory),
    );

    const blockedAmount = await post(`/checks/${linkCheckId}`, {
      entry_type: 'received',
      check_number: `QA-LINK-${stamp}`,
      bank_name: 'QA Link Bank',
      drawer_name: `QA Link Drawer ${stamp}`,
      amount: '701.00',
      issue_date: today,
      due_date: daysFromNow(20),
      received_date: today,
      customer_id: String(customerId),
      supplier_id: String(supplierId),
      status: 'endorsed',
      deposited_bank: '',
      deposited_date: '',
      endorsed_date: today,
      settled_date: '',
      notes: 'Available check for endorsement test.',
    });
    const unchangedAmount = await one('SELECT amount, status FROM checks WHERE id = ?', [linkCheckId]);
    ok(
      'linked check amount guard',
      blockedAmount.status === 422 && unchangedAmount && near(unchangedAmount.amount, 700),
      `${blockedAmount.status} ${JSON.stringify(unchangedAmount)}`,
    );

    const blockedReopen = await post(`/checks/${linkCheckId}/status`, {
      status: 'available',
      status_date: today,
      supplier_id: String(supplierId),
      status_notes: 'Should be blocked while the supplier payment is linked.',
    });
    const stillEndorsed = await one('SELECT status, issued_payment_id FROM checks WHERE id = ?', [linkCheckId]);
    ok(
      'linked check reopen guard',
      blockedReopen.status === 302 && stillEndorsed && stillEndorsed.status === 'endorsed' && stillEndorsed.issued_payment_id === paymentId,
      `${blockedReopen.status} ${JSON.stringify(stillEndorsed)}`,
    );

    const reverse = await post(`/payments/${paymentId}/delete`, {});
    ok('endorsed check payment reverse', reverse.status === 302, `${reverse.status}`);
    const restored = await one('SELECT status, supplier_id, issued_payment_id, endorsed_date FROM checks WHERE id = ?', [linkCheckId]);
    ok(
      'endorsed check returned to available',
      restored &&
        restored.status === 'available' &&
        restored.supplier_id === null &&
        restored.issued_payment_id === null &&
        restored.endorsed_date === null,
      JSON.stringify(restored),
    );
    const restoredHistory = await q('SELECT event, from_status, to_status FROM check_history WHERE check_id = ? ORDER BY id', [linkCheckId]);
    ok(
      'reversal history',
      restoredHistory.some((line) => line.event === 'reopened' && line.from_status === 'endorsed' && line.to_status === 'available'),
      JSON.stringify(restoredHistory),
    );

    const remove = await post(`/checks/${linkCheckId}/delete`, {});
    ok('linkable check delete', remove.status === 302, `${remove.status}`);
    checkIds.splice(checkIds.indexOf(linkCheckId), 1);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL uncaught', error.stack || error.message);
} finally {
  await cleanup();
  await db.end();
}

console.log(failures === 0 ? '\nAll check tests passed.' : `\n${failures} check test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
