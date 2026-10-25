'use strict';

const { withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { todayISO, addDaysISO, lotFromDate } = require('../lib/helpers');

const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/**
 * Rebuilds the aggregated material requirement snapshot for a production
 * order from all of its BOM lines. Components shared by several BOMs are
 * combined into one row; source_count records how many BOM lines use them.
 */
async function snapshotMaterials(conn, productionOrderId) {
  const [lines] = await conn.query(
    `SELECT l.id, l.bom_id, l.quantity, b.output_qty
       FROM production_order_lines l
       JOIN boms b ON b.id = l.bom_id
      WHERE l.production_order_id = ?
      ORDER BY l.sort_order, l.id`,
    [productionOrderId],
  );

  const required = new Map();
  for (const line of lines) {
    const outputQty = Number(line.output_qty) || 1;
    const [items] = await conn.query(
      'SELECT component_id, quantity, scrap_percent FROM bom_items WHERE bom_id = ? ORDER BY id',
      [line.bom_id],
    );
    for (const item of items) {
      const quantity = Number(item.quantity)
        * (Number(line.quantity) / outputQty)
        * (1 + Number(item.scrap_percent) / 100);
      const entry = required.get(item.component_id) || { quantity: 0, sources: 0 };
      entry.quantity += quantity;
      entry.sources += 1;
      required.set(item.component_id, entry);
    }
  }

  await conn.query('DELETE FROM production_order_materials WHERE production_order_id = ?', [productionOrderId]);
  for (const [componentId, entry] of required) {
    await conn.query(
      `INSERT INTO production_order_materials
         (production_order_id, component_id, quantity_required, quantity_consumed, source_count)
       VALUES (?, ?, ?, 0, ?)`,
      [productionOrderId, componentId, round3(entry.quantity), entry.sources],
    );
  }
  return required.size;
}

async function createProductionFromSalesOrder(salesOrderId, userId) {
  return withTransaction(async (conn) => {
    const [orderRows] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [salesOrderId]);
    if (!orderRows.length) throw Object.assign(new Error('Sales order not found'), { status: 404 });
    const order = orderRows[0];
    if (['cancelled', 'delivered'].includes(order.status)) {
      throw Object.assign(new Error('This sales order can no longer be produced.'), { status: 422 });
    }

    const [existing] = await conn.query(
      `SELECT id FROM production_orders
        WHERE sales_order_id = ? AND status <> 'cancelled' LIMIT 1`,
      [salesOrderId],
    );
    if (existing.length) {
      return {
        created: 0,
        skipped: [],
        message: 'This sales order already has a production order. Edit that order to add more BOM lines.',
      };
    }

    const [items] = await conn.query(
      `SELECT i.*, p.name, p.sku, p.is_manufactured
         FROM sales_order_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ?`,
      [salesOrderId],
    );

    const lineMap = new Map();
    const skipped = [];
    for (const item of items) {
      if (!item.is_manufactured) continue;
      const [boms] = await conn.query(
        `SELECT id FROM boms WHERE product_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
        [item.product_id],
      );
      if (!boms.length) {
        skipped.push(`${item.sku} (no active BOM)`);
        continue;
      }
      const key = String(boms[0].id);
      const line = lineMap.get(key) || {
        bom_id: boms[0].id,
        product_id: item.product_id,
        quantity: 0,
      };
      line.quantity = round3(Number(line.quantity) + Number(item.quantity));
      lineMap.set(key, line);
    }
    const lines = [...lineMap.values()];

    if (!lines.length) {
      return {
        created: 0,
        skipped,
        message: skipped.length
          ? `Nothing created: ${skipped.join(', ')}`
          : 'This order contains no manufactured products.',
      };
    }

    const orderDate = todayISO();
    const expected = String(order.expected_date || '').slice(0, 10);
    const dueDate = expected && expected >= orderDate ? expected : addDaysISO(orderDate, 14);
    const productionNo = await nextNumber({
      prefix: 'PRD',
      table: 'production_orders',
      column: 'production_no',
      date: orderDate,
      conn,
    });
    const [result] = await conn.query(
      `INSERT INTO production_orders
         (production_no, sales_order_id, start_date, due_date, status, notes, created_by)
       VALUES (?, ?, ?, ?, 'planned', ?, ?)`,
      [
        productionNo,
        salesOrderId,
        orderDate,
        dueDate,
        `Created from sales order ${order.order_no}`,
        userId,
      ],
    );

    let sort = 0;
    for (const line of lines) {
      await conn.query(
        `INSERT INTO production_order_lines
           (production_order_id, bom_id, product_id, quantity, lot_number, expiry_date, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
        [result.insertId, line.bom_id, line.product_id, line.quantity, lotFromDate(orderDate), sort++],
      );
    }
    await snapshotMaterials(conn, result.insertId);

    return {
      created: 1,
      skipped,
      lines: lines.length,
      message: skipped.length ? `Some products were skipped: ${skipped.join(', ')}` : null,
    };
  });
}

async function completeProductionOrder(productionOrderId, userId) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM production_orders WHERE id = ? FOR UPDATE', [productionOrderId]);
    if (!rows.length) throw Object.assign(new Error('Production order not found'), { status: 404 });
    const order = rows[0];
    if (order.status === 'completed') throw Object.assign(new Error('Production order is already completed.'), { status: 422 });
    if (order.status === 'cancelled') throw Object.assign(new Error('Cancelled production orders cannot be completed.'), { status: 422 });

    const [lines] = await conn.query(
      `SELECT l.*, p.sku, p.name, p.cost_price
         FROM production_order_lines l
         JOIN products p ON p.id = l.product_id
        WHERE l.production_order_id = ?
        ORDER BY l.sort_order, l.id`,
      [productionOrderId],
    );
    if (!lines.length) {
      throw Object.assign(new Error('Add at least one BOM line before completing production.'), { status: 422 });
    }
    const missingBatch = lines.filter((line) => !line.lot_number || !line.expiry_date);
    if (missingBatch.length) {
      throw Object.assign(
        new Error(`Enter lot number and expiry date for: ${missingBatch.map((line) => `${line.sku} (${line.name})`).join(', ')}.`),
        { status: 422 },
      );
    }

    const [materials] = await conn.query(
      `SELECT m.*, p.sku, p.name, p.stock_qty, p.track_stock, p.cost_price
         FROM production_order_materials m JOIN products p ON p.id = m.component_id
        WHERE m.production_order_id = ?`,
      [productionOrderId],
    );

    const shortages = materials
      .filter((m) => m.track_stock && Number(m.stock_qty) < Number(m.quantity_required))
      .map((m) => `${m.sku} (need ${m.quantity_required}, have ${m.stock_qty})`);
    if (shortages.length) {
      throw Object.assign(
        new Error(`Not enough material to complete production: ${shortages.join('; ')}. Receive stock first.`),
        { status: 422 },
      );
    }

    for (const m of materials) {
      await conn.query('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', [m.quantity_required, m.component_id]);
      await conn.query(
        `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
         VALUES (?, 'production_out', ?, ?, 'production_order', ?, ?, ?)`,
        [m.component_id, -m.quantity_required, m.cost_price, productionOrderId, 'Material consumed', userId],
      );
      await conn.query('UPDATE production_order_materials SET quantity_consumed = ? WHERE id = ?', [m.quantity_required, m.id]);
    }

    for (const line of lines) {
      await conn.query('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [line.quantity, line.product_id]);
      await conn.query(
        `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
         VALUES (?, 'production_in', ?, ?, 'production_order', ?, ?, ?)`,
        [line.product_id, line.quantity, line.cost_price || 0, productionOrderId, `Finished goods produced — lot ${line.lot_number}`, userId],
      );
    }

    await conn.query(
      `UPDATE production_orders SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [productionOrderId],
    );
    return { materials: materials.length, lines: lines.length };
  });
}

module.exports = { snapshotMaterials, createProductionFromSalesOrder, completeProductionOrder, round3 };
