'use strict';

/**
 * ARCA VAT rates (alícuotas de IVA).
 * Codes are always four characters, including leading zeros.
 */
const VAT_RATES = [
  { code: '0003', rate: 0, name: '0.00%', active: true },
  { code: '0004', rate: 10.5, name: '10.50%', active: true },
  { code: '0005', rate: 21, name: '21.00%', active: true },
  { code: '0006', rate: 27, name: '27.00%', active: true },
];

const DEFAULT_VAT_CODE = '0005';
const DEFAULT_VAT_RATE = 21;

const rateValue = (rate) => Number(rate).toFixed(2);

const VAT_RATE_OPTIONS = VAT_RATES.map((vat) => ({
  value: rateValue(vat.rate),
  label: `${vat.code} — ${vat.name}`,
  code: vat.code,
  rate: vat.rate,
}));

function codeForRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return null;
  const match = VAT_RATES.find((vat) => Math.abs(vat.rate - rate) < 0.005);
  return match ? match.code : null;
}

function rateForCode(code) {
  const match = VAT_RATES.find((vat) => vat.code === String(code || '').trim());
  return match ? match.rate : null;
}

function isStandardRate(value) {
  return codeForRate(value) !== null;
}

module.exports = {
  VAT_RATES,
  VAT_RATE_OPTIONS,
  DEFAULT_VAT_CODE,
  DEFAULT_VAT_RATE,
  rateValue,
  codeForRate,
  rateForCode,
  isStandardRate,
};
