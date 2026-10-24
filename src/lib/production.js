'use strict';

const { query, one, withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { todayISO, addDaysISO } = require('../lib/helpers');

const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/**
 * Creates the material requirement snapshot for a production order.
 * required = bom component qty * (order qty / bom output qty) * (1 + scrap%)
 */
async function snapshotMaterials(conn, productionOrderId, bomId, quantity) {
  const [bomRows] = await conn.query('SELECT output_qty FROM boms WHERE id = ?', [bomId]);
  if (!bomRows.length) throw new Error('BOM not found');
  const outputQty = Number(bomRows[0].output_qty) || 1;
  const [items] = await conn.query(
    'SELECT component_id, quantity, scrap_percent FROM bom_items WHERE bom_id = ? ORDER BY id',
    [bomId],
  );
  await conn.query('DELETE FROM production_order_materials WHERE production_order_id = ?', [productionOrderId]);
  for (const item of items) {
    const required = round3(
      Number(item.quantity) * (Number(quantity) / outputQty) * (1 + Number(item.scrap_percent) / 100),
    );
    await conn.query(
      `INSERT INTO production_order_materials (production_order_id, component_id, quantity_required, quantity_consumed)
       VALUES (?, ?, ?, 0)`,
      [productionOrderId, item.component_id, required],
    );
  }
  return items.length;
}

async function createProductionFromSalesOrder(salesOrderId, userId) {
  return withTransaction(async (conn) => {
    const [orderRows] = await conn.query('SELECT * FROM sales_orders WHERE id = ?', [salesOrderId]);
    if (!orderRows.length) throw Object.assign(new Error('Sales order not found'), { status: 404 });
    const order = orderRows[0];
    if (['cancelled', 'delivered'].includes(order.status)) {
      throw Object.assign(new Error('This sales order can no longer be produced.'), { status: 422 });
    }

    const [items] = await conn.query(
      `SELECT i.*, p.name, p.sku, p.is_manufactured
         FROM sales_order_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ?`,
      [salesOrderId],
    );

    let created = 0;
    const skipped = [];
    for (const item of items) {
      if (!item.is_manufactured) continue;

      const [existing] = await conn.query(
        `SELECT id FROM production_orders
          WHERE sales_order_id = ? AND product_id = ? AND status <> 'cancelled' LIMIT 1`,
        [salesOrderId, item.product_id],
      );
      if (existing.length) {
        skipped.push(`${item.sku} (already has a production order)`);
        continue;
      }

      const [boms] = await conn.query(
        `SELECT id FROM boms WHERE product_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
        [item.product_id],
      );
      if (!boms.length) {
        skipped.push(`${item.sku} (no active BOM)`);
        continue;
      }

      const orderDate = todayISO();
      const productionNo = await nextNumber({
        prefix: 'PRD',
        table: 'production_orders',
        column: 'production_no',
        date: orderDate,
        conn,
      });
      const [result] = await conn.query(
        `INSERT INTO production_orders
           (production_no, sales_order_id, bom_id, product_id, quantity, start_date, due_date, status, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
        [
          productionNo,
          salesOrderId,
          boms[0].id,
          item.product_id,
          item.quantity,
          orderDate,
          order.expected_date || addDaysISO(orderDate, 14),
          `Created from sales order ${order.order_no}`,
          userId,
        ],
      );
      await snapshotMaterials(conn, result.insertId, boms[0].id, item.quantity);
      created += 1;
    }

    return {
      created,
      skipped,
      message:
        created === 0
          ? skipped.length
            ? `Nothing created: ${skipped.join(', ')}`
            : 'This order contains no manufactured products.'
          : null,
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

    const [productRows] = await conn.query('SELECT cost_price FROM products WHERE id = ?', [order.product_id]);
    await conn.query('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [order.quantity, order.product_id]);
    await conn.query(
      `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
       VALUES (?, 'production_in', ?, ?, 'production_order', ?, ?, ?)`,
      [order.product_id, order.quantity, productRows[0]?.cost_price || 0, productionOrderId, 'Finished goods produced', userId],
    );

    await conn.query(
      `UPDATE production_orders SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [productionOrderId],
    );
    return { materials: materials.length };
  });
}

module.exports = { snapshotMaterials, createProductionFromSalesOrder, completeProductionOrder, round3 };
