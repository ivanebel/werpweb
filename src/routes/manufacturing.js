'use strict';

const express = require('express');
const { query, one, scalar, getPool, withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { pagination, todayISO, addDaysISO, lotFromDate, toNumber, statusInfo, formatMoney } = require('../lib/helpers');
const { snapshotMaterials, completeProductionOrder } = require('../lib/production');
const materials = require('../lib/materials');
const { requireRole } = require('../middleware/web');

const round3 = materials.round3;

const router = express.Router();
const manageMaterials = requireRole('admin', 'manager');

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
    stock: Number(p.stock_qty),
    unit: p.unit,
    type: p.type,
  }));
}

async function materialProductOptions() {
  const rows = await query(
    `SELECT id, sku, name, type, unit, cost_price, stock_qty, status
       FROM products
      WHERE type <> 'service'
      ORDER BY status, name`,
  );
  return rows.map((p) => ({
    value: String(p.id),
    label: `${p.sku} - ${p.name}${p.status === 'inactive' ? ' (inactive)' : ''}`,
    cost: Number(p.cost_price),
    stock: Number(p.stock_qty),
    unit: p.unit,
    type: p.type,
    status: p.status,
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
  const lineCosts = await materials.loadBomLineCosts([id]);
  return lineCosts.get(Number(id)) || [];
}

// -------------------------------------------------------- material classes
async function loadMaterialClass(id) {
  return one('SELECT * FROM material_classes WHERE id = ? LIMIT 1', [id]);
}

async function loadMaterialClassMembers(id) {
  return query(
    `SELECT mcm.*, p.sku, p.name, p.unit AS product_unit, p.type AS product_type,
            p.stock_qty, p.cost_price, p.cost_gross_price, p.cost_levy_rate
       FROM material_class_members mcm
       JOIN products p ON p.id = mcm.product_id
      WHERE mcm.class_id = ?
      ORDER BY mcm.priority, mcm.id`,
    [id],
  );
}

function materialClassDefaults() {
  return {
    code: '',
    name: '',
    unit: 'unit',
    allow_mix: 1,
    cost_method: 'priority',
    status: 'active',
    notes: '',
    members: [{ product_id: '', priority: 100, conversion_factor: 1, status: 'active', notes: '' }],
  };
}

function collectClassMembers(body, productMap, t = (value) => value) {
  const productIds = arr(body.member_product_id);
  const priorities = arr(body.member_priority);
  const factors = arr(body.member_conversion_factor);
  const statuses = arr(body.member_status);
  const notes = arr(body.member_notes);
  const count = Math.max(productIds.length, priorities.length, factors.length, statuses.length, notes.length);
  const rows = [];
  const errors = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const productId = Number.parseInt(productIds[i], 10);
    if (!productId) continue;
    const product = productMap.get(productId);
    if (!product) {
      errors.push(t('Member {line}: select an active product.', { line: rows.length + 1 }));
      continue;
    }
    if (product.type === 'service') {
      errors.push(t('Member {line}: services cannot be used as material class members.', { line: rows.length + 1 }));
      continue;
    }
    if (seen.has(productId)) {
      errors.push(t('The same product cannot be added twice to a material class.'));
      continue;
    }
    const factor = toNumber(factors[i], 0);
    if (factor <= 0) {
      errors.push(t('Member {line}: conversion factor must be greater than zero.', { line: rows.length + 1 }));
      continue;
    }
    const priority = Number.parseInt(priorities[i], 10);
    if (!Number.isInteger(priority) || priority < 0) {
      errors.push(t('Member {line}: priority must be zero or greater.', { line: rows.length + 1 }));
      continue;
    }
    seen.add(productId);
    rows.push({
      product_id: productId,
      priority,
      conversion_factor: factor,
      status: statuses[i] === 'inactive' ? 'inactive' : 'active',
      notes: String(notes[i] || '').trim().slice(0, 255) || null,
    });
  }
  if (!rows.length) errors.push(t('Add at least one active product member to the material class.'));
  return { rows, errors };
}

function validateMaterialClass(body, req) {
  const values = {
    code: String(body.code || '').trim().toUpperCase(),
    name: String(body.name || '').trim(),
    unit: String(body.unit || '').trim().slice(0, 20),
    allow_mix: body.allow_mix === '1' || body.allow_mix === 'on' || body.allow_mix === 'true' ? 1 : 0,
    cost_method: ['priority', 'average', 'lowest', 'highest'].includes(body.cost_method) ? body.cost_method : 'priority',
    status: body.status === 'inactive' ? 'inactive' : 'active',
    notes: String(body.notes || '').trim().slice(0, 500) || null,
  };
  const errors = {};
  if (!/^[A-Z0-9_-]{2,30}$/.test(values.code)) {
    errors.code = req.t('Use 2-30 letters, numbers, hyphens or underscores.');
  }
  if (!values.name) errors.name = req.t('Name is required.');
  else if (values.name.length > 150) errors.name = req.t('Name must be 150 characters or fewer.');
  if (!values.unit) errors.unit = req.t('Unit is required.');
  return { values, errors };
}

async function renderMaterialClassForm(req, res, options = {}) {
  const { status = 200, row, items, errors = {}, memberErrors = [], mode = 'create' } = options;
  const products = await materialProductOptions();
  return res.status(status).render('manufacturing/material-classes/form', {
    title: mode === 'create' ? req.t('New material class') : req.t('Edit material class'),
    active: 'manufacturing-material-classes',
    breadcrumbs: [
      { label: req.t('Manufacturing') },
      { label: req.t('Material classes'), href: '/manufacturing/material-classes' },
      { label: mode === 'create' ? req.t('New material class') : (row.name || req.t('Edit')) },
    ],
    products,
    row,
    items: items && items.length ? items : materialClassDefaults().members,
    errors,
    memberErrors,
    mode,
    action: mode === 'create' ? '/manufacturing/material-classes' : `/manufacturing/material-classes/${row.id}`,
  });
}

router.get('/material-classes', manageMaterials, async (req, res, next) => {
  try {
    const classes = await materials.loadMaterialClasses();
    const usage = await query(
      `SELECT material_class_id, COUNT(*) AS bom_count
         FROM bom_items
        WHERE material_class_id IS NOT NULL
        GROUP BY material_class_id`,
    );
    const usageById = new Map(usage.map((row) => [Number(row.material_class_id), Number(row.bom_count) || 0]));
    res.render('manufacturing/material-classes/index', {
      title: req.t('Material classes'),
      active: 'manufacturing-material-classes',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Material classes') },
      ],
      classes: classes.map((row) => ({ ...row, bom_count: usageById.get(Number(row.id)) || 0 })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/material-classes/new', manageMaterials, async (req, res, next) => {
  try {
    return renderMaterialClassForm(req, res, {
      row: materialClassDefaults(),
      items: materialClassDefaults().members,
      mode: 'create',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/material-classes/:id(\\d+)/edit', manageMaterials, async (req, res, next) => {
  try {
    const row = await loadMaterialClass(req.params.id);
    if (!row) return next(Object.assign(new Error(req.t('Material class not found.')), { status: 404 }));
    const members = await loadMaterialClassMembers(row.id);
    return renderMaterialClassForm(req, res, {
      row: { ...row, allow_mix: Number(row.allow_mix) === 1 ? 1 : 0 },
      items: members,
      mode: 'edit',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/material-classes', manageMaterials, async (req, res, next) => {
  try {
    const products = await materialProductOptions();
    const productMap = new Map(products.map((product) => [Number(product.value), product]));
    const { values, errors } = validateMaterialClass(req.body, req);
    const membersResult = collectClassMembers(req.body, productMap, req.t);
    if (Object.keys(errors).length || membersResult.errors.length) {
      return renderMaterialClassForm(req, res, {
        status: 422,
        row: { ...materialClassDefaults(), ...values, members: membersResult.rows },
        items: membersResult.rows,
        errors,
        memberErrors: membersResult.errors,
        mode: 'create',
      });
    }
    const duplicate = await one('SELECT id FROM material_classes WHERE code = ? OR name = ? LIMIT 1', [values.code, values.name]);
    if (duplicate) {
      errors.code = req.t('A material class with this code or name already exists.');
      return renderMaterialClassForm(req, res, {
        status: 422,
        row: { ...materialClassDefaults(), ...values, members: membersResult.rows },
        items: membersResult.rows,
        errors,
        memberErrors: [],
        mode: 'create',
      });
    }
    const id = await withTransaction(async (conn) => {
      const [result] = await conn.query(
        `INSERT INTO material_classes (code, name, unit, allow_mix, cost_method, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [values.code, values.name, values.unit, values.allow_mix, values.cost_method, values.status, values.notes],
      );
      for (const member of membersResult.rows) {
        await conn.query(
          `INSERT INTO material_class_members (class_id, product_id, priority, conversion_factor, status, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [result.insertId, member.product_id, member.priority, member.conversion_factor, member.status, member.notes],
        );
      }
      return result.insertId;
    });
    req.flash('success', 'Material class created.');
    return res.redirect(`/manufacturing/material-classes/${id}/edit`);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'A material class with this code or name already exists.');
      return res.redirect('/manufacturing/material-classes/new');
    }
    next(err);
  }
});

router.post('/material-classes/:id(\\d+)', manageMaterials, async (req, res, next) => {
  try {
    const existing = await loadMaterialClass(req.params.id);
    if (!existing) return next(Object.assign(new Error(req.t('Material class not found.')), { status: 404 }));
    const products = await materialProductOptions();
    const productMap = new Map(products.map((product) => [Number(product.value), product]));
    const { values, errors } = validateMaterialClass(req.body, req);
    const membersResult = collectClassMembers(req.body, productMap, req.t);
    if (Object.keys(errors).length || membersResult.errors.length) {
      return renderMaterialClassForm(req, res, {
        status: 422,
        row: { ...existing, ...values, id: existing.id, members: membersResult.rows },
        items: membersResult.rows,
        errors,
        memberErrors: membersResult.errors,
        mode: 'edit',
      });
    }
    const duplicate = await one(
      'SELECT id FROM material_classes WHERE (code = ? OR name = ?) AND id <> ? LIMIT 1',
      [values.code, values.name, existing.id],
    );
    if (duplicate) {
      errors.code = req.t('A material class with this code or name already exists.');
      return renderMaterialClassForm(req, res, {
        status: 422,
        row: { ...existing, ...values, id: existing.id, members: membersResult.rows },
        items: membersResult.rows,
        errors,
        memberErrors: [],
        mode: 'edit',
      });
    }
    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE material_classes
            SET code = ?, name = ?, unit = ?, allow_mix = ?, cost_method = ?, status = ?, notes = ?
          WHERE id = ?`,
        [values.code, values.name, values.unit, values.allow_mix, values.cost_method, values.status, values.notes, existing.id],
      );
      await conn.query('DELETE FROM material_class_members WHERE class_id = ?', [existing.id]);
      for (const member of membersResult.rows) {
        await conn.query(
          `INSERT INTO material_class_members (class_id, product_id, priority, conversion_factor, status, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [existing.id, member.product_id, member.priority, member.conversion_factor, member.status, member.notes],
        );
      }
    });
    req.flash('success', 'Material class updated.');
    return res.redirect('/manufacturing/material-classes');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'A material class with this code or name already exists.');
      return res.redirect(`/manufacturing/material-classes/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.post('/material-classes/:id(\\d+)/delete', manageMaterials, async (req, res, next) => {
  try {
    const existing = await loadMaterialClass(req.params.id);
    if (!existing) return next(Object.assign(new Error(req.t('Material class not found.')), { status: 404 }));
    const [usage, requirements] = await Promise.all([
      scalar('SELECT COUNT(*) FROM bom_items WHERE material_class_id = ?', [existing.id]),
      scalar('SELECT COUNT(*) FROM production_order_requirements WHERE material_class_id = ?', [existing.id]),
    ]);
    if (Number(usage) > 0 || Number(requirements) > 0) {
      req.flash('error', 'This material class is used by a BOM or production order. Mark it inactive instead.');
      return res.redirect('/manufacturing/material-classes');
    }
    await getPool().query('DELETE FROM material_classes WHERE id = ?', [existing.id]);
    req.flash('success', 'Material class deleted.');
    return res.redirect('/manufacturing/material-classes');
  } catch (err) {
    next(err);
  }
});

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
              (SELECT COUNT(*) FROM bom_items bi WHERE bi.bom_id = b.id AND bi.material_class_id IS NOT NULL) AS class_count
         FROM boms b JOIN products p ON p.id = b.product_id
         ${whereSql}
        ORDER BY b.id DESC
        LIMIT ? OFFSET ?`,
      [...params, perPage, (pag.page - 1) * perPage],
    );
    const lineCosts = await materials.loadBomLineCosts(rows.map((row) => Number(row.id)));
    for (const row of rows) {
      const items = lineCosts.get(Number(row.id)) || [];
      const materialCost = items.reduce((sum, item) => sum + item.line_cost, 0);
      row.unit_cost = materialCost / (Number(row.output_qty) || 1);
    }

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
    const [products, classes] = await Promise.all([productOptions(), materials.loadMaterialClasses()]);
    const row = {
      product_id: req.query.product_id || '',
      name: '',
      version: 'v1',
      output_qty: 1,
      status: 'draft',
      notes: '',
    };
    const items = [{ item_type: 'component', component_id: '', material_class_id: '', quantity: 1, scrap_percent: 0 }];
    res.render('manufacturing/boms/form', {
      title: req.t('New BOM'),
      active: 'manufacturing-boms',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Bills of materials'), href: '/manufacturing/boms' },
        { label: req.t('New BOM') },
      ],
      products,
      classes,
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

function collectBomItems(body, t = (value) => value, classMap = new Map(), outputProductId = 0) {
  const types = arr(body.item_type);
  const componentIds = arr(body.component_id);
  const classIds = arr(body.material_class_id);
  const qtys = arr(body.quantity);
  const scraps = arr(body.scrap_percent);
  const count = Math.max(types.length, componentIds.length, classIds.length, qtys.length, scraps.length);
  const items = [];
  const errors = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const type = types[i] === 'class' ? 'class' : 'component';
    const componentId = Number.parseInt(componentIds[i], 10);
    const classId = Number.parseInt(classIds[i], 10);
    const qty = toNumber(qtys[i], 0);
    const scrap = toNumber(scraps[i], 0);
    const hasValue = (type === 'class' ? classId : componentId) || qty || scrap;
    if (!hasValue) continue;
    if (type === 'class') {
      if (!classId) {
        errors.push(t('Every material class line needs a class.'));
        continue;
      }
      const materialClass = classMap.get(classId);
      if (!materialClass) {
        errors.push(t('Select a valid material class.'));
        continue;
      }
      if ((materialClass.members || []).some((member) => Number(member.product_id) === Number(outputProductId))) {
        errors.push(t('A BOM cannot contain its own output product through a material class.'));
        continue;
      }
      if (seen.has(`class:${classId}`)) {
        errors.push(t('The same material class cannot be added twice.'));
        continue;
      }
      seen.add(`class:${classId}`);
      if (qty <= 0) {
        errors.push(t('Every material class needs a quantity greater than zero.'));
        continue;
      }
      items.push({
        item_type: 'class',
        component_id: null,
        material_class_id: classId,
        quantity: qty,
        scrap_percent: scrap,
      });
    } else {
      if (!componentId) {
        errors.push(t('Every component line needs a component.'));
        continue;
      }
      if (Number(componentId) === Number(outputProductId)) {
        errors.push(t('A BOM cannot contain its own output product.'));
        continue;
      }
      if (seen.has(`component:${componentId}`)) {
        errors.push(t('The same component cannot be added twice.'));
        continue;
      }
      seen.add(`component:${componentId}`);
      if (qty <= 0) {
        errors.push(t('Every component needs a quantity greater than zero.'));
        continue;
      }
      items.push({
        item_type: 'component',
        component_id: componentId,
        material_class_id: null,
        quantity: qty,
        scrap_percent: scrap,
      });
    }
  }
  if (!items.length) errors.push(t('Add at least one component or material class to the BOM.'));
  return { items, errors };
}

router.post('/boms', async (req, res, next) => {
  try {
    const [products, classes] = await Promise.all([productOptions(), materials.loadMaterialClasses()]);
    const classMap = new Map(classes.map((row) => [Number(row.id), row]));
    const productId = Number.parseInt(req.body.product_id, 10);
    const { items, errors } = collectBomItems(req.body, req.t, classMap, productId);
    const fieldErrors = {};
    if (!productId) fieldErrors.product_id = req.t('Select the product this BOM produces.');
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
        classes,
        row: req.body,
        items: items.length ? items : [{ item_type: 'component', component_id: '', material_class_id: '', quantity: 1, scrap_percent: 0 }],
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
          `INSERT INTO bom_items
             (bom_id, component_id, material_class_id, quantity, scrap_percent, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [result.insertId, item.component_id, item.material_class_id, item.quantity, item.scrap_percent, sort++],
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
    const [products, classes] = await Promise.all([productOptions(), materials.loadMaterialClasses()]);
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
      classes,
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
    const [products, classes] = await Promise.all([productOptions(), materials.loadMaterialClasses()]);
    const classMap = new Map(classes.map((row) => [Number(row.id), row]));
    const productId = Number.parseInt(req.body.product_id, 10);
    const { items, errors } = collectBomItems(req.body, req.t, classMap, productId);
    const fieldErrors = {};
    if (!productId) fieldErrors.product_id = req.t('Select the product this BOM produces.');
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
        classes,
        row: { ...bom, ...req.body },
        items: items.length ? items : [{ item_type: 'component', component_id: '', material_class_id: '', quantity: 1, scrap_percent: 0 }],
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
          `INSERT INTO bom_items
             (bom_id, component_id, material_class_id, quantity, scrap_percent, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [bom.id, item.component_id, item.material_class_id, item.quantity, item.scrap_percent, sort++],
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

async function loadProductionRequirements(productionOrderId) {
  return query(
    `SELECT r.*, mc.code AS class_code, mc.name AS class_name, mc.unit AS class_unit,
            p.sku AS component_sku, p.name AS component_name, p.unit AS component_unit,
            p.stock_qty AS component_stock
       FROM production_order_requirements r
       LEFT JOIN material_classes mc ON mc.id = r.material_class_id
       LEFT JOIN products p ON p.id = r.component_id
      WHERE r.production_order_id = ?
      ORDER BY r.sort_order, r.id`,
    [productionOrderId],
  );
}

async function loadProductionMaterials(productionOrderId) {
  return query(
    `SELECT m.*, p.sku, p.name, p.unit, p.stock_qty, p.track_stock, p.cost_price,
            r.material_class_id, mc.code AS class_code, mc.name AS class_name,
            (m.quantity_required * COALESCE(NULLIF(m.unit_cost, 0), p.cost_price)) AS line_cost
       FROM production_order_materials m
       JOIN products p ON p.id = m.component_id
       LEFT JOIN production_order_requirements r ON r.id = m.requirement_id
       LEFT JOIN material_classes mc ON mc.id = m.material_class_id
      WHERE m.production_order_id = ?
      ORDER BY COALESCE(mc.name, p.name), m.priority, m.id`,
    [productionOrderId],
  );
}

async function reservedForOrder(productionOrderId) {
  const rows = await query(
    `SELECT m.component_id, SUM(m.quantity_required) AS quantity
       FROM production_order_materials m
       JOIN production_orders po ON po.id = m.production_order_id
      WHERE po.status IN ('planned', 'released', 'in_progress')
        AND po.id <> ?
      GROUP BY m.component_id`,
    [productionOrderId],
  );
  return new Map(rows.map((row) => [Number(row.component_id), Number(row.quantity) || 0]));
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
    const requirements = await loadProductionRequirements(order.id);
    const allocations = await loadProductionMaterials(order.id);
    const reserved = await reservedForOrder(order.id);
    for (const allocation of allocations) {
      allocation.reserved_other = reserved.get(Number(allocation.component_id)) || 0;
      allocation.available = Math.max(
        0,
        (Number(allocation.stock_qty) || 0) - allocation.reserved_other,
      );
    }
    const shortage = requirements.some((requirement) => Number(requirement.shortage_qty) > 0.0005)
      || allocations.some((allocation) => (
        Number(allocation.track_stock) === 1
        && Number(allocation.stock_qty) < Number(allocation.quantity_required)
      ));

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
      actions.push({ href: `/manufacturing/production-orders/${order.id}/materials`, label: req.t('Edit material allocation'), tone: 'secondary' });
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
      requirements,
      allocations,
      materials: allocations,
      shortage,
      actions,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/production-orders/:id(\\d+)/readonly', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    }
    const [lines, requirements, allocations] = await Promise.all([
      loadProductionLines(order.id),
      loadProductionRequirements(order.id),
      loadProductionMaterials(order.id),
    ]);
    const shortage = requirements.some((requirement) => Number(requirement.shortage_qty) > 0.0005);
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.render('manufacturing/production/readonly', {
      title: `${order.production_no} · ${req.t('Read-only')}`,
      active: 'manufacturing-production',
      breadcrumbs: [
        { label: req.t('Manufacturing') },
        { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
        { label: order.production_no },
        { label: req.t('Read-only') },
      ],
      order,
      lines,
      requirements,
      allocations,
      shortage,
    });
  } catch (err) {
    next(err);
  }
});

async function loadAllocationPageData(orderId) {
  const requirements = await loadProductionRequirements(orderId);
  const allocations = await loadProductionMaterials(orderId);
  const reserved = await reservedForOrder(orderId);
  const classIds = requirements.filter((row) => row.material_class_id).map((row) => Number(row.material_class_id));
  const members = await materials.loadClassMembers({ classIds, activeOnly: false });
  const membersByClass = new Map();
  for (const member of members) {
    const list = membersByClass.get(member.class_id) || [];
    list.push(member);
    membersByClass.set(member.class_id, list);
  }
  const allocationsByRequirement = new Map();
  for (const allocation of allocations) {
    const key = Number(allocation.requirement_id);
    const list = allocationsByRequirement.get(key) || [];
    list.push(allocation);
    allocationsByRequirement.set(key, list);
  }
  for (const requirement of requirements) {
    const requirementAllocations = allocationsByRequirement.get(Number(requirement.id)) || [];
    requirement.allocations = requirementAllocations;
    if (requirement.material_class_id) {
      requirement.members = (membersByClass.get(Number(requirement.material_class_id)) || [])
        .sort(materials.sortMembers)
        .map((member) => {
          const allocated = requirementAllocations
            .filter((row) => Number(row.component_id) === Number(member.product_id))
            .reduce((sum, row) => sum + Number(row.quantity_required), 0);
          const reservedQty = reserved.get(Number(member.product_id)) || 0;
          const available = Math.max(0, (Number(member.stock_qty) || 0) - reservedQty);
          return {
            ...member,
            unit_cost: materials.memberUnitCost(member),
            reserved_other: reservedQty,
            available,
            allocated: Number(allocated) || 0,
          };
        });
    } else {
      const allocation = requirementAllocations[0] || null;
      const reservedQty = reserved.get(Number(requirement.component_id)) || 0;
      requirement.members = [];
      requirement.allocation = allocation;
      requirement.reserved_other = reservedQty;
      requirement.available = Math.max(0, (Number(requirement.component_stock) || 0) - reservedQty);
    }
  }
  return { requirements, allocations, reserved };
}

async function renderAllocationPage(req, res, options = {}) {
  const { status = 200, order, errors = [], posted = {} } = options;
  const data = await loadAllocationPageData(order.id);
  const currency = (res.locals.settings && res.locals.settings.currency) || 'USD';
  return res.status(status).render('manufacturing/production/materials', {
    title: req.t('Material allocation'),
    active: 'manufacturing-production',
    breadcrumbs: [
      { label: req.t('Manufacturing') },
      { label: req.t('Production orders'), href: '/manufacturing/production-orders' },
      { label: order.production_no, href: `/manufacturing/production-orders/${order.id}` },
      { label: req.t('Material allocation') },
    ],
    order,
    ...data,
    errors,
    posted,
    money: (value) => formatMoney(value, currency, req.locale),
  });
}

router.get('/production-orders/:id(\\d+)/materials', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    if (!['planned', 'released', 'in_progress'].includes(order.status)) {
      req.flash('error', 'Material allocation cannot be changed for this production order.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    return renderAllocationPage(req, res, { order });
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)/materials', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    if (!['planned', 'released', 'in_progress'].includes(order.status)) {
      req.flash('error', 'Material allocation cannot be changed for this production order.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }

    const data = await loadAllocationPageData(order.id);
    const errors = [];
    const posted = {};
    const reservedInOrder = new Map();
    const classRequirements = data.requirements.filter((row) => row.material_class_id);
    for (const requirement of classRequirements) {
      let totalClass = 0;
      for (const member of requirement.members) {
        if (member.status !== 'active' || member.product_status === 'inactive') continue;
        const field = `allocation_${requirement.id}_${member.product_id}`;
        const raw = req.body[field];
        const quantity = raw === undefined || raw === '' ? 0 : Number(raw);
        posted[field] = raw === undefined ? '' : raw;
        if (!Number.isFinite(quantity) || quantity < 0) {
          errors.push(req.t('Line {line}: quantities must be zero or greater.', { line: requirement.class_name || requirement.id }));
          continue;
        }
        const available = Math.max(
          0,
          Number(member.available) - (reservedInOrder.get(Number(member.product_id)) || 0),
        );
        if (quantity > available + 0.0005) {
          errors.push(req.t('Line {line}: {product} only has {available} available.', {
            line: requirement.class_name || requirement.id,
            product: member.name,
            available,
          }));
          continue;
        }
        reservedInOrder.set(
          Number(member.product_id),
          (reservedInOrder.get(Number(member.product_id)) || 0) + quantity,
        );
        totalClass += quantity * Number(member.conversion_factor);
      }
      if (totalClass > Number(requirement.quantity_required) + 0.0005) {
        errors.push(req.t('Line {line}: allocation exceeds the requirement of {required} {unit}.', {
          line: requirement.class_name || requirement.id,
          required: requirement.quantity_required,
          unit: requirement.unit,
        }));
      }
    }

    if (errors.length) {
      return renderAllocationPage(req, res, { status: 422, order, errors, posted });
    }

    await withTransaction(async (conn) => {
      for (const requirement of classRequirements) {
        const members = requirement.members;
        const firstPriority = members.filter((member) => member.status === 'active' && member.product_status !== 'inactive').sort(materials.sortMembers)[0]?.priority;
        let totalClass = 0;
        await conn.query('DELETE FROM production_order_materials WHERE requirement_id = ?', [requirement.id]);
        for (const member of members) {
          if (member.status !== 'active' || member.product_status === 'inactive') continue;
          const field = `allocation_${requirement.id}_${member.product_id}`;
          const quantity = Number(req.body[field] || 0);
          if (!Number.isFinite(quantity) || quantity <= 0) continue;
          const classQuantity = quantity * Number(member.conversion_factor);
          totalClass += classQuantity;
          await conn.query(
            `INSERT INTO production_order_materials
               (production_order_id, requirement_id, material_class_id, component_id,
                quantity_required, quantity_consumed, source_count, priority,
                conversion_factor, unit_cost, is_substitute)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
            [
              order.id,
              requirement.id,
              requirement.material_class_id,
              member.product_id,
              quantity,
              requirement.source_count,
              member.priority,
              member.conversion_factor,
              materials.memberUnitCost(member),
              firstPriority !== undefined && Number(member.priority) > Number(firstPriority) ? 1 : 0,
            ],
          );
        }
        await conn.query(
          `UPDATE production_order_requirements
              SET quantity_allocated = ?, shortage_qty = ?
            WHERE id = ?`,
          [
            round3(totalClass),
            Math.max(0, round3(Number(requirement.quantity_required) - totalClass)),
            requirement.id,
          ],
        );
      }
    });

    req.flash('success', 'Material allocation updated.');
    return res.redirect(`/manufacturing/production-orders/${order.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/production-orders/:id(\\d+)/reallocate', async (req, res, next) => {
  try {
    const order = await loadProductionOrder(req.params.id);
    if (!order) return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Production order') })), { status: 404 }));
    if (!['planned', 'released', 'in_progress'].includes(order.status)) {
      req.flash('error', 'Material allocation cannot be changed for this production order.');
      return res.redirect(`/manufacturing/production-orders/${order.id}`);
    }
    await withTransaction(async (conn) => {
      await snapshotMaterials(conn, order.id);
    });
    req.flash('success', 'Material allocation recalculated by priority and available stock.');
    return res.redirect(`/manufacturing/production-orders/${order.id}`);
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

    const existingLines = await loadProductionLines(order.id);
    const linesChanged = existingLines.length !== lines.length
      || existingLines.some((line, index) => (
        Number(line.bom_id) !== Number(lines[index].bom_id)
        || Math.abs(Number(line.quantity) - Number(lines[index].quantity)) > 0.0005
      ));

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
      if (linesChanged) await snapshotMaterials(conn, order.id);
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
