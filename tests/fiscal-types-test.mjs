/**
 * Checks for the fiscal document type catalog.
 *
 * Run with:
 *   npm run test:fiscal-types
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  FISCAL_DOCUMENT_TYPES,
  getFiscalType,
  activeFiscalTypes,
  fiscalFamily,
  isRegularInvoiceCode,
} = require('../src/lib/fiscalDocumentTypes.js');

const nonFiscal = getFiscalType(999);
assert.equal(nonFiscal.code, 999);
assert.equal(nonFiscal.name, 'DOCUMENTO NO FISCAL');
assert.equal(nonFiscal.active, true);
assert.ok(activeFiscalTypes().some((type) => type.code === 999));
assert.equal(fiscalFamily(999), 'other');
assert.equal(isRegularInvoiceCode(999), false);

const codes = FISCAL_DOCUMENT_TYPES.map((type) => type.code);
assert.equal(new Set(codes).size, codes.length, 'Fiscal document type codes must be unique.');

console.log('All fiscal document type checks passed.');
