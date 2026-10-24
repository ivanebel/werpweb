'use strict';

const bwipjs = require('bwip-js');

const TYPE_SPECS = {
  ean13: { length: 13, bcid: 'ean13', label: 'EAN-13', filenamePrefix: 'EAN13' },
  dun14: { length: 14, bcid: 'itf14', label: 'DUN-14', filenamePrefix: 'DUN14' },
};

function normalizeCode(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, '');
}

function checkDigit(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i += 1) {
    const digit = Number(payload[payload.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Inspect an EAN-13 / DUN-14 value.
 *
 * Existing installations can contain identifiers whose final check digit was
 * entered incorrectly. These are still renderable: the barcode uses the
 * mechanically correct check digit and the result is flagged so the UI can
 * explain that the stored value needs correction.
 */
function analyzeBarcode(type, rawCode) {
  const key = String(type || '').toLowerCase();
  const spec = TYPE_SPECS[key];
  const code = normalizeCode(rawCode);

  if (!spec) {
    return { type: key, code, valid: false, canRender: false, reason: 'unsupported' };
  }
  if (!code) {
    return { type: key, ...spec, code, valid: false, canRender: false, reason: 'empty' };
  }
  if (!/^\d+$/.test(code)) {
    return { type: key, ...spec, code, valid: false, canRender: false, reason: 'digits' };
  }
  if (code.length !== spec.length) {
    return { type: key, ...spec, code, valid: false, canRender: false, reason: 'length' };
  }

  const payload = code.slice(0, -1);
  const expectedCheckDigit = checkDigit(payload);
  const actualCheckDigit = code.slice(-1);
  const valid = expectedCheckDigit === actualCheckDigit;
  const barcodeCode = valid ? code : payload + expectedCheckDigit;

  return {
    type: key,
    ...spec,
    code,
    payload,
    expectedCheckDigit,
    actualCheckDigit,
    barcodeCode,
    valid,
    corrected: !valid,
    canRender: true,
    reason: valid ? null : 'check',
  };
}

function renderBarcodeSvg(type, rawCode) {
  const info = analyzeBarcode(type, rawCode);
  if (!info.canRender) {
    const error = new Error('Invalid barcode value.');
    error.code = 'INVALID_BARCODE';
    error.barcode = info;
    throw error;
  }

  const svg = bwipjs.toSVG({
    bcid: info.bcid,
    text: info.barcodeCode,
    includetext: true,
    textxalign: 'center',
    textsize: 10,
    scale: 3,
    height: 12,
    paddingwidth: 4,
    paddingheight: 4,
    backgroundcolor: 'FFFFFF',
    barcolor: '000000',
  });

  return { svg, info };
}

function barcodeFilename(type, info) {
  const key = String(type || '').toLowerCase();
  const spec = TYPE_SPECS[key];
  const code = info && info.barcodeCode ? info.barcodeCode : normalizeCode(info);
  const prefix = spec ? spec.filenamePrefix : 'BARCODE';
  return `${prefix}-${code}.svg`;
}

module.exports = {
  TYPE_SPECS,
  analyzeBarcode,
  barcodeFilename,
  checkDigit,
  normalizeCode,
  renderBarcodeSvg,
};
