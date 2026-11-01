'use strict';

const { query, one } = require('../db');

const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;

function pair(value) {
  const match = String(value || '').match(/^(\d+):(\d+)$/);
  return match ? { classId: Number(match[1]), productId: Number(match[2]) } : null;
}

async function loadOrderOptions() {
  return query(
    `SELECT po.id, po.production_no, po.status, po.start_date, po.due_date,
            so.order_no, c.company_name AS customer_name,
            COUNT(pol.id) AS line_count
       FROM production_orders po
       LEFT JOIN sales_orders so ON so.id = po.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
       LEFT JOIN production_order_lines pol ON pol.production_order_id = po.id
      WHERE po.status IN ('released', 'in_progress')
      GROUP BY po.id, po.production_no, po.status, po.start_date, po.due_date,
               so.order_no, c.company_name, po.created_at
      ORDER BY po.created_at DESC, po.id DESC
      LIMIT 100`,
  );
}

async function loadOrder(orderId) {
  return one(
    `SELECT po.*, so.order_no, c.company_name AS customer_name
       FROM production_orders po
       LEFT JOIN sales_orders so ON so.id = po.sales_order_id
       LEFT JOIN customers c ON c.id = so.customer_id
      WHERE po.id = ? LIMIT 1`,
    [orderId],
  );
}

async function loadOrderLines(orderId) {
  return query(
    `SELECT l.*, p.name AS product_name, p.sku, p.unit,
            b.name AS bom_name, b.version AS bom_version
       FROM production_order_lines l
       JOIN products p ON p.id = l.product_id
       JOIN boms b ON b.id = l.bom_id
      WHERE l.production_order_id = ?
      ORDER BY l.sort_order, l.id`,
    [orderId],
  );
}

async function loadRawMaterialOptions(orderId) {
  const rows = await query(
    `SELECT l.id AS order_line_id,
            mc.id AS class_id, mc.code AS class_code, mc.name AS class_name, mc.unit AS class_unit,
            mcm.product_id, mcm.priority, mcm.conversion_factor,
            p.name AS product_name, p.sku, p.stock_qty, p.units_per_pack, p.unit AS product_unit
       FROM production_order_lines l
       JOIN bom_items bi ON bi.bom_id = l.bom_id AND bi.material_class_id IS NOT NULL
       JOIN material_classes mc ON mc.id = bi.material_class_id
            AND mc.status = 'active' AND mc.is_bottom_film = 0 AND mc.is_top_film = 0
       JOIN material_class_members mcm ON mcm.class_id = mc.id AND mcm.status = 'active'
       JOIN products p ON p.id = mcm.product_id AND p.status = 'active'
      WHERE l.production_order_id = ?
      ORDER BY l.sort_order, l.id, mc.name, mcm.priority, p.name`,
    [orderId],
  );
  const byLine = new Map();
  for (const row of rows) {
    const lineId = Number(row.order_line_id);
    const classId = Number(row.class_id);
    const classes = byLine.get(lineId) || new Map();
    const entry = classes.get(classId) || {
      id: classId,
      code: row.class_code,
      name: row.class_name,
      unit: row.class_unit,
      products: [],
    };
    entry.products.push({
      product_id: Number(row.product_id),
      name: row.product_name,
      sku: row.sku,
      stock_qty: Number(row.stock_qty) || 0,
      units_per_pack: Number(row.units_per_pack) || 0,
      unit: row.product_unit,
      conversion_factor: Number(row.conversion_factor) || 1,
      priority: Number(row.priority) || 0,
    });
    classes.set(classId, entry);
    byLine.set(lineId, classes);
  }
  const result = {};
  for (const [lineId, classes] of byLine.entries()) {
    result[lineId] = [...classes.values()];
  }
  return result;
}

async function loadFilmOptions(orderId) {
  const rows = await query(
    `SELECT l.id AS order_line_id,
            mc.id AS class_id, mc.code AS class_code, mc.name AS class_name, mc.unit AS class_unit,
            mc.coil_quantity, mc.is_bottom_film, mc.is_top_film,
            mcm.product_id, mcm.priority, mcm.conversion_factor,
            p.name AS product_name, p.sku, p.stock_qty, p.units_per_pack, p.unit AS product_unit,
            p.weight_kg, p.track_stock, p.cost_gross_price, p.cost_levy_rate, p.cost_price
       FROM production_order_lines l
       JOIN bom_items bi ON bi.bom_id = l.bom_id AND bi.material_class_id IS NOT NULL
       JOIN material_classes mc ON mc.id = bi.material_class_id
            AND mc.status = 'active' AND (mc.is_bottom_film = 1 OR mc.is_top_film = 1)
       JOIN material_class_members mcm ON mcm.class_id = mc.id AND mcm.status = 'active'
       JOIN products p ON p.id = mcm.product_id AND p.status = 'active'
      WHERE l.production_order_id = ?
      ORDER BY l.sort_order, l.id, mc.name, mcm.priority, p.name`,
    [orderId],
  );
  const bottom = new Map();
  const top = new Map();
  for (const row of rows) {
    const key = `${row.class_id}:${row.product_id}`;
    const option = {
      class_id: Number(row.class_id),
      class_code: row.class_code,
      class_name: row.class_name,
      class_unit: row.class_unit,
      coil_quantity: Number(row.coil_quantity) || 0,
      product_id: Number(row.product_id),
      product_name: row.product_name,
      sku: row.sku,
      stock_qty: Number(row.stock_qty) || 0,
      units_per_pack: Number(row.units_per_pack) || 0,
      unit: row.product_unit,
      weight_kg: Number(row.weight_kg) || 0,
      track_stock: Number(row.track_stock) === 1,
      cost_gross_price: Number(row.cost_gross_price) || 0,
      cost_levy_rate: Number(row.cost_levy_rate) || 0,
      cost_price: Number(row.cost_price) || 0,
      conversion_factor: Number(row.conversion_factor) || 1,
      order_line_ids: [],
    };
    if (Number(row.is_bottom_film) === 1) {
      const existing = bottom.get(key) || option;
      existing.order_line_ids = [...new Set([...existing.order_line_ids, Number(row.order_line_id)])];
      bottom.set(key, existing);
    }
    if (Number(row.is_top_film) === 1) {
      const existing = top.get(key) || option;
      existing.order_line_ids = [...new Set([...existing.order_line_ids, Number(row.order_line_id)])];
      top.set(key, existing);
    }
  }
  return { bottom: [...bottom.values()], top: [...top.values()] };
}

async function loadMachines() {
  const [portioning, thermoforming] = await Promise.all([
    query(
      `SELECT id, name, full_name, serial_number, status
         FROM machines
        WHERE machine_type = 'portioning' AND status = 'active'
        ORDER BY name`,
    ),
    query(
      `SELECT id, name, full_name, serial_number, status
         FROM machines
        WHERE machine_type = 'thermoforming' AND status = 'active'
        ORDER BY name`,
    ),
  ]);
  return { portioning, thermoforming };
}

async function loadActiveRuns() {
  return query(
    `SELECT r.*, pl.name AS line_name, pl.code AS line_code,
            po.production_no, pol.product_id,
            p.name AS product_name, p.sku AS product_sku
       FROM production_line_runs r
       JOIN production_lines pl ON pl.id = r.production_line_id
       JOIN production_orders po ON po.id = r.production_order_id
       JOIN production_order_lines pol ON pol.id = r.production_order_line_id
       JOIN products p ON p.id = pol.product_id
      WHERE r.status <> 'closed'
      ORDER BY pl.sort_order, r.id DESC`,
  );
}

async function loadRunsForOrder(orderId) {
  const runs = await query(
    `SELECT r.*, pl.name AS line_name, pl.code AS line_code,
            pl.thermoformer_machine_id,
            tf.name AS thermoformer_name, tf.full_name AS thermoformer_full_name,
            pol.quantity AS order_line_quantity, pol.lot_number AS product_lot,
            pol.expiry_date AS product_expiry,
            p.name AS product_name, p.sku AS product_sku, p.unit AS product_unit,
            m1.name AS machine1_name, m2.name AS machine2_name
       FROM production_line_runs r
       JOIN production_lines pl ON pl.id = r.production_line_id
       LEFT JOIN machines tf ON tf.id = pl.thermoformer_machine_id
       JOIN production_order_lines pol ON pol.id = r.production_order_line_id
       JOIN products p ON p.id = pol.product_id
       LEFT JOIN machines m1 ON m1.id = r.portioning_machine_1_id
       LEFT JOIN machines m2 ON m2.id = r.portioning_machine_2_id
      WHERE r.production_order_id = ? AND r.status <> 'closed'
      ORDER BY pl.sort_order, r.id DESC`,
    [orderId],
  );
  if (!runs.length) return [];
  const runIds = runs.map((run) => run.id);
  const placeholders = runIds.map(() => '?').join(',');
  const [films, inputs] = await Promise.all([
    query(
      `SELECT f.*, p.name AS product_name, p.sku, p.unit AS product_unit,
              p.stock_qty, p.weight_kg, p.track_stock, p.units_per_pack,
              p.cost_gross_price, p.cost_levy_rate, p.cost_price
         FROM production_line_films f
         JOIN products p ON p.id = f.product_id
        WHERE f.run_id IN (${placeholders}) AND f.removed_at IS NULL
        ORDER BY f.id DESC`,
      runIds,
    ),
    query(
      `SELECT i.*, p.name AS product_name, p.sku, u.name AS user_name
         FROM production_line_inputs i
         JOIN products p ON p.id = i.product_id
         LEFT JOIN users u ON u.id = i.created_by
        WHERE i.run_id IN (${placeholders})
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT 80`,
      runIds,
    ),
  ]);
  const filmsByRun = new Map();
  for (const film of films) {
    const list = filmsByRun.get(Number(film.run_id)) || [];
    list.push(film);
    filmsByRun.set(Number(film.run_id), list);
  }
  const inputsByRun = new Map();
  for (const input of inputs) {
    const list = inputsByRun.get(Number(input.run_id)) || [];
    list.push(input);
    inputsByRun.set(Number(input.run_id), list);
  }
  return runs.map((run) => ({
    ...run,
    films: filmsByRun.get(Number(run.id)) || [],
    inputs: inputsByRun.get(Number(run.id)) || [],
  }));
}

async function loadProductionLines() {
  return query(
    `SELECT pl.*, m.name AS thermoformer_name, m.full_name AS thermoformer_full_name
       FROM production_lines pl
       LEFT JOIN machines m ON m.id = pl.thermoformer_machine_id
      WHERE pl.status = 'active'
      ORDER BY pl.sort_order, pl.id`,
  );
}

async function loadFloorData(orderId) {
  const [order, orderLines, rawMaterials, filmOptions, machines, productionLines, runs, activeRuns] = await Promise.all([
    loadOrder(orderId),
    loadOrderLines(orderId),
    loadRawMaterialOptions(orderId),
    loadFilmOptions(orderId),
    loadMachines(),
    loadProductionLines(),
    loadRunsForOrder(orderId),
    loadActiveRuns(),
  ]);
  if (!order) return null;
  const runsByLine = new Map(runs.map((run) => [Number(run.production_line_id), run]));
  const activeByLine = new Map();
  for (const run of activeRuns) {
    if (!activeByLine.has(Number(run.production_line_id))) activeByLine.set(Number(run.production_line_id), run);
  }
  return {
    order,
    orderLines,
    rawMaterials,
    filmOptions,
    machines,
    productionLines,
    runsByLine,
    activeByLine,
  };
}

module.exports = {
  pair,
  round3,
  loadOrderOptions,
  loadFloorData,
  loadActiveRuns,
};
