'use strict';

const TYPES = require('./fiscalDocumentTypes.json');

const BY_CODE = new Map(TYPES.map((type) => [type.code, type]));

function getFiscalType(code) {
  const number = Number.parseInt(code, 10);
  return Number.isFinite(number) ? BY_CODE.get(number) || null : null;
}

function getFiscalTypeName(code) {
  const type = getFiscalType(code);
  return type ? type.name : null;
}

function activeFiscalTypes() {
  return TYPES.filter((type) => type.active);
}

function fiscalFamily(code) {
  const type = getFiscalType(code);
  if (!type) return null;
  const name = String(type.name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  if (name.includes('NOTA DE CREDITO')) return 'credit_note';
  if (name.includes('NOTA DE DEBITO')) return 'debit_note';
  if (name.includes('FACTURA') || name.startsWith('TIQUE')) return 'invoice';
  return 'other';
}

function isNoteCode(code) {
  const family = fiscalFamily(code);
  return family === 'credit_note' || family === 'debit_note';
}

function isRegularInvoiceCode(code) {
  // Legacy invoices have no fiscal type yet. Treat them as regular invoices so
  // they can still be selected when linking an existing credit/debit note.
  if (code === null || code === undefined || code === '') return true;
  return fiscalFamily(code) === 'invoice';
}

function invoiceTypeCodes() {
  return TYPES.filter((type) => fiscalFamily(type.code) === 'invoice').map((type) => type.code);
}

function parseInvoiceNumber(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  const match = raw.match(/^(\d{1,5})\s*-\s*(\d{1,8})$/);
  if (!match) return null;
  const pointOfSale = Number(match[1]);
  const documentNumber = Number(match[2]);
  if (pointOfSale < 0 || documentNumber < 0) return null;
  return { pointOfSale, documentNumber };
}

function formatInvoiceNumber(pointOfSale, documentNumber) {
  const point = Number.parseInt(pointOfSale, 10);
  const document = Number.parseInt(documentNumber, 10);
  if (!Number.isFinite(point) || !Number.isFinite(document) || point < 0 || document < 0) return null;
  return `${String(point).padStart(5, '0')}-${String(document).padStart(8, '0')}`;
}

function normalizeInvoiceNumber(value) {
  const parsed = parseInvoiceNumber(value);
  return parsed ? formatInvoiceNumber(parsed.pointOfSale, parsed.documentNumber) : null;
}

module.exports = {
  FISCAL_DOCUMENT_TYPES: TYPES,
  getFiscalType,
  getFiscalTypeName,
  activeFiscalTypes,
  fiscalFamily,
  isNoteCode,
  isRegularInvoiceCode,
  invoiceTypeCodes,
  parseInvoiceNumber,
  formatInvoiceNumber,
  normalizeInvoiceNumber,
};
