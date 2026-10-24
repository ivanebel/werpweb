'use strict';

const { makeResourceRouter } = require('./resource');
const { query, one, withTransaction } = require('../db');
const { todayISO } = require('../lib/helpers');
const {
  STATUSES,
  ENTRY_TYPES,
  STATUS_VALUES,
  statusEvent,
  recordHistory,
} = require('../lib/checks');

function normalizeDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === raw ? raw : null;
}

function textValue(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text ? text.slice(0, maxLength) : null;
}

async function customerOptions() {
  const rows = await query(
    `SELECT id, company_name, customer_no
       FROM customers
      ORDER BY company_name`,
  );
  return rows.map((row) => ({
    value: row.id,
    label: `${row.company_name}${row.customer_no ? ` (${row.customer_no})` : ''}`,
  }));
}

async function supplierOptions() {
  const rows = await query(
    `SELECT id, company_name, supplier_no
       FROM suppliers
      ORDER BY company_name`,
  );
  return rows.map((row) => ({
    value: row.id,
    label: `${row.company_name}${row.supplier_no ? ` (${row.supplier_no})` : ''}`,
  }));
}

const fields = [
  {
    name: 'check_no',
    label: 'Check no.',
    type: 'text',
    readonly: true,
    section: 'Check',
    maxLength: 30,
    help: 'Generated automatically.',
  },
  {
    name: 'entry_type',
    label: 'Entry type',
    type: 'select',
    options: ENTRY_TYPES,
    default: 'received',
    required: true,
    section: 'Check',
    help: 'Received checks are in our portfolio. Issued checks were given to a supplier.',
  },
  { name: 'check_number', label: 'Check number', type: 'text', section: 'Check', maxLength: 60 },
  { name: 'bank_name', label: 'Bank', type: 'text', section: 'Check', maxLength: 120 },
  { name: 'drawer_name', label: 'Drawer / issuer', type: 'text', section: 'Check', maxLength: 150 },
  { name: 'amount', label: 'Amount', type: 'decimal', required: true, min: 0.01, section: 'Check' },
  { name: 'issue_date', label: 'Issue date', type: 'date', section: 'Check' },
  { name: 'due_date', label: 'Due date', type: 'date', section: 'Check' },
  { name: 'received_date', label: 'Received / given date', type: 'date', section: 'Check' },
  {
    name: 'customer_id',
    label: 'Customer',
    type: 'select',
    optionsFrom: customerOptions,
    section: 'Parties',
    help: 'The customer who gave us the check, when applicable.',
  },
  {
    name: 'supplier_id',
    label: 'Supplier / endorsee',
    type: 'select',
    optionsFrom: supplierOptions,
    section: 'Parties',
  },
  {
    name: 'status',
    label: 'Status',
    type: 'select',
    options: STATUSES,
    default: 'available',
    required: true,
    section: 'Status',
  },
  { name: 'deposited_bank', label: 'Deposited bank', type: 'text', section: 'Status', maxLength: 120 },
  { name: 'deposited_date', label: 'Deposited date', type: 'date', section: 'Status' },
  { name: 'endorsed_date', label: 'Endorsed date', type: 'date', section: 'Status' },
  { name: 'settled_date', label: 'Settled date', type: 'date', section: 'Status' },
  { name: 'notes', label: 'Notes', type: 'textarea', section: 'Notes', full: true, maxLength: 5000 },
];

function applyStatusDefaults(data) {
  const fallback = data.received_date || data.issue_date || todayISO();
  if (!data.received_date) data.received_date = data.issue_date || todayISO();
  if (!data.issue_date) data.issue_date = data.received_date || todayISO();
  if (data.entry_type === 'issued') data.customer_id = null;

  if (data.status === 'deposited' && !data.deposited_date) data.deposited_date = fallback;
  if (data.status === 'endorsed' && !data.endorsed_date) data.endorsed_date = fallback;
  if (['paid', 'rejected', 'expired'].includes(data.status) && !data.settled_date) {
    data.settled_date = fallback;
  }

  // Keep the current-state fields consistent with the selected status. The
  // previous values remain available in check_history.
  if (data.status === 'available') {
    data.supplier_id = null;
    data.deposited_bank = null;
    data.deposited_date = null;
    data.endorsed_date = null;
    data.settled_date = null;
  } else if (data.status === 'deposited') {
    if (data.entry_type === 'received') data.supplier_id = null;
    data.endorsed_date = null;
    data.settled_date = null;
  } else if (data.status === 'endorsed') {
    data.deposited_bank = null;
    data.deposited_date = null;
    data.settled_date = null;
  }
}

function validateCheck(data, t) {
  const errors = {};
  if (!STATUS_VALUES.includes(String(data.status || ''))) {
    errors.status = t('Please choose a valid status.');
  }
  if (!['received', 'issued'].includes(String(data.entry_type || ''))) {
    errors.entry_type = t('Please choose a valid entry type.');
  }
  if (data.entry_type === 'issued' && !data.supplier_id) {
    errors.supplier_id = t('Select the supplier or endorsee who received the check.');
  }
  if (data.status === 'endorsed' && !data.supplier_id) {
    errors.supplier_id = t('Select the supplier or endorsee for an endorsed check.');
  }
  if (data.entry_type === 'issued' && data.status === 'available') {
    errors.status = t('An issued check cannot stay available. Choose the status it has with the recipient.');
  }
  return errors;
}

const router = makeResourceRouter({
  key: 'checks',
  basePath: '/checks',
  title: 'Checks',
  singular: 'Check',
  table: 'checks',
  titleField: 'check_no',
  indexSubtitle: 'Track received, deposited, endorsed, paid, rejected and expired checks.',
  number: { prefix: 'CHK', year: true, pad: 4 },
  numberField: 'check_no',
  searchFields: [
    't.check_no',
    't.check_number',
    't.bank_name',
    't.drawer_name',
    't.notes',
    'c.company_name',
    's.company_name',
  ],
  filters: [
    { name: 'status', label: 'Status', options: STATUSES },
    { name: 'entry_type', label: 'Entry type', options: ENTRY_TYPES },
  ],
  orderBy: 't.issue_date DESC, t.id DESC',
  select: `t.*,
           c.company_name AS customer_name, c.customer_no,
           s.company_name AS supplier_name, s.supplier_no,
           COALESCE(c.company_name, s.company_name, t.drawer_name) AS party_name`,
  joins: `LEFT JOIN customers c ON c.id = t.customer_id
          LEFT JOIN suppliers s ON s.id = t.supplier_id`,
  counts: `
    COUNT(*) AS total_count,
    COALESCE(SUM(t.amount), 0) AS total_amount,
    COALESCE(SUM(CASE WHEN t.status = 'available' THEN 1 ELSE 0 END), 0) AS available_count,
    COALESCE(SUM(CASE WHEN t.status = 'available' THEN t.amount ELSE 0 END), 0) AS available_amount,
    COALESCE(SUM(CASE WHEN t.status = 'deposited' THEN 1 ELSE 0 END), 0) AS deposited_count,
    COALESCE(SUM(CASE WHEN t.status = 'deposited' THEN t.amount ELSE 0 END), 0) AS deposited_amount,
    COALESCE(SUM(CASE WHEN t.status = 'endorsed' THEN 1 ELSE 0 END), 0) AS endorsed_count,
    COALESCE(SUM(CASE WHEN t.status = 'endorsed' THEN t.amount ELSE 0 END), 0) AS endorsed_amount,
    COALESCE(SUM(CASE WHEN t.status IN ('available','deposited','endorsed') THEN t.amount ELSE 0 END), 0) AS open_amount
  `,
  fields,
  columns: [
    { key: 'check_no', label: 'Check no.', type: 'primary', sub: 'check_number' },
    { key: 'entry_type', label: 'Type', type: 'status' },
    { key: 'party_name', label: 'Party' },
    { key: 'bank_name', label: 'Bank' },
    { key: 'issue_date', label: 'Issue date', type: 'date' },
    { key: 'due_date', label: 'Due date', type: 'date' },
    { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  beforeCreate: async (data, req) => {
    data.created_by = req.session.user.id;
    applyStatusDefaults(data);
    return validateCheck(data, req.t);
  },
  afterCreate: async (id, data, req) => {
    await recordHistory(null, {
      checkId: id,
      event: 'created',
      fromStatus: null,
      toStatus: data.status,
      eventDate: data.received_date || data.issue_date || todayISO(),
      notes: null,
      userId: req.session.user.id,
    });
  },
  beforeUpdate: async (data, req, existing) => {
    applyStatusDefaults(data);
    const errors = validateCheck(data, req.t);
    if (existing.received_payment_id || existing.issued_payment_id) {
      if (String(data.entry_type) !== String(existing.entry_type)) {
        errors.entry_type = req.t('Reverse the linked payment before changing the check entry type.');
      }
      if (Math.abs(Number(data.amount || 0) - Number(existing.amount || 0)) > 0.005) {
        errors.amount = req.t('Reverse the linked payment before changing the check amount.');
      }
    }
    if (
      existing.received_payment_id &&
      String(data.customer_id || '') !== String(existing.customer_id || '')
    ) {
      errors.customer_id = req.t('Reverse the linked payment before changing the check customer.');
    }
    if (existing.issued_payment_id) {
      if (data.status === 'available' || data.status === 'deposited') {
        errors.status = req.t('Reverse the supplier payment before returning this check to available or deposited.');
      } else if (String(data.supplier_id || '') !== String(existing.supplier_id || '')) {
        errors.supplier_id = req.t('Reverse the supplier payment before changing the endorsee.');
      }
    }
    return errors;
  },
  afterUpdate: async (id, data, existing, req) => {
    const statusChanged = String(existing.status) !== String(data.status);
    await recordHistory(null, {
      checkId: id,
      event: statusChanged ? statusEvent(data.status) : 'updated',
      fromStatus: existing.status,
      toStatus: data.status,
      eventDate: statusChanged
        ? data.settled_date || data.endorsed_date || data.deposited_date || todayISO()
        : todayISO(),
      notes: null,
      userId: req.session.user.id,
    });
  },
  beforeDelete: async (existing, req) => {
    if (existing.received_payment_id || existing.issued_payment_id) {
      return req.t('This check is linked to a payment. Reverse the payment before deleting it.');
    }
    return null;
  },
  relatedLoader: async (row) => {
    const [history, payments] = await Promise.all([
      query(
        `SELECT h.*, u.name AS user_name
           FROM check_history h
           LEFT JOIN users u ON u.id = h.user_id
          WHERE h.check_id = ?
          ORDER BY h.created_at DESC, h.id DESC`,
        [row.id],
      ),
      row.received_payment_id || row.issued_payment_id
        ? query(
            `SELECT id, payment_no, payment_date, total_amount, direction
               FROM payments
              WHERE id IN (?, ?)
              ORDER BY payment_date DESC, id DESC`,
            [row.received_payment_id || 0, row.issued_payment_id || 0],
          )
        : Promise.resolve([]),
    ]);

    const sections = [
      {
        title: 'Check history',
        emptyText: 'No history has been recorded for this check yet.',
        columns: [
          { key: 'event', label: 'Event', type: 'status' },
          { key: 'from_status', label: 'From', type: 'status' },
          { key: 'to_status', label: 'To', type: 'status' },
          { key: 'event_date', label: 'Date', type: 'date' },
          { key: 'notes', label: 'Notes' },
          { key: 'user_name', label: 'User' },
        ],
        rows: history,
      },
    ];

    if (payments.length) {
      sections.push({
        title: 'Linked payments',
        columns: [
          { key: 'payment_no', label: 'Payment' },
          { key: 'payment_date', label: 'Date', type: 'date' },
          { key: 'total_amount', label: 'Amount', type: 'money', align: 'right' },
          { key: 'direction', label: 'Direction', type: 'status' },
        ],
        linkBase: '/payments',
        rows: payments,
      });
    }

    return sections;
  },
  showData: async (row, req) => {
    const suppliers = await supplierOptions();
    return {
      checkStatusOptions: STATUSES.map((item) => ({ ...item, label: req.t(item.label) })),
      checkSupplierOptions: suppliers,
      checkToday: todayISO(),
      checkStatusAction: `/checks/${row.id}/status`,
    };
  },
});

router.post('/:id(\\d+)/status', async (req, res, next) => {
  try {
    const check = await one('SELECT * FROM checks WHERE id = ? LIMIT 1', [req.params.id]);
    if (!check) {
      return next(Object.assign(new Error(req.t('Check not found.')), { status: 404 }));
    }

    const status = String(req.body.status || '');
    if (!STATUS_VALUES.includes(status)) {
      req.flash('error', req.t('Please choose a valid status.'));
      return res.redirect(`/checks/${check.id}`);
    }

    const statusDate = normalizeDate(req.body.status_date) || todayISO();
    const notes = textValue(req.body.status_notes, 500);
    const depositedBank = textValue(req.body.deposited_bank, 120);
    const supplierId = Number.parseInt(req.body.supplier_id, 10) || null;

    if (supplierId) {
      const supplier = await one('SELECT id FROM suppliers WHERE id = ? LIMIT 1', [supplierId]);
      if (!supplier) {
        req.flash('error', req.t('Select a valid supplier or endorsee.'));
        return res.redirect(`/checks/${check.id}`);
      }
    }

    const nextSupplierId = supplierId || check.supplier_id;
    if (status === 'endorsed' && !nextSupplierId) {
      req.flash('error', req.t('Select the supplier or endorsee for an endorsed check.'));
      return res.redirect(`/checks/${check.id}`);
    }
    if (check.entry_type === 'issued' && status === 'available') {
      req.flash('error', req.t('An issued check cannot stay available. Choose the status it has with the recipient.'));
      return res.redirect(`/checks/${check.id}`);
    }
    if (check.issued_payment_id) {
      if (status === 'available' || status === 'deposited') {
        req.flash('error', req.t('Reverse the supplier payment before returning this check to available or deposited.'));
        return res.redirect(`/checks/${check.id}`);
      }
      if (supplierId && String(supplierId) !== String(check.supplier_id || '')) {
        req.flash('error', req.t('Reverse the supplier payment before changing the endorsee.'));
        return res.redirect(`/checks/${check.id}`);
      }
    }

    const updates = { status };
    if (status === 'available') {
      updates.supplier_id = null;
      updates.deposited_bank = null;
      updates.deposited_date = null;
      updates.endorsed_date = null;
      updates.settled_date = null;
    } else if (status === 'deposited') {
      updates.deposited_date = statusDate;
      updates.deposited_bank = depositedBank;
      if (check.entry_type === 'received') updates.supplier_id = null;
      updates.endorsed_date = null;
      updates.settled_date = null;
    } else if (status === 'endorsed') {
      updates.endorsed_date = statusDate;
      updates.deposited_bank = null;
      updates.deposited_date = null;
      updates.settled_date = null;
      if (supplierId) updates.supplier_id = supplierId;
    } else if (['paid', 'rejected', 'expired'].includes(status)) {
      updates.settled_date = statusDate;
    }

    const columns = Object.keys(updates);
    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE checks SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
        [...columns.map((column) => updates[column]), check.id],
      );
      await recordHistory(conn, {
        checkId: check.id,
        event: statusEvent(status),
        fromStatus: check.status,
        toStatus: status,
        eventDate: statusDate,
        notes,
        userId: req.session.user.id,
      });
    });

    req.flash('success', 'Check status updated successfully.');
    return res.redirect(`/checks/${check.id}`);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
