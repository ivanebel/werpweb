'use strict';

const { query, one } = require('../db');
const { todayISO, formatMoney } = require('./helpers');
const { documentSign, round2 } = require('./taxes');

const CONFIG = {
  customer: {
    partyTable: 'customers',
    partyField: 'customer_id',
    invoiceTable: 'sales_invoices',
    invoiceNumberField: 'invoice_no',
    invoiceStatuses: ['sent', 'paid', 'overdue'],
    paymentDirection: 'customer',
    invoiceBase: '/sales',
    paymentBase: '/payments',
    partyLabel: 'Customer',
    invoiceLabel: 'Invoice',
    balanceLabel: 'Receivable balance',
  },
  supplier: {
    partyTable: 'suppliers',
    partyField: 'supplier_id',
    invoiceTable: 'purchase_invoices',
    invoiceNumberField: 'bill_no',
    invoiceStatuses: ['received', 'paid', 'overdue'],
    paymentDirection: 'supplier',
    invoiceBase: '/purchases',
    paymentBase: '/payments',
    partyLabel: 'Supplier',
    invoiceLabel: 'Bill',
    balanceLabel: 'Payable balance',
  },
};

function validDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime()) ? null : raw;
}

function statementRange(from, to) {
  const today = todayISO();
  const start = validDate(from) || `${today.slice(0, 7)}-01`;
  const end = validDate(to) || today;
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

async function loadAccountStatement(type, id, from, to) {
  const cfg = CONFIG[type];
  if (!cfg) return null;

  const party = await one(`SELECT * FROM ${cfg.partyTable} WHERE id = ? LIMIT 1`, [id]);
  if (!party) return null;

  const range = statementRange(from, to);
  const invoicePlaceholders = cfg.invoiceStatuses.map(() => '?').join(', ');
  const [invoices, payments] = await Promise.all([
    query(
      `SELECT i.id, i.${cfg.invoiceNumberField} AS number, i.invoice_date AS date, i.due_date,
              i.status, i.total, i.document_type_code, fdt.name AS document_type_name
         FROM ${cfg.invoiceTable} i
         LEFT JOIN fiscal_document_types fdt ON fdt.code = i.document_type_code
        WHERE i.${cfg.partyField} = ?
          AND i.invoice_date <= ?
          AND i.status IN (${invoicePlaceholders})
        ORDER BY i.invoice_date, i.id`,
      [id, range.to, ...cfg.invoiceStatuses],
    ),
    query(
      `SELECT p.id, p.payment_no AS number, p.payment_date AS date, p.reference,
              p.method_total, p.withholding_total, p.total_amount, p.applied_amount, p.unapplied_amount,
              (SELECT GROUP_CONCAT(DISTINCT pm.method ORDER BY pm.method SEPARATOR ', ')
                 FROM payment_methods pm
                WHERE pm.payment_id = p.id) AS methods
         FROM payments p
        WHERE p.direction = ? AND p.${cfg.partyField} = ? AND p.payment_date <= ?
        ORDER BY p.payment_date, p.id`,
      [cfg.paymentDirection, id, range.to],
    ),
  ]);

  const rows = [];
  for (const invoice of invoices) {
    const sign = documentSign(invoice.document_type_name);
    const signed = round2(Number(invoice.total) * sign);
    const isCredit = signed < 0;
    rows.push({
      kind: 'invoice',
      sort_order: 0,
      id: Number(invoice.id),
      date: String(invoice.date).slice(0, 10),
      due_date: invoice.due_date ? String(invoice.due_date).slice(0, 10) : null,
      status: invoice.status,
      reference: invoice.number,
      description: invoice.document_type_name || cfg.invoiceLabel,
      type_label: isCredit ? 'Credit note' : cfg.invoiceLabel,
      href: `${cfg.invoiceBase}/${invoice.id}`,
      charge: signed >= 0 ? signed : 0,
      payment: signed < 0 ? round2(-signed) : 0,
      amount: round2(Math.abs(signed)),
      is_credit: isCredit,
    });
  }

  for (const payment of payments) {
    // Credit notes applied inside a payment are already listed as separate
    // credit-note invoice rows, so only cash and withholdings reduce the balance.
    const paid = round2(Number(payment.method_total) + Number(payment.withholding_total));
    const methods = payment.methods ? String(payment.methods).replace(/,/g, ', ') : '';
    rows.push({
      kind: 'payment',
      sort_order: 1,
      id: Number(payment.id),
      date: String(payment.date).slice(0, 10),
      due_date: null,
      status: null,
      reference: payment.number,
      description: methods || payment.reference || '',
      type_label: cfg.paymentDirection === 'customer' ? 'Receipt' : 'Payment',
      href: `${cfg.paymentBase}/${payment.id}`,
      charge: 0,
      payment: paid,
      amount: paid,
      is_credit: false,
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.id - b.id;
  });

  let opening = 0;
  for (const row of rows) {
    if (row.date < range.from) opening = round2(opening + row.charge - row.payment);
  }

  let balance = opening;
  let charges = 0;
  let paidTotal = 0;
  let invoiceCount = 0;
  let paymentCount = 0;
  const periodRows = [];
  for (const row of rows) {
    if (row.date < range.from) continue;
    balance = round2(balance + row.charge - row.payment);
    charges = round2(charges + row.charge);
    paidTotal = round2(paidTotal + row.payment);
    if (row.kind === 'invoice') invoiceCount += 1;
    else paymentCount += 1;
    periodRows.push({ ...row, balance });
  }

  return {
    type,
    party,
    partyLabel: cfg.partyLabel,
    invoiceLabel: cfg.invoiceLabel,
    balanceLabel: cfg.balanceLabel,
    from: range.from,
    to: range.to,
    openingBalance: opening,
    charges,
    payments: paidTotal,
    closingBalance: balance,
    invoiceCount,
    paymentCount,
    rows: periodRows,
  };
}

async function renderAccountStatement(req, res, next, type, { print = false } = {}) {
  try {
    const data = await loadAccountStatement(type, Number(req.params.id), req.query.from, req.query.to);
    if (!data) {
      const label = type === 'customer' ? 'Customer' : 'Supplier';
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t(label) })), { status: 404 }));
    }
    const settings = await require('./settings').getSettings();
    const basePath = type === 'customer' ? '/customers' : '/suppliers';
    return res.render(print ? 'parties/statement-print' : 'parties/statement', {
      title: req.t('Account statement'),
      active: type === 'customer' ? 'customers' : 'suppliers',
      breadcrumbs: [
        { label: req.t(type === 'customer' ? 'Customers' : 'Suppliers'), href: basePath },
        { label: data.party.company_name, href: `${basePath}/${data.party.id}` },
        { label: req.t('Account statement') },
      ],
      statement: data,
      settings,
      printMode: print,
      money: (value) => formatMoney(value, settings.currency || 'USD', req.locale),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  CONFIG,
  statementRange,
  loadAccountStatement,
  renderAccountStatement,
};
