'use strict';

const { query, one } = require('../../db');

const ACTIVE_STATUSES = ['planned', 'released', 'in_progress'];
const ALL_STATUSES = ['planned', 'released', 'in_progress', 'completed', 'cancelled'];

function validStatuses(statuses) {
  const list = [...new Set((statuses || []).filter((status) => ALL_STATUSES.includes(status)))];
  return list.length ? list : ACTIVE_STATUSES;
}

async function listProductionOrders(statuses = ACTIVE_STATUSES, limit = 10) {
  const selected = validStatuses(statuses);
  const placeholders = selected.map(() => '?').join(',');
  const rows = await query(
    `SELECT po.id, po.production_no, po.status, po.start_date, po.due_date,
            po.completed_at, so.order_no, c.company_name AS customer_name
       FROM production_orders po
       LEFT JOIN sales_orders so ON so.id = po.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
      WHERE po.status IN (${placeholders})
      ORDER BY (po.due_date IS NULL), po.due_date, po.id
      LIMIT ?`,
    [...selected, Number(limit) || 10],
  );
  const totalRows = await query(
    `SELECT COUNT(*) AS count
       FROM production_orders
      WHERE status IN (${placeholders})`,
    selected,
  );
  const ids = rows.map((row) => Number(row.id));
  if (ids.length) {
    const linePlaceholders = ids.map(() => '?').join(',');
    const lines = await query(
      `SELECT l.production_order_id, l.quantity, l.lot_number, l.expiry_date,
              p.sku, p.name, p.unit
         FROM production_order_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.production_order_id IN (${linePlaceholders})
        ORDER BY l.sort_order, l.id`,
      ids,
    );
    const byOrder = new Map();
    for (const line of lines) {
      const key = Number(line.production_order_id);
      const list = byOrder.get(key) || [];
      list.push({
        quantity: Number(line.quantity) || 0,
        lot_number: line.lot_number,
        expiry_date: line.expiry_date,
        sku: line.sku,
        name: line.name,
        unit: line.unit,
      });
      byOrder.set(key, list);
    }
    for (const row of rows) {
      row.products = byOrder.get(Number(row.id)) || [];
    }
  } else {
    for (const row of rows) row.products = [];
  }
  return {
    orders: rows,
    total: Number(totalRows[0] && totalRows[0].count) || 0,
    shown: rows.length,
    statuses: selected,
  };
}

async function findProductionOrder(reference) {
  const raw = String(reference || '').trim();
  if (!raw) return null;
  const numeric = /^\d+$/.test(raw) ? Number(raw) : 0;
  return one(
    `SELECT po.*, so.order_no, c.company_name AS customer_name
       FROM production_orders po
       LEFT JOIN sales_orders so ON so.id = po.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
      WHERE UPPER(po.production_no) = UPPER(?)
         OR po.id = ?
      LIMIT 1`,
    [raw, numeric],
  );
}

async function getOrderLines(orderId) {
  return query(
    `SELECT l.quantity, l.lot_number, l.expiry_date,
            p.sku, p.name, p.unit
       FROM production_order_lines l
       JOIN products p ON p.id = l.product_id
      WHERE l.production_order_id = ?
      ORDER BY l.sort_order, l.id`,
    [orderId],
  );
}

async function getOrderRequirements(orderId) {
  return query(
    `SELECT r.*, mc.code AS class_code, mc.name AS class_name,
            p.sku AS component_sku, p.name AS component_name,
            COALESCE(mc.name, p.name) AS material_name
       FROM production_order_requirements r
       LEFT JOIN material_classes mc ON mc.id = r.material_class_id
       LEFT JOIN products p ON p.id = r.component_id
      WHERE r.production_order_id = ?
      ORDER BY r.sort_order, r.id`,
    [orderId],
  );
}

async function listShortageOrders(statuses = ACTIVE_STATUSES, limit = 10) {
  const selected = validStatuses(statuses);
  const placeholders = selected.map(() => '?').join(',');
  const rows = await query(
    `SELECT po.id, po.production_no, po.status, po.due_date,
            r.shortage_qty, r.unit,
            COALESCE(mc.name, p.name) AS material_name
       FROM production_order_requirements r
       JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN material_classes mc ON mc.id = r.material_class_id
       LEFT JOIN products p ON p.id = r.component_id
      WHERE po.status IN (${placeholders})
        AND r.shortage_qty > 0.0005
      ORDER BY (po.due_date IS NULL), po.due_date, po.id, r.sort_order, r.id`,
    selected,
  );
  const grouped = new Map();
  for (const row of rows) {
    const key = Number(row.id);
    let order = grouped.get(key);
    if (!order) {
      order = {
        id: Number(row.id),
        production_no: row.production_no,
        status: row.status,
        due_date: row.due_date,
        materials: [],
      };
      grouped.set(key, order);
    }
    order.materials.push({
      name: row.material_name,
      unit: row.unit,
      shortage_qty: Number(row.shortage_qty) || 0,
    });
  }
  const orders = [...grouped.values()];
  return {
    orders: orders.slice(0, Number(limit) || 10),
    total: orders.length,
    shown: Math.min(orders.length, Number(limit) || 10),
    statuses: selected,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  ALL_STATUSES,
  validStatuses,
  listProductionOrders,
  findProductionOrder,
  getOrderLines,
  getOrderRequirements,
  listShortageOrders,
};
