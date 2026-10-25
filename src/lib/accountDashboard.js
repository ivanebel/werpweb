'use strict';

const { query, one } = require('../db');
const { todayISO } = require('./helpers');

const CONFIG = {
  customer: {
    partyTable: 'customers',
    partyField: 'customer_id',
    invoiceTable: 'sales_invoices',
    invoiceItemsTable: 'sales_invoice_items',
    invoiceNumberField: 'invoice_no',
    invoiceType: 'sales',
    openStatuses: ['sent', 'overdue'],
    openFallbackStatus: 'sent',
    issuedStatuses: ['sent', 'paid', 'overdue'],
    orderTable: 'sales_orders',
    orderNumberField: 'order_no',
    paymentDirection: 'customer',
    invoiceBase: '/sales',
    orderBase: '/sales-orders',
    invoiceTitle: 'Sales invoices',
    orderTitle: 'Sales orders',
    topTitle: 'Top products',
    billedLabel: 'Invoiced',
    totalLabel: 'Total sales',
    openTitle: 'Open invoices',
    balanceLabel: 'Receivable balance',
    creditLabel: 'Unapplied credit',
    partyLabel: 'Customer',
    newInvoiceHref: (id) => `/sales/new?customer_id=${id}`,
    newPaymentHref: (id) => `/payments/new?type=customer&party_id=${id}`,
    invoiceSearch: (q) => `/sales?q=${encodeURIComponent(q)}`,
    orderSearch: (q) => `/sales-orders?q=${encodeURIComponent(q)}`,
    paymentSearch: (q) => `/payments?type=customer&q=${encodeURIComponent(q)}`,
  },
  supplier: {
    partyTable: 'suppliers',
    partyField: 'supplier_id',
    invoiceTable: 'purchase_invoices',
    invoiceItemsTable: 'purchase_invoice_items',
    invoiceNumberField: 'bill_no',
    invoiceType: 'purchase',
    openStatuses: ['received', 'overdue'],
    openFallbackStatus: 'received',
    issuedStatuses: ['received', 'paid', 'overdue'],
    orderTable: 'purchase_orders',
    orderNumberField: 'order_no',
    paymentDirection: 'supplier',
    invoiceBase: '/purchases',
    orderBase: '/purchase-orders',
    invoiceTitle: 'Bills',
    orderTitle: 'Purchase orders',
    topTitle: 'Top purchased products',
    billedLabel: 'Purchases',
    totalLabel: 'Total purchases',
    openTitle: 'Open bills',
    balanceLabel: 'Payable balance',
    creditLabel: 'Advance credit',
    partyLabel: 'Supplier',
    newInvoiceHref: (id) => `/purchases/new?supplier_id=${id}`,
    newPaymentHref: (id) => `/payments/new?type=supplier&party_id=${id}`,
    invoiceSearch: (q) => `/purchases?q=${encodeURIComponent(q)}`,
    orderSearch: (q) => `/purchase-orders?q=${encodeURIComponent(q)}`,
    paymentSearch: (q) => `/payments?type=supplier&q=${encodeURIComponent(q)}`,
  },
};

function monthStartISO(offset = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
}

function moneyNumber(value) {
  const number = Number(value || 0);
  return Math.round(number * 100) / 100;
}

async function loadAccountDashboard(type, id, locale = 'en-US') {
  const cfg = CONFIG[type];
  if (!cfg) return null;

  const party = await one(`SELECT * FROM ${cfg.partyTable} WHERE id = ? LIMIT 1`, [id]);
  if (!party) return null;

  const openPlaceholders = cfg.openStatuses.map(() => '?').join(', ');
  const issuedPlaceholders = cfg.issuedStatuses.map(() => '?').join(', ');
  const chartStart = monthStartISO(-11);
  const productStart = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const today = todayISO();

  const [
    openRows,
    totalRows,
    paymentRows,
    averageRows,
    agingRows,
    openInvoices,
    recentPayments,
    recentOrders,
    topProducts,
    monthlyInvoices,
    monthlyPayments,
  ] = await Promise.all([
    query(
      `SELECT COUNT(*) AS open_count,
              COALESCE(SUM(total - amount_paid), 0) AS outstanding,
              COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < CURDATE()
                                THEN total - amount_paid ELSE 0 END), 0) AS overdue,
              COALESCE(SUM(CASE WHEN due_date IS NULL OR due_date >= CURDATE()
                                THEN total - amount_paid ELSE 0 END), 0) AS current,
              COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < CURDATE()
                                THEN 1 ELSE 0 END), 0) AS overdue_count,
              AVG(CASE WHEN due_date IS NOT NULL AND due_date < CURDATE()
                       THEN DATEDIFF(CURDATE(), due_date) END) AS avg_days_overdue
         FROM ${cfg.invoiceTable}
        WHERE ${cfg.partyField} = ?
          AND status IN (${openPlaceholders})
          AND total - amount_paid > 0.005`,
      [id, ...cfg.openStatuses],
    ),
    query(
      `SELECT COUNT(*) AS invoice_count,
              COALESCE(SUM(total), 0) AS total_invoiced,
              COALESCE(SUM(amount_paid), 0) AS total_paid,
              MIN(invoice_date) AS first_invoice_date
         FROM ${cfg.invoiceTable}
        WHERE ${cfg.partyField} = ?
          AND status IN (${issuedPlaceholders})`,
      [id, ...cfg.issuedStatuses],
    ),
    query(
      `SELECT COUNT(*) AS payment_count,
              COALESCE(SUM(total_amount), 0) AS total_payments,
              COALESCE(SUM(applied_amount), 0) AS applied_total,
              COALESCE(SUM(unapplied_amount), 0) AS unapplied_total,
              MAX(payment_date) AS last_payment_date
         FROM payments
        WHERE direction = ? AND ${cfg.partyField} = ?`,
      [cfg.paymentDirection, id],
    ),
    query(
      `SELECT AVG(days) AS avg_days
         FROM (
           SELECT pa.invoice_id,
                  MIN(GREATEST(DATEDIFF(p.payment_date, i.invoice_date), 0)) AS days
             FROM payment_allocations pa
             JOIN payments p ON p.id = pa.payment_id
             JOIN ${cfg.invoiceTable} i ON i.id = pa.invoice_id
            WHERE pa.invoice_type = ?
              AND p.direction = ?
              AND p.${cfg.partyField} = ?
            GROUP BY pa.invoice_id
         ) paid`,
      [cfg.invoiceType, cfg.paymentDirection, id],
    ),
    query(
      `SELECT bucket, COUNT(*) AS count, SUM(balance) AS amount
         FROM (
           SELECT CASE
                    WHEN due_date IS NULL OR due_date >= CURDATE() THEN 'current'
                    WHEN due_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 'd1_30'
                    WHEN due_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY) THEN 'd31_60'
                    WHEN due_date >= DATE_SUB(CURDATE(), INTERVAL 90 DAY) THEN 'd61_90'
                    ELSE 'd90_plus'
                  END AS bucket,
                  total - amount_paid AS balance
             FROM ${cfg.invoiceTable}
            WHERE ${cfg.partyField} = ?
              AND status IN (${openPlaceholders})
              AND total - amount_paid > 0.005
         ) balances
        GROUP BY bucket`,
      [id, ...cfg.openStatuses],
    ),
    query(
      `SELECT id, ${cfg.invoiceNumberField} AS invoice_no, invoice_date, due_date, status,
              total, amount_paid, total - amount_paid AS balance,
              CASE WHEN due_date IS NOT NULL AND due_date < CURDATE()
                    THEN DATEDIFF(CURDATE(), due_date) ELSE 0 END AS days_overdue
         FROM ${cfg.invoiceTable}
        WHERE ${cfg.partyField} = ?
          AND status IN (${openPlaceholders})
          AND total - amount_paid > 0.005
        ORDER BY due_date IS NULL, due_date, invoice_date, id
        LIMIT 12`,
      [id, ...cfg.openStatuses],
    ),
    query(
      `SELECT p.id, p.payment_no, p.payment_date, p.total_amount, p.applied_amount,
              p.unapplied_amount, p.reference,
              (SELECT GROUP_CONCAT(DISTINCT pm.method ORDER BY pm.method SEPARATOR ', ')
                 FROM payment_methods pm
                WHERE pm.payment_id = p.id) AS methods
         FROM payments p
        WHERE p.direction = ? AND p.${cfg.partyField} = ?
        ORDER BY p.payment_date DESC, p.id DESC
        LIMIT 8`,
      [cfg.paymentDirection, id],
    ),
    query(
      `SELECT id, ${cfg.orderNumberField} AS order_no, order_date, status, total
         FROM ${cfg.orderTable}
        WHERE ${cfg.partyField} = ?
        ORDER BY order_date DESC, id DESC
        LIMIT 6`,
      [id],
    ),
    query(
      `SELECT p.id, p.sku, p.name, SUM(ii.quantity) AS quantity, SUM(ii.line_total) AS amount
         FROM ${cfg.invoiceItemsTable} ii
         JOIN ${cfg.invoiceTable} i ON i.id = ii.invoice_id
         JOIN products p ON p.id = ii.product_id
        WHERE i.${cfg.partyField} = ?
          AND i.status IN (${issuedPlaceholders})
          AND i.invoice_date >= ?
        GROUP BY p.id, p.sku, p.name
        ORDER BY amount DESC
        LIMIT 5`,
      [id, ...cfg.issuedStatuses, productStart],
    ),
    query(
      `SELECT DATE_FORMAT(invoice_date, '%Y-%m') AS ym, COALESCE(SUM(total), 0) AS amount
         FROM ${cfg.invoiceTable}
        WHERE ${cfg.partyField} = ?
          AND status IN (${issuedPlaceholders})
          AND invoice_date >= ?
        GROUP BY ym
        ORDER BY ym`,
      [id, ...cfg.issuedStatuses, chartStart],
    ),
    query(
      `SELECT DATE_FORMAT(payment_date, '%Y-%m') AS ym, COALESCE(SUM(total_amount), 0) AS amount
         FROM payments
        WHERE direction = ? AND ${cfg.partyField} = ? AND payment_date >= ?
        GROUP BY ym
        ORDER BY ym`,
      [cfg.paymentDirection, id, chartStart],
    ),
  ]);

  const open = openRows[0] || {};
  const totals = totalRows[0] || {};
  const paymentsSummary = paymentRows[0] || {};
  const outstanding = moneyNumber(open.outstanding);
  const unappliedCredit = moneyNumber(paymentsSummary.unapplied_total);
  const netBalance = moneyNumber(outstanding - unappliedCredit);
  const overdue = moneyNumber(open.overdue);
  const current = moneyNumber(Math.max(0, outstanding - overdue));
  const totalInvoiced = moneyNumber(totals.total_invoiced);
  const totalPaid = moneyNumber(totals.total_paid);
  const creditLimit = moneyNumber(party.credit_limit);
  const creditUsed = Math.max(netBalance, 0);
  const creditAvailable = creditLimit > 0 ? moneyNumber(creditLimit - creditUsed) : null;
  const creditUsage = creditLimit > 0 ? Math.max(0, Math.min(100, (creditUsed / creditLimit) * 100)) : null;
  const paidPercent = totalInvoiced > 0 ? Math.min(100, (totalPaid / totalInvoiced) * 100) : null;
  const averageDaysToPay = averageRows[0] && averageRows[0].avg_days !== null
    ? Number(averageRows[0].avg_days)
    : null;
  const averageDaysOverdue = open.avg_days_overdue !== null && open.avg_days_overdue !== undefined
    ? Number(open.avg_days_overdue)
    : null;

  const agingKeys = [
    { key: 'current', label: 'Current' },
    { key: 'd1_30', label: '1–30 days' },
    { key: 'd31_60', label: '31–60 days' },
    { key: 'd61_90', label: '61–90 days' },
    { key: 'd90_plus', label: '90+ days' },
  ];
  const agingMap = Object.fromEntries(agingRows.map((row) => [row.bucket, row]));
  const aging = agingKeys.map((bucket) => ({
    ...bucket,
    amount: moneyNumber(agingMap[bucket.key] && agingMap[bucket.key].amount),
    count: Number((agingMap[bucket.key] && agingMap[bucket.key].count) || 0),
  }));

  const monthKeys = [];
  for (let index = -11; index <= 0; index += 1) {
    monthKeys.push(monthStartISO(index).slice(0, 7));
  }
  const invoiceMap = Object.fromEntries(monthlyInvoices.map((row) => [row.ym, Number(row.amount)]));
  const paymentMap = Object.fromEntries(monthlyPayments.map((row) => [row.ym, Number(row.amount)]));
  let monthFormatter;
  try {
    monthFormatter = new Intl.DateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  } catch {
    monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  const trend = {
    months: monthKeys.map((key) => monthFormatter.format(new Date(`${key}-01T00:00:00Z`))),
    invoices: monthKeys.map((key) => moneyNumber(invoiceMap[key])),
    payments: monthKeys.map((key) => moneyNumber(paymentMap[key])),
  };

  const openInvoiceRows = openInvoices.map((invoice) => {
    const overdueByDate = invoice.due_date && String(invoice.due_date).slice(0, 10) < today;
    return {
      ...invoice,
      display_status: overdueByDate
        ? 'overdue'
        : (invoice.status === 'overdue' ? cfg.openFallbackStatus : invoice.status),
    };
  });

  const recentPaymentRows = recentPayments.map((payment) => ({
    ...payment,
    methodLabels: payment.methods ? payment.methods.split(', ') : [],
  }));

  const meta = {
    isCustomer: type === 'customer',
    partyLabel: cfg.partyLabel,
    invoiceTitle: cfg.invoiceTitle,
    orderTitle: cfg.orderTitle,
    topTitle: cfg.topTitle,
    billedLabel: cfg.billedLabel,
    totalLabel: cfg.totalLabel,
    openTitle: cfg.openTitle,
    balanceLabel: cfg.balanceLabel,
    creditLabel: cfg.creditLabel,
    invoiceBase: cfg.invoiceBase,
    orderBase: cfg.orderBase,
    invoiceSearch: cfg.invoiceSearch(party.company_name),
    orderSearch: cfg.orderSearch(party.company_name),
    paymentSearch: cfg.paymentSearch(party.company_name),
    newInvoiceHref: cfg.newInvoiceHref(party.id),
    newPaymentHref: cfg.newPaymentHref(party.id),
  };

  return {
    party,
    partyType: type,
    meta,
    summary: {
      outstanding,
      netBalance,
      overdue,
      current,
      unappliedCredit,
      totalInvoiced,
      totalPaid,
      paidPercent,
      openCount: Number(open.open_count || 0),
      overdueCount: Number(open.overdue_count || 0),
      invoiceCount: Number(totals.invoice_count || 0),
      paymentCount: Number(paymentsSummary.payment_count || 0),
      averageDaysToPay,
      averageDaysOverdue,
      creditLimit,
      creditUsed,
      creditAvailable,
      creditUsage,
      lastPaymentDate: paymentsSummary.last_payment_date || null,
      firstInvoiceDate: totals.first_invoice_date || null,
    },
    aging,
    openInvoices: openInvoiceRows,
    recentPayments: recentPaymentRows,
    recentOrders,
    topProducts: topProducts.map((row) => ({
      ...row,
      quantity: Number(row.quantity || 0),
      amount: moneyNumber(row.amount),
    })),
    trend,
  };
}

async function renderAccountDashboard(req, res, next, type) {
  try {
    const data = await loadAccountDashboard(type, Number(req.params.id), req.locale);
    if (!data) {
      const label = type === 'customer' ? 'Customer' : 'Supplier';
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t(label) })), { status: 404 }));
    }
    const basePath = type === 'customer' ? '/customers' : '/suppliers';
    return res.render('parties/dashboard', {
      title: req.t('Account dashboard'),
      active: type === 'customer' ? 'customers' : 'suppliers',
      breadcrumbs: [
        { label: req.t(type === 'customer' ? 'Customers' : 'Suppliers'), href: basePath },
        { label: data.party.company_name, href: `${basePath}/${data.party.id}` },
        { label: req.t('Account dashboard') },
      ],
      includeApex: true,
      ...data,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  loadAccountDashboard,
  renderAccountDashboard,
};
