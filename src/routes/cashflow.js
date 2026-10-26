'use strict';

const express = require('express');
const { query } = require('../db');
const { todayISO, formatMoney } = require('../lib/helpers');
const { makeResourceRouter } = require('./resource');
const cashflow = require('../lib/cashflow');
const { toCsv } = require('../lib/csv');

const router = express.Router();
const basePath = '/finance/cash';

const accountTypeOptions = [
  { value: 'bank', label: 'Bank' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
];
const activeOptions = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];
const directionOptions = [
  { value: 'inflow', label: 'Inflow' },
  { value: 'outflow', label: 'Outflow' },
];
const categoryOptions = [
  { value: 'sales', label: 'Sales' },
  { value: 'purchases', label: 'Purchases' },
  { value: 'payroll', label: 'Payroll' },
  { value: 'tax', label: 'Taxes' },
  { value: 'loan', label: 'Loans' },
  { value: 'capex', label: 'Capex' },
  { value: 'variable_cost', label: 'Variable costs' },
  { value: 'other_income', label: 'Other income' },
  { value: 'other', label: 'Other' },
];
const recurrenceOptions = [
  { value: 'one_off', label: 'One-off' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annual' },
];
const eventStatusOptions = [
  { value: 'planned', label: 'Planned' },
  { value: 'actual', label: 'Actual' },
];
const weekDayOptions = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

async function accountOptions() {
  const rows = await query("SELECT id, name FROM cash_accounts WHERE status = 'active' ORDER BY name");
  return rows.map((row) => ({ value: String(row.id), label: row.name }));
}

function snapshotDateError(data, req) {
  if (data.snapshot_date && data.snapshot_date > todayISO()) {
    return { snapshot_date: req.t('Snapshot date cannot be in the future.') };
  }
  return null;
}

function selectLabel(options, value, t) {
  const option = options.find((item) => String(item.value) === String(value));
  return option ? t(option.label) : value;
}

const accountRouter = makeResourceRouter({
  key: 'cash-accounts',
  basePath: `${basePath}/accounts`,
  title: 'Cash accounts',
  singular: 'Cash account',
  active: 'finance-cash',
  table: 'cash_accounts',
  titleField: 'name',
  searchFields: ['t.name', 't.bank_name', 't.account_number', 't.notes'],
  orderBy: 't.name ASC',
  fields: [
    { name: 'name', label: 'Account name', type: 'text', required: true, full: true, section: 'Cash account', maxLength: 120 },
    { name: 'type', label: 'Account type', type: 'select', options: accountTypeOptions, default: 'bank', required: true, section: 'Cash account' },
    { name: 'bank_name', label: 'Bank name', type: 'text', section: 'Cash account', maxLength: 120 },
    { name: 'account_number', label: 'Account number', type: 'text', section: 'Cash account', maxLength: 60 },
    { name: 'currency', label: 'Currency', type: 'text', default: 'USD', required: true, section: 'Cash account', maxLength: 3 },
    { name: 'opening_balance', label: 'Opening balance', type: 'decimal', default: 0, section: 'Opening balance', help: 'Cash available today for this account. The cash-flow forecast starts from the sum of active account balances.' },
    { name: 'opening_date', label: 'Opening date', type: 'date', section: 'Opening balance' },
    { name: 'status', label: 'Status', type: 'select', options: activeOptions, default: 'active', required: true, section: 'Cash account' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true, section: 'Notes', maxLength: 500 },
  ],
  columns: [
    { key: 'name', label: 'Account', type: 'primary', sub: 'bank_name' },
    { key: 'type', label: 'Type', format: (value, row, t) => selectLabel(accountTypeOptions, value, t) },
    { key: 'opening_balance', label: 'Opening balance', type: 'money', align: 'right' },
    { key: 'opening_date', label: 'Opening date', type: 'date' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
});

const eventRouter = makeResourceRouter({
  key: 'cash-events',
  basePath: `${basePath}/events`,
  title: 'Planned cash events',
  singular: 'Cash event',
  active: 'finance-cash',
  table: 'cash_events',
  titleField: 'name',
  searchFields: ['t.name', 't.notes'],
  filters: [
    { name: 'direction', label: 'Directions', options: directionOptions },
    { name: 'category', label: 'Categories', options: categoryOptions },
    { name: 'recurrence', label: 'Recurrences', options: recurrenceOptions },
    { name: 'status', label: 'Statuses', options: eventStatusOptions },
  ],
  orderBy: 't.event_date DESC, t.id DESC',
  fields: [
    { name: 'name', label: 'Event name', type: 'text', required: true, full: true, section: 'Cash event', maxLength: 180 },
    { name: 'direction', label: 'Direction', type: 'select', options: directionOptions, default: 'outflow', required: true, section: 'Cash event' },
    { name: 'category', label: 'Category', type: 'select', options: categoryOptions, default: 'other', required: true, section: 'Cash event' },
    { name: 'amount', label: 'Amount', type: 'decimal', min: 0, default: 0, required: true, section: 'Cash event' },
    { name: 'event_date', label: 'Event date', type: 'date', required: true, section: 'Schedule' },
    { name: 'recurrence', label: 'Recurrence', type: 'select', options: recurrenceOptions, default: 'one_off', required: true, section: 'Schedule' },
    { name: 'end_date', label: 'End date', type: 'date', section: 'Schedule', help: 'Optional last date for recurring events.' },
    { name: 'account_id', label: 'Cash account', type: 'select', section: 'Schedule', optionsFrom: accountOptions, help: 'Optional. Leave blank for a company-wide event.' },
    { name: 'status', label: 'Status', type: 'select', options: eventStatusOptions, default: 'planned', required: true, section: 'Status' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true, section: 'Notes', maxLength: 500 },
  ],
  columns: [
    { key: 'name', label: 'Event', type: 'primary', sub: 'notes' },
    { key: 'event_date', label: 'Date', type: 'date' },
    { key: 'direction', label: 'Direction', format: (value, row, t) => selectLabel(directionOptions, value, t) },
    { key: 'category', label: 'Category', format: (value, row, t) => selectLabel(categoryOptions, value, t) },
    { key: 'amount', label: 'Amount', type: 'money', align: 'right' },
    { key: 'recurrence', label: 'Recurrence', format: (value, row, t) => selectLabel(recurrenceOptions, value, t) },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  beforeCreate: async (data, req) => {
    data.created_by = req.session.user.id;
    return null;
  },
});

const snapshotRouter = makeResourceRouter({
  key: 'cash-snapshots',
  basePath: `${basePath}/actuals`,
  title: 'Actual cash balances',
  singular: 'Cash snapshot',
  active: 'finance-cash',
  table: 'cash_snapshots',
  titleField: 'account_name',
  searchFields: ['t.notes', 'a.name'],
  orderBy: 't.snapshot_date DESC, t.id DESC',
  select: 't.*, a.name AS account_name',
  joins: 'JOIN cash_accounts a ON a.id = t.account_id',
  filters: [{ name: 'account_id', label: 'Cash accounts', optionsFrom: accountOptions }],
  fields: [
    { name: 'account_id', label: 'Cash account', type: 'select', required: true, section: 'Snapshot', optionsFrom: accountOptions },
    { name: 'snapshot_date', label: 'Snapshot date', type: 'date', required: true, section: 'Snapshot' },
    { name: 'balance', label: 'Actual balance', type: 'decimal', required: true, section: 'Snapshot', help: 'Actual bank or cash balance at the end of the day.' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true, section: 'Notes', maxLength: 500 },
  ],
  columns: [
    { key: 'account_name', label: 'Cash account', type: 'primary', sub: 'notes' },
    { key: 'snapshot_date', label: 'Snapshot date', type: 'date' },
    { key: 'balance', label: 'Actual balance', type: 'money', align: 'right' },
  ],
  beforeCreate: async (data, req) => {
    data.created_by = req.session.user.id;
    return snapshotDateError(data, req);
  },
  beforeUpdate: async (data, req) => snapshotDateError(data, req),
});

function moneyFor(req, res) {
  const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
  return (value) => formatMoney(value, currency, req.locale);
}

function formatDay(locale, value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function formatMonth(locale, value) {
  const date = new Date(`${String(value).slice(0, 7)}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function periodLabelsFor(view, buckets, locale) {
  const labels = {};
  for (const bucket of buckets) {
    labels[bucket.key] = view === 'weekly'
      ? `${formatDay(locale, bucket.start)} – ${formatDay(locale, bucket.end)}`
      : formatMonth(locale, bucket.key);
  }
  return labels;
}

function cashAlerts(result, selected, view, periodLabels, req, res) {
  const t = req.t;
  const money = moneyFor(req, res);
  const alerts = [];
  for (const alert of result.alerts) {
    if (alert.code === 'below_buffer' && alert.view !== view) continue;
    switch (alert.code) {
      case 'no_accounts':
        alerts.push({
          tone: 'warning',
          title: t('No active cash accounts'),
          message: t('Add at least one cash account with its opening balance so the forecast has a starting point.'),
          href: `${basePath}/accounts/new`,
          action: t('Add cash account'),
        });
        break;
      case 'no_opening_cash':
        alerts.push({
          tone: 'info',
          title: t('Opening cash is zero'),
          message: t('Set the opening balance on your active cash accounts for a meaningful forecast.'),
          href: `${basePath}/accounts`,
          action: t('Cash accounts'),
        });
        break;
      case 'no_receivables':
        alerts.push({
          tone: 'info',
          title: t('No open receivables'),
          message: t('There are no sent or overdue sales invoices with an outstanding balance.'),
          href: '/sales',
          action: t('Open sales invoices'),
        });
        break;
      case 'no_payables':
        alerts.push({
          tone: 'info',
          title: t('No open payables'),
          message: t('There are no received or overdue purchase invoices with an outstanding balance.'),
          href: '/purchases',
          action: t('Open purchase invoices'),
        });
        break;
      case 'below_buffer': {
        const bucket = selected.buckets.find((row) => row.key === alert.period);
        alerts.push({
          tone: 'warning',
          title: t('Cash falls below the minimum buffer'),
          message: t('The forecast falls below the buffer in {period} by {amount}.', {
            period: periodLabels[alert.period] || alert.period,
            amount: money(Math.max(0, result.settings.minimum_cash_buffer - (bucket ? bucket.closing : 0))),
          }),
        });
        break;
      }
      case 'negative_cash':
        alerts.push({
          tone: 'error',
          title: t('Projected negative cash'),
          message: t('At least one period has a negative closing balance. Review collections, supplier payments and planned events.'),
        });
        break;
      case 'overdue_ar':
        alerts.push({
          tone: 'warning',
          title: t('Overdue receivables concentration'),
          message: t('{percent}% of open receivables are more than 90 days overdue.', { percent: alert.percent }),
          href: '/sales?status=overdue',
          action: t('Review receivables'),
        });
        break;
      case 'checks_due':
        alerts.push({
          tone: 'info',
          title: t('Open checks included'),
          message: t('{count} open checks are scheduled by their due date.', { count: alert.count }),
          href: '/checks',
          action: t('Open checks'),
        });
        break;
      case 'planned_events':
        alerts.push({
          tone: 'info',
          title: t('Planned cash events included'),
          message: t('{count} planned occurrences are included in the forecast.', { count: alert.count }),
          href: `${basePath}/events`,
          action: t('Planned cash events'),
        });
        break;
      case 'future_sales':
        alerts.push({
          tone: 'info',
          title: t('Future sales are not forecast automatically'),
          message: t('Open invoices and planned events are included. Add planned cash events for expected future receipts, or use the sales simulator for what-if planning.'),
          href: '/finance/simulator',
          action: t('Sales simulator'),
        });
        break;
      case 'non_cash_excluded':
        alerts.push({
          tone: 'info',
          title: t('Non-cash costs excluded'),
          message: t('Depreciation and other non-cash fixed costs are excluded from the cash forecast.'),
        });
        break;
      case 'credit_notes':
        alerts.push({
          tone: 'info',
          title: t('Credit notes are netted'),
          message: t('Open credit notes reduce receivables or payables at their due date.'),
        });
        break;
      default:
        break;
    }
  }
  return alerts;
}

router.get('/', async (req, res, next) => {
  try {
    const view = req.query.view === 'monthly' ? 'monthly' : 'weekly';
    const result = await cashflow.buildCashFlow();
    const selected = result[view];
    const periodLabels = periodLabelsFor(view, selected.buckets, req.locale);
    const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
    const money = (value) => formatMoney(value, currency, req.locale);
    res.render('finance/cash/index', {
      title: req.t('Cash flow'),
      active: 'finance-cash',
      breadcrumbs: [{ label: req.t('Cash flow') }],
      view,
      result,
      selected,
      periodLabels,
      chartLabels: selected.buckets.map((bucket) => periodLabels[bucket.key]),
      alerts: cashAlerts(result, selected, view, periodLabels, req, res),
      money,
      currency,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/settings', async (req, res, next) => {
  try {
    const settings = await cashflow.loadSettings();
    const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
    res.render('finance/cash/settings', {
      title: req.t('Cash flow settings'),
      active: 'finance-cash',
      breadcrumbs: [
        { label: req.t('Cash flow'), href: basePath },
        { label: req.t('Settings') },
      ],
      values: settings,
      errors: [],
      weekDays: weekDayOptions,
      money: (value) => formatMoney(value, currency, req.locale),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings', async (req, res, next) => {
  try {
    const current = await cashflow.loadSettings();
    const values = {
      minimum_cash_buffer: req.body.minimum_cash_buffer,
      collection_rate_current: req.body.collection_rate_current,
      collection_rate_1_30: req.body.collection_rate_1_30,
      collection_rate_31_60: req.body.collection_rate_31_60,
      collection_rate_61_90: req.body.collection_rate_61_90,
      collection_rate_90_plus: req.body.collection_rate_90_plus,
      collection_delay_current: req.body.collection_delay_current,
      collection_delay_1_30: req.body.collection_delay_1_30,
      collection_delay_31_60: req.body.collection_delay_31_60,
      collection_delay_61_90: req.body.collection_delay_61_90,
      collection_delay_90_plus: req.body.collection_delay_90_plus,
      payment_delay_days: req.body.payment_delay_days,
      week_start_day: req.body.week_start_day,
    };
    const errors = [];
    const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';
    const addError = (message) => {
      if (!errors.includes(message)) errors.push(message);
    };
    const buffer = Number(values.minimum_cash_buffer);
    if (isBlank(values.minimum_cash_buffer) || !Number.isFinite(buffer) || buffer < 0) {
      addError(req.t('The minimum cash buffer must be zero or more.'));
    }
    for (const key of ['collection_rate_current', 'collection_rate_1_30', 'collection_rate_31_60', 'collection_rate_61_90', 'collection_rate_90_plus']) {
      const rate = Number(values[key]);
      if (isBlank(values[key]) || !Number.isFinite(rate) || rate < 0 || rate > 100) {
        addError(req.t('Collection rates must be between 0 and 100.'));
      }
    }
    for (const key of ['collection_delay_current', 'collection_delay_1_30', 'collection_delay_31_60', 'collection_delay_61_90', 'collection_delay_90_plus', 'payment_delay_days']) {
      const delay = Number(values[key]);
      if (isBlank(values[key]) || !Number.isFinite(delay) || delay < 0 || delay > 365) {
        addError(req.t('Collection and payment delays must be between 0 and 365 days.'));
      }
    }
    const weekStart = Number(values.week_start_day);
    if (isBlank(values.week_start_day) || !Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) {
      addError(req.t('Select a valid week start day.'));
    }

    if (errors.length) {
      const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
      return res.status(422).render('finance/cash/settings', {
        title: req.t('Cash flow settings'),
        active: 'finance-cash',
        breadcrumbs: [
          { label: req.t('Cash flow'), href: basePath },
          { label: req.t('Settings') },
        ],
        values: { ...current, ...values },
        errors,
        weekDays: weekDayOptions,
        money: (value) => formatMoney(value, currency, req.locale),
      });
    }

    await query(
      `INSERT INTO cash_flow_settings
         (id, minimum_cash_buffer, collection_rate_current, collection_rate_1_30, collection_rate_31_60,
          collection_rate_61_90, collection_rate_90_plus, collection_delay_current, collection_delay_1_30,
          collection_delay_31_60, collection_delay_61_90, collection_delay_90_plus, payment_delay_days,
          week_start_day, updated_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         minimum_cash_buffer = VALUES(minimum_cash_buffer),
         collection_rate_current = VALUES(collection_rate_current),
         collection_rate_1_30 = VALUES(collection_rate_1_30),
         collection_rate_31_60 = VALUES(collection_rate_31_60),
         collection_rate_61_90 = VALUES(collection_rate_61_90),
         collection_rate_90_plus = VALUES(collection_rate_90_plus),
         collection_delay_current = VALUES(collection_delay_current),
         collection_delay_1_30 = VALUES(collection_delay_1_30),
         collection_delay_31_60 = VALUES(collection_delay_31_60),
         collection_delay_61_90 = VALUES(collection_delay_61_90),
         collection_delay_90_plus = VALUES(collection_delay_90_plus),
         payment_delay_days = VALUES(payment_delay_days),
         week_start_day = VALUES(week_start_day),
         updated_by = VALUES(updated_by)`,
      [
        buffer,
        Number(values.collection_rate_current),
        Number(values.collection_rate_1_30),
        Number(values.collection_rate_31_60),
        Number(values.collection_rate_61_90),
        Number(values.collection_rate_90_plus),
        Number(values.collection_delay_current),
        Number(values.collection_delay_1_30),
        Number(values.collection_delay_31_60),
        Number(values.collection_delay_61_90),
        Number(values.collection_delay_90_plus),
        Number(values.payment_delay_days),
        weekStart,
        req.session.user.id,
      ],
    );
    req.flash('success', 'Cash flow settings saved.');
    res.redirect(basePath);
  } catch (err) {
    next(err);
  }
});

router.get('/export', async (req, res, next) => {
  try {
    const view = req.query.view === 'monthly' ? 'monthly' : 'weekly';
    const result = await cashflow.buildCashFlow();
    const selected = result[view];
    const labels = periodLabelsFor(view, selected.buckets, req.locale);
    const header = [
      'Period', 'Opening cash', 'Receivables', 'Checks in', 'Planned in', 'Other in', 'Total in',
      'Payables', 'Fixed costs', 'Checks out', 'Planned out', 'Other out', 'Total out',
      'Net cash', 'Closing cash', 'Minimum buffer', 'Below buffer', 'Actual cash', 'Variance',
    ];
    const rows = selected.buckets.map((bucket) => [
      labels[bucket.key],
      bucket.opening,
      bucket.in.receivables,
      bucket.in.checks,
      bucket.in.events,
      bucket.in.other,
      bucket.total_in,
      bucket.out.payables,
      bucket.out.fixed_costs,
      bucket.out.checks,
      bucket.out.events,
      bucket.out.other,
      bucket.total_out,
      bucket.net,
      bucket.closing,
      result.settings.minimum_cash_buffer,
      bucket.below_buffer ? 'Yes' : 'No',
      bucket.actual === null ? '' : bucket.actual,
      bucket.variance === null ? '' : bucket.variance,
    ]);
    const csv = `\uFEFF${toCsv(header, rows)}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cash-flow-${view}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.use('/accounts', accountRouter);
router.use('/events', eventRouter);
router.use('/actuals', snapshotRouter);

module.exports = router;
