'use strict';

const express = require('express');
const { query, one, withTransaction } = require('../db');
const { todayISO, toNumber, formatMoney } = require('../lib/helpers');
const finance = require('../lib/finance');
const simulator = require('../lib/simulator');
const { toCsv } = require('../lib/csv');

const router = express.Router();
const basePath = '/finance/simulator';

function currentPeriod() {
  return todayISO().slice(0, 7);
}

function defaultStartPeriod() {
  return finance.shiftPeriod(currentPeriod(), 1);
}

function periodLabel(locale, period) {
  const date = new Date(`${period}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function textValue(value, maxLength = 255) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, maxLength) || null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function scenarioDefaults() {
  return {
    name: '',
    description: '',
    start_period: defaultStartPeriod(),
    horizon_months: 6,
    status: 'draft',
    collection_days: 30,
    payment_days: 30,
    inventory_days: 30,
    starting_cash: 0,
  };
}

function scenarioValues(body, existing = null) {
  const defaults = existing
    ? {
        ...scenarioDefaults(),
        ...existing,
        ...simulator.parseAssumptions(existing.assumptions),
      }
    : scenarioDefaults();
  return {
    name: textValue(body.name, 180),
    description: textValue(body.description, 500),
    start_period: String(body.start_period || defaults.start_period || '').slice(0, 7),
    horizon_months: String(body.horizon_months || defaults.horizon_months || 6),
    status: simulator.STATUSES.includes(body.status) ? body.status : (existing ? existing.status : 'draft'),
    collection_days: String(body.collection_days !== undefined ? body.collection_days : defaults.collection_days),
    payment_days: String(body.payment_days !== undefined ? body.payment_days : defaults.payment_days),
    inventory_days: String(body.inventory_days !== undefined ? body.inventory_days : defaults.inventory_days),
    starting_cash: String(body.starting_cash !== undefined ? body.starting_cash : defaults.starting_cash),
  };
}

function validateScenario(values, t) {
  const errors = [];
  if (!values.name) errors.push(t('Scenario name is required.'));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(values.start_period)) {
    errors.push(t('Select a valid start month.'));
  }
  const horizon = Number.parseInt(values.horizon_months, 10);
  if (!Number.isFinite(horizon) || horizon < simulator.HORIZON_MIN || horizon > simulator.HORIZON_MAX) {
    errors.push(t('The horizon must be between {min} and {max} months.', {
      min: simulator.HORIZON_MIN,
      max: simulator.HORIZON_MAX,
    }));
  }
  if (!simulator.STATUSES.includes(values.status)) errors.push(t('Select a valid scenario status.'));
  return errors;
}

function assumptionsFromValues(values) {
  return {
    collection_days: clamp(values.collection_days, 0, 365, 30),
    payment_days: clamp(values.payment_days, 0, 365, 30),
    inventory_days: clamp(values.inventory_days, 0, 365, 30),
    starting_cash: toNumber(values.starting_cash, 0),
  };
}

async function loadProducts(currentIds = []) {
  const ids = [...new Set(currentIds.map((id) => Number(id)).filter((id) => id > 0))];
  const base = 'SELECT id, sku, name, type, unit, sale_price, sale_vat_rate, status, is_sellable FROM products';
  if (!ids.length) {
    return query(`${base} WHERE status = 'active' AND is_sellable = 1 ORDER BY name`);
  }
  const placeholders = ids.map(() => '?').join(', ');
  return query(
    `${base} WHERE (status = 'active' AND is_sellable = 1) OR id IN (${placeholders}) ORDER BY name`,
    ids,
  );
}

async function loadCustomers(currentIds = []) {
  const ids = [...new Set(currentIds.map((id) => Number(id)).filter((id) => id > 0))];
  const base = 'SELECT id, company_name, status FROM customers';
  if (!ids.length) {
    return query(`${base} WHERE status = 'active' ORDER BY company_name`);
  }
  const placeholders = ids.map(() => '?').join(', ');
  return query(
    `${base} WHERE status = 'active' OR id IN (${placeholders}) ORDER BY company_name`,
    ids,
  );
}

async function loadCostItemsForEdit() {
  const items = await finance.loadCostItems({ activeOnly: true });
  return items.map((item) => ({
    ...item,
    is_fixed: finance.isFixedBehavior(item),
    is_variable: finance.isVariableBehavior(item),
    base_fixed: finance.monthlyFixedAmount(item),
    base_rate: Number(item.driver_rate) || 0,
    base_amount: Number(item.amount) || 0,
  }));
}

function buildRowsFromLines(lines, periods) {
  const rows = new Map();
  for (const line of lines) {
    const key = `${line.product_id}:${line.customer_id || 0}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        product_id: Number(line.product_id),
        customer_id: line.customer_id ? Number(line.customer_id) : null,
        product_name: line.name,
        sku: line.sku,
        customer_name: line.customer_name || null,
        unit_price: Number(line.unit_price) || 0,
        discount_pct: Number(line.discount_pct) || 0,
        quantities: Object.fromEntries(periods.map((period) => [period, 0])),
        has_qty: false,
      };
      rows.set(key, row);
    }
    const period = String(line.period).slice(0, 7);
    if (Object.prototype.hasOwnProperty.call(row.quantities, period)) {
      row.quantities[period] = finance.round3((row.quantities[period] || 0) + (Number(line.quantity) || 0));
      if (row.quantities[period] > 0) row.has_qty = true;
    }
  }
  return [...rows.values()];
}

function parseBasket(body, periods, productMap, customerMap, t) {
  const productIds = asArray(body.product_id);
  const customerIds = asArray(body.customer_id);
  const prices = asArray(body.unit_price);
  const discounts = asArray(body.discount_pct);
  const qty = body.qty && typeof body.qty === 'object' ? body.qty : {};
  const rows = [];
  const lines = [];
  const errors = [];

  for (let index = 0; index < productIds.length; index += 1) {
    const productId = Number.parseInt(productIds[index], 10);
    if (!productId) continue;
    const product = productMap.get(String(productId));
    if (!product) {
      errors.push(t('Invalid product in basket row {row}.', { row: index + 1 }));
      continue;
    }
    const customerId = Number.parseInt(customerIds[index], 10) || null;
    if (customerId && !customerMap.has(String(customerId))) {
      errors.push(t('Invalid customer in basket row {row}.', { row: index + 1 }));
      continue;
    }
    const rawPrice = prices[index];
    const price = rawPrice === undefined || rawPrice === null || String(rawPrice).trim() === ''
      ? 0
      : Number(rawPrice);
    if (!Number.isFinite(price) || price < 0) {
      errors.push(t('Enter a valid net price in basket row {row}.', { row: index + 1 }));
      continue;
    }
    const discount = discounts[index] === undefined || discounts[index] === ''
      ? 0
      : Number(discounts[index]);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      errors.push(t('The discount in basket row {row} must be between 0 and 100.', { row: index + 1 }));
      continue;
    }

    const quantities = {};
    let hasQuantity = false;
    for (const period of periods) {
      const list = asArray(qty[period]);
      const quantity = Math.max(0, Number(list[index]) || 0);
      quantities[period] = finance.round3(quantity);
      if (quantity > 0) {
        hasQuantity = true;
        lines.push({
          product_id: productId,
          customer_id: customerId,
          period,
          quantity: finance.round3(quantity),
          unit_price: finance.round2(price),
          discount_pct: finance.round2(discount),
        });
      }
    }

    rows.push({
      product_id: productId,
      customer_id: customerId,
      product_name: product.name,
      sku: product.sku,
      customer_name: customerId ? (customerMap.get(String(customerId)) || {}).company_name || null : null,
      unit_price: price,
      discount_pct: discount,
      quantities,
      has_qty: hasQuantity,
    });
  }

  if (!lines.length) {
    errors.push(t('Add at least one product and a quantity greater than zero.'));
  }
  return { rows, lines, errors };
}

function parseOverrides(body, costItems, t) {
  const map = new Map();
  const errors = [];
  for (const item of costItems) {
    const amountRaw = body[`override_amount_${item.id}`];
    const rateRaw = body[`override_rate_${item.id}`];
    const amount = amountRaw === undefined || amountRaw === null || String(amountRaw).trim() === ''
      ? null
      : Number(amountRaw);
    const rate = rateRaw === undefined || rateRaw === null || String(rateRaw).trim() === ''
      ? null
      : Number(rateRaw);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      errors.push(t('The fixed-cost override for {item} must be zero or more.', { item: item.name }));
      continue;
    }
    if (rate !== null && (!Number.isFinite(rate) || rate < 0)) {
      errors.push(t('The driver-rate override for {item} must be zero or more.', { item: item.name }));
      continue;
    }
    if (rate !== null && ['revenue_percent', 'material_percent'].includes(String(item.driver_type)) && rate > 100) {
      errors.push(t('The percentage override for {item} cannot exceed 100%.', { item: item.name }));
      continue;
    }
    if (amount !== null || rate !== null) {
      map.set(Number(item.id), { amount, driver_rate: rate });
    }
  }
  return { map, errors };
}

async function loadScenarioOr404(id, req) {
  const scenario = await simulator.loadScenario(id);
  if (!scenario) {
    const error = new Error(req.t('{item} not found.', { item: req.t('Scenario') }));
    error.status = 404;
    throw error;
  }
  return scenario;
}

function assertEditable(scenario, req) {
  if (['locked', 'archived'].includes(String(scenario.status))) {
    const error = new Error(req.t('Unlock this scenario before editing it.'));
    error.status = 409;
    throw error;
  }
}

async function renderEdit(req, res, { scenario, rows, overrides, errors = [], targetStatus = 200 }) {
  const periods = simulator.periodsForScenario(scenario.start_period, scenario.horizon_months);
  const [products, customers, costItems] = await Promise.all([
    loadProducts(rows.map((row) => row.product_id)),
    loadCustomers(rows.map((row) => row.customer_id).filter(Boolean)),
    loadCostItemsForEdit(),
  ]);
  const productMap = new Map(products.map((product) => [String(product.id), product]));
  const customerMap = new Map(customers.map((customer) => [String(customer.id), customer]));
  for (const row of rows) {
    const product = productMap.get(String(row.product_id));
    if (product) {
      row.product_name = product.name;
      row.sku = product.sku;
    }
    row.customer_name = row.customer_id
      ? (customerMap.get(String(row.customer_id)) || {}).company_name || row.customer_name
      : null;
  }

  res.status(targetStatus).render('finance/simulator/edit', {
    title: req.t('Edit scenario'),
    active: 'finance-simulator',
    breadcrumbs: [
      { label: req.t('Sales simulator'), href: basePath },
      { label: scenario.name || req.t('New scenario') },
    ],
    scenario,
    periods,
    periodLabels: Object.fromEntries(periods.map((period) => [period, periodLabel(req.locale, period)])),
    rows,
    products,
    customers,
    costItems,
    overrides,
    errors,
    productData: Object.fromEntries(products.map((product) => [
      String(product.id),
      {
        price: simulator.netSalePrice(product),
        name: product.name,
        sku: product.sku,
      },
    ])),
    statuses: simulator.STATUSES,
    money: (value) => formatMoney(value, (res.locals.settings && res.locals.settings.currency) || 'USD', req.locale),
  });
}

function resultAlerts(result, req) {
  return (result.alerts || []).map((alert) => {
    switch (alert.code) {
      case 'no_lines':
        return {
          tone: 'info',
          title: req.t('This scenario has no sales lines'),
          message: req.t('Add products and monthly quantities to see revenue, profit and purchase projections.'),
          href: `${basePath}/${result.scenario.id}/edit`,
          action: req.t('Edit scenario'),
        };
      case 'no_costs':
        return {
          tone: 'info',
          title: req.t('No cost items yet'),
          message: req.t('Add fixed and variable costs to include them in the projection.'),
          href: '/finance/costs/items/new',
          action: req.t('Add cost item'),
        };
      case 'missing_costs':
        return {
          tone: 'warning',
          title: req.t('Products with no cost'),
          message: req.t('Products without a cost: {count}. Contribution may be overstated.', { count: alert.count }),
          href: '/products',
          action: req.t('Review products'),
        };
      case 'no_bom':
        return {
          tone: 'warning',
          title: req.t('Manufactured products without a BOM'),
          message: req.t('Manufactured products without an active BOM: {count}. They were treated as purchased.', { count: alert.count }),
          href: '/manufacturing/boms',
          action: req.t('Review BOMs'),
        };
      case 'no_supplier':
        return {
          tone: 'warning',
          title: req.t('Purchase plan items without a supplier'),
          message: req.t('Purchase plan items without a supplier: {count}. Assign a default supplier to group them correctly.', { count: alert.count }),
          href: '/products',
          action: req.t('Review products'),
        };
      case 'labor_driver':
        return {
          tone: 'info',
          title: req.t('Labour-hour costs are not estimated'),
          message: req.t('Cost items using labour hours: {count}. The simulator cannot estimate labour hours, so those costs contribute zero.', { count: alert.count }),
          href: '/finance/costs/items?behavior=variable',
          action: req.t('Review variable costs'),
        };
      case 'scoped_variable_costs':
        return {
          tone: 'info',
          title: req.t('Some variable costs are not allocated to customers'),
          message: req.t('Variable costs with product or category scope: {count}. They are included in company and product totals but not in customer margins.', { count: alert.count }),
        };
      case 'negative_contribution':
        return {
          tone: 'error',
          title: req.t('Contribution is negative'),
          message: req.t('Variable costs are higher than projected revenue. Review prices, discounts and product costs.'),
        };
      case 'operating_loss':
        return {
          tone: 'warning',
          title: req.t('Operating loss in this scenario'),
          message: req.t('Contribution does not cover the fixed costs in the scenario horizon.'),
        };
      case 'no_fixed':
        return {
          tone: 'info',
          title: req.t('No fixed costs'),
          message: req.t('Add fixed costs to calculate a meaningful break-even point.'),
          href: '/finance/costs/items/new',
          action: req.t('Add fixed cost'),
        };
      default:
        return null;
    }
  }).filter(Boolean);
}

function sendCsv(res, filename, header, rows) {
  const content = `\uFEFF${toCsv(header, rows)}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(content);
}

// --------------------------------------------------------------------- index
router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim().toLowerCase();
    const status = String(req.query.status || '');
    let scenarios = await simulator.loadScenarioSummaries();
    if (search) {
      scenarios = scenarios.filter((scenario) => String(scenario.name || '').toLowerCase().includes(search)
        || String(scenario.description || '').toLowerCase().includes(search));
    }
    if (simulator.STATUSES.includes(status)) {
      scenarios = scenarios.filter((scenario) => scenario.status === status);
    }
    const counts = {
      total: scenarios.length,
      active: scenarios.filter((scenario) => scenario.status === 'active').length,
      draft: scenarios.filter((scenario) => scenario.status === 'draft').length,
      locked: scenarios.filter((scenario) => scenario.status === 'locked').length,
    };
    scenarios = scenarios.map((scenario) => ({
      ...scenario,
      start_label: periodLabel(req.locale, scenario.start_period),
    }));
    res.render('finance/simulator/index', {
      title: req.t('Sales simulator'),
      active: 'finance-simulator',
      breadcrumbs: [{ label: req.t('Sales simulator') }],
      scenarios,
      counts,
      search: req.query.q || '',
      status,
      statuses: simulator.STATUSES,
    });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------- new
router.get('/new', (req, res) => {
  res.render('finance/simulator/new', {
    title: req.t('New scenario'),
    active: 'finance-simulator',
    breadcrumbs: [
      { label: req.t('Sales simulator'), href: basePath },
      { label: req.t('New scenario') },
    ],
    values: scenarioDefaults(),
    errors: [],
    statuses: simulator.STATUSES,
    horizonMin: simulator.HORIZON_MIN,
    horizonMax: simulator.HORIZON_MAX,
  });
});

router.post('/', async (req, res, next) => {
  try {
    const values = scenarioValues(req.body);
    const errors = validateScenario(values, req.t);
    if (errors.length) {
      return res.status(422).render('finance/simulator/new', {
        title: req.t('New scenario'),
        active: 'finance-simulator',
        breadcrumbs: [
          { label: req.t('Sales simulator'), href: basePath },
          { label: req.t('New scenario') },
        ],
        values,
        errors,
        statuses: simulator.STATUSES,
        horizonMin: simulator.HORIZON_MIN,
        horizonMax: simulator.HORIZON_MAX,
      });
    }
    const assumptions = assumptionsFromValues(values);
    const [result] = await require('../db').getPool().query(
      `INSERT INTO planning_scenarios
         (name, description, start_period, horizon_months, status, assumptions, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        values.name,
        values.description,
        values.start_period,
        Number.parseInt(values.horizon_months, 10),
        values.status,
        JSON.stringify(assumptions),
        req.session.user.id,
      ],
    );
    req.flash('success', 'Scenario created. Add products to the sales basket.');
    res.redirect(`${basePath}/${result.insertId}/edit`);
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------------- edit
router.get('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    assertEditable(scenario, req);
    const periods = simulator.periodsForScenario(scenario.start_period, scenario.horizon_months);
    const lines = await simulator.loadScenarioLines(scenario.id);
    const rows = buildRowsFromLines(lines, periods);
    const overrides = await simulator.loadCostOverrides(scenario.id);
    await renderEdit(req, res, { scenario, rows, overrides });
  } catch (err) {
    if (err.status === 409) {
      req.flash('error', err.message);
      return res.redirect(`${basePath}/${req.params.id}`);
    }
    next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const existing = await loadScenarioOr404(req.params.id, req);
    assertEditable(existing, req);
    const values = scenarioValues(req.body, existing);
    const errors = validateScenario(values, req.t);
    const periods = simulator.periodsForScenario(values.start_period, values.horizon_months);
    const postedProductIds = asArray(req.body.product_id).map((id) => Number(id)).filter((id) => id > 0);
    const postedCustomerIds = asArray(req.body.customer_id).map((id) => Number(id)).filter((id) => id > 0);
    const [products, customers, costItems] = await Promise.all([
      loadProducts(postedProductIds),
      loadCustomers(postedCustomerIds),
      loadCostItemsForEdit(),
    ]);
    const productMap = new Map(products.map((product) => [String(product.id), product]));
    const customerMap = new Map(customers.map((customer) => [String(customer.id), customer]));
    const basket = parseBasket(req.body, periods, productMap, customerMap, req.t);
    const overrides = parseOverrides(req.body, costItems, req.t);
    errors.push(...basket.errors, ...overrides.errors);

    if (errors.length) {
      return renderEdit(req, res, {
        scenario: {
          ...existing,
          ...values,
          horizon_months: Number.parseInt(values.horizon_months, 10),
          assumptions: assumptionsFromValues(values),
        },
        rows: basket.rows,
        overrides: overrides.map,
        errors,
        targetStatus: 422,
      });
    }

    const assumptions = assumptionsFromValues(values);
    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE planning_scenarios
            SET name = ?, description = ?, start_period = ?, horizon_months = ?, status = ?, assumptions = ?
          WHERE id = ?`,
        [
          values.name,
          values.description,
          values.start_period,
          Number.parseInt(values.horizon_months, 10),
          values.status,
          JSON.stringify(assumptions),
          existing.id,
        ],
      );
      await conn.query('DELETE FROM scenario_sales_lines WHERE scenario_id = ?', [existing.id]);
      if (basket.lines.length) {
        await conn.query(
          `INSERT INTO scenario_sales_lines
             (scenario_id, product_id, customer_id, period, quantity, unit_price, discount_pct)
           VALUES ?`,
          [basket.lines.map((line) => [
            existing.id,
            line.product_id,
            line.customer_id,
            line.period,
            line.quantity,
            line.unit_price,
            line.discount_pct,
          ])],
        );
      }
      await conn.query('DELETE FROM scenario_cost_overrides WHERE scenario_id = ?', [existing.id]);
      if (overrides.map.size) {
        await conn.query(
          'INSERT INTO scenario_cost_overrides (scenario_id, cost_item_id, amount, driver_rate) VALUES ?',
          [[...overrides.map.entries()].map(([costItemId, override]) => [
            existing.id,
            costItemId,
            override.amount,
            override.driver_rate,
          ])],
        );
      }
    });

    req.flash('success', 'Scenario saved.');
    res.redirect(`${basePath}/${existing.id}`);
  } catch (err) {
    if (err.status === 409) {
      req.flash('error', err.message);
      return res.redirect(`${basePath}/${req.params.id}`);
    }
    next(err);
  }
});

// ------------------------------------------------------------------ results
router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    const result = await simulator.buildScenarioResults(scenario);
    const periodLabels = Object.fromEntries(result.periods.map((period) => [period, periodLabel(req.locale, period)]));
    const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
    res.render('finance/simulator/show', {
      title: scenario.name,
      active: 'finance-simulator',
      breadcrumbs: [
        { label: req.t('Sales simulator'), href: basePath },
        { label: scenario.name },
      ],
      scenario,
      result,
      periodLabels,
      alerts: resultAlerts(result, req),
      money: (value) => formatMoney(value, currency, req.locale),
      statuses: simulator.STATUSES,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- duplicate
router.post('/:id(\\d+)/duplicate', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    const lines = await simulator.loadScenarioLines(scenario.id);
    const overrides = await query('SELECT * FROM scenario_cost_overrides WHERE scenario_id = ?', [scenario.id]);
    const newId = await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO planning_scenarios
           (name, description, start_period, horizon_months, status, assumptions, created_by)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
        [
          `${scenario.name} (copy)`.slice(0, 180),
          scenario.description,
          scenario.start_period,
          scenario.horizon_months,
          JSON.stringify(scenario.assumptions),
          req.session.user.id,
        ],
      );
      if (lines.length) {
        await conn.query(
          `INSERT INTO scenario_sales_lines
             (scenario_id, product_id, customer_id, period, quantity, unit_price, discount_pct)
           VALUES ?`,
          [lines.map((line) => [
            result.insertId,
            line.product_id,
            line.customer_id,
            line.period,
            line.quantity,
            line.unit_price,
            line.discount_pct,
          ])],
        );
      }
      if (overrides.length) {
        await conn.query(
          'INSERT INTO scenario_cost_overrides (scenario_id, cost_item_id, amount, driver_rate) VALUES ?',
          [overrides.map((row) => [result.insertId, row.cost_item_id, row.amount, row.driver_rate])],
        );
      }
      return result.insertId;
    });
    req.flash('success', 'Scenario duplicated.');
    res.redirect(`${basePath}/${newId}/edit`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- status
router.post('/:id(\\d+)/status', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    const target = String(req.body.status || '');
    if (!simulator.STATUSES.includes(target)) {
      req.flash('error', req.t('Select a valid scenario status.'));
      return res.redirect(`${basePath}/${scenario.id}`);
    }
    await query('UPDATE planning_scenarios SET status = ? WHERE id = ?', [target, scenario.id]);
    req.flash('success', 'Scenario status updated.');
    res.redirect(`${basePath}/${scenario.id}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- delete
router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    await query('DELETE FROM planning_scenarios WHERE id = ?', [scenario.id]);
    req.flash('success', 'Scenario deleted.');
    res.redirect(basePath);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------- load baseline
router.post('/:id(\\d+)/load-baseline', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    assertEditable(scenario, req);
    const periods = simulator.periodsForScenario(scenario.start_period, scenario.horizon_months);
    const historyEnd = finance.shiftPeriod(scenario.start_period, -1);
    const historyStart = finance.shiftPeriod(scenario.start_period, -12);
    const historyEndDate = finance.periodRange(historyEnd).end;
    const rows = await query(
      `SELECT si.customer_id, ii.product_id,
              SUM(ii.quantity * CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END) AS quantity,
              SUM(ii.line_total * ((si.total - si.tax_total) / NULLIF(si.total, 0)) *
                  CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END) AS net_revenue
         FROM sales_invoice_items ii
         JOIN sales_invoices si ON si.id = ii.invoice_id
         LEFT JOIN fiscal_document_types fdt ON fdt.code = si.document_type_code
        WHERE si.status IN ('sent', 'paid', 'overdue')
          AND si.invoice_date BETWEEN ? AND ?
        GROUP BY si.customer_id, ii.product_id
       HAVING quantity > 0`,
      [`${historyStart}-01`, historyEndDate],
    );
    if (!rows.length) {
      req.flash('error', req.t('No invoiced sales were found in the 12 months before this scenario.'));
      return res.redirect(`${basePath}/${scenario.id}/edit`);
    }
    const lines = [];
    for (const row of rows) {
      const monthlyQuantity = finance.round3((Number(row.quantity) || 0) / 12);
      if (monthlyQuantity <= 0) continue;
      const price = finance.round2((Number(row.net_revenue) || 0) / (Number(row.quantity) || 1));
      for (const period of periods) {
        lines.push({
          product_id: Number(row.product_id),
          customer_id: row.customer_id ? Number(row.customer_id) : null,
          period,
          quantity: monthlyQuantity,
          unit_price: price,
          discount_pct: 0,
        });
      }
    }
    if (!lines.length) {
      req.flash('error', req.t('No usable historical sales were found for this baseline.'));
      return res.redirect(`${basePath}/${scenario.id}/edit`);
    }
    await withTransaction(async (conn) => {
      await conn.query('DELETE FROM scenario_sales_lines WHERE scenario_id = ?', [scenario.id]);
      await conn.query(
        `INSERT INTO scenario_sales_lines
           (scenario_id, product_id, customer_id, period, quantity, unit_price, discount_pct)
         VALUES ?`,
        [lines.map((line) => [
          scenario.id,
          line.product_id,
          line.customer_id,
          line.period,
          line.quantity,
          line.unit_price,
          line.discount_pct,
        ])],
      );
    });
    req.flash('success', 'Baseline loaded from the last 12 months of invoiced sales.');
    res.redirect(`${basePath}/${scenario.id}/edit`);
  } catch (err) {
    if (err.status === 409) {
      req.flash('error', err.message);
      return res.redirect(`${basePath}/${req.params.id}`);
    }
    next(err);
  }
});

// ------------------------------------------------------------------ compare
router.get('/compare', async (req, res, next) => {
  try {
    const raw = Array.isArray(req.query.ids) ? req.query.ids.join(',') : String(req.query.ids || '');
    const ids = [...new Set(raw.split(',').map((id) => Number.parseInt(id, 10)).filter((id) => id > 0))].slice(0, 4);
    if (ids.length < 2) {
      req.flash('info', req.t('Select at least two scenarios to compare.'));
      return res.redirect(basePath);
    }
    const scenarios = [];
    for (const id of ids) {
      const scenario = await simulator.loadScenario(id);
      if (!scenario) continue;
      const result = await simulator.buildScenarioResults(scenario);
      scenarios.push({ scenario, result, start_label: periodLabel(req.locale, scenario.start_period) });
    }
    if (scenarios.length < 2) {
      req.flash('info', req.t('Select at least two scenarios to compare.'));
      return res.redirect(basePath);
    }
    const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
    res.render('finance/simulator/compare', {
      title: req.t('Compare scenarios'),
      active: 'finance-simulator',
      breadcrumbs: [
        { label: req.t('Sales simulator'), href: basePath },
        { label: req.t('Compare scenarios') },
      ],
      scenarios,
      money: (value) => formatMoney(value, currency, req.locale),
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- export
router.get('/:id(\\d+)/export', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    const result = await simulator.buildScenarioResults(scenario);
    const header = [
      'Period', 'Units', 'Revenue', 'Material cost', 'Other variable costs', 'Contribution',
      'Fixed costs', 'One-off costs', 'Operating profit', 'Purchases', 'Collections',
      'Supplier payments', 'Net cash', 'Closing cash', 'AR', 'AP', 'Inventory',
    ];
    const rows = result.months.map((month) => [
      month.period,
      month.units,
      month.revenue,
      month.material,
      month.variable,
      month.contribution,
      month.fixed,
      month.oneOff,
      month.operatingProfit,
      month.purchases,
      month.collections,
      month.supplierPayments,
      month.netCash,
      month.closingCash,
      month.ar,
      month.ap,
      month.inventory,
    ]);
    const safeName = String(scenario.name || 'scenario').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    sendCsv(res, `${safeName || 'scenario'}-projection.csv`, header, rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/purchase-plan.csv', async (req, res, next) => {
  try {
    const scenario = await loadScenarioOr404(req.params.id, req);
    const result = await simulator.buildScenarioResults(scenario);
    const header = [
      'Supplier', 'SKU', 'Product', 'Unit', 'Purchase unit', 'Required', 'Stock', 'Open POs', 'Net required',
      'Order quantity', 'Unit cost', 'Total cost', 'First need month', 'Order by',
    ];
    const rows = result.purchasePlan.map((row) => [
      row.supplier_name || '',
      row.sku,
      row.name,
      row.unit,
      row.purchase_unit || row.unit,
      row.total,
      row.stock,
      row.open_po,
      row.net_required,
      row.order_quantity,
      row.unit_cost,
      row.total_cost,
      row.first_need_period || '',
      row.order_by || '',
    ]);
    const safeName = String(scenario.name || 'scenario').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    sendCsv(res, `${safeName || 'scenario'}-purchase-plan.csv`, header, rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
