'use strict';

const { query } = require('../db');
const { todayISO } = require('./helpers');
const { nextNumber } = require('./sequences');

const EPSILON = 0.005;

const STATUSES = [
  { value: 'available', label: 'Available' },
  { value: 'deposited', label: 'Deposited' },
  { value: 'endorsed', label: 'Endorsed' },
  { value: 'paid', label: 'Paid' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
];

const ENTRY_TYPES = [
  { value: 'received', label: 'Received' },
  { value: 'issued', label: 'Issued / given' },
];

const STATUS_VALUES = STATUSES.map((item) => item.value);
const ENTRY_TYPE_VALUES = ENTRY_TYPES.map((item) => item.value);

const STATUS_EVENTS = {
  available: 'reopened',
  deposited: 'deposited',
  endorsed: 'endorsed',
  paid: 'paid',
  rejected: 'rejected',
  expired: 'expired',
};

function statusEvent(status) {
  return STATUS_EVENTS[status] || 'updated';
}

async function run(executor, sql, params) {
  if (executor && typeof executor.query === 'function') {
    const [rows] = await executor.query(sql, params);
    return rows;
  }
  return query(sql, params);
}

async function recordHistory(executor, {
  checkId,
  event,
  fromStatus = null,
  toStatus = null,
  eventDate = null,
  notes = null,
  userId = null,
}) {
  await run(
    executor,
    `INSERT INTO check_history (check_id, event, from_status, to_status, event_date, notes, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [checkId, event, fromStatus, toStatus, eventDate || todayISO(), notes, userId],
  );
}

async function loadAvailableChecks() {
  return query(
    `SELECT k.id, k.check_no, k.check_number, k.bank_name, k.amount, k.issue_date, k.due_date,
            k.drawer_name, k.customer_id,
            c.company_name AS customer_name, c.customer_no
       FROM checks k
       LEFT JOIN customers c ON c.id = k.customer_id
      WHERE k.status = 'available' AND k.entry_type = 'received'
      ORDER BY COALESCE(k.due_date, k.issue_date, k.created_at), k.id`,
  );
}

async function createCheckForPayment(conn, {
  direction,
  party,
  line,
  paymentDate,
  paymentId,
  paymentNo,
  userId = null,
  companyName = null,
}) {
  const isCustomer = direction === 'customer';
  const entryType = isCustomer ? 'received' : 'issued';
  const status = isCustomer ? 'available' : 'endorsed';
  const checkNo = await nextNumber({
    prefix: 'CHK',
    table: 'checks',
    column: 'check_no',
    date: paymentDate,
    conn,
  });
  const drawerName = isCustomer
    ? party.company_name
    : line.method === 'own_check'
      ? companyName
      : 'Third party';
  const issueDate = line.check_date || paymentDate;
  const receivedDate = isCustomer ? paymentDate : null;
  const endorsedDate = isCustomer ? null : paymentDate;

  const [result] = await conn.query(
    `INSERT INTO checks
       (check_no, check_number, bank_name, drawer_name, amount, entry_type, status,
        customer_id, supplier_id, issue_date, received_date, endorsed_date,
        received_payment_id, issued_payment_id, source, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'payment', ?, ?)`,
    [
      checkNo,
      line.reference,
      line.bank_name,
      drawerName,
      line.amount,
      entryType,
      status,
      isCustomer ? party.id : null,
      isCustomer ? null : party.id,
      issueDate,
      receivedDate,
      endorsedDate,
      isCustomer ? paymentId : null,
      isCustomer ? null : paymentId,
      line.notes,
      userId,
    ],
  );

  await recordHistory(conn, {
    checkId: result.insertId,
    event: 'created',
    fromStatus: null,
    toStatus: status,
    eventDate: paymentDate,
    notes: paymentNo ? `Created from payment ${paymentNo}.` : null,
    userId,
  });

  return Number(result.insertId);
}

async function linkCheckForPayment(conn, {
  checkId,
  direction,
  party,
  line,
  paymentDate,
  paymentId,
  paymentNo,
  userId = null,
  t = (value) => value,
}) {
  const [rows] = await conn.query('SELECT * FROM checks WHERE id = ? LIMIT 1 FOR UPDATE', [checkId]);
  const check = rows[0];
  if (!check || check.status !== 'available' || check.entry_type !== 'received') {
    throw Object.assign(new Error(t('The selected check is no longer available.')), { status: 422 });
  }
  if (Math.abs(Number(check.amount || 0) - Number(line.amount || 0)) > EPSILON) {
    throw Object.assign(new Error(t('The selected check amount must match the payment method amount.')), { status: 422 });
  }

  const isCustomer = direction === 'customer';
  const updates = {
    check_number: check.check_number || line.reference,
    bank_name: check.bank_name || line.bank_name,
    issue_date: check.issue_date || line.check_date || paymentDate,
  };

  if (isCustomer) {
    updates.received_payment_id = paymentId;
    updates.customer_id = check.customer_id || party.id;
    updates.received_date = check.received_date || paymentDate;
  } else {
    updates.issued_payment_id = paymentId;
    updates.status = 'endorsed';
    updates.supplier_id = party.id;
    updates.endorsed_date = paymentDate;
  }

  const columns = Object.keys(updates);
  await conn.query(
    `UPDATE checks SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
    [...columns.map((column) => updates[column]), check.id],
  );

  await recordHistory(conn, {
    checkId: check.id,
    event: isCustomer ? 'linked' : 'endorsed',
    fromStatus: check.status,
    toStatus: isCustomer ? 'available' : 'endorsed',
    eventDate: paymentDate,
    notes: isCustomer
      ? paymentNo ? `Linked to payment ${paymentNo}.` : null
      : paymentNo ? `Endorsed via payment ${paymentNo}.` : null,
    userId,
  });

  return check.id;
}

async function reversePaymentChecks(conn, paymentId, userId = null) {
  const [checks] = await conn.query(
    `SELECT *
       FROM checks
      WHERE received_payment_id = ? OR issued_payment_id = ?
      ORDER BY id
      FOR UPDATE`,
    [paymentId, paymentId],
  );

  for (const check of checks) {
    const fromStatus = check.status;
    const receivedHere = Number(check.received_payment_id) === Number(paymentId);
    const issuedHere = Number(check.issued_payment_id) === Number(paymentId);
    const otherReceived = receivedHere ? null : check.received_payment_id;
    const otherIssued = issuedHere ? null : check.issued_payment_id;
    const onlyThisPayment = !otherReceived && !otherIssued;

    // A check that was created by this payment and has not moved any further
    // is removed together with the reversed payment. Checks that have been
    // deposited, endorsed, paid, rejected or expired are kept for the audit
    // trail, but detached from the reversed payment.
    if (check.source === 'payment' && onlyThisPayment && check.status === (check.entry_type === 'issued' ? 'endorsed' : 'available')) {
      await conn.query('DELETE FROM checks WHERE id = ?', [check.id]);
      continue;
    }

    const updates = {};
    if (receivedHere) updates.received_payment_id = null;
    if (issuedHere) updates.issued_payment_id = null;

    // When an available check was endorsed through this payment, reversing
    // the payment returns the check to the available portfolio.
    if (issuedHere && check.entry_type === 'received' && check.status === 'endorsed') {
      updates.status = 'available';
      updates.supplier_id = null;
      updates.endorsed_date = null;
    }

    if (Object.keys(updates).length) {
      const columns = Object.keys(updates);
      await conn.query(
        `UPDATE checks SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
        [...columns.map((column) => updates[column]), check.id],
      );
      await recordHistory(conn, {
        checkId: check.id,
        event: updates.status === 'available' ? 'reopened' : 'unlinked',
        fromStatus,
        toStatus: updates.status || fromStatus,
        notes: `Payment reversed.`,
        userId,
      });
    } else {
      await recordHistory(conn, {
        checkId: check.id,
        event: 'unlinked',
        fromStatus,
        toStatus: fromStatus,
        notes: `Payment reversed.`,
        userId,
      });
    }
  }
}

module.exports = {
  STATUSES,
  ENTRY_TYPES,
  STATUS_VALUES,
  ENTRY_TYPE_VALUES,
  statusEvent,
  recordHistory,
  loadAvailableChecks,
  createCheckForPayment,
  linkCheckForPayment,
  reversePaymentChecks,
};
