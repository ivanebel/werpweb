/**
 * Unit checks for the tax-reporting helpers.
 *
 * These do not touch the database. Run with:
 *   npm run test:taxes
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const taxes = require('../src/lib/taxes.js');

assert.deepEqual(taxes.monthRange('2026-10-15', 0), { from: '2026-10-01', to: '2026-10-31' });
assert.deepEqual(taxes.monthRange('2026-01-15', -1), { from: '2025-12-01', to: '2025-12-31' });
assert.deepEqual(taxes.monthRange('2024-02-10', 0), { from: '2024-02-01', to: '2024-02-29' });
assert.deepEqual(taxes.normalizeRange('2026-11-01', '2026-10-01'), {
  from: '2026-10-01',
  to: '2026-11-01',
});
assert.deepEqual(taxes.normalizeRange('bad', 'bad'), taxes.monthRange(undefined, 0));

assert.equal(taxes.documentSign('FACTURA A'), 1);
assert.equal(taxes.documentSign('NOTA DE DEBITO A'), 1);
assert.equal(taxes.documentSign('NOTA DE CREDITO A'), -1);
assert.equal(taxes.documentSign(null), 1);
assert.equal(taxes.isCreditNote('NOTA DE CREDITO B'), true);

const simple = taxes.invoiceTax(
  { subtotal: 1210, discount_total: 0, tax_total: 210, total: 1210, document_type_name: 'FACTURA A' },
  [{ tax_rate: 21, line_total: 1210 }],
);
assert.equal(simple.gross, 1210);
assert.equal(simple.net, 1000);
assert.equal(simple.vat, 210);
assert.deepEqual(simple.by_rate, [{ rate: 21, base: 1000, vat: 210 }]);

const discounted = taxes.invoiceTax(
  { subtotal: 1210, discount_total: 121, tax_total: 210, total: 1089, document_type_name: 'FACTURA A' },
  [{ tax_rate: 21, line_total: 1210 }],
);
assert.equal(discounted.gross, 1089);
assert.equal(discounted.net, 900);
assert.equal(discounted.vat, 189);
assert.deepEqual(discounted.by_rate, [{ rate: 21, base: 900, vat: 189 }]);

const credit = taxes.invoiceTax(
  { subtotal: 1210, discount_total: 0, tax_total: 210, total: 1210, document_type_name: 'NOTA DE CREDITO A' },
  [{ tax_rate: 21, line_total: 1210 }],
);
assert.equal(credit.sign, -1);
assert.equal(credit.gross, -1210);
assert.equal(credit.net, -1000);
assert.equal(credit.vat, -210);
assert.deepEqual(credit.by_rate, [{ rate: 21, base: -1000, vat: -210 }]);

const mixed = taxes.invoiceTax(
  {
    subtotal: 2815,
    discount_total: 0,
    tax_total: 315,
    total: 2815,
    document_type_name: 'FACTURA A',
  },
  [
    { tax_rate: 21, line_total: 1210 },
    { tax_rate: 10.5, line_total: 1105 },
    { tax_rate: 0, line_total: 500 },
  ],
);
assert.equal(mixed.gross, 2815);
assert.equal(mixed.net, 2500);
assert.equal(mixed.vat, 315);
assert.deepEqual(mixed.by_rate, [
  { rate: 0, base: 500, vat: 0 },
  { rate: 10.5, base: 1000, vat: 105 },
  { rate: 21, base: 1000, vat: 210 },
]);

const vatByRate = taxes.buildVatByRate(
  [{ by_rate: [{ rate: 21, base: 1000, vat: 210 }] }],
  [{ by_rate: [{ rate: 21, base: 500, vat: 105 }] }],
);
assert.deepEqual(vatByRate, [{
  rate: 21,
  sales_base: 1000,
  sales_vat: 210,
  purchase_base: 500,
  purchase_vat: 105,
  net_vat: 105,
}]);

const iibbRows = taxes.buildIibbRows({
  grossSales: 10000,
  defaultJurisdiction: { id: 1, code: 'CABA', name: 'CABA', iibb_rate: 3.5 },
  jurisdictions: [
    { id: 1, code: 'CABA', name: 'CABA', sales_share: 60, iibb_rate: 3.5, status: 'active' },
    { id: 2, code: 'BA', name: 'Buenos Aires', sales_share: 40, iibb_rate: 2, status: 'active' },
  ],
  perceptions: new Map([[1, 100], [2, 50]]),
  withholdings: new Map([[1, 200], [null, 30]]),
});
assert.equal(iibbRows.length, 3);
assert.equal(iibbRows[0].is_default, true);
assert.equal(iibbRows[0].sales_base, 6000);
assert.equal(iibbRows[0].calculated, 210);
assert.equal(iibbRows[0].perceptions, 100);
assert.equal(iibbRows[0].withholdings, 200);
assert.equal(iibbRows[0].net, -90);
assert.equal(iibbRows[1].name, 'Buenos Aires');
assert.equal(iibbRows[1].sales_base, 4000);
assert.equal(iibbRows[1].calculated, 80);
assert.equal(iibbRows[1].net, 30);
assert.equal(iibbRows[2].unassigned, true);
assert.equal(iibbRows[2].net, -30);

const creditRows = taxes.buildIibbRows({
  grossSales: 1000,
  defaultJurisdiction: { id: 1, code: 'CABA', name: 'CABA', iibb_rate: 3 },
  jurisdictions: [{ id: 1, code: 'CABA', name: 'CABA', sales_share: 100, iibb_rate: 3, status: 'active' }],
  perceptions: new Map([[1, 100]]),
  withholdings: new Map([[1, 50]]),
});
assert.equal(creditRows[0].net, -120);

console.log('All tax checks passed.');
