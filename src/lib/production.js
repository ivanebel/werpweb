'use strict';

const { withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { todayISO, addDaysISO, lotFromDate } = require('../lib/helpers');
const materials = require('./materials');

const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

async function reservedByComponent(conn, excludeOrderId) {
  const [rows] = await conn.query(
    `SELECT m.component_id, SUM(m.quantity_required) AS quantity
       FROM production_order_materials m
       JOIN production_orders po ON po.id = m.production_order_id
      WHERE po.status IN ('planned', 'released', 'in_progress')
        AND po.id <> ?
      GROUP BY m.component_id`,
    [excludeOrderId || 0],
  );
  return new Map(rows.map((row) => [Number(row.component_id), Number(row.quantity) || 0]));
}

async function loadOrderBomItems(conn, bomIds) {
  const ids = [...new Set((bomIds || []).map(Number).filter((id) => id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT bi.*, p.unit AS component_unit, p.cost_gross_price, p.cost_levy_rate,
            p.cost_price, p.stock_qty, p.track_stock, p.type AS component_type,
            mc.code AS class_code, mc.name AS class_name, mc.unit AS class_unit,
            mc.allow_mix, mc.cost_method
       FROM bom_items bi
       LEFT JOIN products p ON p.id = bi.component_id
       LEFT JOIN material_classes mc ON mc.id = bi.material_class_id
      WHERE bi.bom_id IN (${placeholders})
      ORDER BY bi.bom_id, bi.sort_order, bi.id`,
    ids,
  );
  const byBom = new Map();
  for (const row of rows) {
    const list = byBom.get(Number(row.bom_id)) || [];
    list.push(row);
    byBom.set(Number(row.bom_id), list);
  }
  return byBom;
}

/**
 * Rebuilds the material requirement and allocation snapshot for a production
 * order. Requirements are aggregated by material class or fixed component;
 * allocations store the exact member products selected by priority and stock.
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
  if (!lines.length) {
    await conn.query('DELETE FROM production_order_materials WHERE production_order_id = ?', [productionOrderId]);
    await conn.query('DELETE FROM production_order_requirements WHERE production_order_id = ?', [productionOrderId]);
    return 0;
  }

  const itemsByBom = await loadOrderBomItems(conn, lines.map((line) => line.bom_id));
  const requirements = new Map();
  let sort = 0;
  for (const line of lines) {
    const outputQty = Number(line.output_qty) || 1;
    for (const item of itemsByBom.get(Number(line.bom_id)) || []) {
      const isClass = Number(item.material_class_id) > 0;
      const key = isClass ? `class:${item.material_class_id}` : `component:${item.component_id}`;
      const quantity = Number(item.quantity)
        * (Number(line.quantity) / outputQty)
        * (1 + Number(item.scrap_percent) / 100);
      const existing = requirements.get(key);
      if (existing) {
        existing.quantity_required = round3(existing.quantity_required + quantity);
        existing.source_count += 1;
      } else {
        requirements.set(key, {
          material_class_id: isClass ? Number(item.material_class_id) : null,
          component_id: isClass ? null : Number(item.component_id),
          unit: isClass ? (item.class_unit || 'unit') : (item.component_unit || 'unit'),
          quantity_required: round3(quantity),
          source_count: 1,
          sort_order: sort++,
          class_row: isClass ? item : null,
          component_row: isClass ? null : item,
        });
      }
    }
  }

  await conn.query('DELETE FROM production_order_materials WHERE production_order_id = ?', [productionOrderId]);
  await conn.query('DELETE FROM production_order_requirements WHERE production_order_id = ?', [productionOrderId]);

  for (const requirement of requirements.values()) {
    const [result] = await conn.query(
      `INSERT INTO production_order_requirements
         (production_order_id, material_class_id, component_id, unit, quantity_required,
          quantity_allocated, quantity_consumed, shortage_qty, source_count, sort_order)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      [
        productionOrderId,
        requirement.material_class_id,
        requirement.component_id,
        requirement.unit,
        requirement.quantity_required,
        requirement.quantity_required,
        requirement.source_count,
        requirement.sort_order,
      ],
    );
    requirement.id = result.insertId;
  }

  const reserved = await reservedByComponent(conn, productionOrderId);
  const classIds = [...requirements.values()]
    .map((requirement) => requirement.material_class_id)
    .filter((id) => id);
  const classMembers = await materials.loadClassMembers({ classIds, activeOnly: true, conn });
  const membersByClass = new Map();
  for (const member of classMembers) {
    const list = membersByClass.get(member.class_id) || [];
    list.push(member);
    membersByClass.set(member.class_id, list);
  }

  for (const requirement of requirements.values()) {
    const row = requirement.class_row || requirement.component_row;
    if (requirement.material_class_id) {
      const members = membersByClass.get(Number(requirement.material_class_id)) || [];
      const allowMix = Number(row.allow_mix) !== 0;
      const allocation = materials.allocateClassRequirement({
        required: requirement.quantity_required,
        members,
        reservedByProduct: reserved,
        allowMix,
      });
      const firstPriority = materials.activeMembers(members).sort(materials.sortMembers)[0]?.priority;
      for (const selected of allocation.allocations) {
        await conn.query(
          `INSERT INTO production_order_materials
             (production_order_id, requirement_id, material_class_id, component_id,
              quantity_required, quantity_consumed, source_count, priority,
              conversion_factor, unit_cost, is_substitute)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          [
            productionOrderId,
            requirement.id,
            requirement.material_class_id,
            selected.product_id,
            selected.quantity,
            requirement.source_count,
            selected.priority,
            selected.conversion_factor || 1,
            selected.unit_cost,
            firstPriority !== undefined && selected.priority > firstPriority ? 1 : 0,
          ],
        );
        reserved.set(
          selected.product_id,
          round3((reserved.get(selected.product_id) || 0) + selected.quantity),
        );
      }
      await conn.query(
        `UPDATE production_order_requirements
            SET quantity_allocated = ?, shortage_qty = ?
          WHERE id = ?`,
        [allocation.allocated_class_qty, allocation.shortage_qty, requirement.id],
      );
    } else {
      const componentId = Number(requirement.component_id);
      const tracked = Number(row.track_stock) === 1;
      const stock = tracked
        ? Math.max(0, (Number(row.stock_qty) || 0) - (reserved.get(componentId) || 0))
        : requirement.quantity_required;
      const shortage = tracked ? Math.max(0, round3(requirement.quantity_required - stock)) : 0;
      await conn.query(
        `INSERT INTO production_order_materials
           (production_order_id, requirement_id, material_class_id, component_id,
            quantity_required, quantity_consumed, source_count, priority,
            conversion_factor, unit_cost, is_substitute)
         VALUES (?, ?, NULL, ?, ?, 0, ?, 0, 1, ?, 0)`,
        [
          productionOrderId,
          requirement.id,
          componentId,
          requirement.quantity_required,
          requirement.source_count,
          materials.memberUnitCost(row),
        ],
      );
      reserved.set(componentId, round3((reserved.get(componentId) || 0) + requirement.quantity_required));
      await conn.query(
        `UPDATE production_order_requirements
            SET quantity_allocated = ?, shortage_qty = ?
          WHERE id = ?`,
        [requirement.quantity_required, shortage, requirement.id],
      );
    }
  }

  return requirements.size;
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

    const [requirements] = await conn.query(
      `SELECT r.*, mc.name AS class_name, mc.code AS class_code,
              p.sku AS component_sku, p.name AS component_name
         FROM production_order_requirements r
         LEFT JOIN material_classes mc ON mc.id = r.material_class_id
         LEFT JOIN products p ON p.id = r.component_id
        WHERE r.production_order_id = ?
        ORDER BY r.sort_order, r.id`,
      [productionOrderId],
    );
    if (!requirements.length) {
      throw Object.assign(new Error('Add at least one BOM line before completing production.'), { status: 422 });
    }
    const [allocations] = await conn.query(
      `SELECT m.*, p.sku, p.name, p.stock_qty, p.track_stock, p.cost_price
         FROM production_order_materials m
         JOIN products p ON p.id = m.component_id
        WHERE m.production_order_id = ?
        ORDER BY m.priority, m.id`,
      [productionOrderId],
    );

    const requirementShortages = requirements
      .filter((requirement) => Number(requirement.shortage_qty) > 0.0005)
      .map((requirement) => {
        const label = requirement.material_class_id
          ? `${requirement.class_code || ''} ${requirement.class_name || ''}`.trim()
          : `${requirement.component_sku || ''} ${requirement.component_name || ''}`.trim();
        return `${label} (short ${requirement.shortage_qty} ${requirement.unit})`;
      });
    if (requirementShortages.length) {
      throw Object.assign(
        new Error(`Resolve material shortages before completing production: ${requirementShortages.join('; ')}. Reallocate or receive stock first.`),
        { status: 422 },
      );
    }

    const byComponent = new Map();
    for (const allocation of allocations) {
      const componentId = Number(allocation.component_id);
      const entry = byComponent.get(componentId) || {
        sku: allocation.sku,
        name: allocation.name,
        stock_qty: Number(allocation.stock_qty) || 0,
        track_stock: Number(allocation.track_stock) === 1,
        required: 0,
      };
      entry.required = round3(entry.required + Number(allocation.quantity_required));
      byComponent.set(componentId, entry);
    }
    const stockShortages = [...byComponent.entries()]
      .filter(([, entry]) => entry.track_stock && entry.stock_qty < entry.required)
      .map(([, entry]) => `${entry.sku} (need ${entry.required}, have ${entry.stock_qty})`);
    if (stockShortages.length) {
      throw Object.assign(
        new Error(`Not enough material to complete production: ${stockShortages.join('; ')}. Receive stock first.`),
        { status: 422 },
      );
    }

    for (const allocation of allocations) {
      await conn.query('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', [allocation.quantity_required, allocation.component_id]);
      await conn.query(
        `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
         VALUES (?, 'production_out', ?, ?, 'production_order', ?, ?, ?)`,
        [
          allocation.component_id,
          -allocation.quantity_required,
          allocation.unit_cost || allocation.cost_price,
          productionOrderId,
          'Material consumed',
          userId,
        ],
      );
      await conn.query(
        'UPDATE production_order_materials SET quantity_consumed = ? WHERE id = ?',
        [allocation.quantity_required, allocation.id],
      );
    }
    await conn.query(
      `UPDATE production_order_requirements r
          SET quantity_consumed = (
            SELECT COALESCE(SUM(
              m.quantity_consumed * CASE
                WHEN r.material_class_id IS NULL THEN 1
                ELSE m.conversion_factor
              END
            ), 0)
              FROM production_order_materials m
             WHERE m.requirement_id = r.id
          )
        WHERE r.production_order_id = ?`,
      [productionOrderId],
    );

    for (const line of lines) {
      await conn.query('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [line.quantity, line.product_id]);
      await conn.query(
        `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
         VALUES (?, 'production_in', ?, ?, 'production_order', ?, ?, ?)`,
        [line.product_id, line.quantity, line.cost_price || 0, productionOrderId, `Finished goods produced - lot ${line.lot_number}`, userId],
      );
    }

    await conn.query(
      `UPDATE production_orders SET status = 'completed', completed_at = NOW() WHERE id = ?`,
      [productionOrderId],
    );
    return { materials: allocations.length, lines: lines.length };
  });
}

module.exports = { snapshotMaterials, createProductionFromSalesOrder, completeProductionOrder, round3 };
