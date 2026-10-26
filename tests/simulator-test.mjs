/**
 * Unit checks for the sales-simulator helpers.
 *
 * These do not touch the database. Run with:
 *   npm run test:simulator
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const simulator = require('../src/lib/simulator.js');

assert.equal(simulator.normalizeHorizon(6), 6);
assert.equal(simulator.normalizeHorizon(0), 1);
assert.equal(simulator.normalizeHorizon(99), 24);
assert.equal(simulator.normalizeHorizon('bad', 6), 6);

assert.deepEqual(
  simulator.periodsForScenario('2026-11', 3),
  ['2026-11', '2026-12', '2027-01'],
);

assert.deepEqual(simulator.parseAssumptions(null), {
  collection_days: 30,
  payment_days: 30,
  inventory_days: 30,
  starting_cash: 0,
});
assert.deepEqual(
  simulator.parseAssumptions({ collection_days: 45, payment_days: 15, inventory_days: 60, starting_cash: 5000 }),
  { collection_days: 45, payment_days: 15, inventory_days: 60, starting_cash: 5000 },
);

assert.equal(simulator.netSalePrice({ sale_price: 121, sale_vat_rate: 21 }), 100);
assert.equal(simulator.netSalePrice({ sale_price: 100, sale_vat_rate: 0 }), 100);
assert.equal(
  simulator.netProductCost({ type: 'finished_good', cost_gross_price: 100, cost_levy_rate: 10 }),
  110,
);
assert.equal(
  simulator.netProductCost({ type: 'service', cost_gross_price: 100, cost_levy_rate: 10 }),
  0,
);

assert.equal(simulator.roundOrderQuantity(6.5, 0, 1), 7);
assert.equal(simulator.roundOrderQuantity(6.5, 10, 0), 10);
assert.equal(simulator.roundOrderQuantity(6.5, 0, 5), 10);
assert.equal(simulator.roundOrderQuantity(11, 10, 5), 15);
assert.equal(simulator.roundOrderQuantity(0, 10, 5), 0);

assert.equal(simulator.subtractDays('2027-01-01', 10), '2026-12-22');

console.log('All sales-simulator checks passed.');
