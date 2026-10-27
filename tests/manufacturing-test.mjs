/**
 * Database integration checks for material-class production allocation.
 *
 * The test creates its own products, material class, BOM and production orders,
 * verifies priority allocation, reservations and completion, then removes
 * everything it created. Run against a development database:
 *   npm run test:manufacturing
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const db = require('../src/db/index.js');
const { snapshotMaterials, completeProductionOrder } = require('../src/lib/production.js');

await db.initDb();
const pool = db.getPool();
const conn = await pool.getConnection();
const suffix = `${Date.now()}`;
const ids = { products: [], orders: [] };
let classId = null;
let bomId = null;

async function insertProduct(sku, name, type, unit, stock, cost) {
  const [result] = await conn.query(
    `INSERT INTO products
       (sku, name, type, unit, cost_gross_price, cost_price, stock_qty, track_stock, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active')`,
    [sku, name, type, unit, cost, cost, stock],
  );
  ids.products.push(result.insertId);
  return result.insertId;
}

try {
  const preferredId = await insertProduct(`TST-A-${suffix}`, 'Test preferred member', 'raw_material', 'reel', 100, 100);
  const substituteId = await insertProduct(`TST-B-${suffix}`, 'Test substitute member', 'raw_material', 'box', 50, 60);
  const finishedId = await insertProduct(`TST-F-${suffix}`, 'Test finished good', 'finished_good', 'pcs', 0, 25);

  const [classResult] = await conn.query(
    `INSERT INTO material_classes (code, name, unit, allow_mix, cost_method, status)
     VALUES (?, 'Test class', 'kg', 1, 'priority', 'active')`,
    [`TST-${suffix}`.slice(0, 30)],
  );
  classId = classResult.insertId;
  await conn.query(
    `INSERT INTO material_class_members (class_id, product_id, priority, conversion_factor, status)
     VALUES (?, ?, 10, 20, 'active'), (?, ?, 20, 10, 'active')`,
    [classId, preferredId, classId, substituteId],
  );

  const [bomResult] = await conn.query(
    `INSERT INTO boms (product_id, name, version, output_qty, status)
     VALUES (?, ?, 'test', 1, 'active')`,
    [finishedId, `Test BOM ${suffix}`],
  );
  bomId = bomResult.insertId;
  await conn.query(
    `INSERT INTO bom_items (bom_id, component_id, material_class_id, quantity, scrap_percent, sort_order)
     VALUES (?, NULL, ?, 100, 0, 0)`,
    [bomId, classId],
  );

  async function createOrder(quantity) {
    const [orderResult] = await conn.query(
      `INSERT INTO production_orders (production_no, start_date, status)
       VALUES (?, '2026-10-26', 'planned')`,
      [`TST-${suffix}-${ids.orders.length + 1}`.slice(0, 30)],
    );
    const orderId = orderResult.insertId;
    ids.orders.push(orderId);
    await conn.query(
      `INSERT INTO production_order_lines
         (production_order_id, bom_id, product_id, quantity, lot_number, expiry_date, sort_order)
       VALUES (?, ?, ?, ?, 'TEST-LOT', '2027-12-31', 0)`,
      [orderId, bomId, finishedId, quantity],
    );
    await snapshotMaterials(conn, orderId);
    return orderId;
  }

  // First order: 10 output units = 1,000 kg. The preferred member supplies
  // 100 units x 20 kg per unit, so it covers the requirement alone.
  const firstOrder = await createOrder(10);
  const [firstAllocations] = await conn.query(
    `SELECT component_id, quantity_required, priority, conversion_factor, unit_cost
       FROM production_order_materials
      WHERE production_order_id = ?
      ORDER BY priority`,
    [firstOrder],
  );
  assert.deepEqual(
    firstAllocations.map((row) => [
      row.component_id,
      Number(row.quantity_required),
      Number(row.conversion_factor),
      Number(row.unit_cost),
    ]),
    [[preferredId, 50, 20, 100]],
    'the preferred member covers the requirement first and the conversion factor is snapshotted',
  );
  const [firstRequirement] = await conn.query(
    'SELECT quantity_required, quantity_allocated, shortage_qty FROM production_order_requirements WHERE production_order_id = ?',
    [firstOrder],
  );
  assert.equal(Number(firstRequirement[0].quantity_required), 1000);
  assert.equal(Number(firstRequirement[0].quantity_allocated), 1000);
  assert.equal(Number(firstRequirement[0].shortage_qty), 0);

  // Second order: 20 output units = 2,000 kg. The first order reserves 50
  // units of the preferred member; the remaining 1,500 kg are mixed across the
  // preferred and substitute members.
  const secondOrder = await createOrder(20);
  const [secondAllocations] = await conn.query(
    `SELECT component_id, quantity_required, priority, is_substitute
       FROM production_order_materials
      WHERE production_order_id = ?
      ORDER BY priority`,
    [secondOrder],
  );
  assert.deepEqual(
    secondAllocations.map((row) => [row.component_id, Number(row.quantity_required), Number(row.is_substitute)]),
    [[preferredId, 50, 0], [substituteId, 50, 1]],
    'reservations from other active orders reduce available stock and mixing is used',
  );
  const [secondRequirement] = await conn.query(
    'SELECT quantity_required, quantity_allocated, shortage_qty FROM production_order_requirements WHERE production_order_id = ?',
    [secondOrder],
  );
  assert.equal(Number(secondRequirement[0].quantity_required), 2000);
  assert.equal(Number(secondRequirement[0].quantity_allocated), 1500);
  assert.equal(Number(secondRequirement[0].shortage_qty), 500, 'uncovered quantity stays as a class shortage');

  // Complete the first order and verify the class conversion, stock movements
  // and unit-cost snapshot.
  await conn.query("UPDATE production_orders SET status = 'in_progress' WHERE id = ?", [firstOrder]);
  await completeProductionOrder(firstOrder, null);
  const [completed] = await conn.query(
    'SELECT status FROM production_orders WHERE id = ?',
    [firstOrder],
  );
  assert.equal(completed[0].status, 'completed');
  const [consumedRequirement] = await conn.query(
    'SELECT quantity_consumed FROM production_order_requirements WHERE production_order_id = ?',
    [firstOrder],
  );
  assert.equal(Number(consumedRequirement[0].quantity_consumed), 1000, 'consumption is recorded in class units');
  const [consumedAllocation] = await conn.query(
    'SELECT quantity_consumed FROM production_order_materials WHERE production_order_id = ?',
    [firstOrder],
  );
  assert.equal(Number(consumedAllocation[0].quantity_consumed), 50, 'member consumption is in member units');
  const [stocks] = await conn.query(
    'SELECT id, stock_qty FROM products WHERE id IN (?, ?, ?)',
    [preferredId, substituteId, finishedId],
  );
  const stockById = new Map(stocks.map((row) => [Number(row.id), Number(row.stock_qty)]));
  assert.equal(stockById.get(preferredId), 50);
  assert.equal(stockById.get(substituteId), 50);
  assert.equal(stockById.get(finishedId), 10);
  const [movements] = await conn.query(
    `SELECT movement_type, quantity, unit_cost
       FROM stock_movements
      WHERE reference_type = 'production_order' AND reference_id = ?
      ORDER BY id`,
    [firstOrder],
  );
  assert.deepEqual(
    movements.map((row) => [row.movement_type, Number(row.quantity), Number(row.unit_cost)]),
    [
      ['production_out', -50, 100],
      ['production_in', 10, 25],
    ],
    'stock movements carry the snapshotted member and finished-goods costs',
  );

  console.log('All manufacturing integration checks passed.');
} finally {
  try {
    for (const orderId of ids.orders) {
      await conn.query(
        "DELETE FROM stock_movements WHERE reference_type = 'production_order' AND reference_id = ?",
        [orderId],
      );
      await conn.query('DELETE FROM production_orders WHERE id = ?', [orderId]);
    }
    if (bomId) await conn.query('DELETE FROM boms WHERE id = ?', [bomId]);
    if (classId) await conn.query('DELETE FROM material_classes WHERE id = ?', [classId]);
    for (const productId of ids.products) {
      await conn.query('DELETE FROM products WHERE id = ?', [productId]);
    }
  } finally {
    conn.release();
    await db.closeDb();
  }
}
