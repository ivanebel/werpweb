'use strict';

const express = require('express');
const multer = require('multer');
const { query, one, withTransaction } = require('../db');
const { todayISO, toNumber, formatMoney } = require('../lib/helpers');
const finance = require('../lib/finance');
const { parseCsv, toCsv } = require('../lib/csv');

const router = express.Router();
const basePath = '/finance/costs';
const actualsUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
}).single('file');

const STATUSES = ['active', 'inactive'];

function periodLabel(locale, period) {
  const date = new Date(`${period}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function currentPeriod() {
  return todayISO().slice(0, 7);
}

function textValue(value, maxLength = 255) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, maxLength) || null;
}

function intValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function boolValue(value) {
  return value === '1' || value === 'on' || value === 'true' || value === true ? 1 : 0;
}

function isDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

async function loadFormOptions({ categoryId = null, centerId = null, productId = null, productCategoryId = null, supplierId = null } = {}) {
  const [categories, centers, products, productCategories, suppliers] = await Promise.all([
    query("SELECT id, name, status FROM cost_categories WHERE status = 'active' OR id = ? ORDER BY name", [categoryId || 0]),
    query("SELECT id, name, status FROM cost_centers WHERE status = 'active' OR id = ? ORDER BY name", [centerId || 0]),
    query("SELECT id, sku, name, status FROM products WHERE status = 'active' OR id = ? ORDER BY name", [productId || 0]),
    query('SELECT id, name FROM product_categories ORDER BY name'),
    query("SELECT id, company_name, status FROM suppliers WHERE status = 'active' OR id = ? ORDER BY company_name", [supplierId || 0]),
  ]);
  return { categories, centers, products, productCategories, suppliers };
}

function formOptionIds(values = {}) {
  return {
    categoryId: values.category_id || null,
    centerId: values.cost_center_id || null,
    productId: values.scope_product_id || null,
    productCategoryId: values.scope_category_id || null,
    supplierId: values.supplier_id || null,
  };
}

function itemDefaults(period = currentPeriod()) {
  return {
    name: '',
    category_id: '',
    cost_center_id: '',
    behavior: 'fixed',
    amount: 0,
    frequency: 'monthly',
    driver_type: '',
    driver_rate: 0,
    scope_type: 'company',
    scope_product_id: '',
    scope_category_id: '',
    amount_basis: 'net',
    vat_rate: 0,
    vat_recoverable: 1,
    is_non_cash: 0,
    payment_days: 0,
    payment_day: '',
    effective_from: `${period}-01`,
    effective_to: '',
    supplier_id: '',
    notes: '',
    status: 'active',
  };
}

function validateItem(body, existing = null) {
  const errors = {};
  const values = { ...itemDefaults(), ...(existing || {}) };

  values.name = textValue(body.name, 180);
  if (!values.name) errors.name = 'Name is required.';

  values.category_id = intValue(body.category_id);
  values.cost_center_id = intValue(body.cost_center_id);
  values.behavior = finance.BEHAVIORS.includes(body.behavior) ? body.behavior : 'fixed';
  values.frequency = finance.FREQUENCIES.includes(body.frequency) ? body.frequency : 'monthly';
  values.amount = Math.max(0, toNumber(body.amount, 0));
  values.driver_rate = Math.max(0, toNumber(body.driver_rate, 0));
  values.driver_type = finance.DRIVER_TYPES.includes(body.driver_type) ? body.driver_type : null;
  values.scope_type = finance.SCOPES.includes(body.scope_type) ? body.scope_type : 'company';
  values.scope_product_id = intValue(body.scope_product_id);
  values.scope_category_id = intValue(body.scope_category_id);
  values.amount_basis = finance.AMOUNT_BASES.includes(body.amount_basis) ? body.amount_basis : 'net';
  values.vat_rate = Math.max(0, Math.min(100, toNumber(body.vat_rate, 0)));
  values.vat_recoverable = boolValue(body.vat_recoverable);
  values.is_non_cash = boolValue(body.is_non_cash);
  values.payment_days = Math.max(0, Math.trunc(toNumber(body.payment_days, 0)));
  const paymentDay = Number.parseInt(body.payment_day, 10);
  values.payment_day = Number.isFinite(paymentDay) && paymentDay >= 1 && paymentDay <= 31 ? paymentDay : null;
  values.effective_from = String(body.effective_from || '').slice(0, 10);
  values.effective_to = String(body.effective_to || '').slice(0, 10) || null;
  values.supplier_id = intValue(body.supplier_id);
  values.notes = textValue(body.notes, 5000);
  values.status = STATUSES.includes(body.status) ? body.status : 'active';

  if (!isDate(values.effective_from)) {
    errors.effective_from = 'Enter a valid effective-from date.';
  }
  if (values.effective_to && !isDate(values.effective_to)) {
    errors.effective_to = 'Enter a valid effective-to date.';
  } else if (values.effective_to && values.effective_to < values.effective_from) {
    errors.effective_to = 'The effective-to date cannot be before the effective-from date.';
  }

  if (values.behavior === 'variable') {
    if (!values.driver_type) errors.driver_type = 'Select a driver for a variable cost.';
    if (values.amount > 0) values.amount = 0;
  }
  if (values.behavior === 'variable' || values.behavior === 'semi_variable') {
    if (!values.driver_type) errors.driver_type = 'Select a driver for a variable cost.';
    if (values.driver_rate <= 0) errors.driver_rate = 'Enter a driver rate greater than zero.';
    if (['revenue_percent', 'material_percent'].includes(values.driver_type) && values.driver_rate > 100) {
      errors.driver_rate = 'A percentage driver cannot exceed 100%.';
    }
  } else {
    values.driver_type = null;
    values.driver_rate = 0;
    values.scope_type = 'company';
    values.scope_product_id = null;
    values.scope_category_id = null;
  }

  if (values.scope_type === 'product') {
    if (!values.scope_product_id) errors.scope_product_id = 'Select the product this cost applies to.';
    values.scope_category_id = null;
  } else if (values.scope_type === 'category') {
    if (!values.scope_category_id) errors.scope_category_id = 'Select the category this cost applies to.';
    values.scope_product_id = null;
  } else {
    values.scope_product_id = null;
    values.scope_category_id = null;
  }

  if (values.behavior === 'fixed' || values.behavior === 'stepped') {
    values.driver_type = null;
    values.driver_rate = 0;
  }

  return { values, errors };
}

function itemFormState(req, row, errors, mode, itemId = null) {
  return {
    title: mode === 'create' ? req.t('New cost item') : req.t('Edit cost item'),
    active: 'finance-costs',
    breadcrumbs: [
      { label: req.t('Costs & profitability'), href: basePath },
      { label: req.t('Cost items'), href: `${basePath}/items` },
      { label: mode === 'create' ? req.t('New cost item') : req.t('Edit cost item') },
    ],
    mode,
    action: mode === 'create' ? `${basePath}/items` : `${basePath}/items/${itemId}`,
    itemId,
    row,
    errors,
  };
}

function alertList(data, req, res) {
  const alerts = [];
  const t = req.t;
  const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
  const money = (value) => formatMoney(value, currency, req.locale);

  if (data.netRevenue <= 0) {
    alerts.push({
      tone: 'info',
      title: t('No invoiced sales in this period'),
      message: t('Contribution margin and break-even need sales invoices in the selected month.'),
      href: '/sales',
      action: t('Open sales invoices'),
    });
  }

  if (data.costItems.length && data.fixedRunRate <= 0) {
    alerts.push({
      tone: 'warning',
      title: t('No recurring fixed costs'),
      message: t('Add fixed costs such as rent, salaries or insurance so break-even can be calculated.'),
      href: `${basePath}/items/new`,
      action: t('Add fixed cost'),
    });
  }

  if (data.netRevenue > 0 && data.cmRatio <= 0) {
    alerts.push({
      tone: 'error',
      title: t('Contribution margin is zero or negative'),
      message: t('Variable costs are equal to or higher than net revenue. Review product costs and variable cost rates.'),
      href: `${basePath}/items`,
      action: t('Review cost items'),
    });
  }

  if (data.breakEvenRevenue !== null && data.netRevenue > 0 && data.netRevenue < data.breakEvenRevenue) {
    alerts.push({
      tone: 'warning',
      title: t('Revenue is below break-even'),
      message: t('The selected month is {amount} below break-even revenue.', {
        amount: money(data.breakEvenRevenue - data.netRevenue),
      }),
      href: `${basePath}/items`,
      action: t('Review cost structure'),
    });
  }

  if (data.operatingProfit < 0) {
    alerts.push({
      tone: 'warning',
      title: t('Operating loss in this period'),
      message: t('Contribution margin does not cover fixed costs for the selected month.'),
    });
  }

  if (data.missingCostProducts.length) {
    const names = data.missingCostProducts.slice(0, 3).map((product) => product.name).join(', ');
    alerts.push({
      tone: 'warning',
      title: t('Products with sales have no cost'),
      message: t('{count} products are missing a cost. Add a product cost or an active BOM so contribution margin is calculated correctly. Products: {names}', {
        count: data.missingCostProducts.length,
        names,
      }),
      href: '/products',
      action: t('Review products'),
    });
  }

  if (data.zeroRateItems.length) {
    alerts.push({
      tone: 'warning',
      title: t('Variable cost items without a rate'),
      message: t('{count} variable cost items have a zero driver rate and add nothing to the analysis.', {
        count: data.zeroRateItems.length,
      }),
      href: `${basePath}/items?behavior=variable`,
      action: t('Review variable costs'),
    });
  }

  if (data.invalidScopeItems.length) {
    alerts.push({
      tone: 'warning',
      title: t('Variable costs with a missing scope'),
      message: t('{count} active variable costs point to a product or category that no longer exists.', {
        count: data.invalidScopeItems.length,
      }),
      href: `${basePath}/items?behavior=variable`,
      action: t('Review variable costs'),
    });
  }

  if (data.fixedWithoutActuals.length) {
    alerts.push({
      tone: 'info',
      title: t('Fixed costs without an actual this month'),
      message: t('{count} fixed costs have no actual for this month. Enter monthly actuals to compare the recurring plan with what was really spent.', {
        count: data.fixedWithoutActuals.length,
      }),
      href: `${basePath}/actuals?period=${data.range.period}`,
      action: t('Enter monthly actuals'),
    });
  }

  if (data.unallocatedVariable > 0) {
    alerts.push({
      tone: 'info',
      title: t('Some variable costs are not allocated to products'),
      message: t('Invoice, pallet and labour-hour drivers are included in the company totals but not in individual product margins.'),
    });
  }

  return alerts;
}

// ------------------------------------------------------------------ dashboard
router.get('/', (req, res) => res.redirect(basePath));

router.get('/costs', async (req, res, next) => {
  try {
    const period = finance.normalizePeriod(req.query.period, currentPeriod());
    const data = await finance.buildCostDashboard(period);
    const settings = res.locals.settings || {};
    const currency = settings.currency || 'USD';

    res.render('finance/costs', {
      ...data,
      title: req.t('Costs & profitability'),
      active: 'finance-costs',
      breadcrumbs: [{ label: req.t('Costs & profitability') }],
      period,
      periodLabel: periodLabel(req.locale, period),
      previousPeriod: finance.shiftPeriod(period, -1),
      nextPeriod: finance.shiftPeriod(period, 1),
      money: (value) => formatMoney(value, currency, req.locale),
      alerts: alertList(data, req, res),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- cost items
router.get('/costs/items', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const behavior = String(req.query.behavior || '');
    const status = String(req.query.status || '');
    const where = [];
    const params = [];
    if (search) {
      where.push('(ci.name LIKE ? OR ci.notes LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (finance.BEHAVIORS.includes(behavior)) {
      where.push('ci.behavior = ?');
      params.push(behavior);
    }
    if (STATUSES.includes(status)) {
      where.push('ci.status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await query(
      `SELECT ci.*, cc.name AS category_name, ctr.name AS cost_center_name,
              p.name AS scope_product_name, pc.name AS scope_category_name
         FROM cost_items ci
         LEFT JOIN cost_categories cc ON cc.id = ci.category_id
         LEFT JOIN cost_centers ctr ON ctr.id = ci.cost_center_id
         LEFT JOIN products p ON p.id = ci.scope_product_id
         LEFT JOIN product_categories pc ON pc.id = ci.scope_category_id
         ${whereSql}
        ORDER BY FIELD(ci.behavior, 'fixed', 'semi_variable', 'stepped', 'variable'), ci.name`,
      params,
    );
    for (const row of rows) {
      row.monthly_fixed = finance.monthlyFixedAmount(row);
      row.scope_label = row.scope_type === 'product'
        ? row.scope_product_name
        : row.scope_type === 'category'
          ? row.scope_category_name
          : null;
    }

    res.render('finance/items', {
      title: req.t('Cost items'),
      active: 'finance-costs',
      breadcrumbs: [
        { label: req.t('Costs & profitability'), href: basePath },
        { label: req.t('Cost items') },
      ],
      rows,
      search,
      behavior,
      status,
      behaviors: finance.BEHAVIORS,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/costs/items/new', async (req, res, next) => {
  try {
    const options = await loadFormOptions();
    res.render('finance/item-form', {
      ...itemFormState(req, itemDefaults(finance.normalizePeriod(req.query.period, currentPeriod())), {}, 'create'),
      ...options,
      behaviors: finance.BEHAVIORS,
      frequencies: finance.FREQUENCIES,
      driverTypes: finance.DRIVER_TYPES,
      scopes: finance.SCOPES,
      amountBases: finance.AMOUNT_BASES,
      statuses: STATUSES,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/costs/items', async (req, res, next) => {
  try {
    const { values, errors } = validateItem(req.body);
    if (Object.keys(errors).length) {
      const options = await loadFormOptions(formOptionIds(values));
      return res.status(422).render('finance/item-form', {
        ...itemFormState(req, values, errors, 'create'),
        ...options,
        behaviors: finance.BEHAVIORS,
        frequencies: finance.FREQUENCIES,
        driverTypes: finance.DRIVER_TYPES,
        scopes: finance.SCOPES,
        amountBases: finance.AMOUNT_BASES,
        statuses: STATUSES,
      });
    }
    await query(
      `INSERT INTO cost_items
         (name, category_id, cost_center_id, behavior, amount, frequency, driver_type, driver_rate,
          scope_type, scope_product_id, scope_category_id, amount_basis, vat_rate, vat_recoverable,
          is_non_cash, payment_days, payment_day, effective_from, effective_to, supplier_id, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.name, values.category_id, values.cost_center_id, values.behavior, values.amount, values.frequency,
        values.driver_type, values.driver_rate, values.scope_type, values.scope_product_id, values.scope_category_id,
        values.amount_basis, values.vat_rate, values.vat_recoverable, values.is_non_cash, values.payment_days,
        values.payment_day, values.effective_from, values.effective_to, values.supplier_id, values.notes,
        values.status, req.session.user.id,
      ],
    );
    req.flash('success', '{item} created successfully.', { item: req.t('Cost item') });
    res.redirect(`${basePath}/items`);
  } catch (err) {
    next(err);
  }
});

router.get('/costs/items/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM cost_items WHERE id = ? LIMIT 1', [req.params.id]);
    if (!row) return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Cost item') })), { status: 404 }));
    const options = await loadFormOptions({
      categoryId: row.category_id,
      centerId: row.cost_center_id,
      productId: row.scope_product_id,
      productCategoryId: row.scope_category_id,
      supplierId: row.supplier_id,
    });
    res.render('finance/item-form', {
      ...itemFormState(req, row, {}, 'edit', row.id),
      ...options,
      behaviors: finance.BEHAVIORS,
      frequencies: finance.FREQUENCIES,
      driverTypes: finance.DRIVER_TYPES,
      scopes: finance.SCOPES,
      amountBases: finance.AMOUNT_BASES,
      statuses: STATUSES,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/costs/items/:id(\\d+)', async (req, res, next) => {
  try {
    const existing = await one('SELECT * FROM cost_items WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existing) return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Cost item') })), { status: 404 }));
    const { values, errors } = validateItem(req.body, existing);
    if (Object.keys(errors).length) {
      const options = await loadFormOptions(formOptionIds(values));
      return res.status(422).render('finance/item-form', {
        ...itemFormState(req, values, errors, 'edit', existing.id),
        ...options,
        behaviors: finance.BEHAVIORS,
        frequencies: finance.FREQUENCIES,
        driverTypes: finance.DRIVER_TYPES,
        scopes: finance.SCOPES,
        amountBases: finance.AMOUNT_BASES,
        statuses: STATUSES,
      });
    }
    await query(
      `UPDATE cost_items
          SET name = ?, category_id = ?, cost_center_id = ?, behavior = ?, amount = ?, frequency = ?,
              driver_type = ?, driver_rate = ?, scope_type = ?, scope_product_id = ?, scope_category_id = ?,
              amount_basis = ?, vat_rate = ?, vat_recoverable = ?, is_non_cash = ?, payment_days = ?,
              payment_day = ?, effective_from = ?, effective_to = ?, supplier_id = ?, notes = ?, status = ?
        WHERE id = ?`,
      [
        values.name, values.category_id, values.cost_center_id, values.behavior, values.amount, values.frequency,
        values.driver_type, values.driver_rate, values.scope_type, values.scope_product_id, values.scope_category_id,
        values.amount_basis, values.vat_rate, values.vat_recoverable, values.is_non_cash, values.payment_days,
        values.payment_day, values.effective_from, values.effective_to, values.supplier_id, values.notes,
        values.status, existing.id,
      ],
    );
    req.flash('success', '{item} updated successfully.', { item: req.t('Cost item') });
    res.redirect(`${basePath}/items`);
  } catch (err) {
    next(err);
  }
});

router.post('/costs/items/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const existing = await one('SELECT id, name FROM cost_items WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existing) return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Cost item') })), { status: 404 }));
    const actuals = await one('SELECT COUNT(*) AS c FROM cost_actuals WHERE cost_item_id = ?', [existing.id]);
    if (Number(actuals.c) > 0) {
      req.flash('error', 'This cost item has actual costs. Mark it inactive instead of deleting it.');
      return res.redirect(`${basePath}/items`);
    }
    await query('DELETE FROM cost_items WHERE id = ?', [existing.id]);
    req.flash('success', '{item} deleted.', { item: req.t('Cost item') });
    res.redirect(`${basePath}/items`);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- actual costs
router.get('/costs/actuals', async (req, res, next) => {
  try {
    const period = finance.normalizePeriod(req.query.period, currentPeriod());
    const data = await finance.buildCostDashboard(period);
    const settings = res.locals.settings || {};
    const currency = settings.currency || 'USD';

    res.render('finance/actuals', {
      title: req.t('Monthly actual costs'),
      active: 'finance-costs',
      breadcrumbs: [
        { label: req.t('Costs & profitability'), href: basePath },
        { label: req.t('Monthly actuals') },
      ],
      period,
      periodLabel: periodLabel(req.locale, period),
      previousPeriod: finance.shiftPeriod(period, -1),
      nextPeriod: finance.shiftPeriod(period, 1),
      ...data,
      posted: null,
      errors: {},
      money: (value) => formatMoney(value, currency, req.locale),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/costs/actuals', async (req, res, next) => {
  try {
    const period = finance.normalizePeriod(req.body.period, currentPeriod());
    const items = await finance.loadCostItems({ activeOnly: true, period });
    const validIds = new Set(items.map((item) => Number(item.id)));
    const values = {};
    const errors = {};

    for (const item of items) {
      const key = `amount_${item.id}`;
      const raw = req.body[key];
      if (raw === undefined) continue;
      const text = String(raw).trim();
      if (!text) {
        values[item.id] = '';
        continue;
      }
      const amount = Number(text.replace(/,/g, ''));
      if (!Number.isFinite(amount) || amount < 0) {
        errors[key] = req.t('Enter a valid amount of zero or more.');
        values[item.id] = text;
      } else {
        values[item.id] = finance.round2(amount);
      }
    }

    if (Object.keys(errors).length) {
      const data = await finance.buildCostDashboard(period);
      const settings = res.locals.settings || {};
      const currency = settings.currency || 'USD';
      return res.status(422).render('finance/actuals', {
        title: req.t('Monthly actual costs'),
        active: 'finance-costs',
        breadcrumbs: [
          { label: req.t('Costs & profitability'), href: basePath },
          { label: req.t('Monthly actuals') },
        ],
        period,
        periodLabel: periodLabel(req.locale, period),
        previousPeriod: finance.shiftPeriod(period, -1),
        nextPeriod: finance.shiftPeriod(period, 1),
        ...data,
        posted: values,
        errors,
        money: (value) => formatMoney(value, currency, req.locale),
      });
    }

    await withTransaction(async (conn) => {
      for (const [itemId, value] of Object.entries(values)) {
        if (!validIds.has(Number(itemId))) continue;
        if (value === '') {
          await conn.query('DELETE FROM cost_actuals WHERE cost_item_id = ? AND period = ?', [itemId, period]);
          continue;
        }
        await conn.query(
          `INSERT INTO cost_actuals (cost_item_id, period, amount, source, created_by)
           VALUES (?, ?, ?, 'manual', ?)
           ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = 'manual', created_by = VALUES(created_by)`,
          [itemId, period, value, req.session.user.id],
        );
      }
    });

    req.flash('success', 'Monthly actual costs saved.');
    res.redirect(`${basePath}/actuals?period=${period}`);
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- cost setup
async function loadSetupData() {
  const [centers, categories] = await Promise.all([
    query(
      `SELECT c.*, (SELECT COUNT(*) FROM cost_items ci WHERE ci.cost_center_id = c.id) AS item_count
         FROM cost_centers c ORDER BY c.name`,
    ),
    query(
      `SELECT c.*, (SELECT COUNT(*) FROM cost_items ci WHERE ci.category_id = c.id) AS item_count
         FROM cost_categories c ORDER BY c.name`,
    ),
  ]);
  return { centers, categories };
}

function setupState(req, { editCenter = null, editCategory = null, errors = {}, posted = {}, errorForm = null } = {}) {
  return {
    title: req.t('Cost setup'),
    active: 'finance-costs',
    breadcrumbs: [
      { label: req.t('Costs & profitability'), href: basePath },
      { label: req.t('Cost setup') },
    ],
    editCenter,
    editCategory,
    errors,
    posted,
    errorForm,
  };
}

router.get('/costs/setup', async (req, res, next) => {
  try {
    const { centers, categories } = await loadSetupData();
    const editCenter = req.query.edit_center
      ? await one('SELECT * FROM cost_centers WHERE id = ? LIMIT 1', [req.query.edit_center])
      : null;
    const editCategory = req.query.edit_category
      ? await one('SELECT * FROM cost_categories WHERE id = ? LIMIT 1', [req.query.edit_category])
      : null;
    res.render('finance/setup', {
      ...setupState(req, { editCenter, editCategory }),
      centers,
      categories,
    });
  } catch (err) {
    next(err);
  }
});

async function saveSetupRecord(req, res, next, { table, singular }) {
  try {
    const id = req.params.id ? Number(req.params.id) : null;
    const existing = id ? await one(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [id]) : null;
    if (id && !existing) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t(singular) })), { status: 404 }));
    }
    const name = textValue(req.body.name, 120);
    const description = textValue(req.body.description, 255);
    const code = table === 'cost_centers' ? textValue(req.body.code, 30) : null;
    const status = STATUSES.includes(req.body.status) ? req.body.status : 'active';
    const errors = {};
    if (!name) errors.name = req.t('Name is required.');
    const duplicate = name
      ? await one(`SELECT id FROM ${table} WHERE name = ? AND id <> ? LIMIT 1`, [name, existing ? existing.id : 0])
      : null;
    if (duplicate) errors.name = req.t('A record with this name already exists.');

    if (Object.keys(errors).length) {
      const { centers, categories } = await loadSetupData();
      const editCenter = table === 'cost_centers'
        ? { ...(existing || {}), ...req.body, name, code, description, status }
        : null;
      const editCategory = table === 'cost_categories'
        ? { ...(existing || {}), ...req.body, name, description, status }
        : null;
      return res.status(422).render('finance/setup', {
        ...setupState(req, {
          editCenter,
          editCategory,
          errors,
          posted: { ...req.body, name },
          errorForm: table === 'cost_centers' ? 'center' : 'category',
        }),
        centers,
        categories,
      });
    }

    if (existing) {
      if (table === 'cost_centers') {
        await query('UPDATE cost_centers SET name = ?, code = ?, description = ?, status = ? WHERE id = ?', [
          name, code, description, status, existing.id,
        ]);
      } else {
        await query('UPDATE cost_categories SET name = ?, description = ?, status = ? WHERE id = ?', [
          name, description, status, existing.id,
        ]);
      }
      req.flash('success', '{item} updated successfully.', { item: req.t(singular) });
    } else if (table === 'cost_centers') {
      await query('INSERT INTO cost_centers (name, code, description, status) VALUES (?, ?, ?, ?)', [
        name, code, description, status,
      ]);
      req.flash('success', '{item} created successfully.', { item: req.t(singular) });
    } else {
      await query('INSERT INTO cost_categories (name, description, status) VALUES (?, ?, ?)', [
        name, description, status,
      ]);
      req.flash('success', '{item} created successfully.', { item: req.t(singular) });
    }
    res.redirect(`${basePath}/setup`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', req.t('A record with this name already exists.'));
      return res.redirect(`${basePath}/setup`);
    }
    next(err);
  }
}

router.post('/costs/centers', (req, res, next) =>
  saveSetupRecord(req, res, next, { table: 'cost_centers', singular: 'Cost center' }));
router.post('/costs/centers/:id(\\d+)', (req, res, next) =>
  saveSetupRecord(req, res, next, { table: 'cost_centers', singular: 'Cost center' }));
router.post('/costs/categories', (req, res, next) =>
  saveSetupRecord(req, res, next, { table: 'cost_categories', singular: 'Cost category' }));
router.post('/costs/categories/:id(\\d+)', (req, res, next) =>
  saveSetupRecord(req, res, next, { table: 'cost_categories', singular: 'Cost category' }));

router.post('/costs/centers/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const count = await one('SELECT COUNT(*) AS c FROM cost_items WHERE cost_center_id = ?', [req.params.id]);
    if (Number(count.c) > 0) {
      req.flash('error', req.t('This cost center is used by cost items. Mark it inactive instead.'));
      return res.redirect(`${basePath}/setup`);
    }
    await query('DELETE FROM cost_centers WHERE id = ?', [req.params.id]);
    req.flash('success', '{item} deleted.', { item: req.t('Cost center') });
    res.redirect(`${basePath}/setup`);
  } catch (err) {
    next(err);
  }
});

router.post('/costs/categories/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const count = await one('SELECT COUNT(*) AS c FROM cost_items WHERE category_id = ?', [req.params.id]);
    if (Number(count.c) > 0) {
      req.flash('error', req.t('This cost category is used by cost items. Mark it inactive instead.'));
      return res.redirect(`${basePath}/setup`);
    }
    await query('DELETE FROM cost_categories WHERE id = ?', [req.params.id]);
    req.flash('success', '{item} deleted.', { item: req.t('Cost category') });
    res.redirect(`${basePath}/setup`);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------- actuals CSV import
function csvNumber(value) {
  const text = String(value === undefined || value === null ? '' : value).trim().replace(/\s+/g, '');
  if (!text) return NaN;
  if (text.includes(',') && text.includes('.')) {
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    return lastComma > lastDot
      ? Number(text.replace(/\./g, '').replace(',', '.'))
      : Number(text.replace(/,/g, ''));
  }
  if (text.includes(',') && !text.includes('.')) return Number(text.replace(',', '.'));
  return Number(text);
}

function renderActualsImport(req, res, { errors = [], preview = [], period = currentPeriod(), status = 200 } = {}) {
  res.status(status).render('finance/actuals-import', {
    title: req.t('Import monthly actuals'),
    active: 'finance-costs',
    breadcrumbs: [
      { label: req.t('Costs & profitability'), href: basePath },
      { label: req.t('Monthly actuals'), href: `${basePath}/actuals` },
      { label: req.t('Import CSV') },
    ],
    errors,
    preview,
    period,
  });
}

router.get('/costs/actuals/import', (req, res) => {
  const period = finance.normalizePeriod(req.query.period, currentPeriod());
  renderActualsImport(req, res, { period });
});

router.get('/costs/actuals/import/template', async (req, res, next) => {
  try {
    const period = finance.normalizePeriod(req.query.period, currentPeriod());
    const items = await finance.loadCostItems({ activeOnly: true, period });
    const rows = items.map((item) => [item.name, period, '', '']);
    const csv = `\uFEFF${toCsv(['cost_item', 'period', 'amount', 'notes'], rows)}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="actual-costs-template-${period}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.post('/costs/actuals/import', async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return renderActualsImport(req, res, {
        errors: [req.t('Choose a CSV file to import.')],
        status: 422,
      });
    }
    const source = req.file.buffer.toString('utf8');
    const rows = parseCsv(source);
    if (rows.length < 2) {
      return renderActualsImport(req, res, {
        errors: [req.t('The CSV file is empty or has no data rows.')],
        status: 422,
      });
    }
    if (rows.length > 1001) {
      return renderActualsImport(req, res, {
        errors: [req.t('The CSV file has too many rows. Import at most 1,000 rows at a time.')],
        status: 422,
      });
    }

    const header = rows[0].map((value) => String(value).trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const index = {
      cost_item: header.indexOf('cost_item'),
      period: header.indexOf('period'),
      amount: header.indexOf('amount'),
      notes: header.indexOf('notes'),
    };
    if (index.cost_item < 0 || index.period < 0 || index.amount < 0) {
      return renderActualsImport(req, res, {
        errors: [req.t('The CSV must include the columns cost_item, period and amount.')],
        status: 422,
      });
    }

    const costItems = await query('SELECT id, name FROM cost_items ORDER BY name');
    const byId = new Map(costItems.map((item) => [Number(item.id), item]));
    const byName = new Map();
    for (const item of costItems) {
      const key = String(item.name || '').trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(item);
    }

    const errors = [];
    const preview = [];
    const validRows = [];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const line = rowIndex + 1;
      const rawItem = String(row[index.cost_item] || '').trim();
      const rawPeriod = String(row[index.period] || '').trim().slice(0, 7);
      const rawAmount = row[index.amount];
      const note = index.notes >= 0 ? String(row[index.notes] || '').trim().slice(0, 500) : '';

      let item = null;
      let error = null;
      const numericId = Number.parseInt(rawItem, 10);
      if (Number.isFinite(numericId) && byId.has(numericId)) {
        item = byId.get(numericId);
      } else {
        const matches = byName.get(rawItem.toLowerCase()) || [];
        if (matches.length === 1) item = matches[0];
        else if (matches.length > 1) error = req.t('Row {row}: the cost item name "{name}" is ambiguous. Use the cost item ID instead.', { row: line, name: rawItem });
        else error = req.t('Row {row}: cost item "{name}" was not found.', { row: line, name: rawItem });
      }

      if (!item && !error) error = req.t('Row {row}: cost item is required.', { row: line });
      if (!error && !/^\d{4}-(0[1-9]|1[0-2])$/.test(rawPeriod)) {
        error = req.t('Row {row}: period must use the YYYY-MM format.', { row: line });
      }
      const amount = csvNumber(rawAmount);
      if (!error && (!Number.isFinite(amount) || amount < 0)) {
        error = req.t('Row {row}: amount must be zero or more.', { row: line });
      }

      preview.push({
        line,
        item_name: item ? item.name : rawItem,
        period: rawPeriod,
        amount: Number.isFinite(amount) ? finance.round2(amount) : rawAmount,
        notes: note,
        error,
      });
      if (error) {
        errors.push(error);
      } else {
        validRows.push({
          cost_item_id: item.id,
          period: rawPeriod,
          amount: finance.round2(amount),
          notes: note || null,
        });
      }
    }

    if (errors.length) {
      return renderActualsImport(req, res, {
        errors: errors.slice(0, 50),
        preview: preview.slice(0, 100),
        status: 422,
      });
    }

    if (!validRows.length) {
      return renderActualsImport(req, res, {
        errors: [req.t('No valid rows were found in the CSV file.')],
        status: 422,
      });
    }

    await withTransaction(async (conn) => {
      for (const row of validRows) {
        await conn.query(
          `INSERT INTO cost_actuals (cost_item_id, period, amount, source, notes, created_by)
           VALUES (?, ?, ?, 'import', ?, ?)
           ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = 'import', notes = VALUES(notes), created_by = VALUES(created_by)`,
          [row.cost_item_id, row.period, row.amount, row.notes, req.session.user.id],
        );
      }
    });

    req.flash('success', 'Imported {count} monthly actual costs.', { count: validRows.length });
    res.redirect(`${basePath}/actuals?period=${validRows[0].period}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.actualsUpload = actualsUpload;
