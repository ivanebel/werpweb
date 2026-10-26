/**
 * Unit checks for the finance calculation helpers.
 *
 * These do not touch the database. Run with:
 *   npm run test:finance
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const finance = require('../src/lib/finance.js');

assert.equal(
  finance.netCostAmount({ amount: 121, amount_basis: 'gross', vat_rate: 21, vat_recoverable: 1 }),
  100,
  'recoverable VAT is extracted from a gross amount',
);
assert.equal(
  finance.netCostAmount({ amount: 121, amount_basis: 'gross', vat_rate: 21, vat_recoverable: 0 }),
  121,
  'non-recoverable VAT stays in the cost',
);
assert.equal(
  finance.netCostAmount({ amount: 121, amount_basis: 'net', vat_rate: 21, vat_recoverable: 1 }),
  121,
  'net amounts are not changed',
);

assert.equal(finance.monthlyFixedAmount({ amount: 1200, amount_basis: 'net', frequency: 'monthly' }), 1200);
assert.equal(finance.monthlyFixedAmount({ amount: 300, amount_basis: 'net', frequency: 'quarterly' }), 100);
assert.equal(finance.monthlyFixedAmount({ amount: 1200, amount_basis: 'net', frequency: 'annual' }), 100);
assert.equal(finance.monthlyFixedAmount({ amount: 1200, amount_basis: 'net', frequency: 'one_off' }), 0);

assert.equal(finance.periodRange('2026-02').end, '2026-02-28');
assert.equal(finance.periodRange('2028-02').end, '2028-02-29');
assert.equal(finance.shiftPeriod('2026-01', -1), '2025-12');
assert.equal(finance.shiftPeriod('2026-12', 1), '2027-01');
assert.equal(finance.normalizePeriod('not-a-month', '2026-10'), '2026-10');
assert.equal(finance.normalizePeriod('2026-11'), '2026-11');

assert.equal(finance.isFixedBehavior({ behavior: 'fixed' }), true);
assert.equal(finance.isFixedBehavior({ behavior: 'semi_variable' }), true);
assert.equal(finance.isFixedBehavior({ behavior: 'variable' }), false);
assert.equal(finance.isVariableBehavior({ behavior: 'variable' }), true);
assert.equal(finance.isVariableBehavior({ behavior: 'semi_variable' }), true);
assert.equal(finance.isVariableBehavior({ behavior: 'fixed' }), false);

console.log('All finance calculation checks passed.');
