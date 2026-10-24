'use strict';

const express = require('express');
const { query, one, scalar, withTransaction } = require('../db');
const { pagination, toNumber, todayISO, percentChange } = require('../lib/helpers');
const { getSettings } = require('../lib/settings');

const router = express.Router();

const TICKET_TYPE_SUGGESTIONS = ['Ticket', 'Invoice', 'Credit note'];
const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'other', label: 'Other' },
];
const PAYMENT_VALUES = PAYMENT_METHODS.map((method) => method.value);
const NET_LINE_REVENUE = `(i.line_total * CASE WHEN s.subtotal > 0 THEN (1 - (s.discount_total / s.subtotal)) ELSE 1 END)`;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().slice(0, 20);
}

function normalizeCustomerName(value) {
  const text = String(value || '').trim().slice(0, 180);
  return /^walk[- ]?in customer$/i.test(text) ? null : text || null;
}

function arr(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveRange(source = {}) {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);

  let to = parseDate(source.to) || iso(now);
  let from = parseDate(source.from);
  if (!from) {
    const start = new Date(`${to}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 89);
    from = iso(start);
  }
  if (from > to) [from, to] = [to, from];

  const days = Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1,
  );
  const previousTo = new Date(`${from}T00:00:00Z`);
  previousTo.setUTCDate(previousTo.getUTCDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - (days - 1));

  return {
    from,
    to,
    days,
    previousFrom: iso(previousFrom),
    previousTo: iso(previousTo),
    defaulted: !parseDate(source.from) && !parseDate(source.to),
  };
}

function saleScope(range, posId = null) {
  const where = ['s.sale_date BETWEEN ? AND ?'];
  const params = [range.from, range.to];
  if (posId) {
    where.push('s.pos_id = ?');
    params.push(posId);
  }
  return { sql: where.join(' AND '), params };
}

function itemScope(scope, { categoryId = null, search = '' } = {}) {
  const where = [scope.sql];
  const params = [...scope.params];
  if (categoryId) {
    where.push('p.category_id = ?');
    params.push(categoryId);
  }
  if (search) {
    where.push('(p.name LIKE ? OR p.sku LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like);
  }
  return { sql: where.join(' AND '), params };
}

function numeric(row, key) {
  return Number((row && row[key]) || 0);
}

async function loadLocations() {
  return query('SELECT id, code, name, status FROM pos_locations ORDER BY name ASC, code ASC');
}

async function loadTicketTypes() {
  const rows = await query(
    "SELECT DISTINCT ticket_type FROM pos_sales WHERE ticket_type <> '' ORDER BY ticket_type ASC",
  );
  return rows.map((row) => row.ticket_type);
}

async function loadCategories() {
  return query('SELECT id, name FROM product_categories ORDER BY name ASC');
}

async function loadProducts() {
  const rows = await query(
    `SELECT id, sku, name, unit, sale_price, sale_vat_rate, sold_by_weight
       FROM products
      WHERE is_sellable = 1
      ORDER BY name ASC`,
  );
  return rows.map((product) => ({
    value: String(product.id),
    label: `${product.sku} — ${product.name}`,
    name: product.name,
    sku: product.sku,
    unit: product.unit,
    price: Number(product.sale_price || 0),
    taxRate: Number(product.sale_vat_rate || 0),
    weighted: Number(product.sold_by_weight) === 1,
  }));
}

async function findSale(id) {
  return one(
    `SELECT s.*, l.code AS pos_code, l.name AS pos_name, l.status AS pos_status,
            u.name AS created_by_name
       FROM pos_sales s
       JOIN pos_locations l ON l.id = s.pos_id
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = ? LIMIT 1`,
    [id],
  );
}

async function findLocation(id) {
  return one('SELECT * FROM pos_locations WHERE id = ? LIMIT 1', [id]);
}

async function loadSaleItems(saleId) {
  return query(
    `SELECT i.*, p.sku, p.name, p.unit
       FROM pos_sale_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.sale_id = ?
      ORDER BY i.id ASC`,
    [saleId],
  );
}

function parseItems(body, defaultTaxRate) {
  const ids = arr(body.item_product_id);
  const descriptions = arr(body.item_description);
  const quantities = arr(body.item_quantity);
  const prices = arr(body.item_unit_price);
  const taxes = arr(body.item_tax_rate);
  const items = [];

  for (let i = 0; i < ids.length && items.length < 200; i++) {
    const productId = Number.parseInt(ids[i], 10);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    const quantity = toNumber(quantities[i], 0);
    if (quantity <= 0) continue;
    const unitPrice = Math.max(0, toNumber(prices[i], 0));
    const taxRate =
      taxes[i] === undefined || taxes[i] === ''
        ? Number(defaultTaxRate || 0)
        : Math.min(100, Math.max(0, toNumber(taxes[i], 0)));
    const lineTotal = round2(quantity * unitPrice);
    items.push({
      product_id: productId,
      description: String(descriptions[i] || '').trim().slice(0, 255) || null,
      quantity: round3(quantity),
      unit_price: round2(unitPrice),
      tax_rate: Math.min(100, Math.max(0, taxRate)),
      line_total: lineTotal,
    });
  }
  return items;
}

function computeTotals(items, discount) {
  const subtotal = round2(items.reduce((sum, item) => sum + item.line_total, 0));
  const taxTotal = round2(
    items.reduce((sum, item) => {
      const rate = Number(item.tax_rate) || 0;
      return sum + (rate > 0 ? item.line_total * (rate / (100 + rate)) : 0);
    }, 0),
  );
  const discountTotal = round2(Math.min(Math.max(Number(discount) || 0, 0), subtotal));
  return {
    subtotal,
    tax_total: taxTotal,
    discount_total: discountTotal,
    total: round2(subtotal - discountTotal),
  };
}

async function validateSale(req, { locations, posId, ticketType, ticketNumber, saleDate, paymentMethod, items, existingId = null }) {
  const errors = {};
  const itemErrors = [];

  if (!posId || !locations.some((location) => Number(location.id) === posId)) {
    errors.pos_id = req.t('Select a valid point of sale.');
  }
  if (!ticketType) errors.ticket_type = req.t('Ticket type is required.');
  if (!ticketNumber) errors.ticket_number = req.t('Ticket number is required.');
  if (!saleDate) errors.sale_date = req.t('A valid sale date is required.');
  if (!PAYMENT_VALUES.includes(paymentMethod)) errors.payment_method = req.t('Invalid payment method.');
  if (!items.length) {
    itemErrors.push(req.t('Add at least one line item with a quantity greater than zero.'));
  }

  if (posId && ticketType && ticketNumber) {
    const duplicate = await one(
      `SELECT id FROM pos_sales
        WHERE pos_id = ? AND ticket_type = ? AND ticket_number = ? AND id <> ?
        LIMIT 1`,
      [posId, ticketType, ticketNumber, existingId || 0],
    );
    if (duplicate) {
      errors.ticket_number = req.t(
        'This ticket number already exists for the selected point of sale and ticket type.',
      );
    }
  }

  if (items.length) {
    const productIds = [...new Set(items.map((item) => item.product_id))];
    const placeholders = productIds.map(() => '?').join(', ');
    const existingProducts = await query(`SELECT id FROM products WHERE id IN (${placeholders})`, productIds);
    if (existingProducts.length !== productIds.length) {
      itemErrors.push(req.t('One or more selected products no longer exist.'));
    }
  }

  return { errors, itemErrors };
}

async function loadSaleTotals(scope) {
  const row = await one(
    `SELECT COUNT(*) AS tickets,
            COALESCE(SUM(s.subtotal),0) AS gross,
            COALESCE(SUM(s.discount_total),0) AS discounts,
            COALESCE(SUM(s.tax_total),0) AS tax,
            COALESCE(SUM(s.total),0) AS revenue
       FROM pos_sales s
       JOIN pos_locations l ON l.id = s.pos_id
      WHERE ${scope.sql}`,
    scope.params,
  );
  return {
    tickets: numeric(row, 'tickets'),
    gross: numeric(row, 'gross'),
    discounts: numeric(row, 'discounts'),
    tax: numeric(row, 'tax'),
    revenue: numeric(row, 'revenue'),
  };
}

async function loadItemTotals(scope) {
  const row = await one(
    `SELECT COUNT(DISTINCT s.id) AS tickets,
            COUNT(DISTINCT i.product_id) AS products,
            COALESCE(SUM(i.quantity),0) AS units,
            COALESCE(SUM(${NET_LINE_REVENUE}),0) AS revenue
       FROM pos_sale_items i
       JOIN pos_sales s ON s.id = i.sale_id
       JOIN products p ON p.id = i.product_id
       JOIN pos_locations l ON l.id = s.pos_id
      WHERE ${scope.sql}`,
    scope.params,
  );
  return {
    tickets: numeric(row, 'tickets'),
    products: numeric(row, 'products'),
    units: numeric(row, 'units'),
    revenue: numeric(row, 'revenue'),
  };
}

async function loadCategoryBreakdown(scope, limit = null) {
  const params = [...scope.params];
  let limitSql = '';
  if (limit) {
    limitSql = 'LIMIT ?';
    params.push(limit);
  }
  const rows = await query(
    `SELECT COALESCE(pc.name, 'Uncategorised') AS name,
            COALESCE(SUM(i.quantity),0) AS qty,
            COALESCE(SUM(${NET_LINE_REVENUE}),0) AS revenue,
            COUNT(DISTINCT s.id) AS tickets,
            COUNT(DISTINCT p.id) AS products
       FROM pos_sale_items i
       JOIN pos_sales s ON s.id = i.sale_id
       JOIN products p ON p.id = i.product_id
       JOIN pos_locations l ON l.id = s.pos_id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE ${scope.sql}
      GROUP BY pc.id, pc.name
      ORDER BY revenue DESC, name ASC
      ${limitSql}`,
    params,
  );
  return rows.map((row) => ({
    name: row.name,
    qty: numeric(row, 'qty'),
    revenue: numeric(row, 'revenue'),
    tickets: numeric(row, 'tickets'),
    products: numeric(row, 'products'),
  }));
}

async function loadProductBreakdown(scope, { limit = 10, offset = 0, sort = 'revenue' } = {}) {
  const order = sort === 'units' ? 'qty' : 'revenue';
  const rows = await query(
    `SELECT p.id, p.sku, p.name, p.unit, COALESCE(pc.name, 'Uncategorised') AS category_name,
            COALESCE(SUM(i.quantity),0) AS qty,
            COALESCE(SUM(${NET_LINE_REVENUE}),0) AS revenue,
            COUNT(DISTINCT s.id) AS tickets
       FROM pos_sale_items i
       JOIN pos_sales s ON s.id = i.sale_id
       JOIN products p ON p.id = i.product_id
       JOIN pos_locations l ON l.id = s.pos_id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE ${scope.sql}
      GROUP BY p.id, p.sku, p.name, p.unit, pc.name
      ORDER BY ${order} DESC, p.name ASC
      LIMIT ? OFFSET ?`,
    [...scope.params, limit, offset],
  );
  return rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    category_name: row.category_name,
    qty: numeric(row, 'qty'),
    revenue: numeric(row, 'revenue'),
    tickets: numeric(row, 'tickets'),
  }));
}

async function loadProductCount(scope) {
  return Number(
    (await scalar(
      `SELECT COUNT(DISTINCT i.product_id)
         FROM pos_sale_items i
         JOIN pos_sales s ON s.id = i.sale_id
         JOIN products p ON p.id = i.product_id
         JOIN pos_locations l ON l.id = s.pos_id
        WHERE ${scope.sql}`,
      scope.params,
    )) || 0,
  );
}

async function loadTicketBreakdown(scope) {
  const rows = await query(
    `SELECT s.ticket_type, COUNT(*) AS tickets, COALESCE(SUM(s.total),0) AS revenue
       FROM pos_sales s
       JOIN pos_locations l ON l.id = s.pos_id
      WHERE ${scope.sql}
      GROUP BY s.ticket_type
      ORDER BY revenue DESC, s.ticket_type ASC`,
    scope.params,
  );
  return rows.map((row) => ({
    ticket_type: row.ticket_type,
    tickets: numeric(row, 'tickets'),
    revenue: numeric(row, 'revenue'),
  }));
}

async function loadRecentSales(scope, limit = 8) {
  const rows = await query(
    `SELECT s.id, s.ticket_type, s.ticket_number, s.sale_date, s.total, s.payment_method,
            s.customer_name, l.code AS pos_code, l.name AS pos_name,
            (SELECT COUNT(*) FROM pos_sale_items i WHERE i.sale_id = s.id) AS item_count,
            (SELECT COALESCE(SUM(i.quantity),0) FROM pos_sale_items i WHERE i.sale_id = s.id) AS units
       FROM pos_sales s
       JOIN pos_locations l ON l.id = s.pos_id
      WHERE ${scope.sql}
      ORDER BY s.sale_date DESC, s.id DESC
      LIMIT ?`,
    [...scope.params, limit],
  );
  return rows.map((row) => ({
    ...row,
    total: numeric(row, 'total'),
    item_count: numeric(row, 'item_count'),
    units: numeric(row, 'units'),
  }));
}

async function loadTrend(range, posId, locale) {
  const endMonth = range.to.slice(0, 7);
  const start = new Date(`${endMonth}-01T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - 5);
  const startMonth = iso(start).slice(0, 7);
  const where = ['s.sale_date BETWEEN ? AND ?'];
  const params = [iso(start), range.to];
  if (posId) {
    where.push('s.pos_id = ?');
    params.push(posId);
  }

  const rows = await query(
    `SELECT DATE_FORMAT(s.sale_date, '%Y-%m') AS ym,
            COALESCE(SUM(s.total),0) AS revenue,
            COUNT(*) AS tickets
       FROM pos_sales s
      WHERE ${where.join(' AND ')}
      GROUP BY ym
      ORDER BY ym ASC`,
    params,
  );
  const byMonth = Object.fromEntries(rows.map((row) => [row.ym, row]));

  const keys = [];
  const cursor = new Date(`${startMonth}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 7) <= endMonth && keys.length < 24) {
    keys.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const labels = keys.map((key) =>
    new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(
      new Date(`${key}-01T00:00:00Z`),
    ),
  );
  return {
    keys,
    labels,
    revenue: keys.map((key) => numeric(byMonth[key], 'revenue')),
    tickets: keys.map((key) => numeric(byMonth[key], 'tickets')),
  };
}

async function loadPosComparison(range, posId = null) {
  const where = posId ? 'WHERE l.id = ?' : '';
  const params = [range.from, range.to, range.from, range.to];
  if (posId) params.push(posId);

  const rows = await query(
    `SELECT l.id, l.code, l.name, l.status,
            COUNT(s.id) AS tickets,
            COALESCE(SUM(s.total),0) AS revenue,
            COALESCE(SUM(s.tax_total),0) AS tax,
            COALESCE(SUM(s.discount_total),0) AS discounts,
            COALESCE(AVG(s.total),0) AS avg_ticket,
            COALESCE(u.units,0) AS units,
            MAX(s.sale_date) AS last_sale
       FROM pos_locations l
       LEFT JOIN pos_sales s ON s.pos_id = l.id AND s.sale_date BETWEEN ? AND ?
       LEFT JOIN (
         SELECT s2.pos_id, COALESCE(SUM(i.quantity),0) AS units
           FROM pos_sales s2
           JOIN pos_sale_items i ON i.sale_id = s2.id
          WHERE s2.sale_date BETWEEN ? AND ?
          GROUP BY s2.pos_id
       ) u ON u.pos_id = l.id
      ${where}
      GROUP BY l.id, l.code, l.name, l.status, u.units
      ORDER BY revenue DESC, l.name ASC`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    tickets: numeric(row, 'tickets'),
    revenue: numeric(row, 'revenue'),
    tax: numeric(row, 'tax'),
    discounts: numeric(row, 'discounts'),
    avg_ticket: numeric(row, 'avg_ticket'),
    units: numeric(row, 'units'),
    last_sale: row.last_sale,
  }));
}

function buildStats(saleTotals, itemTotals, previousSaleTotals, previousItemTotals) {
  const revenue = saleTotals.revenue;
  const tickets = saleTotals.tickets;
  const units = itemTotals.units;
  const previousRevenue = previousSaleTotals.revenue;
  const previousTickets = previousSaleTotals.tickets;
  const previousUnits = previousItemTotals.units;
  const avgTicket = tickets > 0 ? revenue / tickets : 0;
  const previousAvg = previousTickets > 0 ? previousRevenue / previousTickets : 0;

  return {
    revenue,
    revenueDelta: percentChange(revenue, previousRevenue),
    tickets,
    ticketsDelta: percentChange(tickets, previousTickets),
    units,
    unitsDelta: percentChange(units, previousUnits),
    avgTicket,
    avgTicketDelta: percentChange(avgTicket, previousAvg),
    tax: saleTotals.tax,
    discounts: saleTotals.discounts,
    gross: saleTotals.gross,
    products: itemTotals.products,
  };
}

async function loadAnalytics({ range, posId = null, categoryId = null, search = '', locale, productLimit = 8 }) {
  const currentSale = saleScope(range, posId);
  const currentItem = itemScope(currentSale, { categoryId, search });
  const previousSale = saleScope({ from: range.previousFrom, to: range.previousTo }, posId);
  const previousItem = itemScope(previousSale, { categoryId, search });

  const [
    saleTotals,
    itemTotals,
    previousSaleTotals,
    previousItemTotals,
    categories,
    products,
    ticketTypes,
    trend,
    recent,
  ] = await Promise.all([
    loadSaleTotals(currentSale),
    loadItemTotals(currentItem),
    loadSaleTotals(previousSale),
    loadItemTotals(previousItem),
    loadCategoryBreakdown(currentItem, productLimit),
    loadProductBreakdown(currentItem, { limit: productLimit }),
    loadTicketBreakdown(currentSale),
    loadTrend(range, posId, locale),
    loadRecentSales(currentSale, 8),
  ]);

  return {
    currentSale,
    currentItem,
    previousSale,
    previousItem,
    saleTotals,
    itemTotals,
    previousSaleTotals,
    previousItemTotals,
    categories,
    products,
    ticketTypes,
    trend,
    recent,
    stats: buildStats(saleTotals, itemTotals, previousSaleTotals, previousItemTotals),
  };
}

function saleFormLocals(req, { title, mode, row, items, errors, itemErrors, action, breadcrumbs, locations, products, defaultTaxRate }) {
  return {
    title,
    active: 'pos-sales',
    breadcrumbs,
    mode,
    action,
    row,
    items,
    errors,
    itemErrors,
    locations,
    products,
    defaultTaxRate,
    ticketTypeSuggestions: TICKET_TYPE_SUGGESTIONS,
    paymentMethods: PAYMENT_METHODS,
  };
}

function locationFormLocals(req, { title, mode, row, errors, action, breadcrumbs }) {
  return {
    title,
    active: 'pos-locations',
    breadcrumbs,
    mode,
    action,
    row,
    errors,
  };
}

// ------------------------------------------------------------------ dashboard
router.get('/', async (req, res, next) => {
  try {
    const range = resolveRange(req.query);
    const posId = parseId(req.query.pos);
    const [locations, analytics, posRows] = await Promise.all([
      loadLocations(),
      loadAnalytics({ range, posId, locale: req.locale, productLimit: 8 }),
      loadPosComparison(range, posId),
    ]);

    const totalRevenue = analytics.saleTotals.revenue;
    const perPos = posRows.map((row) => ({
      ...row,
      share: totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0,
    }));

    const categories = analytics.categories.map((category) => ({
      ...category,
      share: analytics.itemTotals.revenue > 0 ? (category.revenue / analytics.itemTotals.revenue) * 100 : 0,
    }));

    res.render('pos/dashboard', {
      title: req.t('POS dashboard'),
      active: 'pos-dashboard',
      breadcrumbs: [{ label: req.t('Point of Sale') }, { label: req.t('POS dashboard') }],
      range,
      posId,
      locations,
      stats: analytics.stats,
      perPos,
      categories,
      products: analytics.products,
      ticketTypes: analytics.ticketTypes,
      trend: analytics.trend,
      recent: analytics.recent,
      charts: {
        trend: analytics.trend,
        categories,
        products: analytics.products,
        ticketTypes: analytics.ticketTypes,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- performance
router.get('/performance', async (req, res, next) => {
  try {
    const range = resolveRange(req.query);
    const posId = parseId(req.query.pos);
    const categoryId = parseId(req.query.category);
    const search = String(req.query.q || '').trim();
    const sort = req.query.sort === 'units' ? 'units' : 'revenue';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

    const currentSale = saleScope(range, posId);
    const currentItem = itemScope(currentSale, { categoryId, search });
    const previousSale = saleScope({ from: range.previousFrom, to: range.previousTo }, posId);
    const previousItem = itemScope(previousSale, { categoryId, search });

    const [locations, categories, saleTotals, itemTotals, previousSaleTotals, previousItemTotals] =
      await Promise.all([
        loadLocations(),
        loadCategories(),
        loadSaleTotals(currentSale),
        loadItemTotals(currentItem),
        loadSaleTotals(previousSale),
        loadItemTotals(previousItem),
      ]);

    const totalProducts = await loadProductCount(currentItem);
    const pag = pagination(totalProducts, page, 20);
    const [products, categoryRows, topProducts] = await Promise.all([
      loadProductBreakdown(currentItem, {
        limit: pag.perPage,
        offset: (pag.page - 1) * pag.perPage,
        sort,
      }),
      loadCategoryBreakdown(currentItem),
      loadProductBreakdown(currentItem, { limit: 8, sort }),
    ]);

    const totalItemRevenue = itemTotals.revenue;
    const productRows = products.map((product) => ({
      ...product,
      share: totalItemRevenue > 0 ? (product.revenue / totalItemRevenue) * 100 : 0,
      avg_price: product.qty > 0 ? product.revenue / product.qty : 0,
    }));
    const categoryData = categoryRows.map((category) => ({
      ...category,
      share: totalItemRevenue > 0 ? (category.revenue / totalItemRevenue) * 100 : 0,
      avg_price: category.qty > 0 ? category.revenue / category.qty : 0,
    }));

    res.render('pos/performance', {
      title: req.t('Sales performance'),
      active: 'pos-performance',
      breadcrumbs: [{ label: req.t('Point of Sale') }, { label: req.t('Sales performance') }],
      range,
      posId,
      categoryId,
      categories,
      search,
      sort,
      locations,
      stats: buildStats(saleTotals, itemTotals, previousSaleTotals, previousItemTotals),
      products: productRows,
      categoryRows: categoryData,
      topProducts,
      pagination: pag,
      charts: {
        products: topProducts,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- sales index
router.get('/sales', async (req, res, next) => {
  try {
    const range = resolveRange(req.query);
    const posId = parseId(req.query.pos);
    const ticketType = String(req.query.ticket_type || '').trim();
    const search = String(req.query.q || '').trim();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);

    const where = ['s.sale_date BETWEEN ? AND ?'];
    const params = [range.from, range.to];
    if (posId) {
      where.push('s.pos_id = ?');
      params.push(posId);
    }
    if (ticketType) {
      where.push('s.ticket_type = ?');
      params.push(ticketType);
    }
    if (search) {
      where.push('(s.ticket_number LIKE ? OR s.customer_name LIKE ? OR l.name LIKE ? OR s.notes LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.join(' AND ');

    const total = Number(
      (await scalar(
        `SELECT COUNT(*)
           FROM pos_sales s
           JOIN pos_locations l ON l.id = s.pos_id
          WHERE ${whereSql}`,
        params,
      )) || 0,
    );
    const pag = pagination(total, page, 15);

    const [rows, locations, ticketTypes, saleTotals, itemTotals] = await Promise.all([
      query(
        `SELECT s.*, l.code AS pos_code, l.name AS pos_name,
                (SELECT COUNT(*) FROM pos_sale_items i WHERE i.sale_id = s.id) AS item_count,
                (SELECT COALESCE(SUM(i.quantity),0) FROM pos_sale_items i WHERE i.sale_id = s.id) AS units
           FROM pos_sales s
           JOIN pos_locations l ON l.id = s.pos_id
          WHERE ${whereSql}
          ORDER BY s.sale_date DESC, s.id DESC
          LIMIT ? OFFSET ?`,
        [...params, pag.perPage, (pag.page - 1) * pag.perPage],
      ),
      loadLocations(),
      loadTicketTypes(),
      loadSaleTotals({ sql: whereSql, params }),
      loadItemTotals({ sql: whereSql, params }),
    ]);

    res.render('pos/sales/index', {
      title: req.t('POS sales'),
      active: 'pos-sales',
      breadcrumbs: [{ label: req.t('Point of Sale') }, { label: req.t('POS sales') }],
      rows: rows.map((row) => ({
        ...row,
        total: numeric(row, 'total'),
        item_count: numeric(row, 'item_count'),
        units: numeric(row, 'units'),
      })),
      pagination: pag,
      range,
      posId,
      locations,
      ticketTypes,
      activeTicketType: ticketType,
      search,
      stats: {
        revenue: saleTotals.revenue,
        tickets: saleTotals.tickets,
        units: itemTotals.units,
        avgTicket: saleTotals.tickets > 0 ? saleTotals.revenue / saleTotals.tickets : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- new sale
router.get('/sales/new', async (req, res, next) => {
  try {
    const [locations, products, settings] = await Promise.all([
      loadLocations(),
      loadProducts(),
      getSettings(),
    ]);
    const defaultTaxRate = Number(settings.default_tax_rate || 0);
    const row = {
      pos_id: req.query.pos || '',
      ticket_type: req.query.ticket_type || 'Ticket',
      ticket_number: '',
      sale_date: todayISO(),
      payment_method: 'card',
      customer_name: '',
      discount_total: 0,
      notes: '',
    };

    res.render(
      'pos/sales/form',
      saleFormLocals(req, {
        title: req.t('New POS sale'),
        mode: 'create',
        row,
        items: [
          {
            product_id: '',
            description: '',
            quantity: 1,
            unit_price: 0,
            tax_rate: defaultTaxRate,
            unit: '',
          },
        ],
        errors: {},
        itemErrors: [],
        action: '/pos/sales',
        breadcrumbs: [
          { label: req.t('POS sales'), href: '/pos/sales' },
          { label: req.t('New POS sale') },
        ],
        locations,
        products,
        defaultTaxRate,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- create sale
router.post('/sales', async (req, res, next) => {
  try {
    const [locations, products, settings] = await Promise.all([
      loadLocations(),
      loadProducts(),
      getSettings(),
    ]);
    const defaultTaxRate = Number(settings.default_tax_rate || 0);
    const posId = parseId(req.body.pos_id);
    const ticketType = String(req.body.ticket_type || '').trim().slice(0, 40);
    const ticketNumber = String(req.body.ticket_number || '').trim().slice(0, 40);
    const saleDate = parseDate(req.body.sale_date);
    const paymentMethod = String(req.body.payment_method || '');
    const items = parseItems(req.body, defaultTaxRate);
    const { errors, itemErrors } = await validateSale(req, {
      locations,
      posId,
      ticketType,
      ticketNumber,
      saleDate,
      paymentMethod,
      items,
    });

    if (Object.keys(errors).length || itemErrors.length) {
      return res.status(422).render(
        'pos/sales/form',
        saleFormLocals(req, {
          title: req.t('New POS sale'),
          mode: 'create',
          row: { ...req.body, discount_total: req.body.discount_total || 0 },
          items:
            items.length > 0
              ? items
              : [{ product_id: '', description: '', quantity: 1, unit_price: 0, tax_rate: defaultTaxRate, unit: '' }],
          errors,
          itemErrors,
          action: '/pos/sales',
          breadcrumbs: [
            { label: req.t('POS sales'), href: '/pos/sales' },
            { label: req.t('New POS sale') },
          ],
          locations,
          products,
          defaultTaxRate,
        }),
      );
    }

    const totals = computeTotals(items, req.body.discount_total);
    const saleId = await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO pos_sales
           (pos_id, ticket_type, ticket_number, sale_date, payment_method, customer_name,
            subtotal, discount_total, tax_total, total, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          posId,
          ticketType,
          ticketNumber,
          saleDate,
          paymentMethod,
          normalizeCustomerName(req.body.customer_name),
          totals.subtotal,
          totals.discount_total,
          totals.tax_total,
          totals.total,
          String(req.body.notes || '').trim().slice(0, 5000) || null,
          req.session.user.id,
        ],
      );
      const id = result.insertId;
      for (const item of items) {
        await conn.query(
          `INSERT INTO pos_sale_items
             (sale_id, product_id, description, quantity, unit_price, tax_rate, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            item.product_id,
            item.description,
            item.quantity,
            item.unit_price,
            item.tax_rate,
            item.line_total,
          ],
        );
      }
      return id;
    });

    req.flash('success', 'POS sale recorded successfully.');
    res.redirect(`/pos/sales/${saleId}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This ticket number already exists for the selected point of sale and ticket type.');
      return res.redirect('/pos/sales/new');
    }
    next(err);
  }
});

// ----------------------------------------------------------------- show sale
router.get('/sales/:id(\\d+)', async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    if (!sale) {
      return next(Object.assign(new Error(req.t('POS sale not found.')), { status: 404 }));
    }
    const items = await loadSaleItems(sale.id);
    const units = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    res.render('pos/sales/show', {
      title: sale.ticket_number,
      active: 'pos-sales',
      breadcrumbs: [
        { label: req.t('POS sales'), href: '/pos/sales' },
        { label: sale.ticket_number },
      ],
      sale,
      items,
      units,
    });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- edit sale
router.get('/sales/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    if (!sale) {
      return next(Object.assign(new Error(req.t('POS sale not found.')), { status: 404 }));
    }
    const [locations, products, settings, items] = await Promise.all([
      loadLocations(),
      loadProducts(),
      getSettings(),
      loadSaleItems(sale.id),
    ]);
    const defaultTaxRate = Number(settings.default_tax_rate || 0);
    res.render(
      'pos/sales/form',
      saleFormLocals(req, {
        title: req.t('Edit POS sale'),
        mode: 'edit',
        row: sale,
        items:
          items.length > 0
            ? items
            : [{ product_id: '', description: '', quantity: 1, unit_price: 0, tax_rate: defaultTaxRate, unit: '' }],
        errors: {},
        itemErrors: [],
        action: `/pos/sales/${sale.id}`,
        breadcrumbs: [
          { label: req.t('POS sales'), href: '/pos/sales' },
          { label: sale.ticket_number, href: `/pos/sales/${sale.id}` },
          { label: req.t('Edit') },
        ],
        locations,
        products,
        defaultTaxRate,
      }),
    );
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- update sale
router.post('/sales/:id(\\d+)', async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    if (!sale) {
      return next(Object.assign(new Error(req.t('POS sale not found.')), { status: 404 }));
    }
    const [locations, products, settings] = await Promise.all([
      loadLocations(),
      loadProducts(),
      getSettings(),
    ]);
    const defaultTaxRate = Number(settings.default_tax_rate || 0);
    const posId = parseId(req.body.pos_id);
    const ticketType = String(req.body.ticket_type || '').trim().slice(0, 40);
    const ticketNumber = String(req.body.ticket_number || '').trim().slice(0, 40);
    const saleDate = parseDate(req.body.sale_date);
    const paymentMethod = String(req.body.payment_method || '');
    const items = parseItems(req.body, defaultTaxRate);
    const { errors, itemErrors } = await validateSale(req, {
      locations,
      posId,
      ticketType,
      ticketNumber,
      saleDate,
      paymentMethod,
      items,
      existingId: sale.id,
    });

    if (Object.keys(errors).length || itemErrors.length) {
      return res.status(422).render(
        'pos/sales/form',
        saleFormLocals(req, {
          title: req.t('Edit POS sale'),
          mode: 'edit',
          row: { ...sale, ...req.body, discount_total: req.body.discount_total || 0 },
          items:
            items.length > 0
              ? items
              : [{ product_id: '', description: '', quantity: 1, unit_price: 0, tax_rate: defaultTaxRate, unit: '' }],
          errors,
          itemErrors,
          action: `/pos/sales/${sale.id}`,
          breadcrumbs: [
            { label: req.t('POS sales'), href: '/pos/sales' },
            { label: sale.ticket_number, href: `/pos/sales/${sale.id}` },
            { label: req.t('Edit') },
          ],
          locations,
          products,
          defaultTaxRate,
        }),
      );
    }

    const totals = computeTotals(items, req.body.discount_total);
    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE pos_sales
            SET pos_id = ?, ticket_type = ?, ticket_number = ?, sale_date = ?,
                payment_method = ?, customer_name = ?, subtotal = ?, discount_total = ?,
                tax_total = ?, total = ?, notes = ?
          WHERE id = ?`,
        [
          posId,
          ticketType,
          ticketNumber,
          saleDate,
          paymentMethod,
          normalizeCustomerName(req.body.customer_name),
          totals.subtotal,
          totals.discount_total,
          totals.tax_total,
          totals.total,
          String(req.body.notes || '').trim().slice(0, 5000) || null,
          sale.id,
        ],
      );
      await conn.query('DELETE FROM pos_sale_items WHERE sale_id = ?', [sale.id]);
      for (const item of items) {
        await conn.query(
          `INSERT INTO pos_sale_items
             (sale_id, product_id, description, quantity, unit_price, tax_rate, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            sale.id,
            item.product_id,
            item.description,
            item.quantity,
            item.unit_price,
            item.tax_rate,
            item.line_total,
          ],
        );
      }
    });

    req.flash('success', 'POS sale updated successfully.');
    res.redirect(`/pos/sales/${sale.id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This ticket number already exists for the selected point of sale and ticket type.');
      return res.redirect(`/pos/sales/${req.params.id}/edit`);
    }
    next(err);
  }
});

// --------------------------------------------------------------- delete sale
router.post('/sales/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const sale = await findSale(req.params.id);
    if (!sale) {
      return next(Object.assign(new Error(req.t('POS sale not found.')), { status: 404 }));
    }
    await withTransaction(async (conn) => {
      await conn.query('DELETE FROM pos_sales WHERE id = ?', [sale.id]);
    });
    req.flash('success', 'POS sale deleted.');
    res.redirect('/pos/sales');
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------- POS locations
router.get('/locations', async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT l.*,
              COUNT(s.id) AS sale_count,
              COALESCE(SUM(s.total),0) AS revenue,
              COALESCE(u.units,0) AS units,
              MAX(s.sale_date) AS last_sale
         FROM pos_locations l
         LEFT JOIN pos_sales s ON s.pos_id = l.id
         LEFT JOIN (
           SELECT s2.pos_id, COALESCE(SUM(i.quantity),0) AS units
             FROM pos_sales s2
             JOIN pos_sale_items i ON i.sale_id = s2.id
            GROUP BY s2.pos_id
         ) u ON u.pos_id = l.id
        GROUP BY l.id, u.units
        ORDER BY l.name ASC, l.code ASC`,
    );
    const locations = rows.map((row) => ({
      ...row,
      sale_count: numeric(row, 'sale_count'),
      revenue: numeric(row, 'revenue'),
      units: numeric(row, 'units'),
    }));
    res.render('pos/locations/index', {
      title: req.t('Points of sale'),
      active: 'pos-locations',
      breadcrumbs: [{ label: req.t('Point of Sale') }, { label: req.t('Points of sale') }],
      locations,
      stats: {
        total: locations.length,
        active: locations.filter((location) => location.status === 'active').length,
        revenue: locations.reduce((sum, location) => sum + location.revenue, 0),
        sales: locations.reduce((sum, location) => sum + location.sale_count, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/locations/new', (req, res, next) => {
  try {
    res.render(
      'pos/locations/form',
      locationFormLocals(req, {
        title: req.t('New point of sale'),
        mode: 'create',
        row: { status: 'active' },
        errors: {},
        action: '/pos/locations',
        breadcrumbs: [
          { label: req.t('Points of sale'), href: '/pos/locations' },
          { label: req.t('New point of sale') },
        ],
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.post('/locations', async (req, res, next) => {
  try {
    const data = {
      code: normalizeCode(req.body.code),
      name: String(req.body.name || '').trim().slice(0, 120),
      address_line1: String(req.body.address_line1 || '').trim().slice(0, 190) || null,
      city: String(req.body.city || '').trim().slice(0, 100) || null,
      state: String(req.body.state || '').trim().slice(0, 100) || null,
      postal_code: String(req.body.postal_code || '').trim().slice(0, 20) || null,
      phone: String(req.body.phone || '').trim().slice(0, 40) || null,
      status: req.body.status === 'inactive' ? 'inactive' : 'active',
      notes: String(req.body.notes || '').trim().slice(0, 5000) || null,
    };
    const errors = {};
    if (!data.code) errors.code = req.t('Code is required.');
    if (!data.name) errors.name = req.t('Name is required.');
    if (data.code) {
      const duplicate = await one('SELECT id FROM pos_locations WHERE code = ? LIMIT 1', [data.code]);
      if (duplicate) errors.code = req.t('This code is already used by another point of sale.');
    }
    if (Object.keys(errors).length) {
      return res.status(422).render(
        'pos/locations/form',
        locationFormLocals(req, {
          title: req.t('New point of sale'),
          mode: 'create',
          row: data,
          errors,
          action: '/pos/locations',
          breadcrumbs: [
            { label: req.t('Points of sale'), href: '/pos/locations' },
            { label: req.t('New point of sale') },
          ],
        }),
      );
    }

    const result = await query(
      `INSERT INTO pos_locations
         (code, name, address_line1, city, state, postal_code, phone, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.code,
        data.name,
        data.address_line1,
        data.city,
        data.state,
        data.postal_code,
        data.phone,
        data.status,
        data.notes,
      ],
    );
    req.flash('success', 'Point of sale created successfully.');
    res.redirect(`/pos/locations/${result.insertId}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This code is already used by another point of sale.');
      return res.redirect('/pos/locations/new');
    }
    next(err);
  }
});

router.get('/locations/:id(\\d+)', async (req, res, next) => {
  try {
    const location = await findLocation(req.params.id);
    if (!location) {
      return next(Object.assign(new Error(req.t('Point of sale not found.')), { status: 404 }));
    }
    const range = resolveRange(req.query);
    const analytics = await loadAnalytics({
      range,
      posId: location.id,
      locale: req.locale,
      productLimit: 8,
    });
    res.render('pos/locations/show', {
      title: location.name,
      active: 'pos-locations',
      breadcrumbs: [
        { label: req.t('Points of sale'), href: '/pos/locations' },
        { label: location.name },
      ],
      location,
      range,
      stats: analytics.stats,
      categories: analytics.categories,
      products: analytics.products,
      ticketTypes: analytics.ticketTypes,
      trend: analytics.trend,
      recent: analytics.recent,
      charts: {
        trend: analytics.trend,
        categories: analytics.categories,
        products: analytics.products,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/locations/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const location = await findLocation(req.params.id);
    if (!location) {
      return next(Object.assign(new Error(req.t('Point of sale not found.')), { status: 404 }));
    }
    res.render(
      'pos/locations/form',
      locationFormLocals(req, {
        title: req.t('Edit point of sale'),
        mode: 'edit',
        row: location,
        errors: {},
        action: `/pos/locations/${location.id}`,
        breadcrumbs: [
          { label: req.t('Points of sale'), href: '/pos/locations' },
          { label: location.name, href: `/pos/locations/${location.id}` },
          { label: req.t('Edit') },
        ],
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.post('/locations/:id(\\d+)', async (req, res, next) => {
  try {
    const location = await findLocation(req.params.id);
    if (!location) {
      return next(Object.assign(new Error(req.t('Point of sale not found.')), { status: 404 }));
    }
    const data = {
      code: normalizeCode(req.body.code),
      name: String(req.body.name || '').trim().slice(0, 120),
      address_line1: String(req.body.address_line1 || '').trim().slice(0, 190) || null,
      city: String(req.body.city || '').trim().slice(0, 100) || null,
      state: String(req.body.state || '').trim().slice(0, 100) || null,
      postal_code: String(req.body.postal_code || '').trim().slice(0, 20) || null,
      phone: String(req.body.phone || '').trim().slice(0, 40) || null,
      status: req.body.status === 'inactive' ? 'inactive' : 'active',
      notes: String(req.body.notes || '').trim().slice(0, 5000) || null,
    };
    const errors = {};
    if (!data.code) errors.code = req.t('Code is required.');
    if (!data.name) errors.name = req.t('Name is required.');
    if (data.code) {
      const duplicate = await one('SELECT id FROM pos_locations WHERE code = ? AND id <> ? LIMIT 1', [
        data.code,
        location.id,
      ]);
      if (duplicate) errors.code = req.t('This code is already used by another point of sale.');
    }
    if (Object.keys(errors).length) {
      return res.status(422).render(
        'pos/locations/form',
        locationFormLocals(req, {
          title: req.t('Edit point of sale'),
          mode: 'edit',
          row: { ...location, ...data },
          errors,
          action: `/pos/locations/${location.id}`,
          breadcrumbs: [
            { label: req.t('Points of sale'), href: '/pos/locations' },
            { label: location.name, href: `/pos/locations/${location.id}` },
            { label: req.t('Edit') },
          ],
        }),
      );
    }

    await query(
      `UPDATE pos_locations
          SET code = ?, name = ?, address_line1 = ?, city = ?, state = ?, postal_code = ?,
              phone = ?, status = ?, notes = ?
        WHERE id = ?`,
      [
        data.code,
        data.name,
        data.address_line1,
        data.city,
        data.state,
        data.postal_code,
        data.phone,
        data.status,
        data.notes,
        location.id,
      ],
    );
    req.flash('success', 'Point of sale updated successfully.');
    res.redirect(`/pos/locations/${location.id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This code is already used by another point of sale.');
      return res.redirect(`/pos/locations/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.post('/locations/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const location = await findLocation(req.params.id);
    if (!location) {
      return next(Object.assign(new Error(req.t('Point of sale not found.')), { status: 404 }));
    }
    const saleCount = Number(
      (await scalar('SELECT COUNT(*) FROM pos_sales WHERE pos_id = ?', [location.id])) || 0,
    );
    if (saleCount > 0) {
      req.flash(
        'error',
        'This point of sale has recorded sales and cannot be deleted. Mark it inactive instead.',
      );
      return res.redirect(`/pos/locations/${location.id}`);
    }
    await query('DELETE FROM pos_locations WHERE id = ?', [location.id]);
    req.flash('success', 'Point of sale deleted.');
    res.redirect('/pos/locations');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
