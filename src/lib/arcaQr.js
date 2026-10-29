'use strict';

class ArcaQrError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ArcaQrError';
    this.code = code;
  }
}

function digits(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\D/g, '');
}

function numberValue(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new ArcaQrError('invalid_number', `${field} is missing.`);
  }
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) throw new ArcaQrError('invalid_number', `${field} is not a number.`);
  return n;
}

function validDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

function decodeBase64Json(value) {
  const raw = String(value || '').trim().replace(/\s+/g, '');
  if (!raw) throw new ArcaQrError('empty', 'Empty QR payload.');
  let text;
  try {
    text = Buffer.from(raw, 'base64').toString('utf8').trim();
  } catch {
    throw new ArcaQrError('invalid_base64', 'Invalid base64 QR payload.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ArcaQrError('invalid_payload', 'The QR payload is not valid JSON.');
  }
}

function extractUrlPayload(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new ArcaQrError('invalid_url', 'The QR link is not a valid URL.');
  }
  const p = url.searchParams.get('p');
  if (!p) throw new ArcaQrError('missing_payload', 'The QR link does not contain a payload.');
  return { payload: decodeBase64Json(p), qrUrl: url.toString() };
}

function decodeQrInput(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new ArcaQrError('empty', 'Empty QR payload.');

  if (raw.startsWith('{')) {
    try {
      return { payload: JSON.parse(raw), qrUrl: null };
    } catch {
      throw new ArcaQrError('invalid_payload', 'The QR payload is not valid JSON.');
    }
  }

  if (/^https?:\/\//i.test(raw)) {
    return extractUrlPayload(raw);
  }

  if (/^p=/i.test(raw)) {
    const p = new URLSearchParams(raw).get('p');
    if (!p) throw new ArcaQrError('missing_payload', 'The QR link does not contain a payload.');
    return { payload: decodeBase64Json(p), qrUrl: null };
  }

  return { payload: decodeBase64Json(raw), qrUrl: null };
}

function normalizeArcaQr(input) {
  const { payload, qrUrl } = decodeQrInput(input);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ArcaQrError('invalid_payload', 'The QR payload is not a JSON object.');
  }

  const version = numberValue(payload.ver, 'ver');
  if (version !== 1) {
    throw new ArcaQrError('unsupported_version', 'Unsupported QR version.');
  }

  const invoiceDate = validDate(payload.fecha);
  if (!invoiceDate) throw new ArcaQrError('invalid_date', 'The invoice date is invalid.');

  const issuerCuit = digits(payload.cuit);
  if (!issuerCuit) throw new ArcaQrError('missing_issuer', 'The issuer CUIT is missing.');

  const pointOfSale = numberValue(payload.ptoVta, 'ptoVta');
  const documentTypeCode = numberValue(payload.tipoCmp, 'tipoCmp');
  const documentNumber = numberValue(payload.nroCmp, 'nroCmp');
  const total = numberValue(payload.importe, 'importe');
  if (total < 0) throw new ArcaQrError('invalid_amount', 'The invoice total is invalid.');

  const currency = String(payload.moneda || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ArcaQrError('invalid_currency', 'The invoice currency is invalid.');
  }

  const exchangeRate = numberValue(payload.ctz === undefined ? 1 : payload.ctz, 'ctz');
  if (exchangeRate <= 0) throw new ArcaQrError('invalid_exchange_rate', 'The exchange rate is invalid.');

  const receiverDocType = numberValue(payload.tipoDocRec, 'tipoDocRec');
  const receiverDocNumber = digits(payload.nroDocRec);
  if (!receiverDocNumber) throw new ArcaQrError('missing_receiver', 'The customer document number is missing.');

  const authType = String(payload.tipoCodAut || '').trim().toUpperCase();
  if (!authType) throw new ArcaQrError('missing_auth_type', 'The authorization type is missing.');

  const cae = digits(payload.codAut);
  if (!/^\d{14}$/.test(cae)) {
    throw new ArcaQrError('invalid_cae', 'The CAE number must contain 14 digits.');
  }

  return {
    payload,
    qrUrl,
    fields: {
      version,
      invoice_date: invoiceDate,
      cae_expiry_date: invoiceDate,
      issuer_cuit: issuerCuit,
      point_of_sale: pointOfSale,
      document_type_code: documentTypeCode,
      document_number: documentNumber,
      invoice_no: `${String(pointOfSale).padStart(5, '0')}-${String(documentNumber).padStart(8, '0')}`,
      total,
      currency,
      exchange_rate: exchangeRate,
      receiver_doc_type: receiverDocType,
      receiver_doc_number: receiverDocNumber,
      auth_type: authType,
      cae,
    },
  };
}

module.exports = {
  ArcaQrError,
  digits,
  decodeQrInput,
  normalizeArcaQr,
};
