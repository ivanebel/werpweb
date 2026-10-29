/**
 * Unit checks for the ARCA QR payload parser.
 *
 * These do not touch the database or the network. Run with:
 *   npm run test:arca-qr
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeArcaQr, ArcaQrError } = require('../src/lib/arcaQr.js');

const payload = {
  ver: 1,
  fecha: '2026-10-28',
  cuit: 30715071440,
  ptoVta: 2,
  tipoCmp: 201,
  nroCmp: 445,
  importe: 7361640,
  moneda: 'PES',
  ctz: 1,
  tipoDocRec: 80,
  nroDocRec: 30685849751,
  tipoCodAut: 'E',
  codAut: 86439795393680,
};
const base64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
const url = `https://servicioscf.afip.gob.ar/publico/comprobantes/cae.aspx?p=${base64}`;

const fromUrl = normalizeArcaQr(url);
assert.equal(fromUrl.qrUrl, url);
assert.deepEqual(fromUrl.fields, {
  version: 1,
  invoice_date: '2026-10-28',
  cae_expiry_date: '2026-10-28',
  issuer_cuit: '30715071440',
  point_of_sale: 2,
  document_type_code: 201,
  document_number: 445,
  invoice_no: '00002-00000445',
  total: 7361640,
  currency: 'PES',
  exchange_rate: 1,
  receiver_doc_type: 80,
  receiver_doc_number: '30685849751',
  auth_type: 'E',
  cae: '86439795393680',
});

const fromBase64 = normalizeArcaQr(base64);
assert.equal(fromBase64.fields.invoice_no, '00002-00000445');
assert.equal(fromBase64.qrUrl, null);

const fromJson = normalizeArcaQr(JSON.stringify(payload));
assert.equal(fromJson.fields.cae, '86439795393680');

assert.throws(() => normalizeArcaQr('not-a-qr'), (error) => error instanceof ArcaQrError);
assert.throws(
  () => normalizeArcaQr(Buffer.from(JSON.stringify({ ...payload, ver: 2 })).toString('base64')),
  (error) => error.code === 'unsupported_version',
);
assert.throws(
  () => normalizeArcaQr(Buffer.from(JSON.stringify({ ...payload, fecha: '2026-02-31' })).toString('base64')),
  (error) => error.code === 'invalid_date',
);
assert.throws(
  () => normalizeArcaQr(Buffer.from(JSON.stringify({ ...payload, codAut: 123 })).toString('base64')),
  (error) => error.code === 'invalid_cae',
);

console.log('All ARCA QR checks passed.');
