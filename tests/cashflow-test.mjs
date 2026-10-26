/**
 * Unit checks for the cash-flow forecast helpers.
 *
 * These do not touch the database. Run with:
 *   npm run test:cashflow
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cashflow = require('../src/lib/cashflow.js');

const settings = cashflow.parseSettings({
  minimum_cash_buffer: -5,
  collection_rate_current: 150,
  collection_rate_1_30: -10,
  collection_delay_current: -1,
  collection_delay_1_30: 999,
  payment_delay_days: 999,
  week_start_day: 9,
});
assert.equal(settings.minimum_cash_buffer, 0);
assert.equal(settings.collection_rate_current, 100);
assert.equal(settings.collection_rate_1_30, 0);
assert.equal(settings.collection_delay_current, 0);
assert.equal(settings.collection_delay_1_30, 365);
assert.equal(settings.payment_delay_days, 365);
assert.equal(settings.week_start_day, 6);

const defaults = cashflow.parseSettings(null);
assert.deepEqual(defaults, cashflow.DEFAULT_SETTINGS);

assert.equal(cashflow.addDays('2026-12-31', 1), '2027-01-01');
assert.equal(cashflow.addDays('2026-01-01', -1), '2025-12-31');
assert.equal(cashflow.addMonths('2026-01-31', 1), '2026-02-28');
assert.equal(cashflow.addMonths('2024-01-31', 1), '2024-02-29');
assert.equal(cashflow.addMonths('2026-12-15', 1), '2027-01-15');

assert.equal(cashflow.startOfWeek('2026-10-28', 1), '2026-10-26');
assert.equal(cashflow.startOfWeek('2026-10-25', 0), '2026-10-25');
assert.equal(cashflow.startOfWeek('2026-10-25', 1), '2026-10-19');

const weeks = cashflow.makeWeeklyBuckets('2026-10-26', 3);
assert.deepEqual(
  weeks.map((week) => [week.start, week.end]),
  [
    ['2026-10-26', '2026-11-01'],
    ['2026-11-02', '2026-11-08'],
    ['2026-11-09', '2026-11-15'],
  ],
);

const months = cashflow.makeMonthlyBuckets('2026-10', 3);
assert.deepEqual(
  months.map((month) => [month.key, month.start, month.end]),
  [
    ['2026-10', '2026-10-01', '2026-10-31'],
    ['2026-11', '2026-11-01', '2026-11-30'],
    ['2026-12', '2026-12-01', '2026-12-31'],
  ],
);

assert.equal(cashflow.findBucket(weeks, '2026-10-01', 'weekly'), 0);
assert.equal(cashflow.findBucket(weeks, '2026-11-08', 'weekly'), 1);
assert.equal(cashflow.findBucket(weeks, '2026-12-01', 'weekly'), -1);
assert.equal(cashflow.findBucket(months, '2026-11-20', 'monthly'), 1);

const flows = [
  { date: '2026-10-27', direction: 'in', category: 'receivables', amount: 100 },
  { date: '2026-10-28', direction: 'in', category: 'checks', amount: 50 },
  { date: '2026-11-03', direction: 'out', category: 'payables', amount: 70 },
  { date: '2026-12-01', direction: 'out', category: 'fixed_costs', amount: 30 },
];
const aggregated = cashflow.aggregateBuckets(weeks, flows, 'weekly', 500, 1000);
assert.equal(aggregated.rows[0].in.receivables, 100);
assert.equal(aggregated.rows[0].in.checks, 50);
assert.equal(aggregated.rows[0].total_in, 150);
assert.equal(aggregated.rows[0].closing, 650);
assert.equal(aggregated.rows[0].below_buffer, true);
assert.equal(aggregated.rows[1].out.payables, 70);
assert.equal(aggregated.rows[1].closing, 580);
assert.equal(aggregated.rows[2].closing, 580);
assert.equal(aggregated.beyond_out, 30);
assert.equal(aggregated.beyond_in, 0);

const actualRows = cashflow.aggregateBuckets(weeks, [], 'weekly', 0, 0).rows;
const accounts = [{ id: 1 }, { id: 2 }];
cashflow.attachActuals(
  actualRows,
  accounts,
  [
    { account_id: 1, snapshot_date: '2026-10-26', balance: 500 },
    { account_id: 2, snapshot_date: '2026-10-27', balance: 300 },
    { account_id: 1, snapshot_date: '2026-11-03', balance: 600 },
  ],
  '2026-11-05',
);
assert.equal(actualRows[0].actual, 800);
assert.equal(actualRows[0].variance, 800);
assert.equal(actualRows[1].actual, null);
assert.equal(actualRows[2].actual, null);

const futureRows = cashflow.aggregateBuckets(weeks, [], 'weekly', 0, 0).rows;
cashflow.attachActuals(
  futureRows,
  accounts,
  [
    { account_id: 1, snapshot_date: '2026-10-27', balance: 500 },
    { account_id: 2, snapshot_date: '2026-10-28', balance: 300 },
  ],
  '2026-10-26',
);
assert.equal(futureRows[0].actual, null);

const agingSettings = cashflow.parseSettings({ collection_rate_1_30: 90 });
const aging = cashflow.buildAging(
  [
    { bucket: 'current', net_amount: 1000, expected_amount: 1000 },
    { bucket: '1_30', net_amount: 500, expected_amount: 450 },
  ],
  agingSettings,
);
assert.equal(aging.total, 1500);
assert.equal(aging.expected, 1450);
assert.equal(aging.uncollected, 50);
assert.equal(aging.overdue, 500);
assert.equal(aging.count, 2);
assert.equal(aging.buckets.find((bucket) => bucket.key === '1_30').rate, 90);

assert.equal(cashflow.cashCostAmount({ amount: 100, amount_basis: 'net', vat_rate: 21 }), 121);
assert.equal(cashflow.cashCostAmount({ amount: 100, amount_basis: 'gross', vat_rate: 21 }), 100);
assert.equal(cashflow.cashCostAmount({ amount: 100, amount_basis: 'net', vat_rate: 0 }), 100);

console.log('All cash-flow checks passed.');
