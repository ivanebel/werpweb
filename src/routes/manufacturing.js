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
      `SELECT po.id, po.production_no, po.quantity, po.status, po.due_date, so.order_no
         FROM production_orders po LEFT JOIN sales_orders so ON so.id = po.sales_order_id
        WHERE po.bom_id = ? ORDER BY po.id DESC LIMIT 10`,
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
    const used = await scalar('SELECT COUNT(*) FROM production_orders WHERE bom_id = ?', [bom.id]);
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
router.get('/production-orders', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const where = [];
    const params = [];
    if (search) {
      where.push('(po.production_no LIKE ? OR p.name LIKE ? OR p.sku LIKE ? OR po.lot_number LIKE ? OR so.order_no LIKE ?)');
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
        `SELECT COUNT(*) FROM production_orders po JOIN products p ON p.id = po.product_id
          LEFT JOIN sales_orders so ON so.id = po.sales_order_id ${whereSql}`,
        params,
      )) || 0,
    );
    const pag = pagination(total, page, perPage);
    const rows = await query(
      `SELECT po.*, p.name AS product_name, p.sku AS product_sku, so.order_no, b.name AS bom_name
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         JOIN boms b ON b.id = po.bom_id
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
    const boms = await query(
      `SELECT b.id, b.name, b.version, b.output_qty, p.name AS product_name, p.sku, p.unit
         FROM boms b JOIN products p ON p.id = b.product_id
        WHERE b.status = 'active' ORDER BY p.name`,
    );
    const salesOrders = await query(
      `SELECT so.id, so.order_no, so.expected_date, c.company_name FROM sales_orders so
         JOIN customers c ON c.id = so.customer_id
        WHERE so.status IN ('confirmed','partially_delivered')
        ORDER BY so.order_date DESC LIMIT 100`,
    );
    const today = todayISO();
    const row = {
      bom_id: req.query.bom_id || '',
      sales_order_id: req.query.sales_order_id || '',
      quantity: 1,
      lot_number: lotFromDate(today),
      expiry_date: '',
      start_date: today,
      due_date: addDaysISO(today, 14),
      notes: '',
    };
    res.render('manufacturing/production/form', {
      title: req.t('New Production Order'),
      active: 'manufacturing-production',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
        { label: req.t('New order') },
      ],
      boms,
      salesOrders,
      row,
      errors: {},
      mode: 'create',
      action: '/manufacturing/production-orders',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders', async (req, res, next) => {
  try {
    const bomId = Number.parseInt(req.body.bom_id, 10);
    const quantity = toNumber(req.body.quantity, 0);
    const bom = bomId
      ? await one('SELECT * FROM boms WHERE id = ?', [bomId])
      : null;
    const startDate = String(req.body.start_date || '').slice(0, 10);
    const lotNumber = String(req.body.lot_number || '').trim().slice(0, 60);
    const expiryDate = String(req.body.expiry_date || '').slice(0, 10);
    const errors = {};
    if (!bom) errors.bom_id = req.t('Select an active BOM.');
    if (quantity <= 0) errors.quantity = req.t('Quantity must be greater than zero.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      errors.start_date = req.t('Valid start date required.');
    }
    if (!lotNumber) errors.lot_number = req.t('Lot number is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      errors.expiry_date = req.t('Valid expiry date required.');
    }

    if (Object.keys(errors).length) {
      const boms = await query(
        `SELECT b.id, b.name, b.version, b.output_qty, p.name AS product_name, p.sku, p.unit
           FROM boms b JOIN products p ON p.id = b.product_id WHERE b.status = 'active' ORDER BY p.name`,
      );
      const salesOrders = await query(
        `SELECT so.id, so.order_no, so.expected_date, c.company_name FROM sales_orders so
           JOIN customers c ON c.id = so.customer_id
          WHERE so.status IN ('confirmed','partially_delivered') ORDER BY so.order_date DESC LIMIT 100`,
      );
      return res.status(422).render('manufacturing/production/form', {
        title: req.t('New Production Order'),
        active: 'manufacturing-production',
        breadcrumbs: [
          { label: req.t('Manufacturing') },
          { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
          { label: req.t('New order') },
        ],
        boms,
        salesOrders,
        row: req.body,
        errors,
        mode: 'create',
        action: '/manufacturing/production-orders',
      });
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
           (production_no, sales_order_id, bom_id, product_id, lot_number, expiry_date, quantity, start_date, due_date, status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
        [
          productionNo,
          Number.parseInt(req.body.sales_order_id, 10) || null,
          bom.id,
          bom.product_id,
          lotNumber,
          expiryDate,
          quantity,
          startDate,
          req.body.due_date || null,
          (req.body.notes || '').slice(0, 5000) || null,
          req.session.user.id,
        ],
      );
      await snapshotMaterials(conn, result.insertId, bom.id, quantity);
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
    const order = await one(
      `SELECT po.*, p.name AS product_name, p.sku AS product_sku, p.unit, p.stock_qty AS product_stock,
              b.name AS bom_name, b.version, b.output_qty, so.order_no, c.company_name AS customer_name
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
         JOIN boms b ON b.id = po.bom_id
         LEFT JOIN sales_orders so ON so.id = po.sales_order_id
         LEFT JOIN customers c ON c.id = so.customer_id
        WHERE po.id = ? LIMIT 1`,
      [req.params.id],
    );
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }

    const materials = await query(
      `SELECT m.*, p.sku, p.name, p.unit, p.stock_qty, p.track_stock, p.cost_price,
              (m.quantity_required * p.cost_price) AS line_cost
         FROM production_order_materials m JOIN products p ON p.id = m.component_id
        WHERE m.production_order_id = ? ORDER BY m.id`,
      [order.id],
    );
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
      materials,
      shortage,
      actions,
      defaultLot: order.lot_number || lotFromDate(order.start_date),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/production-orders/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const order = await one('SELECT * FROM production_orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (order.status !== 'planned') {
      req.flash('error', 'Only planned production orders can be edited.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    const boms = await query(
      `SELECT b.id, b.name, b.version, b.output_qty, p.name AS product_name, p.sku, p.unit
         FROM boms b JOIN products p ON p.id = b.product_id WHERE b.status = 'active' ORDER BY p.name`,
    );
    const salesOrders = await query(
      `SELECT so.id, so.order_no, so.expected_date, c.company_name FROM sales_orders so
         JOIN customers c ON c.id = so.customer_id
        WHERE so.status IN ('confirmed','partially_delivered') ORDER BY so.order_date DESC LIMIT 100`,
    );
    res.render('manufacturing/production/form', {
      title: req.t('Edit {number}', { number: order.production_no }),
      active: 'manufacturing-production',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
        { label: order.production_no, href: `/manufacturing/production-orders/${order.id}` },
        { label: req.t('Edit') },
      ],
      boms,
      salesOrders,
      row: { ...order, lot_number: order.lot_number || lotFromDate(order.start_date) },
      errors: {},
      mode: 'edit',
      action: `/manufacturing/production-orders/${order.id}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)', async (req, res, next) => {
  try {
    const order = await one('SELECT * FROM production_orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (order.status !== 'planned') {
      req.flash('error', 'Only planned production orders can be edited.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    const bomId = Number.parseInt(req.body.bom_id, 10);
    const quantity = toNumber(req.body.quantity, 0);
    const bom = bomId ? await one('SELECT * FROM boms WHERE id = ?', [bomId]) : null;
    const startDate = String(req.body.start_date || '').slice(0, 10);
    const lotNumber = String(req.body.lot_number || '').trim().slice(0, 60);
    const expiryDate = String(req.body.expiry_date || '').slice(0, 10);
    const errors = {};
    if (!bom) errors.bom_id = req.t('Select an active BOM.');
    if (quantity <= 0) errors.quantity = req.t('Quantity must be greater than zero.');
    if (!lotNumber) errors.lot_number = req.t('Lot number is required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      errors.expiry_date = req.t('Valid expiry date required.');
    }

    if (Object.keys(errors).length) {
      const boms = await query(
        `SELECT b.id, b.name, b.version, b.output_qty, p.name AS product_name, p.sku, p.unit
           FROM boms b JOIN products p ON p.id = b.product_id WHERE b.status = 'active' ORDER BY p.name`,
      );
      const salesOrders = await query(
        `SELECT so.id, so.order_no, so.expected_date, c.company_name FROM sales_orders so
           JOIN customers c ON c.id = so.customer_id
          WHERE so.status IN ('confirmed','partially_delivered') ORDER BY so.order_date DESC LIMIT 100`,
      );
      return res.status(422).render('manufacturing/production/form', {
        title: req.t('Edit {number}', { number: order.production_no }),
        active: 'manufacturing-production',
        breadcrumbs: [
          { label: req.t('Manufacturing') },
          { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
          { label: order.production_no, href: `/manufacturing/production-orders/${order.id}` },
          { label: req.t('Edit') },
        ],
        boms,
        salesOrders,
        row: { ...order, ...req.body },
        errors,
        mode: 'edit',
        action: `/manufacturing/production-orders/${order.id}`,
      });
    }

    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE production_orders
            SET sales_order_id = ?, bom_id = ?, product_id = ?, lot_number = ?, expiry_date = ?,
                quantity = ?, start_date = ?, due_date = ?, notes = ?
          WHERE id = ?`,
        [
          Number.parseInt(req.body.sales_order_id, 10) || null,
          bom.id,
          bom.product_id,
          lotNumber,
          expiryDate,
          quantity,
          startDate || null,
          req.body.due_date || null,
          (req.body.notes || '').slice(0, 5000) || null,
          order.id,
        ],
      );
      await snapshotMaterials(conn, order.id, bom.id, quantity);
    });

    req.flash('success', 'Production order updated.');
    res.redirect(`/manufacturing/production-orders/${order.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)/batch', async (req, res, next) => {
  try {
    const order = await one('SELECT * FROM production_orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    if (!['planned', 'released', 'in_progress'].includes(order.status)) {
      req.flash('error', 'Batch details cannot be changed for this production order.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }

    const lotNumber = String(req.body.lot_number || '').trim().slice(0, 60);
    const expiryDate = String(req.body.expiry_date || '').slice(0, 10);
    if (!lotNumber) {
      req.flash('error', 'Lot number is required.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      req.flash('error', 'Valid expiry date required.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }

    await getPool().query(
      'UPDATE production_orders SET lot_number = ?, expiry_date = ? WHERE id = ?',
      [lotNumber, expiryDate, order.id],
    );
    req.flash('success', 'Batch details updated.');
    res.redirect(`/manufacturing/production-orders/${order.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)/status', async (req, res, next) => {
  try {
    const order = await one('SELECT * FROM production_orders WHERE id = ?', [req.params.id]);
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
      if (!order.lot_number || !order.expiry_date) {
        req.flash('error', 'Enter lot number and expiry date before completing production.');
        return res.redirect(`/manufacturing/production-orders/${order.id}`);
      }
      await completeProductionOrder(order.id, req.session.user.id);
      req.flash('success', 'Production completed. Materials consumed and finished goods added to stock.');
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
    const order = await one('SELECT * FROM production_orders WHERE id = ?', [req.params.id]);
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

module.exports = router;
