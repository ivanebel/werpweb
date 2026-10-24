'use strict';

const express = require('express');
const { query, one, scalar, withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { pagination, toNumber, todayISO } = require('../lib/helpers');
const { translator } = require('../lib/i18n');
const {
  loadAvailableChecks,
  createCheckForPayment,
  linkCheckForPayment,
  reversePaymentChecks,
} = require('../lib/checks');
const { getSettings } = require('../lib/settings');

const router = express.Router();
const PER_PAGE = 12;
const EPSILON = 0.005;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const TYPES = {
  customer: {
    key: 'customer',
    active: 'payments-customer',
    label: 'Customer payment',
    plural: 'Customer payments',
    partyLabel: 'Customer',
    partyTable: 'customers',
    partyField: 'customer_id',
    partyNumberField: 'customer_no',
    invoiceTable: 'sales_invoices',
    invoiceType: 'sales',
    numberField: 'invoice_no',
    invoiceBase: '/sales',
    openStatuses: ['sent', 'overdue'],
    fallbackOpenStatus: 'sent',
    paidStatus: 'paid',
    prefix: 'RCP',
    adjustmentKinds: ['credit_note', 'withholding'],
    indexSubtitle: 'Track customer receipts, invoice allocations and unapplied credit.',
  },
  supplier: {
    key: 'supplier',
    active: 'payments-supplier',
    label: 'Supplier payment',
    plural: 'Supplier payments',
    partyLabel: 'Supplier',
    partyTable: 'suppliers',
    partyField: 'supplier_id',
    partyNumberField: 'supplier_no',
    invoiceTable: 'purchase_invoices',
    invoiceType: 'purchase',
    numberField: 'bill_no',
    invoiceBase: '/purchases',
    openStatuses: ['received', 'overdue'],
    fallbackOpenStatus: 'received',
    paidStatus: 'paid',
    prefix: 'PMT',
    adjustmentKinds: ['credit_note', 'debit_note'],
    indexSubtitle: 'Track supplier payments, invoice allocations and available credit.',
  },
};

const METHOD_LABELS = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  own_check: 'Own check',
  endorsed_check: 'Endorsed third-party check',
  other: 'Other',
};

const ADJUSTMENT_LABELS = {
  credit_note: 'Credit note',
  debit_note: 'Debit note',
  withholding: 'Tax withholding',
};

function localizeType(type, locale) {
  const t = translator(locale);
  const cfg = TYPES[type];
  return {
    ...cfg,
    label: t(cfg.label),
    plural: t(cfg.plural),
    partyLabel: t(cfg.partyLabel),
    indexSubtitle: t(cfg.indexSubtitle),
    newLabel: t(type === 'customer' ? 'New customer payment' : 'New supplier payment'),
    recordLabel: t(type === 'customer' ? 'Record customer payment' : 'Record supplier payment'),
  };
}

function methodOptions(locale) {
  const t = translator(locale);
  return Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label: t(label) }));
}

function adjustmentOptions(type, locale) {
  const t = translator(locale);
  return TYPES[type].adjustmentKinds.map((value) => ({ value, label: t(ADJUSTMENT_LABELS[value]) }));
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === raw ? raw : null;
}

function blankMethod() {
  return { method: 'cash', amount: '', reference: '', bank_name: '', check_date: '', notes: '', check_id: '' };
}

function emptyTotals() {
  return {
    methodTotal: 0,
    creditTotal: 0,
    debitTotal: 0,
    withholdingTotal: 0,
    sourceTotal: 0,
    appliedTotal: 0,
    unapplied: 0,
  };
}

function computeTotals(methods, adjustments, allocations) {
  const sum = (rows) => round2(rows.reduce((total, row) => total + Number(row.amount || 0), 0));
  const methodTotal = sum(methods);
  const creditTotal = sum(adjustments.filter((row) => row.kind === 'credit_note'));
  const debitTotal = sum(adjustments.filter((row) => row.kind === 'debit_note'));
  const withholdingTotal = sum(adjustments.filter((row) => row.kind === 'withholding'));
  const sourceTotal = round2(methodTotal + creditTotal + withholdingTotal);
  const appliedTotal = sum(allocations);
  const unapplied = round2(sourceTotal - appliedTotal - debitTotal);
  return {
    methodTotal,
    creditTotal,
    debitTotal,
    withholdingTotal,
    sourceTotal,
    appliedTotal,
    unapplied: Math.abs(unapplied) < EPSILON ? 0 : unapplied,
  };
}

async function loadPartyOptions(type) {
  const cfg = TYPES[type];
  return query(
    `SELECT id, company_name, ${cfg.partyNumberField} AS party_no
       FROM ${cfg.partyTable}
      ORDER BY company_name`,
  );
}

async function loadOpenInvoices(type, partyId) {
  const cfg = TYPES[type];
  const id = Number.parseInt(partyId, 10) || 0;
  if (!id) return [];
  const placeholders = cfg.openStatuses.map(() => '?').join(', ');
  const rows = await query(
    `SELECT id, ${cfg.numberField} AS invoice_no, invoice_date, due_date, status, total, amount_paid,
            ROUND(total - amount_paid, 2) AS balance
       FROM ${cfg.invoiceTable}
      WHERE ${cfg.partyField} = ?
        AND status IN (${placeholders})
        AND total - amount_paid > ?
      ORDER BY due_date IS NULL, due_date, invoice_date, id`,
    [id, ...cfg.openStatuses, EPSILON],
  );
  return rows.map((row) => ({
    ...row,
    balance: round2(Number(row.balance || 0)),
  }));
}

function parseMethodRows(body) {
  const types = asArray(body.method_type);
  const amounts = asArray(body.method_amount);
  const references = asArray(body.method_reference);
  const banks = asArray(body.method_bank);
  const dates = asArray(body.method_date);
  const notes = asArray(body.method_notes);
  const checkIds = asArray(body.method_check_id);
  const count = Math.max(
    types.length,
    amounts.length,
    references.length,
    banks.length,
    dates.length,
    notes.length,
    checkIds.length,
  );
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      method: String(types[i] || 'cash'),
      amount: amounts[i] === undefined ? '' : amounts[i],
      reference: references[i] === undefined ? '' : references[i],
      bank_name: banks[i] === undefined ? '' : banks[i],
      check_date: dates[i] === undefined ? '' : dates[i],
      notes: notes[i] === undefined ? '' : notes[i],
      check_id: checkIds[i] === undefined ? '' : checkIds[i],
    });
  }
  return rows;
}

function parseAdjustmentRows(body) {
  const kinds = asArray(body.adjustment_kind);
  const amounts = asArray(body.adjustment_amount);
  const references = asArray(body.adjustment_reference);
  const notes = asArray(body.adjustment_notes);
  const count = Math.max(kinds.length, amounts.length, references.length, notes.length);
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      kind: String(kinds[i] || 'credit_note'),
      amount: amounts[i] === undefined ? '' : amounts[i],
      reference: references[i] === undefined ? '' : references[i],
      notes: notes[i] === undefined ? '' : notes[i],
    });
  }
  return rows;
}

function validateMethods(rows, t) {
  const lines = [];
  const errors = [];
  const usedChecks = new Set();
  for (const row of rows) {
    const amount = round2(toNumber(row.amount, 0));
    const reference = textValue(row.reference, 120);
    const bankName = textValue(row.bank_name, 120);
    const checkDate = normalizeDate(row.check_date);
    const notes = textValue(row.notes, 255);
    const checkId = Number.parseInt(row.check_id, 10) || null;
    const hasDetails = Boolean(reference || bankName || row.check_date || notes);
    if (amount === 0 && !hasDetails) continue;
    if (amount <= 0) {
      errors.push(t('Enter an amount greater than zero for every payment method line.'));
      continue;
    }
    if (!METHOD_LABELS[row.method]) {
      errors.push(t('Invalid payment method.'));
      continue;
    }
    const linkableCheckId = row.method === 'endorsed_check' ? checkId : null;
    if (linkableCheckId) {
      if (usedChecks.has(linkableCheckId)) {
        errors.push(t('The same check cannot be used more than once in a payment.'));
        continue;
      }
      usedChecks.add(linkableCheckId);
    }
    lines.push({
      method: row.method,
      amount,
      reference,
      bank_name: bankName,
      check_date: checkDate,
      notes,
      check_id: linkableCheckId,
    });
  }
  return { lines, errors };
}

function validateAdjustments(rows, cfg, t) {
  const lines = [];
  const errors = [];
  for (const row of rows) {
    const amount = round2(toNumber(row.amount, 0));
    const reference = textValue(row.reference, 120);
    const notes = textValue(row.notes, 255);
    if (amount === 0 && !reference && !notes) continue;
    if (amount <= 0) {
      errors.push(t('Enter an amount greater than zero for every adjustment line.'));
      continue;
    }
    if (!cfg.adjustmentKinds.includes(row.kind)) {
      errors.push(t('This adjustment type cannot be used on this payment.'));
      continue;
    }
    lines.push({
      kind: row.kind,
      amount,
      reference,
      notes,
    });
  }
  return { lines, errors };
}

function parseAllocations(body, openInvoices, t) {
  const ids = asArray(body.invoice_id);
  const amountInput = body.invoice_amount;
  const openById = new Map(openInvoices.map((invoice) => [String(invoice.id), invoice]));
  const allocations = [];
  const seen = new Map();
  const errors = [];

  ids.forEach((rawId, index) => {
    const id = Number.parseInt(rawId, 10);
    if (!id) return;
    const invoice = openById.get(String(id));
    if (!invoice) {
      errors.push(t('One of the selected invoices is no longer open for this party.'));
      return;
    }

    let rawAmount = '';
    if (amountInput && typeof amountInput === 'object') {
      if (Object.prototype.hasOwnProperty.call(amountInput, String(id))) {
        rawAmount = amountInput[String(id)];
      } else if (Array.isArray(amountInput)) {
        rawAmount = amountInput[index];
      }
    }
    const amountWasBlank = rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === '';
    let amount = round2(toNumber(rawAmount, 0));
    if (amountWasBlank) amount = round2(invoice.balance);
    if (amount <= 0) {
      errors.push(
        amountWasBlank
          ? t('The selected invoice has no outstanding balance.')
          : t('Enter an amount greater than zero for the selected invoice.'),
      );
      return;
    }

    const existing = seen.get(String(id));
    if (existing) {
      existing.amount = round2(existing.amount + amount);
    } else {
      const allocation = { invoice_id: id, invoice_no: invoice.invoice_no, amount, invoice };
      seen.set(String(id), allocation);
      allocations.push(allocation);
    }
  });

  for (const allocation of allocations) {
    if (allocation.amount > allocation.invoice.balance + EPSILON) {
      errors.push(
        t('Invoice {invoice} only has {amount} outstanding.', {
          invoice: allocation.invoice_no,
          amount: allocation.invoice.balance.toFixed(2),
        }),
      );
    }
  }

  return { allocations, errors };
}

async function parsePaymentBody(req) {
  const t = req.t;
  const errors = {};
  const rawType = String(req.body.direction || '');
  const validType = Boolean(TYPES[rawType]);
  const type = validType ? rawType : 'customer';
  const cfg = TYPES[type];
  if (!validType) errors.direction = t('Invalid payment type.');

  const partyId = Number.parseInt(req.body.party_id, 10) || 0;
  const party = partyId
    ? await one(`SELECT id, company_name FROM ${cfg.partyTable} WHERE id = ? LIMIT 1`, [partyId])
    : null;
  if (!party) {
    errors.party_id = t('Select a {party}.', { party: t(cfg.partyLabel).toLowerCase() });
  }

  const paymentDate = normalizeDate(req.body.payment_date);
  if (!paymentDate) errors.payment_date = t('Enter a valid payment date.');
  const reference = textValue(req.body.reference, 120);
  const notes = textValue(req.body.notes, 5000);

  const openInvoices = partyId ? await loadOpenInvoices(type, partyId) : [];
  const methodRows = parseMethodRows(req.body);
  const adjustmentRows = parseAdjustmentRows(req.body);
  const methodsResult = validateMethods(methodRows, t);
  const adjustmentsResult = validateAdjustments(adjustmentRows, cfg, t);
  const allocationResult = parseAllocations(req.body, openInvoices, t);

  if (methodsResult.errors.length) errors.methods = [...new Set(methodsResult.errors)].join(' ');
  if (adjustmentsResult.errors.length) errors.adjustments = [...new Set(adjustmentsResult.errors)].join(' ');
  if (allocationResult.errors.length) errors.allocations = [...new Set(allocationResult.errors)].join(' ');

  const totals = computeTotals(methodsResult.lines, adjustmentsResult.lines, allocationResult.allocations);
  if (!methodsResult.lines.length && !adjustmentsResult.lines.length) {
    errors.sources = t('Add at least one payment method or adjustment.');
  } else if (totals.sourceTotal <= 0) {
    errors.sources = t('Payment sources must total more than zero.');
  }
  if (totals.unapplied < -EPSILON) {
    errors.total = t('Payment sources cannot be less than the amount applied to invoices and debit notes.');
  }

  const errorList = [...new Set(Object.values(errors).filter(Boolean))];
  return {
    valid: errorList.length === 0,
    type,
    cfg,
    partyId,
    party,
    paymentDate: paymentDate || todayISO(),
    reference,
    notes,
    openInvoices,
    methods: methodRows,
    adjustments: adjustmentRows,
    methodLines: methodsResult.lines,
    adjustmentLines: adjustmentsResult.lines,
    allocations: allocationResult.allocations,
    totals,
    errors,
    errorList,
    form: {
      payment_date: req.body.payment_date || todayISO(),
      reference: req.body.reference || '',
      notes: req.body.notes || '',
    },
  };
}

async function renderForm(req, res, state, status = 200) {
  const type = state.type;
  const cfg = localizeType(type, req.locale);
  const partyOptions = await loadPartyOptions(type);
  const availableChecks = type === 'supplier' ? await loadAvailableChecks() : [];
  const selected = {};
  for (const allocation of state.allocations || []) {
    selected[String(allocation.invoice_id)] = allocation.amount;
  }
  return res.status(status).render('payments/form', {
    title: cfg.newLabel,
    active: cfg.active,
    breadcrumbs: [
      { label: cfg.plural, href: `/payments?type=${type}` },
      { label: cfg.newLabel },
    ],
    paymentType: cfg,
    typeKey: type,
    partyOptions,
    availableChecks,
    partyId: state.partyId || '',
    openInvoices: state.openInvoices || [],
    selected,
    form: state.form || { payment_date: todayISO(), reference: '', notes: '' },
    methods: state.methods && state.methods.length ? state.methods : [blankMethod()],
    adjustments: state.adjustments || [],
    methodOptions: methodOptions(req.locale),
    adjustmentOptions: adjustmentOptions(type, req.locale),
    errors: state.errors || {},
    errorList: state.errorList || [],
    totals: state.totals || emptyTotals(),
    action: '/payments',
  });
}

async function applyAllocation(conn, cfg, partyId, allocation, t) {
  const [rows] = await conn.query(
    `SELECT id, ${cfg.numberField} AS invoice_no, total, amount_paid, status
       FROM ${cfg.invoiceTable}
      WHERE id = ? AND ${cfg.partyField} = ?
      FOR UPDATE`,
    [allocation.invoice_id, partyId],
  );
  if (!rows.length) {
    throw Object.assign(new Error(t('The selected invoice is no longer available.')), { status: 422 });
  }
  const invoice = rows[0];
  if (!cfg.openStatuses.includes(invoice.status)) {
    throw Object.assign(new Error(t('The selected invoice is no longer open.')), { status: 422 });
  }
  const total = round2(Number(invoice.total || 0));
  const amountPaid = round2(Number(invoice.amount_paid || 0));
  const remaining = round2(total - amountPaid);
  if (allocation.amount > remaining + EPSILON) {
    throw Object.assign(
      new Error(t('Invoice {invoice} only has {amount} outstanding.', { invoice: invoice.invoice_no, amount: remaining.toFixed(2) })),
      { status: 422 },
    );
  }
  const newPaid = round2(amountPaid + allocation.amount);
  const newStatus = newPaid >= total - EPSILON ? cfg.paidStatus : invoice.status;
  await conn.query(`UPDATE ${cfg.invoiceTable} SET amount_paid = ?, status = ? WHERE id = ?`, [
    newPaid,
    newStatus,
    invoice.id,
  ]);
  return invoice.invoice_no;
}

function invoiceOpenStatus(cfg, invoice) {
  const due = invoice.due_date ? String(invoice.due_date).slice(0, 10) : null;
  return due && due < todayISO() ? 'overdue' : cfg.fallbackOpenStatus;
}

async function revertAllocation(conn, allocation) {
  const cfg = allocation.invoice_type === 'purchase' ? TYPES.supplier : TYPES.customer;
  const [rows] = await conn.query(
    `SELECT id, total, amount_paid, status, due_date
       FROM ${cfg.invoiceTable}
      WHERE id = ?
      FOR UPDATE`,
    [allocation.invoice_id],
  );
  if (!rows.length) return;
  const invoice = rows[0];
  const newPaid = Math.max(0, round2(Number(invoice.amount_paid || 0) - Number(allocation.amount || 0)));
  let newStatus = invoice.status;
  if (invoice.status !== 'cancelled') {
    if (round2(Number(invoice.total || 0)) <= newPaid + EPSILON) {
      newStatus = cfg.paidStatus;
    } else if (invoice.status === cfg.paidStatus) {
      newStatus = invoiceOpenStatus(cfg, invoice);
    }
  }
  await conn.query(`UPDATE ${cfg.invoiceTable} SET amount_paid = ?, status = ? WHERE id = ?`, [
    newPaid,
    newStatus,
    invoice.id,
  ]);
}

async function loadPaymentDetail(id) {
  const payment = await one(
    `SELECT p.*,
            c.company_name AS customer_name, c.customer_no, c.contact_name AS customer_contact,
            c.email AS customer_email, c.phone AS customer_phone, c.address_line1 AS customer_address,
            c.city AS customer_city, c.state AS customer_state, c.postal_code AS customer_postal,
            c.tax_id AS customer_tax_id,
            s.company_name AS supplier_name, s.supplier_no, s.contact_name AS supplier_contact,
            s.email AS supplier_email, s.phone AS supplier_phone, s.address_line1 AS supplier_address,
            s.city AS supplier_city, s.state AS supplier_state, s.postal_code AS supplier_postal,
            s.tax_id AS supplier_tax_id,
            u.name AS created_by_name
       FROM payments p
       LEFT JOIN customers c ON c.id = p.customer_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = ?
      LIMIT 1`,
    [id],
  );
  if (!payment) return null;

  const [allocations, methods, adjustments, checks] = await Promise.all([
    query('SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY id', [id]),
    query('SELECT * FROM payment_methods WHERE payment_id = ? ORDER BY sort_order, id', [id]),
    query('SELECT * FROM payment_adjustments WHERE payment_id = ? ORDER BY sort_order, id', [id]),
    query(
      `SELECT k.*, COALESCE(c.company_name, s.company_name, k.drawer_name) AS party_name
         FROM checks k
         LEFT JOIN customers c ON c.id = k.customer_id
         LEFT JOIN suppliers s ON s.id = k.supplier_id
        WHERE k.received_payment_id = ? OR k.issued_payment_id = ?
        ORDER BY k.id`,
      [id, id],
    ),
  ]);

  if (payment.direction === 'customer') {
    payment.party_name = payment.customer_name;
    payment.party_no = payment.customer_no;
    payment.party_contact = payment.customer_contact;
    payment.party_email = payment.customer_email;
    payment.party_phone = payment.customer_phone;
    payment.party_address = payment.customer_address;
    payment.party_city = payment.customer_city;
    payment.party_state = payment.customer_state;
    payment.party_postal = payment.customer_postal;
    payment.party_tax_id = payment.customer_tax_id;
  } else {
    payment.party_name = payment.supplier_name;
    payment.party_no = payment.supplier_no;
    payment.party_contact = payment.supplier_contact;
    payment.party_email = payment.supplier_email;
    payment.party_phone = payment.supplier_phone;
    payment.party_address = payment.supplier_address;
    payment.party_city = payment.supplier_city;
    payment.party_state = payment.supplier_state;
    payment.party_postal = payment.supplier_postal;
    payment.party_tax_id = payment.supplier_tax_id;
  }

  return { ...payment, allocations, methods, adjustments, checks };
}

// ---------------------------------------------------------------- index
router.get('/', async (req, res, next) => {
  try {
    const type = TYPES[String(req.query.type || '')] ? String(req.query.type) : '';
    const search = String(req.query.q || '').trim();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const where = [];
    const params = [];
    if (type) {
      where.push('p.direction = ?');
      params.push(type);
    }
    if (search) {
      where.push('(p.payment_no LIKE ? OR p.reference LIKE ? OR COALESCE(c.company_name, s.company_name) LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const joins = 'FROM payments p LEFT JOIN customers c ON c.id = p.customer_id LEFT JOIN suppliers s ON s.id = p.supplier_id';
    const total = Number((await scalar(`SELECT COUNT(*) ${joins} ${whereSql}`, params)) || 0);
    const pag = pagination(total, page, PER_PAGE);
    const rows = await query(
      `SELECT p.*, COALESCE(c.company_name, s.company_name) AS party_name,
              c.customer_no, s.supplier_no
         ${joins}
         ${whereSql}
        ORDER BY p.payment_date DESC, p.id DESC
        LIMIT ? OFFSET ?`,
      [...params, PER_PAGE, (pag.page - 1) * PER_PAGE],
    );
    const stats = await one(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(p.total_amount), 0) AS total,
              COALESCE(SUM(p.applied_amount), 0) AS applied,
              COALESCE(SUM(p.unapplied_amount), 0) AS unapplied
         ${joins}
         ${whereSql}`,
      params,
    );
    const activeType = type ? localizeType(type, req.locale) : null;
    res.render('payments/index', {
      title: activeType ? activeType.plural : req.t('Payments'),
      active: activeType ? activeType.active : '',
      breadcrumbs: [{ label: req.t('Payments') }],
      selectedType: type,
      selectedTypeConfig: activeType,
      rows,
      pagination: pag,
      search,
      stats: {
        count: Number(stats.count || 0),
        total: Number(stats.total || 0),
        applied: Number(stats.applied || 0),
        unapplied: Number(stats.unapplied || 0),
        totalLabel: type === 'customer' ? req.t('Total received') : type === 'supplier' ? req.t('Total paid') : req.t('Total payments'),
      },
      basePath: '/payments',
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ new / create
router.get('/new', async (req, res, next) => {
  try {
    const requested = String(req.query.type || req.query.direction || '');
    const type = TYPES[requested] ? requested : 'customer';
    const partyQuery = type === 'customer'
      ? (req.query.customer_id || req.query.party_id)
      : (req.query.supplier_id || req.query.party_id);
    const partyId = Number.parseInt(partyQuery, 10) || 0;
    const openInvoices = partyId ? await loadOpenInvoices(type, partyId) : [];
    const allocations = [];
    const invoiceId = Number.parseInt(req.query.invoice_id, 10) || 0;
    if (invoiceId) {
      const invoice = openInvoices.find((row) => Number(row.id) === invoiceId);
      if (invoice) {
        allocations.push({
          invoice_id: invoice.id,
          invoice_no: invoice.invoice_no,
          amount: invoice.balance,
          invoice,
        });
      }
    }
    const methods = [blankMethod()];
    if (allocations.length) methods[0].amount = allocations[0].amount;
    return renderForm(req, res, {
      type,
      partyId,
      openInvoices,
      allocations,
      methods,
      adjustments: [],
      form: { payment_date: todayISO(), reference: '', notes: '' },
      totals: computeTotals(methods, [], allocations),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  let parsed = null;
  try {
    parsed = await parsePaymentBody(req);
    if (!parsed.valid) {
      return renderForm(req, res, parsed, 422);
    }

    const cfg = TYPES[parsed.type];
    const settings = await getSettings();
    const paymentId = await withTransaction(async (conn) => {
      const paymentNo = await nextNumber({
        prefix: cfg.prefix,
        table: 'payments',
        column: 'payment_no',
        date: parsed.paymentDate,
        conn,
      });
      const [result] = await conn.query(
        `INSERT INTO payments
           (payment_no, direction, ${cfg.partyField}, payment_date, reference,
            method_total, credit_total, debit_total, withholding_total, total_amount,
            applied_amount, unapplied_amount, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          paymentNo,
          parsed.type,
          parsed.partyId,
          parsed.paymentDate,
          parsed.reference,
          parsed.totals.methodTotal,
          parsed.totals.creditTotal,
          parsed.totals.debitTotal,
          parsed.totals.withholdingTotal,
          parsed.totals.sourceTotal,
          parsed.totals.appliedTotal,
          parsed.totals.unapplied,
          parsed.notes,
          req.session.user.id,
        ],
      );
      const id = Number(result.insertId);

      for (let i = 0; i < parsed.methodLines.length; i += 1) {
        const line = parsed.methodLines[i];
        await conn.query(
          `INSERT INTO payment_methods
             (payment_id, method, amount, reference, bank_name, check_date, notes, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, line.method, line.amount, line.reference, line.bank_name, line.check_date, line.notes, i],
        );

        if (line.method === 'own_check' || line.method === 'endorsed_check') {
          const linkCheckId = parsed.type === 'supplier' && line.method === 'endorsed_check' ? line.check_id : null;
          if (linkCheckId) {
            await linkCheckForPayment(conn, {
              checkId: linkCheckId,
              direction: parsed.type,
              party: parsed.party,
              line,
              paymentDate: parsed.paymentDate,
              paymentId: id,
              paymentNo,
              userId: req.session.user.id,
              t: req.t,
            });
          } else {
            await createCheckForPayment(conn, {
              direction: parsed.type,
              party: parsed.party,
              line,
              paymentDate: parsed.paymentDate,
              paymentId: id,
              paymentNo,
              userId: req.session.user.id,
              companyName: settings.company_name,
            });
          }
        }
      }
      for (let i = 0; i < parsed.adjustmentLines.length; i += 1) {
        const line = parsed.adjustmentLines[i];
        await conn.query(
          `INSERT INTO payment_adjustments
             (payment_id, kind, amount, reference, notes, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, line.kind, line.amount, line.reference, line.notes, i],
        );
      }
      for (const allocation of parsed.allocations) {
        const invoiceNo = await applyAllocation(conn, cfg, parsed.partyId, allocation, req.t);
        await conn.query(
          `INSERT INTO payment_allocations
             (payment_id, invoice_type, invoice_id, invoice_no, amount)
           VALUES (?, ?, ?, ?, ?)`,
          [id, cfg.invoiceType, allocation.invoice_id, invoiceNo, allocation.amount],
        );
      }
      return id;
    });

    req.flash(
      'success',
      parsed.type === 'customer' ? 'Customer payment recorded successfully.' : 'Supplier payment recorded successfully.',
    );
    return res.redirect(`/payments/${paymentId}`);
  } catch (err) {
    if (err.status === 422) {
      req.flash('error', err.message);
      return res.redirect(`/payments/new?type=${parsed ? parsed.type : 'customer'}`);
    }
    next(err);
  }
});

// ---------------------------------------------------------------- print
router.get('/:id(\\d+)/print', async (req, res, next) => {
  try {
    const payment = await loadPaymentDetail(req.params.id);
    if (!payment) {
      return next(Object.assign(new Error(req.t('Payment not found.')), { status: 404 }));
    }
    const cfg = localizeType(payment.direction, req.locale);
    res.render('payments/print', {
      title: payment.payment_no,
      payment,
      paymentType: cfg,
      typeKey: payment.direction,
      methodLabels: Object.fromEntries(
        Object.entries(METHOD_LABELS).map(([value, label]) => [value, req.t(label)]),
      ),
      adjustmentLabels: Object.fromEntries(
        Object.entries(ADJUSTMENT_LABELS).map(([value, label]) => [value, req.t(label)]),
      ),
    });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- show
router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const payment = await loadPaymentDetail(req.params.id);
    if (!payment) {
      return next(Object.assign(new Error(req.t('Payment not found.')), { status: 404 }));
    }
    const cfg = localizeType(payment.direction, req.locale);
    res.render('payments/show', {
      title: payment.payment_no,
      active: cfg.active,
      breadcrumbs: [
        { label: cfg.plural, href: `/payments?type=${payment.direction}` },
        { label: payment.payment_no },
      ],
      payment,
      paymentType: cfg,
      typeKey: payment.direction,
      methodLabels: Object.fromEntries(
        Object.entries(METHOD_LABELS).map(([value, label]) => [value, req.t(label)]),
      ),
      adjustmentLabels: Object.fromEntries(
        Object.entries(ADJUSTMENT_LABELS).map(([value, label]) => [value, req.t(label)]),
      ),
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- reversal
router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const payment = await one('SELECT * FROM payments WHERE id = ? LIMIT 1', [req.params.id]);
    if (!payment) {
      return next(Object.assign(new Error(req.t('Payment not found.')), { status: 404 }));
    }
    await withTransaction(async (conn) => {
      const [allocations] = await conn.query(
        'SELECT * FROM payment_allocations WHERE payment_id = ? ORDER BY id FOR UPDATE',
        [payment.id],
      );
      for (const allocation of allocations) {
        await revertAllocation(conn, allocation);
      }
      await reversePaymentChecks(conn, payment.id, req.session.user.id);
      await conn.query('DELETE FROM payments WHERE id = ?', [payment.id]);
    });
    req.flash('success', 'Payment reversed and deleted.');
    return res.redirect(`/payments?type=${payment.direction}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.TYPES = TYPES;
module.exports.METHOD_LABELS = METHOD_LABELS;
module.exports.ADJUSTMENT_LABELS = ADJUSTMENT_LABELS;
module.exports.localizeType = localizeType;
module.exports.loadPaymentDetail = loadPaymentDetail;
