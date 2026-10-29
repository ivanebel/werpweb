'use strict';

const express = require('express');
const { query, one, withTransaction } = require('../db');
const { getSettings } = require('../lib/settings');
const { digits, normalizeArcaQr, ArcaQrError } = require('../lib/arcaQr');
const { formatMoney } = require('../lib/helpers');

const router = express.Router();
const basePath = '/sales/import-arca';

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function validDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime()) ? null : raw;
}

function parseInvoiceId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanFilename(value) {
  return String(value || '').trim().replace(/^.*[\\/]/, '').slice(0, 255) || null;
}

function cleanSha256(value) {
  const raw = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

function sourceValue(value) {
  return value === 'pdf_qr' ? 'pdf_qr' : 'manual_qr';
}

function qrErrorMessage(req, error) {
  if (!(error instanceof ArcaQrError)) return req.t('The QR code could not be read.');
  const messages = {
    empty: 'The QR payload is empty.',
    invalid_base64: 'The QR code does not contain valid ARCA data.',
    invalid_payload: 'The QR code does not contain valid ARCA data.',
    invalid_url: 'The QR link is not valid.',
    missing_payload: 'The QR link does not contain invoice data.',
    unsupported_version: 'This QR version is not supported.',
    invalid_date: 'The invoice date in the QR code is invalid.',
    missing_issuer: 'The QR code does not contain the issuer CUIT.',
    invalid_number: 'The QR code contains an invalid number.',
    invalid_amount: 'The invoice total in the QR code is invalid.',
    invalid_currency: 'The invoice currency in the QR code is invalid.',
    invalid_exchange_rate: 'The exchange rate in the QR code is invalid.',
    missing_receiver: 'The QR code does not contain the customer document number.',
    missing_auth_type: 'The QR code does not contain a valid authorization type.',
    invalid_cae: 'The QR code does not contain a valid CAE number.',
  };
  return req.t(messages[error.code] || 'The QR code could not be read.');
}

async function loadTargetInvoice(invoiceId) {
  if (!invoiceId) return null;
  return one('SELECT * FROM sales_invoices WHERE id = ? LIMIT 1', [invoiceId]);
}

async function loadCustomers() {
  return query(
    `SELECT id, customer_no, company_name, tax_id, status
       FROM customers
      ORDER BY company_name`,
  );
}

async function buildReview(req, {
  qrInput,
  invoiceId,
  source,
  pdfFilename,
  pdfSha256,
  postedCustomerId,
  postedCaeExpiry,
}) {
  const parsed = normalizeArcaQr(qrInput);
  const fields = parsed.fields;
  const [settings, customers, fiscalType, targetInvoice] = await Promise.all([
    getSettings(),
    loadCustomers(),
    one('SELECT code, name, active FROM fiscal_document_types WHERE code = ? LIMIT 1', [fields.document_type_code]),
    loadTargetInvoice(invoiceId),
  ]);

  if (invoiceId && !targetInvoice) {
    throw Object.assign(new Error(req.t('Sales invoice not found.')), { status: 404 });
  }

  const errors = [];
  const warnings = [];
  const displayCurrency = fields.currency === 'PES' ? 'ARS' : fields.currency;
  const qrMoney = (value) => formatMoney(value, displayCurrency, req.locale);

  if (targetInvoice && targetInvoice.status !== 'draft') {
    errors.push(req.t('Only draft sales invoices can receive ARCA data.'));
  }
  if (fields.currency !== 'PES') {
    errors.push(req.t('Only PES invoices are supported.'));
  }
  if (!fiscalType) {
    errors.push(req.t('The fiscal document type {code} is not configured in the ERP.', {
      code: fields.document_type_code,
    }));
  } else if (Number(fiscalType.active) !== 1) {
    warnings.push(req.t('The fiscal document type {name} is inactive.', { name: fiscalType.name }));
  }

  const companyCuit = digits(settings.company_tax_id);
  if (!companyCuit) {
    warnings.push(req.t('The company tax ID is not configured. The issuer CUIT could not be validated.'));
  } else if (companyCuit !== fields.issuer_cuit) {
    warnings.push(req.t('The issuer CUIT ({issuer}) does not match the company tax ID ({company}).', {
      issuer: fields.issuer_cuit,
      company: companyCuit,
    }));
  }

  const matches = customers.filter((customer) => digits(customer.tax_id) === fields.receiver_doc_number);
  let selectedCustomer = null;
  const postedId = parseInvoiceId(postedCustomerId);
  if (postedId) {
    selectedCustomer = customers.find((customer) => Number(customer.id) === postedId) || null;
  }
  if (!selectedCustomer) selectedCustomer = matches[0] || null;
  if (!selectedCustomer && targetInvoice) {
    selectedCustomer = customers.find((customer) => Number(customer.id) === Number(targetInvoice.customer_id)) || null;
  }

  if (!selectedCustomer) {
    warnings.push(req.t('No customer matches CUIT {cuit}. Select one manually.', {
      cuit: fields.receiver_doc_number,
    }));
  } else if (digits(selectedCustomer.tax_id) !== fields.receiver_doc_number) {
    warnings.push(req.t('The selected customer does not match the CUIT in the QR code ({cuit}).', {
      cuit: fields.receiver_doc_number,
    }));
  }

  if (fields.receiver_doc_type !== 80) {
    warnings.push(req.t('The customer document type in the QR code is not CUIT.'));
  }
  if (fields.auth_type !== 'E') {
    warnings.push(req.t('The authorization type in the QR code is {type}, not CAE.', {
      type: fields.auth_type,
    }));
  }

  if (targetInvoice) {
    if (Math.abs(Number(targetInvoice.total) - fields.total) > 0.01) {
      warnings.push(req.t('The QR total ({qr}) does not match the current invoice total ({invoice}).', {
        qr: qrMoney(fields.total),
        invoice: qrMoney(Number(targetInvoice.total) || 0),
      }));
    }
    if (targetInvoice.invoice_no !== fields.invoice_no) {
      warnings.push(req.t('The invoice number will change from {old} to {new}.', {
        old: targetInvoice.invoice_no,
        new: fields.invoice_no,
      }));
    }
    if (Number(targetInvoice.customer_id) !== Number(selectedCustomer && selectedCustomer.id)) {
      warnings.push(req.t('The customer on the draft invoice will be replaced.'));
    }
    if (targetInvoice.document_type_code && Number(targetInvoice.document_type_code) !== fields.document_type_code) {
      warnings.push(req.t('The fiscal document type on the draft invoice will be replaced.'));
    }
    if (targetInvoice.cae && String(targetInvoice.cae) !== fields.cae) {
      warnings.push(req.t('The existing CAE on the draft invoice will be replaced.'));
    }
  }

  const duplicate = await one(
    'SELECT id, invoice_no FROM sales_invoices WHERE invoice_no = ? AND id <> ? LIMIT 1',
    [fields.invoice_no, targetInvoice ? targetInvoice.id : 0],
  );
  if (duplicate) {
    errors.push(req.t('An invoice with number {number} already exists (ID {id}).', {
      number: fields.invoice_no,
      id: duplicate.id,
    }));
  }

  const caeExpiry = validDate(postedCaeExpiry)
    || validDate(fields.cae_expiry_date)
    || fields.invoice_date;
  if (!validDate(caeExpiry)) {
    errors.push(req.t('Enter a valid CAE expiry date.'));
  }

  return {
    parsed,
    fields,
    fiscalType,
    customers,
    targetInvoice,
    selectedCustomer,
    selectedCustomerId: selectedCustomer ? String(selectedCustomer.id) : '',
    caeExpiry,
    warnings,
    errors,
    source: sourceValue(source),
    pdfFilename: cleanFilename(pdfFilename),
    pdfSha256: cleanSha256(pdfSha256),
    qrInput: String(qrInput || ''),
    qrUrl: parsed.qrUrl || null,
    displayCurrency,
    qrMoney,
    invoiceId: targetInvoice ? targetInvoice.id : null,
  };
}

function renderUpload(req, res, options = {}) {
  const { status = 200, invoice = null, error = null } = options;
  return res.status(status).render('sales/arca-import/upload', {
    title: req.t('Import ARCA invoice'),
    active: 'sales',
    breadcrumbs: [
      { label: req.t('Sales'), href: '/sales' },
      { label: req.t('Import ARCA invoice') },
    ],
    invoice,
    error,
  });
}

function renderReview(req, res, review, options = {}) {
  const { status = 200 } = options;
  return res.status(status).render('sales/arca-import/review', {
    title: req.t('Review ARCA import'),
    active: 'sales',
    breadcrumbs: [
      { label: req.t('Sales'), href: '/sales' },
      { label: req.t('Import ARCA invoice'), href: basePath },
      { label: req.t('Review') },
    ],
    ...review,
  });
}

router.get('/', async (req, res, next) => {
  try {
    const invoiceId = parseInvoiceId(req.query.invoice_id);
    const invoice = invoiceId ? await loadTargetInvoice(invoiceId) : null;
    if (invoiceId && !invoice) {
      return next(Object.assign(new Error(req.t('Sales invoice not found.')), { status: 404 }));
    }
    if (invoice && invoice.status !== 'draft') {
      req.flash('error', req.t('ARCA data can only be imported into a draft sales invoice.'));
      return res.redirect(`/sales/${invoice.id}`);
    }
    return renderUpload(req, res, { invoice });
  } catch (error) {
    next(error);
  }
});

router.post('/preview', async (req, res, next) => {
  try {
    const qrInput = String(req.body.qr_data || req.body.manual_qr || '').trim();
    const invoiceId = parseInvoiceId(req.body.invoice_id);
    if (!qrInput) {
      return renderUpload(req, res, {
        status: 422,
        invoice: await loadTargetInvoice(invoiceId),
        error: req.t('Select a PDF or paste an ARCA QR link.'),
      });
    }
    let review;
    try {
      review = await buildReview(req, {
        qrInput,
        invoiceId,
        source: req.body.source,
        pdfFilename: req.body.pdf_filename,
        pdfSha256: req.body.pdf_sha256,
      });
    } catch (error) {
      if (error instanceof ArcaQrError) {
        return renderUpload(req, res, {
          status: 422,
          invoice: await loadTargetInvoice(invoiceId),
          error: qrErrorMessage(req, error),
        });
      }
      throw error;
    }
    return renderReview(req, res, review);
  } catch (error) {
    next(error);
  }
});

router.post('/confirm', async (req, res, next) => {
  try {
    const qrInput = String(req.body.qr_data || '').trim();
    const invoiceId = parseInvoiceId(req.body.invoice_id);
    if (!qrInput) {
      req.flash('error', 'The ARCA QR data is missing. Scan the PDF again.');
      return res.redirect(basePath);
    }

    let review;
    try {
      review = await buildReview(req, {
        qrInput,
        invoiceId,
        source: req.body.source,
        pdfFilename: req.body.pdf_filename,
        pdfSha256: req.body.pdf_sha256,
        postedCustomerId: req.body.customer_id,
        postedCaeExpiry: req.body.cae_expiry_date,
      });
    } catch (error) {
      if (error instanceof ArcaQrError) {
        req.flash('error', qrErrorMessage(req, error));
        return res.redirect(basePath);
      }
      throw error;
    }

    const customer = review.customers.find(
      (row) => Number(row.id) === Number(req.body.customer_id),
    ) || null;
    if (!customer) {
      review.errors.push(req.t('Select the customer for this invoice.'));
    }
    if (!validDate(req.body.cae_expiry_date)) {
      review.errors.push(req.t('Enter a valid CAE expiry date.'));
    } else {
      review.caeExpiry = validDate(req.body.cae_expiry_date);
    }
    if (review.errors.length) {
      return renderReview(req, res, review, { status: 422 });
    }

    const result = await withTransaction(async (conn) => {
      let savedInvoiceId = review.targetInvoice ? review.targetInvoice.id : null;
      if (savedInvoiceId) {
        await conn.query(
          `UPDATE sales_invoices
              SET invoice_no = ?, document_type_code = ?, cae = ?, cae_expiry_date = ?,
                  customer_id = ?, invoice_date = ?
            WHERE id = ?`,
          [
            review.fields.invoice_no,
            review.fields.document_type_code,
            review.fields.cae,
            review.caeExpiry,
            customer.id,
            review.fields.invoice_date,
            savedInvoiceId,
          ],
        );
      } else {
        const [inserted] = await conn.query(
          `INSERT INTO sales_invoices
             (invoice_no, document_type_code, cae, cae_expiry_date, customer_id,
              invoice_date, status, subtotal, discount_total, tax_total, total,
              amount_paid, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, 0, 0, ?, 0, ?, ?)`,
          [
            review.fields.invoice_no,
            review.fields.document_type_code,
            review.fields.cae,
            review.caeExpiry,
            customer.id,
            review.fields.invoice_date,
            review.fields.total,
            review.fields.total,
            null,
            req.session.user.id,
          ],
        );
        savedInvoiceId = inserted.insertId;
      }

      await conn.query(
        `INSERT INTO sales_invoice_imports
           (invoice_id, source, issuer_cuit, receiver_doc_type, receiver_doc_number,
            currency, exchange_rate, raw_payload, qr_url, warnings, pdf_filename,
            pdf_sha256, imported_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          savedInvoiceId,
          review.source,
          review.fields.issuer_cuit,
          review.fields.receiver_doc_type,
          review.fields.receiver_doc_number,
          review.fields.currency,
          review.fields.exchange_rate,
          JSON.stringify(review.parsed.payload),
          review.qrUrl,
          JSON.stringify(review.warnings),
          review.pdfFilename,
          review.pdfSha256,
          req.session.user.id,
        ],
      );
      return { invoiceId: savedInvoiceId, created: !review.targetInvoice };
    });

    if (review.warnings.length) {
      req.flash('warning', result.created
        ? 'Draft invoice created from ARCA QR with {count} warning(s). Add the line items before sending it.'
        : 'ARCA data imported with {count} warning(s). Review the invoice.', { count: review.warnings.length });
    } else {
      req.flash('success', result.created
        ? 'Draft invoice created from ARCA QR. Add the line items before sending it.'
        : 'ARCA data imported into the draft invoice.');
    }
    return res.redirect(result.created ? `/sales/${result.invoiceId}/edit` : `/sales/${result.invoiceId}`);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
