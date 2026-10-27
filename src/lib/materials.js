'use strict';

const { query } = require('../db');

const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
const round4 = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;

function memberUnitCost(member) {
  const type = member && (member.product_type || member.component_type || member.type);
  if (!member || String(type) === 'service') return 0;
  const gross = Math.max(0, Number(member.cost_gross_price) || 0);
  const levy = Math.max(0, Number(member.cost_levy_rate) || 0);
  if (gross > 0) return round4(gross + (gross * levy) / 100);
  return round4(Math.max(0, Number(member.cost_price) || 0));
}

function memberClassCost(member) {
  const factor = Math.max(0.000001, Number(member.conversion_factor) || 1);
  return round4(memberUnitCost(member) / factor);
}

function sortMembers(a, b) {
  const priority = (Number(a.priority) || 0) - (Number(b.priority) || 0);
  if (priority !== 0) return priority;
  return String(a.name || a.sku || '').localeCompare(String(b.name || b.sku || ''));
}

function activeMembers(members) {
  return (members || []).filter((member) => (
    member.status === 'active'
    && (member.product_status === undefined || member.product_status === 'active')
  ));
}

function classCostSummary(members, method = 'priority') {
  const active = activeMembers(members).sort(sortMembers);
  const costs = active
    .map((member) => memberClassCost(member))
    .filter((value) => Number.isFinite(value));
  if (!costs.length) {
    return { cost: 0, min: 0, max: 0, preferred: null, priced_count: 0 };
  }
  const preferred = active[0] || null;
  let cost = preferred ? memberClassCost(preferred) : 0;
  if (method === 'average') {
    cost = round4(costs.reduce((sum, value) => sum + value, 0) / costs.length);
  } else if (method === 'lowest') {
    cost = Math.min(...costs);
  } else if (method === 'highest') {
    cost = Math.max(...costs);
  }
  return {
    cost,
    min: Math.min(...costs),
    max: Math.max(...costs),
    preferred,
    priced_count: costs.length,
  };
}

function classStock(members) {
  return round3(activeMembers(members).reduce(
    (sum, member) => sum + Math.max(0, Number(member.stock_qty) || 0) * Math.max(0, Number(member.conversion_factor) || 0),
    0,
  ));
}

function allocateClassRequirement({ required, members, reservedByProduct = new Map(), allowMix = true }) {
  const quantity = Math.max(0, Number(required) || 0);
  const active = activeMembers(members).sort(sortMembers);
  const allocations = [];
  let remaining = quantity;

  for (const member of active) {
    if (remaining <= 0.0005) break;
    const factor = Math.max(0.000001, Number(member.conversion_factor) || 1);
    const reserved = Math.max(0, Number(reservedByProduct.get(Number(member.product_id)) || 0));
    const stock = Math.max(0, (Number(member.stock_qty) || 0) - reserved);
    const availableClass = round3(stock * factor);
    const takeClass = allowMix
      ? Math.min(remaining, availableClass)
      : (availableClass >= remaining ? remaining : 0);
    if (takeClass <= 0.0005) continue;
    allocations.push({
      member,
      product_id: Number(member.product_id),
      class_quantity: round3(takeClass),
      quantity: round3(takeClass / factor),
      priority: Number(member.priority) || 0,
      conversion_factor: factor,
      unit_cost: memberUnitCost(member),
    });
    remaining = round3(remaining - takeClass);
  }

  return {
    allocations,
    allocated_class_qty: round3(quantity - remaining),
    shortage_qty: round3(Math.max(0, remaining)),
  };
}

async function loadClassMembers({ classIds = null, activeOnly = true, conn = null } = {}) {
  const params = [];
  const where = [];
  if (classIds) {
    const ids = [...new Set(classIds.map(Number).filter((id) => id > 0))];
    if (!ids.length) return [];
    where.push(`mcm.class_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (activeOnly) where.push("mcm.status = 'active'");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT mcm.*, p.sku AS product_sku, p.name, p.unit AS product_unit,
                      p.type AS product_type, p.status AS product_status,
                      p.cost_gross_price, p.cost_levy_rate, p.cost_price,
                      p.stock_qty, p.supplier_id, p.lead_time_days, p.min_order_qty, p.order_multiple,
                      s.company_name AS supplier_name
                 FROM material_class_members mcm
                 JOIN products p ON p.id = mcm.product_id
                 LEFT JOIN suppliers s ON s.id = p.supplier_id
                 ${whereSql}
                ORDER BY mcm.class_id, mcm.priority, mcm.id`;
  const rows = conn ? (await conn.query(sql, params))[0] : await query(sql, params);
  return rows.map((row) => {
    const member = {
      ...row,
      product_id: Number(row.product_id),
      class_id: Number(row.class_id),
      priority: Number(row.priority) || 0,
      conversion_factor: Number(row.conversion_factor) || 1,
      stock_qty: Number(row.stock_qty) || 0,
    };
    member.unit_cost = memberUnitCost(member);
    member.class_unit_cost = memberClassCost(member);
    member.class_stock = round3(
      Math.max(0, member.stock_qty) * Math.max(0, member.conversion_factor),
    );
    return member;
  });
}

async function loadMaterialClasses({ activeOnly = false } = {}) {
  const classes = await query(
    `SELECT * FROM material_classes
      ${activeOnly ? "WHERE status = 'active'" : ''}
      ORDER BY name`,
  );
  if (!classes.length) return [];
  const members = await loadClassMembers({
    classIds: classes.map((row) => row.id),
    activeOnly: false,
  });
  const byClass = new Map();
  for (const member of members) {
    const list = byClass.get(member.class_id) || [];
    list.push(member);
    byClass.set(member.class_id, list);
  }
  return classes.map((row) => {
    const list = (byClass.get(Number(row.id)) || []).sort(sortMembers);
    const summary = classCostSummary(list, row.cost_method);
    const active = activeMembers(list);
    return {
      ...row,
      id: Number(row.id),
      allow_mix: Number(row.allow_mix) === 1,
      members: list,
      active_members: active,
      member_count: list.length,
      active_member_count: active.length,
      stock_qty: classStock(list),
      unit_cost: summary.cost,
      cost_min: summary.min,
      cost_max: summary.max,
      preferred_member: summary.preferred,
    };
  });
}

async function loadBomLineCosts(bomIds) {
  const ids = [...new Set((bomIds || []).map(Number).filter((id) => id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await query(
    `SELECT bi.*, p.sku AS component_sku, p.name AS component_name, p.unit AS component_unit,
            p.type AS component_type, p.cost_gross_price, p.cost_levy_rate, p.cost_price,
            p.stock_qty AS component_stock, p.supplier_id, p.lead_time_days,
            p.min_order_qty, p.order_multiple, s.company_name AS supplier_name,
            mc.code AS class_code, mc.name AS class_name, mc.unit AS class_unit,
            mc.cost_method AS class_cost_method, mc.status AS class_status
       FROM bom_items bi
       LEFT JOIN products p ON p.id = bi.component_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN material_classes mc ON mc.id = bi.material_class_id
      WHERE bi.bom_id IN (${placeholders})
      ORDER BY bi.bom_id, bi.sort_order, bi.id`,
    ids,
  );
  const classIds = [...new Set(rows.map((row) => Number(row.material_class_id)).filter((id) => id > 0))];
  const members = await loadClassMembers({ classIds, activeOnly: false });
  const byClass = new Map();
  for (const member of members) {
    const list = byClass.get(member.class_id) || [];
    list.push(member);
    byClass.set(member.class_id, list);
  }

  const result = new Map();
  for (const row of rows) {
    const list = result.get(Number(row.bom_id)) || [];
    const quantity = Math.max(0, Number(row.quantity) || 0);
    const scrap = Math.max(0, Number(row.scrap_percent) || 0);
    const isClass = Number(row.material_class_id) > 0;
    let unit = row.component_unit;
    let name = row.component_name;
    let sku = row.component_sku;
    let unitCost = 0;
    let costMin = 0;
    let costMax = 0;
    let preferred = null;
    let classMembers = [];
    let stockQty = Number(row.component_stock) || 0;
    let type = row.component_type;
    if (isClass) {
      classMembers = (byClass.get(Number(row.material_class_id)) || []).sort(sortMembers);
      const summary = classCostSummary(classMembers, row.class_cost_method);
      unit = row.class_unit || 'unit';
      name = row.class_name;
      sku = row.class_code;
      unitCost = summary.cost;
      costMin = summary.min;
      costMax = summary.max;
      preferred = summary.preferred;
      stockQty = classStock(classMembers);
      type = 'material_class';
    } else {
      unitCost = memberUnitCost(row);
      costMin = unitCost;
      costMax = unitCost;
    }
    const lineCost = round4(quantity * (1 + scrap / 100) * unitCost);
    list.push({
      ...row,
      id: Number(row.id),
      bom_id: Number(row.bom_id),
      is_class: isClass,
      component_id: row.component_id ? Number(row.component_id) : null,
      material_class_id: row.material_class_id ? Number(row.material_class_id) : null,
      name,
      sku,
      unit: unit || 'unit',
      quantity,
      scrap_percent: scrap,
      qty_with_scrap: round3(quantity * (1 + scrap / 100)),
      unit_cost: round4(unitCost),
      cost_price: round4(unitCost),
      cost_min: round4(costMin),
      cost_max: round4(costMax),
      line_cost: lineCost,
      stock_qty: stockQty,
      type,
      preferred_member: preferred,
      members: classMembers,
      class_missing: isClass && !classMembers.some((member) => member.status === 'active' && member.product_status !== 'inactive'),
    });
    result.set(Number(row.bom_id), list);
  }
  return result;
}

async function loadBomCostsForProducts(productIds) {
  const ids = [...new Set((productIds || []).map(Number).filter((id) => id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const boms = await query(
    `SELECT id, product_id, output_qty
       FROM boms
      WHERE status = 'active'
        AND product_id IN (${placeholders})
      ORDER BY id DESC`,
    ids,
  );
  const selected = new Map();
  for (const bom of boms) {
    const productId = Number(bom.product_id);
    if (!selected.has(productId)) selected.set(productId, bom);
  }
  const lines = await loadBomLineCosts([...selected.values()].map((bom) => bom.id));
  const result = new Map();
  for (const [productId, bom] of selected) {
    const items = lines.get(Number(bom.id)) || [];
    const materialCost = round4(items.reduce((sum, item) => sum + item.line_cost, 0));
    const output = Math.max(0.0001, Number(bom.output_qty) || 1);
    result.set(productId, {
      bom_id: Number(bom.id),
      output_qty: output,
      items,
      material_cost: materialCost,
      unit_cost: round4(materialCost / output),
    });
  }
  return result;
}

module.exports = {
  round3,
  round4,
  memberUnitCost,
  memberClassCost,
  sortMembers,
  activeMembers,
  classCostSummary,
  classStock,
  allocateClassRequirement,
  loadClassMembers,
  loadMaterialClasses,
  loadBomLineCosts,
  loadBomCostsForProducts,
};
