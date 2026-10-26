'use strict';

const express = require('express');
const { query, one } = require('../db');
const { todayISO, formatMoney } = require('../lib/helpers');
const { requireRole } = require('../middleware/web');
const taxes = require('../lib/taxes');

const router = express.Router();
const adminOnly = requireRole('admin');
const basePath = '/finance/taxes';

const withholdingTypeOptions = [
  { value: 'none', label: 'Unclassified' },
  { value: 'iibb', label: 'IIBB (Ingresos Brutos)' },
  { value: 'income', label: 'Income tax' },
  { value: 'other', label: 'Other' },
];

function currencyFor(res) {
  return (res.locals.settings && res.locals.settings.currency) || 'USD';
}

function moneyFor(req, res) {
  const currency = currencyFor(res);
  return (value) => formatMoney(value, currency, req.locale);
}

function rangeFromQuery(req) {
  return taxes.normalizeRange(req.query.from, req.query.to);
}

function rangeFromBody(req) {
  return taxes.normalizeRange(req.body.from, req.body.to);
}

function rangeQuery(range) {
  return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

function periodLinks() {
  const today = todayISO();
  return {
    thisMonth: taxes.monthRange(today, 0),
    previousMonth: taxes.monthRange(today, -1),
  };
}

function dashboardAlerts(report, req, range, canManageTaxes) {
  const t = req.t;
  const settingsHref = `${basePath}/settings`;
  const rangeQs = rangeQuery(range);
  const alerts = [];
  for (const alert of report.alerts) {
    if (alert.code === 'no_default_jurisdiction') {
      alerts.push({
        tone: 'warning',
        title: t('No default tax jurisdiction'),
        message: canManageTaxes
          ? t('Choose a default jurisdiction and set its IIBB and municipal rates to calculate these taxes.')
          : t('Ask an administrator to configure the default jurisdiction and its rates.'),
        href: canManageTaxes ? settingsHref : null,
        action: canManageTaxes ? t('Tax settings') : null,
      });
    } else if (alert.code === 'zero_iibb_rate') {
      alerts.push({
        tone: 'warning',
        title: t('IIBB rate is not configured'),
        message: canManageTaxes
          ? t('Set the IIBB rate for {jurisdiction} so the Ingresos Brutos estimate is calculated.', { jurisdiction: alert.jurisdiction })
          : t('The IIBB rate for {jurisdiction} is zero. Ask an administrator to configure it.', { jurisdiction: alert.jurisdiction }),
        href: canManageTaxes ? settingsHref : null,
        action: canManageTaxes ? t('Tax settings') : null,
      });
    } else if (alert.code === 'zero_municipal_rate') {
      alerts.push({
        tone: 'info',
        title: t('Municipal rate is not configured'),
        message: canManageTaxes
          ? t('Set the municipal rate for {jurisdiction} to include the municipal tax estimate.', { jurisdiction: alert.jurisdiction })
          : t('The municipal rate for {jurisdiction} is zero. Ask an administrator to configure it.', { jurisdiction: alert.jurisdiction }),
        href: canManageTaxes ? settingsHref : null,
        action: canManageTaxes ? t('Tax settings') : null,
      });
    } else if (alert.code === 'sales_share_total') {
      alerts.push({
        tone: 'warning',
        title: t('Sales allocation does not total 100%'),
        message: canManageTaxes
          ? t('The active jurisdictions total {total}%. Adjust the sales allocation so IIBB is calculated on all gross sales.', { total: alert.total })
          : t('The active jurisdictions total {total}%. Ask an administrator to adjust the sales allocation.', { total: alert.total }),
        href: canManageTaxes ? settingsHref : null,
        action: canManageTaxes ? t('Tax settings') : null,
      });
    } else if (alert.code === 'no_sales') {
      alerts.push({
        tone: 'info',
        title: t('No sales invoices in this period'),
        message: t('VAT output and gross sales are zero. Issue or select a period with sales invoices.'),
      });
    } else if (alert.code === 'no_purchases') {
      alerts.push({
        tone: 'info',
        title: t('No purchase invoices in this period'),
        message: t('VAT input and purchase perceptions may be incomplete for this period.'),
      });
    } else if (alert.code === 'unclassified_withholdings') {
      alerts.push({
        tone: 'warning',
        title: t('Unclassified withholdings'),
        message: t('{count} customer payment withholdings are unclassified and are not reducing IIBB.', { count: alert.count }),
        href: `${basePath}/withholdings?${rangeQs}`,
        action: t('Classify withholdings'),
      });
    } else if (alert.code === 'unassigned_iibb') {
      alerts.push({
        tone: 'warning',
        title: t('IIBB withholdings without a jurisdiction'),
        message: t('{count} IIBB withholdings have no jurisdiction. Assign one so they reduce the correct jurisdiction.', { count: alert.count }),
        href: `${basePath}/withholdings?${rangeQs}`,
        action: t('Classify withholdings'),
      });
    }
  }
  return alerts;
}

function invoiceStatusError(t) {
  return t('Select a received, paid or overdue purchase invoice.');
}

async function loadPurchaseInvoice(invoiceId) {
  if (!invoiceId) return null;
  return one(
    `SELECT i.*, fdt.name AS document_type_name
       FROM purchase_invoices i
       LEFT JOIN fiscal_document_types fdt ON fdt.code = i.document_type_code
      WHERE i.id = ? LIMIT 1`,
    [invoiceId],
  );
}

async function loadJurisdiction(jurisdictionId) {
  if (!jurisdictionId) return null;
  return one("SELECT * FROM tax_jurisdictions WHERE id = ? AND status = 'active' LIMIT 1", [jurisdictionId]);
}

function parseJurisdiction(body, req) {
  const values = {
    code: String(body.code || '').trim().toUpperCase(),
    name: String(body.name || '').trim(),
    sales_share: String(body.sales_share === undefined ? '' : body.sales_share).trim(),
    iibb_rate: String(body.iibb_rate === undefined ? '' : body.iibb_rate).trim(),
    municipal_rate: String(body.municipal_rate === undefined ? '' : body.municipal_rate).trim(),
    status: body.status === 'inactive' ? 'inactive' : 'active',
  };
  const errors = {};
  if (!/^[A-Z0-9_-]{2,20}$/.test(values.code)) {
    errors.code = req.t('Use 2-20 letters, numbers, hyphens or underscores.');
  }
  if (!values.name) errors.name = req.t('Name is required.');
  else if (values.name.length > 120) errors.name = req.t('Name must be 120 characters or fewer.');
  const salesShare = Number(values.sales_share);
  if (values.sales_share === '' || !Number.isFinite(salesShare) || salesShare < 0 || salesShare > 100) {
    errors.sales_share = req.t('The sales share must be between 0 and 100.');
  }
  const iibbRate = Number(values.iibb_rate);
  if (values.iibb_rate === '' || !Number.isFinite(iibbRate) || iibbRate < 0 || iibbRate > 100) {
    errors.iibb_rate = req.t('The rate must be between 0 and 100.');
  }
  const municipalRate = Number(values.municipal_rate);
  if (values.municipal_rate === '' || !Number.isFinite(municipalRate) || municipalRate < 0 || municipalRate > 100) {
    errors.municipal_rate = req.t('The rate must be between 0 and 100.');
  }
  return { values, errors };
}

async function jurisdictionReferenceCounts(id) {
  const rows = await query(
    `SELECT
       (SELECT COUNT(*) FROM purchase_invoice_perceptions WHERE jurisdiction_id = ?) AS perceptions,
       (SELECT COUNT(*) FROM payment_adjustments WHERE jurisdiction_id = ?) AS withholdings`,
    [id, id],
  );
  return rows[0] || { perceptions: 0, withholdings: 0 };
}

async function loadSettingsData(defaultId = null) {
  const [settings, rows] = await Promise.all([
    taxes.loadTaxSettings(),
    query(
      `SELECT j.*,
              (SELECT COUNT(*) FROM purchase_invoice_perceptions p WHERE p.jurisdiction_id = j.id) AS perception_count,
              (SELECT COUNT(*) FROM payment_adjustments pa WHERE pa.jurisdiction_id = j.id) AS withholding_count
         FROM tax_jurisdictions j
        ORDER BY j.name`,
    ),
  ]);
  const selectedDefault = defaultId || (settings ? Number(settings.default_jurisdiction_id) : null);
  return {
    taxSettings: settings,
    defaultId: settings ? Number(settings.default_jurisdiction_id) : null,
    jurisdictions: rows.map((row) => ({
      ...row,
      is_default: selectedDefault !== null && Number(row.id) === Number(selectedDefault),
    })),
  };
}

async function renderSettings(req, res, options = {}) {
  const {
    status = 200,
    values = null,
    errors = {},
    errorForm = null,
    editId = null,
  } = options;
  const data = await loadSettingsData();
  const editRow = editId
    ? data.jurisdictions.find((row) => Number(row.id) === Number(editId)) || null
    : null;
  const currency = currencyFor(res);
  return res.status(status).render('finance/taxes/settings', {
    title: req.t('Tax settings'),
    active: 'finance-taxes',
    breadcrumbs: [
      { label: req.t('Taxes'), href: basePath },
      { label: req.t('Tax settings') },
    ],
    ...data,
    editJurisdiction: editRow,
    errorForm,
    values: values || (editRow ? { ...editRow } : {
      code: '',
      name: '',
      sales_share: '0.00',
      iibb_rate: '0.00',
      municipal_rate: '0.00',
      status: 'active',
    }),
    errors,
    money: (value) => formatMoney(value, currency, req.locale),
  });
}

// ------------------------------------------------------------------ dashboard
router.get('/', async (req, res, next) => {
  try {
    const range = rangeFromQuery(req);
    const report = await taxes.buildTaxReport(range.from, range.to);
    const canManageTaxes = req.session.user.role === 'admin';
    const links = periodLinks();
    res.render('finance/taxes/index', {
      title: req.t('Taxes'),
      active: 'finance-taxes',
      breadcrumbs: [{ label: req.t('Taxes') }],
      report,
      range,
      thisMonth: links.thisMonth,
      previousMonth: links.previousMonth,
      money: moneyFor(req, res),
      currency: currencyFor(res),
      canManageTaxes,
      alerts: dashboardAlerts(report, req, range, canManageTaxes),
    });
  } catch (error) {
    next(error);
  }
});

// ----------------------------------------------------------------- perceptions
async function renderPerceptions(req, res, options = {}) {
  const {
    status = 200,
    range = null,
    values = null,
    errors = {},
  } = options;
  const selectedRange = range || rangeFromQuery(req);
  const [report, jurisdictions] = await Promise.all([
    taxes.buildTaxReport(selectedRange.from, selectedRange.to),
    taxes.loadJurisdictions({ activeOnly: true }),
  ]);
  const purchaseInvoices = report.purchases.invoices;
  const currency = currencyFor(res);
  return res.status(status).render('finance/taxes/perceptions', {
    title: req.t('IIBB perceptions'),
    active: 'finance-taxes',
    breadcrumbs: [
      { label: req.t('Taxes'), href: basePath },
      { label: req.t('IIBB perceptions') },
    ],
    report,
    range: selectedRange,
    purchaseInvoices,
    jurisdictions,
    values: values || { invoice_id: '', jurisdiction_id: '', amount: '', reference: '', notes: '' },
    errors,
    money: (value) => formatMoney(value, currency, req.locale),
  });
}

router.get('/perceptions', async (req, res, next) => {
  try {
    return renderPerceptions(req, res);
  } catch (error) {
    next(error);
  }
});

router.post('/perceptions', async (req, res, next) => {
  try {
    const range = rangeFromBody(req);
    const values = {
      invoice_id: String(req.body.invoice_id || ''),
      jurisdiction_id: String(req.body.jurisdiction_id || ''),
      amount: String(req.body.amount || ''),
      reference: String(req.body.reference || '').trim(),
      notes: String(req.body.notes || '').trim(),
    };
    const errors = {};
    const invoiceId = Number(values.invoice_id);
    const jurisdictionId = Number(values.jurisdiction_id);
    const amount = Number(values.amount);
    const invoice = await loadPurchaseInvoice(invoiceId);
    const jurisdiction = await loadJurisdiction(jurisdictionId);

    if (!invoice || !taxes.includedStatus('purchase', invoice.status)) {
      errors.invoice_id = invoiceStatusError(req.t);
    }
    if (!jurisdiction) errors.jurisdiction_id = req.t('Select an active jurisdiction.');
    if (!Number.isFinite(amount) || amount <= 0) errors.amount = req.t('Enter an amount greater than zero.');
    if (values.reference.length > 120) errors.reference = req.t('Reference must be 120 characters or fewer.');
    if (values.notes.length > 255) errors.notes = req.t('Notes must be 255 characters or fewer.');

    if (Object.keys(errors).length) {
      return renderPerceptions(req, res, { status: 422, range, values, errors });
    }

    await query(
      `INSERT INTO purchase_invoice_perceptions
         (invoice_id, jurisdiction_id, amount, reference, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        invoiceId,
        jurisdictionId,
        taxes.round2(amount),
        values.reference || null,
        values.notes || null,
        req.session.user.id,
      ],
    );
    req.flash('success', 'IIBB perception added.');
    return res.redirect(`${basePath}/perceptions?${rangeQuery(range)}`);
  } catch (error) {
    next(error);
  }
});

router.post('/perceptions/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const range = rangeFromBody(req);
    await query('DELETE FROM purchase_invoice_perceptions WHERE id = ?', [req.params.id]);
    req.flash('success', 'IIBB perception deleted.');
    return res.redirect(`${basePath}/perceptions?${rangeQuery(range)}`);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------- withholdings
async function renderWithholdings(req, res, options = {}) {
  const { status = 200, range = null } = options;
  const selectedRange = range || rangeFromQuery(req);
  const [report, jurisdictions] = await Promise.all([
    taxes.buildTaxReport(selectedRange.from, selectedRange.to),
    taxes.loadJurisdictions({ activeOnly: true }),
  ]);
  const currency = currencyFor(res);
  return res.status(status).render('finance/taxes/withholdings', {
    title: req.t('Tax withholdings'),
    active: 'finance-taxes',
    breadcrumbs: [
      { label: req.t('Taxes'), href: basePath },
      { label: req.t('Tax withholdings') },
    ],
    report,
    range: selectedRange,
    jurisdictions,
    withholdingTypeOptions,
    money: (value) => formatMoney(value, currency, req.locale),
  });
}

router.get('/withholdings', async (req, res, next) => {
  try {
    return renderWithholdings(req, res);
  } catch (error) {
    next(error);
  }
});

router.post('/withholdings/:id(\\d+)', async (req, res, next) => {
  try {
    const range = rangeFromBody(req);
    const row = await one(
      `SELECT pa.*, p.direction
         FROM payment_adjustments pa
         JOIN payments p ON p.id = pa.payment_id
        WHERE pa.id = ? AND pa.kind = 'withholding'
        LIMIT 1`,
      [req.params.id],
    );
    if (!row || row.direction !== 'customer') {
      return next(Object.assign(new Error(req.t('Withholding not found.')), { status: 404 }));
    }

    const taxType = taxes.WITHHOLDING_TYPES.includes(req.body.tax_type) ? req.body.tax_type : 'none';
    let jurisdictionId = null;
    if (taxType === 'iibb') {
      jurisdictionId = Number(req.body.jurisdiction_id);
      const jurisdiction = await loadJurisdiction(jurisdictionId);
      if (!jurisdiction) {
        req.flash('error', 'Select an active jurisdiction for IIBB withholdings.');
        return res.redirect(`${basePath}/withholdings?${rangeQuery(range)}`);
      }
    }

    await query(
      'UPDATE payment_adjustments SET tax_type = ?, jurisdiction_id = ? WHERE id = ?',
      [taxType, jurisdictionId, row.id],
    );
    req.flash('success', 'Withholding classification updated.');
    return res.redirect(`${basePath}/withholdings?${rangeQuery(range)}`);
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------------- settings
router.get('/settings', adminOnly, async (req, res, next) => {
  try {
    const editId = req.query.edit ? Number(req.query.edit) : null;
    return renderSettings(req, res, { editId });
  } catch (error) {
    next(error);
  }
});

router.post('/settings', adminOnly, async (req, res, next) => {
  try {
    const jurisdictionId = Number(req.body.default_jurisdiction_id);
    const jurisdiction = await loadJurisdiction(jurisdictionId);
    if (!jurisdiction) {
      req.flash('error', 'Select an active default jurisdiction.');
      return res.redirect(`${basePath}/settings`);
    }
    await query(
      `INSERT INTO tax_settings (id, default_jurisdiction_id, updated_by)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE
         default_jurisdiction_id = VALUES(default_jurisdiction_id),
         updated_by = VALUES(updated_by)`,
      [jurisdictionId, req.session.user.id],
    );
    req.flash('success', 'Tax settings saved.');
    return res.redirect(`${basePath}/settings`);
  } catch (error) {
    next(error);
  }
});

router.post('/jurisdictions', adminOnly, async (req, res, next) => {
  try {
    const { values, errors } = parseJurisdiction(req.body, req);
    const duplicate = values.code || values.name
      ? await one('SELECT id FROM tax_jurisdictions WHERE code = ? OR name = ? LIMIT 1', [values.code, values.name])
      : null;
    if (duplicate) errors.code = req.t('A jurisdiction with this code or name already exists.');
    if (Object.keys(errors).length) {
      return renderSettings(req, res, { status: 422, values, errors, errorForm: 'create' });
    }
    await query(
      `INSERT INTO tax_jurisdictions (code, name, sales_share, iibb_rate, municipal_rate, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        values.code,
        values.name,
        Number(values.sales_share),
        Number(values.iibb_rate),
        Number(values.municipal_rate),
        values.status,
      ],
    );
    req.flash('success', 'Jurisdiction created.');
    return res.redirect(`${basePath}/settings`);
  } catch (error) {
    next(error);
  }
});

router.post('/jurisdictions/:id(\\d+)', adminOnly, async (req, res, next) => {
  try {
    const existing = await one('SELECT * FROM tax_jurisdictions WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existing) {
      return next(Object.assign(new Error(req.t('Jurisdiction not found.')), { status: 404 }));
    }
    const { values, errors } = parseJurisdiction(req.body, req);
    const settings = await taxes.loadTaxSettings();
    const isDefault = settings && Number(settings.default_jurisdiction_id) === Number(existing.id);
    if (isDefault && values.status === 'inactive') {
      errors.status = req.t('The default jurisdiction must remain active.');
    }
    const duplicate = values.code || values.name
      ? await one('SELECT id FROM tax_jurisdictions WHERE (code = ? OR name = ?) AND id <> ? LIMIT 1', [
          values.code,
          values.name,
          existing.id,
        ])
      : null;
    if (duplicate) errors.code = req.t('A jurisdiction with this code or name already exists.');
    if (Object.keys(errors).length) {
      return renderSettings(req, res, {
        status: 422,
        values,
        errors,
        errorForm: 'edit',
        editId: existing.id,
      });
    }
    await query(
      `UPDATE tax_jurisdictions
          SET code = ?, name = ?, sales_share = ?, iibb_rate = ?, municipal_rate = ?, status = ?
        WHERE id = ?`,
      [
        values.code,
        values.name,
        Number(values.sales_share),
        Number(values.iibb_rate),
        Number(values.municipal_rate),
        values.status,
        existing.id,
      ],
    );
    req.flash('success', 'Jurisdiction updated.');
    return res.redirect(`${basePath}/settings`);
  } catch (error) {
    next(error);
  }
});

router.post('/jurisdictions/:id(\\d+)/delete', adminOnly, async (req, res, next) => {
  try {
    const existing = await one('SELECT * FROM tax_jurisdictions WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existing) {
      return next(Object.assign(new Error(req.t('Jurisdiction not found.')), { status: 404 }));
    }
    const settings = await taxes.loadTaxSettings();
    if (settings && Number(settings.default_jurisdiction_id) === Number(existing.id)) {
      req.flash('error', 'The default jurisdiction cannot be deleted. Choose another default first.');
      return res.redirect(`${basePath}/settings`);
    }
    const counts = await jurisdictionReferenceCounts(existing.id);
    if (Number(counts.perceptions) > 0 || Number(counts.withholdings) > 0) {
      req.flash('error', 'This jurisdiction is used by perceptions or withholdings. Mark it inactive instead.');
      return res.redirect(`${basePath}/settings`);
    }
    await query('DELETE FROM tax_jurisdictions WHERE id = ?', [existing.id]);
    req.flash('success', 'Jurisdiction deleted.');
    return res.redirect(`${basePath}/settings`);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
