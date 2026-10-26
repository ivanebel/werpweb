'use strict';

const { query, one } = require('../db');
const { todayISO } = require('./helpers');
const finance = require('./finance');

const round2 = finance.round2;

const DEFAULT_SETTINGS = {
  minimum_cash_buffer: 0,
  collection_rate_current: 100,
  collection_rate_1_30: 90,
  collection_rate_31_60: 75,
  collection_rate_61_90: 50,
  collection_rate_90_plus: 25,
  collection_delay_current: 0,
  collection_delay_1_30: 15,
  collection_delay_31_60: 30,
  collection_delay_61_90: 45,
  collection_delay_90_plus: 60,
  payment_delay_days: 0,
  week_start_day: 1,
};

const AGING_BUCKETS = [
  { key: 'current', label: 'Current', min: -Infinity, max: 0 },
  { key: '1_30', label: '1-30 days', min: 1, max: 30 },
  { key: '31_60', label: '31-60 days', min: 31, max: 60 },
  { key: '61_90', label: '61-90 days', min: 61, max: 90 },
  { key: '90_plus', label: '90+ days', min: 91, max: Infinity },
];

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = parseDate(dateString);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + (Number(days) || 0));
  return isoDate(date);
}

function addMonths(dateString, months) {
  const date = parseDate(dateString);
  if (!date) return null;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + (Number(months) || 0));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return isoDate(date);
}

function startOfWeek(dateString, weekStartDay = 1) {
  const date = parseDate(dateString);
  if (!date) return null;
  const start = clamp(weekStartDay, 0, 6, 1);
  const diff = (date.getUTCDay() - start + 7) % 7;
  date.setUTCDate(date.getUTCDate() - diff);
  return isoDate(date);
}

function endOfWeek(startDate) {
  return addDays(startDate, 6);
}

function startOfMonth(dateString) {
  const date = parseDate(dateString);
  if (!date) return null;
  return `${date.toISOString().slice(0, 7)}-01`;
}

function endOfMonth(dateString) {
  const date = parseDate(startOfMonth(dateString));
  if (!date) return null;
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return isoDate(end);
}

function monthKey(dateString) {
  return String(dateString || '').slice(0, 7);
}

function monthDiff(fromMonth, toMonth) {
  const [fromYear, from] = String(fromMonth).split('-').map(Number);
  const [toYear, to] = String(toMonth).split('-').map(Number);
  if (![fromYear, from, toYear, to].every(Number.isFinite)) return 0;
  return (toYear - fromYear) * 12 + (to - from);
}

function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function daysBetween(fromDate, toDate) {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  if (!from || !to) return 0;
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

function agingBucket(dueDate, asOf) {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return AGING_BUCKETS[0];
  return AGING_BUCKETS.find((bucket) => overdue >= bucket.min && overdue <= bucket.max) || AGING_BUCKETS[AGING_BUCKETS.length - 1];
}

function parseSettings(row) {
  const source = row || {};
  return {
    minimum_cash_buffer: Math.max(0, Number(source.minimum_cash_buffer) || 0),
    collection_rate_current: clamp(source.collection_rate_current, 0, 100, DEFAULT_SETTINGS.collection_rate_current),
    collection_rate_1_30: clamp(source.collection_rate_1_30, 0, 100, DEFAULT_SETTINGS.collection_rate_1_30),
    collection_rate_31_60: clamp(source.collection_rate_31_60, 0, 100, DEFAULT_SETTINGS.collection_rate_31_60),
    collection_rate_61_90: clamp(source.collection_rate_61_90, 0, 100, DEFAULT_SETTINGS.collection_rate_61_90),
    collection_rate_90_plus: clamp(source.collection_rate_90_plus, 0, 100, DEFAULT_SETTINGS.collection_rate_90_plus),
    collection_delay_current: clamp(source.collection_delay_current, 0, 365, DEFAULT_SETTINGS.collection_delay_current),
    collection_delay_1_30: clamp(source.collection_delay_1_30, 0, 365, DEFAULT_SETTINGS.collection_delay_1_30),
    collection_delay_31_60: clamp(source.collection_delay_31_60, 0, 365, DEFAULT_SETTINGS.collection_delay_31_60),
    collection_delay_61_90: clamp(source.collection_delay_61_90, 0, 365, DEFAULT_SETTINGS.collection_delay_61_90),
    collection_delay_90_plus: clamp(source.collection_delay_90_plus, 0, 365, DEFAULT_SETTINGS.collection_delay_90_plus),
    payment_delay_days: clamp(source.payment_delay_days, 0, 365, DEFAULT_SETTINGS.payment_delay_days),
    week_start_day: clamp(source.week_start_day, 0, 6, DEFAULT_SETTINGS.week_start_day),
  };
}

async function loadSettings() {
  const row = await one('SELECT * FROM cash_flow_settings WHERE id = 1 LIMIT 1');
  return parseSettings(row);
}

async function loadAccounts() {
  return query("SELECT * FROM cash_accounts WHERE status = 'active' ORDER BY name");
}

function openingCash(accounts, asOf) {
  return round2((accounts || []).reduce((sum, account) => {
    const openingDate = account.opening_date ? String(account.opening_date).slice(0, 10) : null;
    if (openingDate && openingDate > asOf) return sum;
    return sum + (Number(account.opening_balance) || 0);
  }, 0));
}

function bankParty(row) {
  return row.customer_name || row.supplier_name || row.drawer_name || '';
}

async function loadOpenReceivables(asOf) {
  const rows = await query(
    `SELECT si.id, si.invoice_no, si.customer_id, c.company_name AS party_name,
            si.invoice_date, si.due_date, si.total, si.amount_paid,
            (si.total - si.amount_paid) AS balance,
            CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END AS sign,
            fdt.name AS document_type_name
       FROM sales_invoices si
       JOIN customers c ON c.id = si.customer_id
       LEFT JOIN fiscal_document_types fdt ON fdt.code = si.document_type_code
      WHERE si.status IN ('sent', 'overdue')
        AND si.total - si.amount_paid > 0.005
      ORDER BY COALESCE(si.due_date, DATE_ADD(si.invoice_date, INTERVAL 30 DAY)), si.invoice_date, si.id`,
  );
  const settings = await loadSettings();
  return rows.map((row) => {
    const dueDate = row.due_date ? String(row.due_date).slice(0, 10) : addDays(String(row.invoice_date).slice(0, 10), 30);
    const bucket = agingBucket(dueDate, asOf);
    const rate = settings[`collection_rate_${bucket.key}`];
    const delay = settings[`collection_delay_${bucket.key}`];
    const netAmount = round2((Number(row.balance) || 0) * (Number(row.sign) || 1));
    const expectedAmount = round2(netAmount * rate / 100);
    return {
      ...row,
      due_date: dueDate,
      bucket: bucket.key,
      bucket_label: bucket.label,
      days_overdue: Math.max(0, daysBetween(dueDate, asOf)),
      net_amount: netAmount,
      expected_rate: rate,
      expected_delay: delay,
      expected_amount: expectedAmount,
      expected_date: addDays(maxDate(dueDate, asOf), delay),
      uncollected_amount: round2(netAmount - expectedAmount),
      is_credit_note: Number(row.sign) < 0,
    };
  });
}

async function loadOpenPayables(asOf) {
  const rows = await query(
    `SELECT pi.id, pi.bill_no, pi.supplier_id, s.company_name AS party_name,
            pi.invoice_date, pi.due_date, pi.total, pi.amount_paid,
            (pi.total - pi.amount_paid) AS balance,
            CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END AS sign,
            fdt.name AS document_type_name
       FROM purchase_invoices pi
       JOIN suppliers s ON s.id = pi.supplier_id
       LEFT JOIN fiscal_document_types fdt ON fdt.code = pi.document_type_code
      WHERE pi.status IN ('received', 'overdue')
        AND pi.total - pi.amount_paid > 0.005
      ORDER BY COALESCE(pi.due_date, DATE_ADD(pi.invoice_date, INTERVAL 30 DAY)), pi.invoice_date, pi.id`,
  );
  const settings = await loadSettings();
  return rows.map((row) => {
    const dueDate = row.due_date ? String(row.due_date).slice(0, 10) : addDays(String(row.invoice_date).slice(0, 10), 30);
    const bucket = agingBucket(dueDate, asOf);
    const netAmount = round2((Number(row.balance) || 0) * (Number(row.sign) || 1));
    return {
      ...row,
      due_date: dueDate,
      bucket: bucket.key,
      bucket_label: bucket.label,
      days_overdue: Math.max(0, daysBetween(dueDate, asOf)),
      net_amount: netAmount,
      expected_rate: 100,
      expected_delay: settings.payment_delay_days,
      expected_amount: netAmount,
      expected_date: addDays(maxDate(dueDate, asOf), settings.payment_delay_days),
      is_credit_note: Number(row.sign) < 0,
    };
  });
}

async function loadChecks(asOf) {
  const rows = await query(
    `SELECT k.*, c.company_name AS customer_name, s.company_name AS supplier_name
       FROM checks k
       LEFT JOIN customers c ON c.id = k.customer_id
       LEFT JOIN suppliers s ON s.id = k.supplier_id
      WHERE k.status IN ('available', 'deposited', 'endorsed')
      ORDER BY COALESCE(k.due_date, k.issue_date, k.received_date), k.id`,
  );
  const checks = [];
  for (const row of rows) {
    let direction = null;
    if (row.entry_type === 'received' && ['available', 'deposited'].includes(row.status)) direction = 'in';
    if (row.entry_type === 'issued' && ['endorsed', 'deposited'].includes(row.status)) direction = 'out';
    if (!direction) continue;
    const baseDate = row.due_date || row.issue_date || row.received_date || asOf;
    const effectiveDate = maxDate(String(baseDate).slice(0, 10), asOf);
    checks.push({
      ...row,
      direction,
      effective_date: effectiveDate,
      party_name: bankParty(row),
      net_amount: round2(Number(row.amount) || 0),
    });
  }
  return checks;
}

async function loadCashEvents(rangeStart, rangeEnd) {
  const rows = await query(
    `SELECT e.*, a.name AS account_name
       FROM cash_events e
       LEFT JOIN cash_accounts a ON a.id = e.account_id
      WHERE e.status = 'planned'
      ORDER BY e.event_date, e.id`,
  );
  const events = [];
  for (const row of rows) {
    const step = row.recurrence === 'monthly' ? 1 : row.recurrence === 'quarterly' ? 3 : row.recurrence === 'annual' ? 12 : 0;
    const endDate = row.end_date ? String(row.end_date).slice(0, 10) : rangeEnd;
    if (!step) {
      if (String(row.event_date).slice(0, 10) <= rangeEnd) events.push({ ...row, occurrence_date: String(row.event_date).slice(0, 10) });
      continue;
    }
    let date = String(row.event_date).slice(0, 10);
    let guard = 0;
    while (date < rangeStart && guard < 240) {
      date = addMonths(date, step);
      guard += 1;
    }
    while (date <= endDate && date <= rangeEnd && guard < 480) {
      events.push({ ...row, occurrence_date: date });
      date = addMonths(date, step);
      guard += 1;
    }
  }
  return events;
}

function cashCostAmount(item) {
  const amount = Math.max(0, Number(item.amount) || 0);
  if (String(item.amount_basis) === 'gross') return round2(amount);
  const vat = Math.max(0, Number(item.vat_rate) || 0);
  return round2(amount * (1 + vat / 100));
}

function fixedCostDue(item, month) {
  const effectiveMonth = monthKey(item.effective_from);
  const diff = monthDiff(effectiveMonth, month);
  if (diff < 0) return false;
  switch (String(item.frequency)) {
    case 'monthly': return true;
    case 'quarterly': return diff % 3 === 0;
    case 'annual': return diff % 12 === 0;
    case 'one_off': return diff === 0;
    default: return true;
  }
}

function fixedCostPaymentDate(item, month) {
  if (String(item.frequency) === 'one_off') {
    return addDays(String(item.effective_from).slice(0, 10), Number(item.payment_days) || 0);
  }
  const start = `${month}-01`;
  const lastDay = Number(endOfMonth(start).slice(-2));
  const day = Math.min(lastDay, Math.max(1, Number(item.payment_day) || 1));
  const date = `${month}-${String(day).padStart(2, '0')}`;
  return addDays(date, Number(item.payment_days) || 0);
}

async function loadFixedCostFlows(rangeStart, rangeEnd) {
  const items = await finance.loadCostItems({ activeOnly: true });
  const flows = [];
  const today = todayISO();
  let month = startOfMonth(rangeStart);
  const endMonth = startOfMonth(rangeEnd);
  let guard = 0;
  while (month <= endMonth && guard < 240) {
    for (const item of items) {
      if (Number(item.is_non_cash) === 1) continue;
      if (!['fixed', 'semi_variable', 'stepped'].includes(String(item.behavior))) continue;
      if (!finance.effectiveInPeriod(item, finance.periodRange(month))) continue;
      if (!fixedCostDue(item, month)) continue;
      const amount = cashCostAmount(item);
      if (amount <= 0) continue;
      const date = fixedCostPaymentDate(item, month);
      if (!date || date < today) continue;
      flows.push({
        date,
        direction: 'out',
        category: 'fixed_costs',
        amount,
        label: item.name,
        reference: item.category_name || '',
      });
    }
    month = addMonths(month, 1);
    guard += 1;
  }
  return flows;
}

function makeWeeklyBuckets(start, count = 13) {
  const buckets = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    const end = endOfWeek(cursor);
    buckets.push({ key: cursor, start: cursor, end });
    cursor = addDays(end, 1);
  }
  return buckets;
}

function makeMonthlyBuckets(startMonth, count = 12) {
  const buckets = [];
  let cursor = `${startMonth}-01`;
  for (let index = 0; index < count; index += 1) {
    buckets.push({ key: monthKey(cursor), start: cursor, end: endOfMonth(cursor) });
    cursor = addMonths(cursor, 1);
  }
  return buckets;
}

function findBucket(buckets, date, view) {
  if (!buckets.length) return -1;
  if (date < buckets[0].start) return 0;
  if (view === 'monthly') {
    const key = monthKey(date);
    return buckets.findIndex((bucket) => bucket.key === key);
  }
  return buckets.findIndex((bucket) => date <= bucket.end);
}

function aggregateBuckets(buckets, flows, view, opening, buffer) {
  const rows = buckets.map((bucket) => ({
    ...bucket,
    in: { receivables: 0, checks: 0, events: 0, other: 0 },
    out: { payables: 0, fixed_costs: 0, checks: 0, events: 0, other: 0 },
    total_in: 0,
    total_out: 0,
    net: 0,
    opening: 0,
    closing: 0,
    below_buffer: false,
    actual: null,
    variance: null,
  }));
  let beyondIn = 0;
  let beyondOut = 0;
  for (const flow of flows) {
    const index = findBucket(buckets, flow.date, view);
    if (index < 0) {
      if (flow.direction === 'in') beyondIn = round2(beyondIn + flow.amount);
      else beyondOut = round2(beyondOut + flow.amount);
      continue;
    }
    const row = rows[index];
    if (flow.direction === 'in') {
      row.in[flow.category] = round2((row.in[flow.category] || 0) + flow.amount);
    } else {
      row.out[flow.category] = round2((row.out[flow.category] || 0) + flow.amount);
    }
  }
  let cash = opening;
  for (const row of rows) {
    row.total_in = round2(Object.values(row.in).reduce((sum, value) => sum + value, 0));
    row.total_out = round2(Object.values(row.out).reduce((sum, value) => sum + value, 0));
    row.net = round2(row.total_in - row.total_out);
    row.opening = cash;
    row.closing = round2(cash + row.net);
    row.below_buffer = row.closing < buffer;
    cash = row.closing;
  }
  return { rows, beyond_in: beyondIn, beyond_out: beyondOut };
}

function attachActuals(rows, accounts, snapshots, today) {
  if (!accounts.length) return;
  for (const row of rows) {
    const latest = new Map();
    for (const snapshot of snapshots) {
      const date = String(snapshot.snapshot_date).slice(0, 10);
      // A snapshot belongs to the period it falls in. Carrying a balance forward
      // into later periods would compare a past actual with a future forecast.
      if (date < row.start || date > row.end || date > today) continue;
      const accountId = Number(snapshot.account_id);
      const current = latest.get(accountId);
      if (!current || date >= current.date) {
        latest.set(accountId, { date, balance: Number(snapshot.balance) || 0 });
      }
    }
    const complete = accounts.every((account) => latest.has(Number(account.id)));
    if (!complete) continue;
    row.actual = round2([...latest.values()].reduce((sum, value) => sum + value.balance, 0));
    row.variance = round2(row.actual - row.closing);
  }
}

function summarize(rows, opening, buffer) {
  const lowest = rows.length ? Math.min(...rows.map((row) => row.closing)) : opening;
  const firstShortfall = rows.find((row) => row.closing < buffer) || null;
  const belowCount = rows.filter((row) => row.closing < buffer).length;
  const largestOutflow = rows.reduce((largest, row) => (!largest || row.total_out > largest.total_out ? row : largest), null);
  return {
    opening_cash: opening,
    closing_cash: rows.length ? rows[rows.length - 1].closing : opening,
    total_in: round2(rows.reduce((sum, row) => sum + row.total_in, 0)),
    total_out: round2(rows.reduce((sum, row) => sum + row.total_out, 0)),
    net: round2(rows.reduce((sum, row) => sum + row.net, 0)),
    lowest_cash: round2(lowest),
    buffer,
    funding_gap: round2(Math.max(0, buffer - lowest)),
    first_shortfall: firstShortfall,
    below_count: belowCount,
    largest_outflow: largestOutflow,
    actual_rows: rows.filter((row) => row.actual !== null).length,
  };
}

function buildAging(rows, settings) {
  const buckets = AGING_BUCKETS.map((bucket) => {
    const matching = rows.filter((row) => row.bucket === bucket.key);
    const amount = round2(matching.reduce((sum, row) => sum + row.net_amount, 0));
    const expected = round2(matching.reduce((sum, row) => sum + row.expected_amount, 0));
    return {
      ...bucket,
      amount,
      expected,
      uncollected: round2(amount - expected),
      count: matching.length,
      rate: bucket.key === 'current' ? settings.collection_rate_current
        : bucket.key === '1_30' ? settings.collection_rate_1_30
          : bucket.key === '31_60' ? settings.collection_rate_31_60
            : bucket.key === '61_90' ? settings.collection_rate_61_90
              : settings.collection_rate_90_plus,
      delay: bucket.key === 'current' ? settings.collection_delay_current
        : bucket.key === '1_30' ? settings.collection_delay_1_30
          : bucket.key === '31_60' ? settings.collection_delay_31_60
            : bucket.key === '61_90' ? settings.collection_delay_61_90
              : settings.collection_delay_90_plus,
    };
  });
  return {
    buckets,
    total: round2(buckets.reduce((sum, bucket) => sum + bucket.amount, 0)),
    expected: round2(buckets.reduce((sum, bucket) => sum + bucket.expected, 0)),
    uncollected: round2(buckets.reduce((sum, bucket) => sum + bucket.uncollected, 0)),
    overdue: round2(buckets.slice(1).reduce((sum, bucket) => sum + bucket.amount, 0)),
    count: rows.length,
  };
}

async function buildCashFlow() {
  const today = todayISO();
  const settings = await loadSettings();
  const weekStart = startOfWeek(today, settings.week_start_day);
  const weeklyBuckets = makeWeeklyBuckets(weekStart, 13);
  const monthlyBuckets = makeMonthlyBuckets(monthKey(today), 12);
  const rangeStart = weeklyBuckets[0].start < monthlyBuckets[0].start ? weeklyBuckets[0].start : monthlyBuckets[0].start;
  const weeklyEnd = weeklyBuckets[weeklyBuckets.length - 1].end;
  const monthlyEnd = monthlyBuckets[monthlyBuckets.length - 1].end;
  const rangeEnd = weeklyEnd > monthlyEnd ? weeklyEnd : monthlyEnd;

  const [accounts, receivables, payables, checks, events, fixedFlows, snapshots] = await Promise.all([
    loadAccounts(),
    loadOpenReceivables(today),
    loadOpenPayables(today),
    loadChecks(today),
    loadCashEvents(rangeStart, rangeEnd),
    loadFixedCostFlows(rangeStart, rangeEnd),
    query('SELECT * FROM cash_snapshots WHERE snapshot_date <= ? ORDER BY account_id, snapshot_date', [today]),
  ]);

  const opening = openingCash(accounts, today);
  const flows = [];
  for (const row of receivables) {
    if (row.expected_amount !== 0) {
      flows.push({
        date: row.expected_date,
        direction: 'in',
        category: 'receivables',
        amount: row.expected_amount,
        label: row.party_name,
        reference: row.invoice_no,
      });
    }
  }
  for (const row of payables) {
    flows.push({
      date: row.expected_date,
      direction: 'out',
      category: 'payables',
      amount: row.expected_amount,
      label: row.party_name,
      reference: row.bill_no,
    });
  }
  for (const check of checks) {
    flows.push({
      date: check.effective_date,
      direction: check.direction,
      category: 'checks',
      amount: check.net_amount,
      label: check.check_no,
      reference: check.party_name,
    });
  }
  for (const event of events) {
    flows.push({
      date: event.occurrence_date,
      direction: event.direction === 'inflow' ? 'in' : 'out',
      category: 'events',
      amount: round2(Number(event.amount) || 0),
      label: event.name,
      reference: event.category,
    });
  }
  flows.push(...fixedFlows);

  const weekly = aggregateBuckets(weeklyBuckets, flows, 'weekly', opening, settings.minimum_cash_buffer);
  const monthly = aggregateBuckets(monthlyBuckets, flows, 'monthly', opening, settings.minimum_cash_buffer);
  attachActuals(weekly.rows, accounts, snapshots, today);
  attachActuals(monthly.rows, accounts, snapshots, today);

  const arAging = buildAging(receivables, settings);
  const apAging = buildAging(payables, {
    ...settings,
    collection_rate_current: 100,
    collection_rate_1_30: 100,
    collection_rate_31_60: 100,
    collection_rate_61_90: 100,
    collection_rate_90_plus: 100,
    collection_delay_current: settings.payment_delay_days,
    collection_delay_1_30: settings.payment_delay_days,
    collection_delay_31_60: settings.payment_delay_days,
    collection_delay_61_90: settings.payment_delay_days,
    collection_delay_90_plus: settings.payment_delay_days,
  });

  const weeklyTotals = summarize(weekly.rows, opening, settings.minimum_cash_buffer);
  const monthlyTotals = summarize(monthly.rows, opening, settings.minimum_cash_buffer);

  const alerts = [];
  if (!accounts.length) alerts.push({ code: 'no_accounts', tone: 'warning' });
  else if (opening === 0) alerts.push({ code: 'no_opening_cash', tone: 'info' });
  if (!receivables.length) alerts.push({ code: 'no_receivables', tone: 'info' });
  if (!payables.length) alerts.push({ code: 'no_payables', tone: 'info' });
  if (weeklyTotals.first_shortfall) alerts.push({ code: 'below_buffer', tone: 'warning', period: weeklyTotals.first_shortfall.key, view: 'weekly' });
  if (monthlyTotals.first_shortfall) alerts.push({ code: 'below_buffer', tone: 'warning', period: monthlyTotals.first_shortfall.key, view: 'monthly' });
  if ([...weekly.rows, ...monthly.rows].some((row) => row.closing < 0)) alerts.push({ code: 'negative_cash', tone: 'error' });
  const ar90 = arAging.buckets.find((bucket) => bucket.key === '90_plus');
  if (arAging.total > 0 && ar90 && ar90.amount / arAging.total > 0.3) {
    alerts.push({ code: 'overdue_ar', tone: 'warning', percent: round2((ar90.amount / arAging.total) * 100) });
  }
  if (checks.length) alerts.push({ code: 'checks_due', tone: 'info', count: checks.length });
  if (events.length) alerts.push({ code: 'planned_events', tone: 'info', count: events.length });
  alerts.push({ code: 'future_sales', tone: 'info' });
  alerts.push({ code: 'non_cash_excluded', tone: 'info' });
  if (receivables.some((row) => row.is_credit_note) || payables.some((row) => row.is_credit_note)) {
    alerts.push({ code: 'credit_notes', tone: 'info' });
  }

  return {
    today,
    settings,
    accounts,
    opening_cash: opening,
    range: { start: rangeStart, end: rangeEnd },
    weekly: {
      buckets: weekly.rows,
      totals: weeklyTotals,
      beyond_in: weekly.beyond_in,
      beyond_out: weekly.beyond_out,
    },
    monthly: {
      buckets: monthly.rows,
      totals: monthlyTotals,
      beyond_in: monthly.beyond_in,
      beyond_out: monthly.beyond_out,
    },
    receivables,
    payables,
    checks,
    events,
    fixed_flows: fixedFlows,
    ar_aging: arAging,
    ap_aging: apAging,
    alerts,
    chart: {
      weekly: {
        labels: weekly.rows.map((row) => row.start),
        closing: weekly.rows.map((row) => row.closing),
        inflows: weekly.rows.map((row) => row.total_in),
        outflows: weekly.rows.map((row) => row.total_out),
      },
      monthly: {
        labels: monthly.rows.map((row) => row.key),
        closing: monthly.rows.map((row) => row.closing),
        inflows: monthly.rows.map((row) => row.total_in),
        outflows: monthly.rows.map((row) => row.total_out),
      },
    },
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  parseSettings,
  loadSettings,
  loadAccounts,
  buildCashFlow,
  cashCostAmount,
  addDays,
  addMonths,
  startOfWeek,
  makeWeeklyBuckets,
  makeMonthlyBuckets,
  findBucket,
  aggregateBuckets,
  attachActuals,
  buildAging,
};
