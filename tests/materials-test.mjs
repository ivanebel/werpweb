/**
 * Unit checks for the material-class and BOM costing helpers.
 *
 * These do not touch the database. Run with:
 *   npm run test:materials
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const materials = require('../src/lib/materials.js');

const member = (overrides = {}) => ({
  product_id: 1,
  name: 'Member',
  product_sku: 'SKU-1',
  status: 'active',
  product_status: 'active',
  priority: 100,
  conversion_factor: 1,
  stock_qty: 0,
  cost_price: 10,
  cost_gross_price: 0,
  cost_levy_rate: 0,
  ...overrides,
});

// ---------------------------------------------------------------- unit costs
assert.equal(
  materials.memberUnitCost(member({ cost_gross_price: 100, cost_levy_rate: 21 })),
  121,
  'gross cost adds the levy rate',
);
assert.equal(
  materials.memberUnitCost(member({ cost_gross_price: 0, cost_price: 12.5 })),
  12.5,
  'falls back to the product cost',
);
assert.equal(
  materials.memberUnitCost(member({ cost_gross_price: 50, product_type: 'service' })),
  0,
  'services have no material cost',
);
assert.equal(
  materials.memberClassCost(member({ cost_gross_price: 100, conversion_factor: 20 })),
  5,
  'a 20 kg reel at 100 costs 5 per kg',
);

// ---------------------------------------------------------- class cost summary
const members = [
  member({ product_id: 1, name: 'Premium', priority: 10, conversion_factor: 20, cost_gross_price: 100 }),
  member({ product_id: 2, name: 'Standard', priority: 20, conversion_factor: 10, cost_gross_price: 60 }),
  member({ product_id: 3, name: 'Inactive', priority: 1, conversion_factor: 1, cost_gross_price: 1, status: 'inactive' }),
  member({ product_id: 4, name: 'Retired product', priority: 2, conversion_factor: 1, cost_gross_price: 1, product_status: 'inactive' }),
];
const summary = materials.classCostSummary(members);
assert.equal(summary.preferred.name, 'Premium', 'the lowest priority number is preferred');
assert.equal(summary.cost, 5, 'priority cost is converted to class units');
assert.equal(summary.min, 5);
assert.equal(summary.max, 6);
assert.equal(summary.priced_count, 2, 'inactive members are excluded from the range');
assert.equal(materials.classCostSummary(members, 'average').cost, 5.5);
assert.equal(materials.classCostSummary(members, 'lowest').cost, 5);
assert.equal(materials.classCostSummary(members, 'highest').cost, 6);
assert.deepEqual(materials.classCostSummary([]), {
  cost: 0, min: 0, max: 0, preferred: null, priced_count: 0,
});

// --------------------------------------------------------------- class stock
assert.equal(
  materials.classStock([
    member({ product_id: 1, stock_qty: 3, conversion_factor: 20 }),
    member({ product_id: 2, stock_qty: 10, conversion_factor: 10 }),
    member({ product_id: 3, stock_qty: 100, conversion_factor: 1, status: 'inactive' }),
  ]),
  160,
  'class stock converts member stock into class units and ignores inactive members',
);

// --------------------------------------------------------------- allocation
const stockMembers = [
  member({ product_id: 1, name: 'A', priority: 10, conversion_factor: 20, stock_qty: 2, cost_gross_price: 100 }),
  member({ product_id: 2, name: 'B', priority: 20, conversion_factor: 10, stock_qty: 10, cost_gross_price: 60 }),
  member({ product_id: 3, name: 'C', priority: 30, conversion_factor: 1, stock_qty: 0, cost_gross_price: 5 }),
];

const mixed = materials.allocateClassRequirement({ required: 50, members: stockMembers });
assert.deepEqual(
  mixed.allocations.map((row) => [row.member.name, row.class_quantity, row.quantity]),
  [['A', 40, 2], ['B', 10, 1]],
  'allocation consumes the preferred member first and mixes when needed',
);
assert.equal(mixed.allocated_class_qty, 50);
assert.equal(mixed.shortage_qty, 0);

const partial = materials.allocateClassRequirement({ required: 100, members: stockMembers });
assert.equal(partial.allocated_class_qty, 100);
assert.equal(partial.shortage_qty, 0, '140 class units cover a 100 class unit requirement');

const shortage = materials.allocateClassRequirement({ required: 200, members: stockMembers });
assert.equal(shortage.allocated_class_qty, 140);
assert.equal(shortage.shortage_qty, 60, 'shortage stays in class units');

const reserved = materials.allocateClassRequirement({
  required: 50,
  members: stockMembers,
  reservedByProduct: new Map([[1, 1], [2, 4]]),
});
assert.deepEqual(
  reserved.allocations.map((row) => [row.member.name, row.class_quantity]),
  [['A', 20], ['B', 30]],
  'reservations reduce the stock available to the current order',
);
assert.equal(reserved.allocated_class_qty, 50);

const noMix = materials.allocateClassRequirement({
  required: 30,
  members: stockMembers,
  allowMix: false,
});
assert.deepEqual(
  noMix.allocations.map((row) => [row.member.name, row.class_quantity]),
  [['A', 30]],
  'without mixing a member must cover the whole requirement',
);
assert.equal(noMix.shortage_qty, 0);

assert.equal(materials.round3(1.23456), 1.235);
assert.equal(materials.round4(1.23456), 1.2346);

console.log('All material-class checks passed.');
