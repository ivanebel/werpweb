'use strict';

const express = require('express');
const { query, one, scalar, getPool, withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { pagination, todayISO, addDaysISO, lotFromDate, toNumber, statusInfo } = require('../lib/helpers');
const { snapshotMaterials, completeProductionOrder } = require('../lib/production');

const router = express.Router();

function arr(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// Scale filters accept both date-only values and datetime-local values. A
// date-only "to" value includes the whole day, which is what users expect.
function filterDateTime(value, endOfDay = false) {
  let raw = String(value || '').trim().replace(' ', 'T');
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    raw += endOfDay ? 'T23:59:59' : 'T00:00:00';
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    raw += endOfDay ? ':59' : ':00';
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  if (Number.isNaN(new Date(`${raw}Z`).getTime())) return null;
  return raw.replace('T', ' ');
}

function dateTimeInputValue(value, endOfDay = false) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return '';
  return `${match[1]}T${match[2] || (endOfDay ? '23' : '00')}:${match[3] || (endOfDay ? '59' : '00')}`;
}

function scaleRecordFilters(queryParams) {
  const lot = String(queryParams.lot || '').trim();
  const range = ['in', 'out'].includes(String(queryParams.range || ''))
    ? String(queryParams.range)
    : '';
  const from = filterDateTime(queryParams.from, false);
  const to = filterDateTime(queryParams.to, true);
  const where = [];
  const params = [];
  if (lot) {
    where.push('sr.lot_number LIKE ?');
    params.push(`%${lot}%`);
  }
  if (from) {
    where.push('sr.weighed_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('sr.weighed_at <= ?');
    params.push(to);
  }
  if (range === 'in') where.push('sr.in_range = 1');
  if (range === 'out') where.push('sr.in_range = 0');
  return { where, params, lot, range, from, to };
}

async function productOptions() {
  const rows = await query(
    `SELECT id, sku, name, type, unit, cost_price, sale_price, stock_qty FROM products WHERE status = 'active' ORDER BY name`,
  );
  return rows.map((p) => ({
    value: String(p.id),
    label: `${p.sku} — ${p.name}`,
    cost: Number(p.cost_price),
    sale: Number(p.sale_price),
    unit: p.unit,
    type: p.type,
  }));
}

async function loadBom(id) {
  return one(
    `SELECT b.*, p.name AS product_name, p.sku AS product_sku, p.sale_price, p.cost_price AS product_cost,
            p.unit AS product_unit, pc.name AS category_name
       FROM boms b
       JOIN products p ON p.id = b.product_id
       LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE b.id = ? LIMIT 1`,
    [id],
  );
}

async function loadBomItems(id) {
  return query(
    `SELECT bi.*, p.sku, p.name, p.unit, p.cost_price, p.stock_qty, p.type,
            (bi.quantity * (1 + bi.scrap_percent / 100)) AS qty_with_scrap,
            (bi.quantity * (1 + bi.scrap_percent / 100) * p.cost_price) AS line_cost
       FROM bom_items bi JOIN products p ON p.id = bi.component_id
      WHERE bi.bom_id = ? ORDER BY bi.sort_order, bi.id`,
    [id],
  );
}

// ------------------------------------------------------------------- BOM list
router.get('/boms', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const where = [];
    const params = [];
    if (search) {
      where.push('(p.name LIKE ? OR p.sku LIKE ? OR b.name LIKE ? OR b.version LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      where.push('b.status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const perPage = 12;
    const total = Number(
      (await scalar(
        `SELECT COUNT(*) FROM boms b JOIN products p ON p.id = b.product_id ${whereSql}`,
        params,
      )) || 0,
    );
    const pag = pagination(total, page, perPage);
    const rows = await query(
      `SELECT b.*, p.name AS product_name, p.sku AS product_sku, p.sale_price,
              (SELECT COUNT(*) FROM bom_items bi WHERE bi.bom_id = b.id) AS component_count,
              COALESCE((
                SELECT SUM(bi.quantity * (1 + bi.scrap_percent / 100) * cp.cost_price)
                  FROM bom_items bi JOIN products cp ON cp.id = bi.component_id
                 WHERE bi.bom_id = b.id
              ), 0) / NULLIF(b.output_qty, 0) AS unit_cost
         FROM boms b JOIN products p ON p.id = b.product_id
         ${whereSql}
        ORDER BY b.id DESC
        LIMIT ? OFFSET ?`,
      [...params, perPage, (pag.page - 1) * perPage],
    );

    res.render('manufacturing/boms/index', {
      title: req.t('Bills of Materials'),
      active: 'manufacturing-boms',
      breadcrumbs: [{ label: req.t('Manufacturing') }, { label: req.t('Bills of materials') }],
      rows,
      pagination: pag,
      search,
      activeStatus: status,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/boms/new', async (req, res, next) => {
  try {
    const products = await productOptions();
    const row = {
      product_id: req.query.product_id || '',
      name: '',
      version: 'v1',
      output_qty: 1,
      status: 'draft',
      notes: '',
    };
    const items = [{ component_id: '', quantity: 1, scrap_percent: 0 }];
    res.render('manufacturing/boms/form', {
      title: req.t('New BOM'),
      active: 'manufacturing-boms',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Bills of materials'), href: '/manufacturing/boms' },
        { label: req.t('New BOM') },
      ],
      products,
      row,
      items,
      errors: {},
      itemErrors: [],
      mode: 'create',
      action: '/manufacturing/boms',
    });
  } catch (err) {
    next(err);
  }
});

function collectBomItems(body, t = (value) => value) {
  const ids = arr(body.component_id);
  const qtys = arr(body.quantity);
  const scraps = arr(body.scrap_percent);
  const items = [];
  const errors = [];
  const seen = new Set();
  for (let i = 0; i < ids.length; i++) {
    const componentId = Number.parseInt(ids[i], 10);
    if (!componentId) continue;
    const qty = toNumber(qtys[i], 0);
    const scrap = toNumber(scraps[i], 0);
    if (qty <= 0) {
      errors.push(t('Every component needs a quantity greater than zero.'));
      continue;
    }
    if (seen.has(componentId)) {
      errors.push(t('The same component cannot be added twice.'));
      continue;
    }
    seen.add(componentId);
    items.push({ component_id: componentId, quantity: qty, scrap_percent: scrap });
  }
  if (!items.length) errors.push(t('Add at least one component to the BOM.'));
  return { items, errors };
}

router.post('/boms', async (req, res, next) => {
  try {
    const products = await productOptions();
    const productId = Number.parseInt(req.body.product_id, 10);
    const { items, errors } = collectBomItems(req.body, req.t);
    const fieldErrors = {};
    if (!productId) fieldErrors.product_id = req.t('Select the product this BOM produces.');
    if (items.some((i) => i.component_id === productId)) {
      errors.push(req.t('A BOM cannot contain its own output product.'));
    }
    if (!['draft', 'active', 'archived'].includes(req.body.status)) fieldErrors.status = req.t('Invalid status.');
    if (toNumber(req.body.output_qty, 0) <= 0) {
      fieldErrors.output_qty = req.t('Output quantity must be greater than zero.');
    }
    if (!String(req.body.name || '').trim()) fieldErrors.name = req.t('BOM name is required.');

    if (Object.keys(fieldErrors).length || errors.length) {
      return res.status(422).render('manufacturing/boms/form', {
        title: req.t('New BOM'),
        active: 'manufacturing-boms',
        breadcrumbs: [
          { label: req.t('Manufacturing') },
          { label: req.t('Bills of materials'), href: '/manufacturing/boms' },
          { label: req.t('New BOM') },
        ],
        products,
        row: req.body,
        items: items.length ? items : [{ component_id: '', quantity: 1, scrap_percent: 0 }],
        errors: fieldErrors,
        itemErrors: errors,
        mode: 'create',
        action: '/manufacturing/boms',
      });
    }

    const bomId = await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO boms (product_id, name, version, output_qty, status, notes) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          productId,
          String(req.body.name).trim().slice(0, 180),
          String(req.body.version || 'v1').trim().slice(0, 20),
          toNumber(req.body.output_qty, 1),
          req.body.status,
          (req.body.notes || '').slice(0, 5000) || null,
        ],
      );
      let sort = 0;
      for (const item of items) {
        await conn.query(
          'INSERT INTO bom_items (bom_id, component_id, quantity, scrap_percent, sort_order) VALUES (?, ?, ?, ?, ?)',
          [result.insertId, item.component_id, item.quantity, item.scrap_percent, sort++],
        );
      }
      return result.insertId;
    });

    req.flash('success', 'BOM created.');
    res.redirect(`/manufacturing/boms/${bomId}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This product already has a BOM with that version.');
      return res.redirect('/manufacturing/boms/new');
    }
    next(err);
  }
});

router.get('/boms/:id(\\d+)', async (req, res, next) => {
  try {
    const bom = await loadBom(req.params.id);
    if (!bom) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('BOM') })), { status: 404 }));
    }
    const items = await loadBomItems(bom.id);
    const materialCost = items.reduce((s, i) => s + Number(i.line_cost), 0);
    const unitCost = materialCost / (Number(bom.output_qty) || 1);
    const margin = Number(bom.sale_price) - unitCost;
    const productionOrders = await query(
      `SELECT DISTINCT po.id, po.production_no, l.quantity, po.status, po.due_date, so.order_no
         FROM production_orders po
         JOIN production_order_lines l ON l.production_order_id = po.id
         LEFT JOIN sales_orders so ON so.id = po.sales_order_id
        WHERE l.bom_id = ? ORDER BY po.id DESC LIMIT 10`,
      [bom.id],
    );

    res.render('manufacturing/boms/show', {
      title: bom.name,
      active: 'manufacturing-boms',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Bills of materials'), href: '/manufacturing/boms' },
        { label: bom.name },
      ],
      bom,
      items,
      materialCost,
      unitCost,
      margin,
      productionOrders,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/boms/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const bom = await loadBom(req.params.id);
    if (!bom) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('BOM') })), { status: 404 }));
    }
    const items = await loadBomItems(bom.id);
    const products = await productOptions();
    res.render('manufacturing/boms/form', {
      title: req.t('Edit {name}', { name: bom.name }),
      active: 'manufacturing-boms',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Bills of materials'), href: '/manufacturing/boms' },
        { label: bom.name, href: `/manufacturing/boms/${bom.id}` },
        { label: req.t('Edit') },
      ],
      products,
      row: bom,
      items,
      errors: {},
      itemErrors: [],
      mode: 'edit',
      action: `/manufacturing/boms/${bom.id}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/boms/:id(\\d+)', async (req, res, next) => {
  try {
    const bom = await loadBom(req.params.id);
    if (!bom) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('BOM') })), { status: 404 }));
    }
    const products = await productOptions();
    const productId = Number.parseInt(req.body.product_id, 10);
    const { items, errors } = collectBomItems(req.body, req.t);
    const fieldErrors = {};
    if (!productId) fieldErrors.product_id = req.t('Select the product this BOM produces.');
    if (items.some((i) => i.component_id === productId)) {
      errors.push(req.t('A BOM cannot contain its own output product.'));
    }
    if (!['draft', 'active', 'archived'].includes(req.body.status)) fieldErrors.status = req.t('Invalid status.');
    if (toNumber(req.body.output_qty, 0) <= 0) {
      fieldErrors.output_qty = req.t('Output quantity must be greater than zero.');
    }
    if (!String(req.body.name || '').trim()) fieldErrors.name = req.t('BOM name is required.');

    if (Object.keys(fieldErrors).length || errors.length) {
      return res.status(422).render('manufacturing/boms/form', {
        title: req.t('Edit {name}', { name: bom.name }),
        active: 'manufacturing-boms',
        breadcrumbs: [
          { label: req.t('Manufacturing') },
          { label: req.t('Bills of materials'), href: '/manufacturing/boms' },
          { label: bom.name, href: `/manufacturing/boms/${bom.id}` },
          { label: req.t('Edit') },
        ],
        products,
        row: { ...bom, ...req.body },
        items: items.length ? items : [{ component_id: '', quantity: 1, scrap_percent: 0 }],
        errors: fieldErrors,
        itemErrors: errors,
        mode: 'edit',
        action: `/manufacturing/boms/${bom.id}`,
      });
    }

    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE boms SET product_id = ?, name = ?, version = ?, output_qty = ?, status = ?, notes = ? WHERE id = ?`,
        [
          productId,
          String(req.body.name).trim().slice(0, 180),
          String(req.body.version || 'v1').trim().slice(0, 20),
          toNumber(req.body.output_qty, 1),
          req.body.status,
          (req.body.notes || '').slice(0, 5000) || null,
          bom.id,
        ],
      );
      await conn.query('DELETE FROM bom_items WHERE bom_id = ?', [bom.id]);
      let sort = 0;
      for (const item of items) {
        await conn.query(
          'INSERT INTO bom_items (bom_id, component_id, quantity, scrap_percent, sort_order) VALUES (?, ?, ?, ?, ?)',
          [bom.id, item.component_id, item.quantity, item.scrap_percent, sort++],
        );
      }
    });

    req.flash('success', 'BOM updated.');
    res.redirect(`/manufacturing/boms/${bom.id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'This product already has a BOM with that version.');
      return res.redirect(`/manufacturing/boms/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.post('/boms/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const bom = await loadBom(req.params.id);
    if (!bom) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('BOM') })), { status: 404 }));
    }
    const used = await scalar('SELECT COUNT(*) FROM production_order_lines WHERE bom_id = ?', [bom.id]);
    if (Number(used) > 0) {
      req.flash('error', 'This BOM is used by production orders and cannot be deleted. Archive it instead.');
      return res.redirect(`/manufacturing/boms/${bom.id}`);
    }
    await getPool().query('DELETE FROM boms WHERE id = ?', [bom.id]);
    req.flash('success', 'BOM deleted.');
    res.redirect('/manufacturing/boms');
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------- production orders

async function bomOptions(productionOrderId = null) {
  return query(
    `SELECT b.id, b.name, b.version, b.output_qty, b.status,
            b.product_id, p.name AS product_name, p.sku, p.unit
       FROM boms b JOIN products p ON p.id = b.product_id
      WHERE (b.status = 'active'
        ${productionOrderId ? 'OR b.id IN (SELECT bom_id FROM production_order_lines WHERE production_order_id = ?)' : ''})
      ORDER BY p.name, b.version`,
    productionOrderId ? [productionOrderId] : [],
  );
}

async function productionFormOptions(productionOrderId = null) {
  const boms = await bomOptions(productionOrderId);
  const salesOrders = await query(
    `SELECT so.id, so.order_no, so.expected_date, c.company_name FROM sales_orders so
       JOIN customers c ON c.id = so.customer_id
      WHERE so.status IN ('confirmed','partially_delivered')
      ORDER BY so.order_date DESC LIMIT 100`,
  );
  return { boms, salesOrders };
}

function defaultProductionLine(startDate, bomId = '') {
  return {
    bom_id: bomId,
    quantity: 1,
    lot_number: lotFromDate(startDate || todayISO()),
    expiry_date: '',
    notes: '',
  };
}

function collectProductionLines(body, boms, t = (value) => value) {
  const bomIds = arr(body.line_bom_id);
  const quantities = arr(body.line_quantity);
  const lots = arr(body.line_lot_number);
  const expiries = arr(body.line_expiry_date);
  const notes = arr(body.line_notes);
  const count = Math.max(bomIds.length, quantities.length, lots.length, expiries.length, notes.length);
  const byId = new Map(boms.map((bom) => [String(bom.id), bom]));
  const seen = new Set();
  const seenProducts = new Set();
  const rows = [];
  const lines = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    const raw = {
      bom_id: String(bomIds[i] || '').trim(),
      quantity: String(quantities[i] || '').trim(),
      lot_number: String(lots[i] || '').trim(),
      expiry_date: String(expiries[i] || '').trim(),
      notes: String(notes[i] || '').trim(),
    };
    if (!raw.bom_id && !raw.quantity && !raw.lot_number && !raw.expiry_date && !raw.notes) continue;
    rows.push(raw);
    const lineNumber = rows.length;
    const bomId = Number.parseInt(raw.bom_id, 10);
    const bom = byId.get(String(bomId));
    if (!bom) {
      errors.push(t('Line {line}: select a valid BOM.', { line: lineNumber }));
      continue;
    }
    if (seen.has(bomId)) {
      errors.push(t('Line {line}: this BOM is already in the order.', { line: lineNumber }));
      continue;
    }
    if (seenProducts.has(bom.product_id)) {
      errors.push(t('Line {line}: this product is already produced by another BOM in the order.', { line: lineNumber }));
      continue;
    }
    seen.add(bomId);
    seenProducts.add(bom.product_id);
    const quantity = toNumber(raw.quantity, 0);
    if (quantity <= 0) {
      errors.push(t('Line {line}: quantity must be greater than zero.', { line: lineNumber }));
    }
    if (!raw.lot_number) {
      errors.push(t('Line {line}: lot number is required.', { line: lineNumber }));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.expiry_date)) {
      errors.push(t('Line {line}: valid expiry date required.', { line: lineNumber }));
    }
    lines.push({
      bom_id: bomId,
      product_id: bom.product_id,
      quantity,
      lot_number: raw.lot_number.slice(0, 60),
      expiry_date: raw.expiry_date.slice(0, 10),
      notes: raw.notes.slice(0, 5000) || null,
      sort_order: lines.length,
    });
  }

  if (!rows.length) errors.push(t('Add at least one BOM line.'));
  return { rows, lines, errors };
}

async function loadProductionLines(productionOrderId) {
  return query(
    `SELECT l.*, b.name AS bom_name, b.version, b.output_qty, b.status AS bom_status,
            p.name AS product_name, p.sku, p.unit, p.stock_qty AS product_stock
       FROM production_order_lines l
       JOIN boms b ON b.id = l.bom_id
       JOIN products p ON p.id = l.product_id
      WHERE l.production_order_id = ?
      ORDER BY l.sort_order, l.id`,
    [productionOrderId],
  );
}

async function loadProductionMaterials(productionOrderId) {
  return query(
    `SELECT m.*, p.sku, p.name, p.unit, p.stock_qty, p.track_stock, p.cost_price,
            (m.quantity_required * p.cost_price) AS line_cost
       FROM production_order_materials m
       JOIN products p ON p.id = m.component_id
      WHERE m.production_order_id = ?
      ORDER BY p.name, m.id`,
    [productionOrderId],
  );
}

async function loadProductionOrder(productionOrderId) {
  return one(
    `SELECT po.*, so.order_no, so.customer_order_no, c.company_name AS customer_name
       FROM production_orders po
       LEFT JOIN sales_orders so ON so.id = po.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
      WHERE po.id = ? LIMIT 1`,
    [productionOrderId],
  );
}

function productionFormLocals(req, options) {
  const breadcrumbs = [
    { label: req.t('Manufacturing') },
    { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
  ];
  if (options.mode === 'edit') {
    breadcrumbs.push(
      { label: options.row.production_no, href: `/manufacturing/production-orders/${options.row.id}` },
      { label: req.t('Edit') },
    );
  } else {
    breadcrumbs.push({ label: req.t('New order') });
  }
  return {
    title: options.title,
    active: 'manufacturing-production',
    breadcrumbs,
    boms: options.boms,
    salesOrders: options.salesOrders,
    row: options.row,
    lines: options.lines,
    errors: options.errors || {},
    lineErrors: options.lineErrors || [],
    mode: options.mode,
    action: options.action,
    defaultLot: lotFromDate(options.row.start_date || todayISO()),
  };
}

router.get('/production-orders', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const where = [];
    const params = [];
    if (search) {
      where.push(`(po.production_no LIKE ? OR so.order_no LIKE ? OR EXISTS (
        SELECT 1 FROM production_order_lines l JOIN products p ON p.id = l.product_id
         WHERE l.production_order_id = po.id
           AND (p.name LIKE ? OR p.sku LIKE ? OR l.lot_number LIKE ?)
      ))`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      where.push('po.status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const perPage = 12;
    const total = Number(
      (await scalar(
        `SELECT COUNT(*) FROM production_orders po
           LEFT JOIN sales_orders so ON so.id = po.sales_order_id
           ${whereSql}`,
        params,
      )) || 0,
    );
    const pag = pagination(total, page, perPage);
    const rows = await query(
      `SELECT po.*, so.order_no,
              (SELECT COUNT(*) FROM production_order_lines l WHERE l.production_order_id = po.id) AS line_count,
              (SELECT p.name FROM production_order_lines l JOIN products p ON p.id = l.product_id
                WHERE l.production_order_id = po.id ORDER BY l.sort_order, l.id LIMIT 1) AS first_product_name,
              (SELECT p.sku FROM production_order_lines l JOIN products p ON p.id = l.product_id
                WHERE l.production_order_id = po.id ORDER BY l.sort_order, l.id LIMIT 1) AS first_product_sku,
              (SELECT GROUP_CONCAT(DISTINCT l.lot_number ORDER BY l.lot_number SEPARATOR ', ')
                 FROM production_order_lines l
                WHERE l.production_order_id = po.id AND l.lot_number IS NOT NULL AND l.lot_number <> '') AS lot_summary,
              (SELECT MIN(l.expiry_date) FROM production_order_lines l
                WHERE l.production_order_id = po.id AND l.expiry_date IS NOT NULL) AS next_expiry
         FROM production_orders po
         LEFT JOIN sales_orders so ON so.id = po.sales_order_id
         ${whereSql}
        ORDER BY FIELD(po.status, 'in_progress','released','planned','completed','cancelled'), po.due_date ASC, po.id DESC
        LIMIT ? OFFSET ?`,
      [...params, perPage, (pag.page - 1) * perPage],
    );
    const counts = await one(
      `SELECT SUM(status = 'planned') AS planned, SUM(status = 'released') AS released,
              SUM(status = 'in_progress') AS in_progress, SUM(status = 'completed') AS completed
         FROM production_orders`,
    );
    res.render('manufacturing/production/index', {
      title: req.t('Production Orders'),
      active: 'manufacturing-production',
      breadcrumbs: [{ label: req.t('Manufacturing') }, { label: req.t('Production orders') }],
      rows,
      pagination: pag,
      search,
      activeStatus: status,
      counts: {
        planned: Number(counts.planned || 0),
        released: Number(counts.released || 0),
        in_progress: Number(counts.in_progress || 0),
        completed: Number(counts.completed || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/production-orders/new', async (req, res, next) => {
  try {
    const options = await productionFormOptions();
    const today = todayISO();
    const row = {
      sales_order_id: req.query.sales_order_id || '',
      start_date: today,
      due_date: addDaysISO(today, 14),
      notes: '',
    };
    const lines = [defaultProductionLine(today, req.query.bom_id || '')];
    res.render('manufacturing/production/form', productionFormLocals(req, {
      title: req.t('New Production Order'),
      mode: 'create',
      action: '/manufacturing/production-orders',
      row,
      lines,
      ...options,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders', async (req, res, next) => {
  try {
    const options = await productionFormOptions();
    const { rows, lines, errors: lineErrors } = collectProductionLines(req.body, options.boms, req.t);
    const errors = {};
    const startDate = String(req.body.start_date || '').slice(0, 10);
    const dueDate = String(req.body.due_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      errors.start_date = req.t('Valid start date required.');
    }
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      errors.due_date = req.t('Valid due date required.');
    }
    if (!errors.start_date && !errors.due_date && dueDate && dueDate < startDate) {
      errors.due_date = req.t('Due date cannot be before the start date.');
    }
    const row = { ...req.body, start_date: startDate, due_date: dueDate };

    if (Object.keys(errors).length || lineErrors.length) {
      return res.status(422).render('manufacturing/production/form', productionFormLocals(req, {
        title: req.t('New Production Order'),
        mode: 'create',
        action: '/manufacturing/production-orders',
        row,
        lines: rows.length ? rows : [defaultProductionLine(startDate)],
        errors,
        lineErrors,
        ...options,
      }));
    }

    const id = await withTransaction(async (conn) => {
      const productionNo = await nextNumber({
        prefix: 'PRD',
        table: 'production_orders',
        column: 'production_no',
        date: startDate,
        conn,
      });
      const [result] = await conn.query(
        `INSERT INTO production_orders
           (production_no, sales_order_id, start_date, due_date, status, notes, created_by)
         VALUES (?, ?, ?, ?, 'planned', ?, ?)`,
        [
          productionNo,
          Number.parseInt(req.body.sales_order_id, 10) || null,
          startDate,
          dueDate || null,
          (req.body.notes || '').slice(0, 5000) || null,
          req.session.user.id,
        ],
      );
      let sort = 0;
      for (const line of lines) {
        await conn.query(
          `INSERT INTO production_order_lines
             (production_order_id, bom_id, product_id, quantity, lot_number, expiry_date, notes, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            result.insertId,
            line.bom_id,
            line.product_id,
            line.quantity,
            line.lot_number,
            line.expiry_date,
            line.notes,
            sort++,
          ],
        );
      }
      await snapshotMaterials(conn, result.insertId);
      return result.insertId;
    });

    req.flash('success', 'Production order created.');
    res.redirect(`/manufacturing/production-orders/${id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/production-orders/:id(\\d+)', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    const lines = await loadProductionLines(order.id);
    const materials = await loadProductionMaterials(order.id);
    const shortage = materials.some((m) => m.track_stock && Number(m.stock_qty) < Number(m.quantity_required));

    const actions = [];
    if (order.status === 'planned') {
      actions.push({ action: 'status', value: 'released', label: req.t('Release to production'), tone: 'primary' });
      actions.push({ href: `/manufacturing/production-orders/${order.id}/edit`, label: req.t('Edit'), tone: 'secondary' });
    }
    if (order.status === 'released') {
      actions.push({ action: 'status', value: 'in_progress', label: req.t('Start production'), tone: 'primary' });
    }
    if (order.status === 'in_progress') {
      actions.push({ action: 'status', value: 'completed', label: req.t('Complete & consume stock'), tone: 'success', confirm: true });
    }
    if (['planned', 'released', 'in_progress'].includes(order.status)) {
      actions.push({ href: `/manufacturing/production-orders/${order.id}/batches`, label: req.t('Edit batch details'), tone: 'secondary' });
      actions.push({ action: 'status', value: 'cancelled', label: req.t('Cancel'), tone: 'danger', confirm: true });
    }

    res.render('manufacturing/production/show', {
      title: order.production_no,
      active: 'manufacturing-production',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
        { label: order.production_no },
      ],
      order,
      lines,
      materials,
      shortage,
      actions,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/production-orders/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (order.status !== 'planned') {
      req.flash('error', 'Only planned production orders can be edited.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    const options = await productionFormOptions(order.id);
    let lines = await loadProductionLines(order.id);
    if (!lines.length) lines = [defaultProductionLine(order.start_date || todayISO())];
    res.render('manufacturing/production/form', productionFormLocals(req, {
      title: req.t('Edit {number}', { number: order.production_no }),
      mode: 'edit',
      action: `/manufacturing/production-orders/${order.id}`,
      row: { ...order, start_date: order.start_date || todayISO(), due_date: order.due_date || '', notes: order.notes || '' },
      lines,
      ...options,
    }));
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (order.status !== 'planned') {
      req.flash('error', 'Only planned production orders can be edited.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    const options = await productionFormOptions(order.id);
    const { rows, lines, errors: lineErrors } = collectProductionLines(req.body, options.boms, req.t);
    const errors = {};
    const startDate = String(req.body.start_date || '').slice(0, 10);
    const dueDate = String(req.body.due_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      errors.start_date = req.t('Valid start date required.');
    }
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      errors.due_date = req.t('Valid due date required.');
    }
    if (!errors.start_date && !errors.due_date && dueDate && dueDate < startDate) {
      errors.due_date = req.t('Due date cannot be before the start date.');
    }

    if (Object.keys(errors).length || lineErrors.length) {
      return res.status(422).render('manufacturing/production/form', productionFormLocals(req, {
        title: req.t('Edit {number}', { number: order.production_no }),
        mode: 'edit',
        action: `/manufacturing/production-orders/${order.id}`,
        row: { ...order, ...req.body, start_date: startDate, due_date: dueDate },
        lines: rows.length ? rows : [defaultProductionLine(startDate)],
        errors,
        lineErrors,
        ...options,
      }));
    }

    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE production_orders
            SET sales_order_id = ?, start_date = ?, due_date = ?, notes = ?,
                bom_id = NULL, product_id = NULL, quantity = NULL, lot_number = NULL, expiry_date = NULL
          WHERE id = ?`,
        [
          Number.parseInt(req.body.sales_order_id, 10) || null,
          startDate,
          dueDate || null,
          (req.body.notes || '').slice(0, 5000) || null,
          order.id,
        ],
      );
      await conn.query('DELETE FROM production_order_lines WHERE production_order_id = ?', [order.id]);
      let sort = 0;
      for (const line of lines) {
        await conn.query(
          `INSERT INTO production_order_lines
             (production_order_id, bom_id, product_id, quantity, lot_number, expiry_date, notes, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            order.id,
            line.bom_id,
            line.product_id,
            line.quantity,
            line.lot_number,
            line.expiry_date,
            line.notes,
            sort++,
          ],
        );
      }
      await snapshotMaterials(conn, order.id);
    });

    req.flash('success', 'Production order updated.');
    res.redirect(`/manufacturing/production-orders/${order.id}`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Each BOM can only appear once in a production order.');
      return res.redirect(`/manufacturing/production-orders/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.get('/production-orders/:id(\\d+)/batches', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (!['planned', 'released', 'in_progress'].includes(order.status)) {
      req.flash('error', 'Batch details cannot be changed for this production order.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    const lines = await loadProductionLines(order.id);
    res.render('manufacturing/production/batches', {
      title: req.t('Batch details'),
      active: 'manufacturing-production',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
        { label: order.production_no, href: `/manufacturing/production-orders/${order.id}` },
        { label: req.t('Batch details') },
      ],
      order,
      lines,
      errors: [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)/batches', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (!['planned', 'released', 'in_progress'].includes(order.status)) {
      req.flash('error', 'Batch details cannot be changed for this production order.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    const lines = await loadProductionLines(order.id);
    const ids = arr(req.body.line_id);
    const lots = arr(req.body.line_lot_number);
    const expiries = arr(req.body.line_expiry_date);
    const notes = arr(req.body.line_notes);
    const errors = [];
    const updates = [];
    const byId = new Map(lines.map((line) => [String(line.id), line]));
    const submitted = lines.map((line) => {
      const index = ids.indexOf(String(line.id));
      if (index < 0) return line;
      return {
        ...line,
        lot_number: String(lots[index] || '').trim(),
        expiry_date: String(expiries[index] || '').slice(0, 10),
        notes: String(notes[index] || '').trim(),
      };
    });

    submitted.forEach((line, index) => {
      if (!line.lot_number) errors.push(req.t('Line {line}: lot number is required.', { line: index + 1 }));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(line.expiry_date)) {
        errors.push(req.t('Line {line}: valid expiry date required.', { line: index + 1 }));
      }
      if (byId.has(String(line.id)) && line.lot_number && /^\d{4}-\d{2}-\d{2}$/.test(line.expiry_date)) {
        updates.push({
          id: line.id,
          lot_number: line.lot_number.slice(0, 60),
          expiry_date: line.expiry_date,
          notes: line.notes.slice(0, 5000) || null,
        });
      }
    });

    if (errors.length) {
      return res.status(422).render('manufacturing/production/batches', {
        title: req.t('Batch details'),
        active: 'manufacturing-production',
        breadcrumbs: [
          { label: req.t('Manufacturing') },
          { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
          { label: order.production_no, href: `/manufacturing/production-orders/${order.id}` },
          { label: req.t('Batch details') },
        ],
        order,
        lines: submitted,
        errors,
      });
    }

    await withTransaction(async (conn) => {
      for (const update of updates) {
        await conn.query(
          'UPDATE production_order_lines SET lot_number = ?, expiry_date = ?, notes = ? WHERE id = ? AND production_order_id = ?',
          [update.lot_number, update.expiry_date, update.notes, update.id, order.id],
        );
      }
    });

    req.flash('success', 'Batch details updated.');
    res.redirect(`/manufacturing/production-orders/${order.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)/status', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    const target = req.body.status;
    const allowed = {
      planned: ['released', 'cancelled'],
      released: ['in_progress', 'cancelled'],
      in_progress: ['completed', 'cancelled'],
    };
    if (!(allowed[order.status] || []).includes(target)) {
      req.flash('error', 'Cannot change status from {from} to {to}.', {
        from: statusInfo(order.status, req.locale).label,
        to: statusInfo(target, req.locale).label,
      });
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }

    if (target === 'completed') {
      const result = await completeProductionOrder(order.id, req.session.user.id);
      req.flash('success', 'Production completed. {lines} products produced and materials consumed.', {
        lines: result.lines,
      });
    } else {
      await getPool().query('UPDATE production_orders SET status = ? WHERE id = ?', [target, order.id]);
      req.flash('success', 'Production order marked as {status}.', {
        status: statusInfo(target, req.locale).label,
      });
    }
    res.redirect(`/manufacturing/production-orders/${order.id}`);
  } catch (err) {
    if (err.status === 422) {
      req.flash('error', err.message);
      return res.redirect(`/manufacturing/production-orders/${req.params.id}`);
    }
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (!['planned', 'cancelled'].includes(order.status)) {
      req.flash('error', 'Only planned or cancelled production orders can be deleted.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    await getPool().query('DELETE FROM production_orders WHERE id = ?', [order.id]);
    req.flash('success', 'Production order deleted.');
    res.redirect('/manufacturing/production-orders');
  } catch (err) {
    next(err);
  }
});


// ------------------------------------------------------------- scale records
router.get('/scale-records', async (req, res, next) => {
  try {
    const { where, params, lot, range } = scaleRecordFilters(req.query);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const statsRow = await one(
      `SELECT
         COUNT(*) AS items,
         COALESCE(SUM(sr.real_weight), 0) AS total_real_weight,
         COALESCE(SUM(sr.printed_weight), 0) AS total_printed_weight,
         COALESCE(SUM(sr.printed_price), 0) AS total_printed_price,
         COALESCE(AVG(sr.real_weight), 0) AS average_weight,
         COALESCE(MIN(sr.real_weight), 0) AS min_weight,
         COALESCE(MAX(sr.real_weight), 0) AS max_weight,
         COUNT(DISTINCT NULLIF(sr.label_id, '')) AS labels,
         COUNT(DISTINCT NULLIF(sr.box_id, '')) AS boxes,
         COUNT(DISTINCT NULLIF(sr.pallet_id, '')) AS pallets,
         COALESCE(SUM(sr.in_range = 1), 0) AS in_range,
         COALESCE(SUM(sr.in_range = 0), 0) AS out_of_range
       FROM scale_records sr
       ${whereSql}`,
      params,
    );

    const total = Number(statsRow.items || 0);
    const inRange = Number(statsRow.in_range || 0);
    const outOfRange = Number(statsRow.out_of_range || 0);
    const stats = {
      items: total,
      totalRealWeight: Number(statsRow.total_real_weight || 0),
      totalPrintedWeight: Number(statsRow.total_printed_weight || 0),
      totalPrintedPrice: Number(statsRow.total_printed_price || 0),
      averageWeight: Number(statsRow.average_weight || 0),
      minWeight: Number(statsRow.min_weight || 0),
      maxWeight: Number(statsRow.max_weight || 0),
      labels: Number(statsRow.labels || 0),
      boxes: Number(statsRow.boxes || 0),
      pallets: Number(statsRow.pallets || 0),
      inRange,
      outOfRange,
      inRangePct: total ? (inRange / total) * 100 : 0,
      outOfRangePct: total ? (outOfRange / total) * 100 : 0,
    };

    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const perPage = 50;
    const pag = pagination(total, page, perPage);
    const rows = await query(
      `SELECT sr.*, p.name AS product_name, p.sku AS product_sku, p.unit AS product_unit
         FROM scale_records sr
         LEFT JOIN products p ON p.id = sr.product_id
         ${whereSql}
        ORDER BY sr.weighed_at DESC, sr.id DESC
        LIMIT ? OFFSET ?`,
      [...params, perPage, (pag.page - 1) * perPage],
    );

    res.render('manufacturing/scale-records/index', {
      title: req.t('Scale records'),
      active: 'manufacturing-scale-records',
      breadcrumbs: [{ label: req.t('Manufacturing') }, { label: req.t('Scale records') }],
      rows,
      pagination: pag,
      stats,
      lot,
      rangeFilter: range,
      fromValue: dateTimeInputValue(req.query.from, false),
      toValue: dateTimeInputValue(req.query.to, true),
      hasFilters: Boolean(lot || range || req.query.from || req.query.to),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
