/**
 * Integration checks for the production floor setup, stock posting and
 * completion reconciliation.
 *
 * Requires the app to be running:
 *   npm run test:production-floor
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const mysql = require('mysql2/promise');

const base = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'werp_erp',
  dateStrings: true,
});

const q = async (sql, params = []) => (await db.query(sql, params))[0];
const one = async (sql, params = []) => (await q(sql, params))[0] || null;

const jar = new Map();
let csrf = '';
let failures = 0;
const created = { products: [], machines: [] };
let orderId = 0;
let orderLineId = 0;
let bomId = 0;
let classIds = [];
let line1Id = 0;
let line2Id = 0;
const testLineIds = [];
const requirementIds = {};

function absorb(res) {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

const cookie = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    redirect: 'manual',
    headers: { cookie: cookie(), ...(opts.headers || {}) },
  });
  absorb(res);
  return res;
}

function body(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.append(k, String(v));
  }
  sp.append('_csrf', csrf);
  return sp;
}

const post = (path, params) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body(params),
  });

const get = (path) => req(path, { method: 'GET' });

function ok(name, condition, extra = '') {
  if (condition) console.log('PASS', name);
  else {
    failures += 1;
    console.log('FAIL', name, extra);
  }
}

async function insertProduct({ sku, name, type, unit = 'kg', stock = 0, unitsPerPack = 0, manufactured = 0, weight = 0, cost = 1 }) {
  const [result] = await db.query(
    `INSERT INTO products (sku, name, type, unit, stock_qty, cost_price, cost_gross_price, sale_price,
                           units_per_pack, weight_kg, is_manufactured, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, 'active')`,
    [sku, name, type, unit, stock, cost, cost, unitsPerPack, weight, manufactured],
  );
  created.products.push(result.insertId);
  return result.insertId;
}

async function insertClass({ code, name, unit = 'kg', bottom = 0, top = 0, coil = 0 }) {
  const [result] = await db.query(
    `INSERT INTO material_classes (code, name, unit, status, is_bottom_film, is_top_film, coil_quantity)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    [code, name, unit, bottom, top, coil],
  );
  classIds.push(result.insertId);
  return result.insertId;
}

async function insertMachine(name, type) {
  const [result] = await db.query(
    `INSERT INTO machines (name, full_name, machine_type, status)
     VALUES (?, ?, ?, 'active')`,
    [name, `${name} full name`, type],
  );
  created.machines.push(result.insertId);
  return result.insertId;
}

async function insertRequirement({ classId, unit, required }) {
  const [result] = await db.query(
    `INSERT INTO production_order_requirements
       (production_order_id, material_class_id, unit, quantity_required, quantity_allocated,
        quantity_consumed, shortage_qty, source_count, sort_order)
     VALUES (?, ?, ?, ?, ?, 0, 0, 1, ?)`,
    [orderId, classId, unit, required, required, Object.keys(requirementIds).length],
  );
  requirementIds[classId] = result.insertId;
  return result.insertId;
}

async function insertAllocation({ classId, productId, required }) {
  await db.query(
    `INSERT INTO production_order_materials
       (production_order_id, requirement_id, material_class_id, component_id,
        quantity_required, quantity_consumed, source_count, priority,
        conversion_factor, unit_cost, is_substitute)
     VALUES (?, ?, ?, ?, ?, 0, 1, 0, 1, 1, 0)`,
    [orderId, requirementIds[classId], classId, productId, required],
  );
}

const stockOf = async (productId) => Number((await one('SELECT stock_qty FROM products WHERE id = ?', [productId])).stock_qty);
const runFor = (lineId) => one('SELECT * FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, lineId]);
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup() {
  try {
    if (orderId) await q('DELETE FROM production_orders WHERE id = ?', [orderId]);
    if (created.products.length) {
      const placeholders = created.products.map(() => '?').join(',');
      await q(`DELETE FROM stock_movements WHERE product_id IN (${placeholders})`, created.products);
    }
    if (bomId) await q('DELETE FROM boms WHERE id = ?', [bomId]);
    if (classIds.length) await q(`DELETE FROM material_classes WHERE id IN (${classIds.map(() => '?').join(',')})`, classIds);
    if (testLineIds.length) await q(`DELETE FROM production_lines WHERE id IN (${testLineIds.map(() => '?').join(',')})`, testLineIds);
    if (created.products.length) await q(`DELETE FROM products WHERE id IN (${created.products.map(() => '?').join(',')})`, created.products);
    if (created.machines.length) await q(`DELETE FROM machines WHERE id IN (${created.machines.map(() => '?').join(',')})`, created.machines);
  } catch (error) {
    console.log('CLEANUP WARNING', error.message);
  }
}

try {
  await cleanup();

  const loginPage = await get('/login');
  const loginHtml = await loginPage.text();
  csrf = (loginHtml.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const login = await post('/login', { email: 'admin@werp.local', password: 'Admin123!' });
  ok('login', login.status === 302, `${login.status}`);
  const dashboard = await get('/dashboard');
  const dashboardHtml = await dashboard.text();
  csrf = (dashboardHtml.match(/name="csrf-token" content="([^"]+)"/) || [])[1] || csrf;
  ok('csrf token', Boolean(csrf));

  const lineAdmin = await get('/manufacturing/production-lines');
  ok('production lines admin renders', lineAdmin.status === 200, `${lineAdmin.status}`);

  const suffix = Date.now().toString(36).slice(-7);
  const finishedId = await insertProduct({ sku: `QA-FIN-${suffix}`, name: `QA Finished ${suffix}`, type: 'finished_good', unit: 'unit', manufactured: 1, cost: 10 });
  const mainId = await insertProduct({ sku: `QA-MAIN-${suffix}`, name: `QA Main ${suffix}`, type: 'raw_material', stock: 1000, unitsPerPack: 20, cost: 2 });
  const bottomId = await insertProduct({ sku: `QA-BOT-${suffix}`, name: `QA Bottom film ${suffix}`, type: 'raw_material', unit: 'pcs', stock: 10, weight: 20, cost: 3 });
  const topId = await insertProduct({ sku: `QA-TOP-${suffix}`, name: `QA Top film ${suffix}`, type: 'raw_material', unit: 'kg', stock: 100, weight: 20, cost: 4 });
  const extraId = await insertProduct({ sku: `QA-EXTRA-${suffix}`, name: `QA Extra film ${suffix}`, type: 'raw_material', unit: 'kg', stock: 50, weight: 20, cost: 5 });
  const mainClass = await insertClass({ code: `QA-M-${suffix}`, name: `QA Main class ${suffix}` });
  const bottomClass = await insertClass({ code: `QA-B-${suffix}`, name: `QA Bottom class ${suffix}`, unit: 'pcs', bottom: 1, coil: 1 });
  const topClass = await insertClass({ code: `QA-T-${suffix}`, name: `QA Top class ${suffix}`, unit: 'kg', top: 1, coil: 20 });
  const extraClass = await insertClass({ code: `QA-X-${suffix}`, name: `QA Extra class ${suffix}`, unit: 'kg', bottom: 1, coil: 20 });
  for (const [classId, productId] of [[mainClass, mainId], [bottomClass, bottomId], [topClass, topId], [extraClass, extraId]]) {
    await db.query(
      `INSERT INTO material_class_members (class_id, product_id, priority, conversion_factor, status)
       VALUES (?, ?, 10, 1, 'active')`,
      [classId, productId],
    );
  }
  const [bom] = await db.query(
    `INSERT INTO boms (product_id, name, version, output_qty, status)
     VALUES (?, ?, 'QA', 1, 'active')`,
    [finishedId, `QA BOM ${suffix}`],
  );
  bomId = bom.insertId;
  for (const [classId, quantity] of [[mainClass, 1], [bottomClass, 0.1], [topClass, 0.1]]) {
    await db.query(
      `INSERT INTO bom_items (bom_id, material_class_id, quantity, scrap_percent, sort_order)
       VALUES (?, ?, ?, 0, 0)`,
      [bomId, classId, quantity],
    );
  }
  const [order] = await db.query(
    `INSERT INTO production_orders (production_no, start_date, due_date, status, created_by)
     VALUES (?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 7 DAY), 'released', 1)`,
    [`PRD-QA-FLOOR-${suffix}`],
  );
  orderId = order.insertId;
  const [line] = await db.query(
    `INSERT INTO production_order_lines
       (production_order_id, bom_id, product_id, quantity, lot_number, expiry_date, sort_order)
     VALUES (?, ?, ?, 100, ?, DATE_ADD(CURDATE(), INTERVAL 30 DAY), 0)`,
    [orderId, bomId, finishedId, `LOT-${suffix}`],
  );
  orderLineId = line.insertId;
  const p1 = await insertMachine(`QA P1 ${suffix}`, 'portioning');
  const p2 = await insertMachine(`QA P2 ${suffix}`, 'portioning');
  const p3 = await insertMachine(`QA P3 ${suffix}`, 'portioning');
  const p4 = await insertMachine(`QA P4 ${suffix}`, 'portioning');
  const t1 = await insertMachine(`QA T1 ${suffix}`, 'thermoforming');
  const t2 = await insertMachine(`QA T2 ${suffix}`, 'thermoforming');
  const [testLine1] = await db.query(
    `INSERT INTO production_lines (code, name, thermoformer_machine_id, status, sort_order)
     VALUES (?, ?, ?, 'active', 980)`,
    [`QA-L1-${suffix}`.slice(0, 30), `QA Line 1 ${suffix}`.slice(0, 80), t1],
  );
  const [testLine2] = await db.query(
    `INSERT INTO production_lines (code, name, thermoformer_machine_id, status, sort_order)
     VALUES (?, ?, ?, 'active', 981)`,
    [`QA-L2-${suffix}`.slice(0, 30), `QA Line 2 ${suffix}`.slice(0, 80), t2],
  );
  line1Id = testLine1.insertId;
  line2Id = testLine2.insertId;
  testLineIds.push(line1Id, line2Id);
  await insertRequirement({ classId: mainClass, unit: 'kg', required: 100 });
  await insertRequirement({ classId: bottomClass, unit: 'pcs', required: 0.1 });
  await insertRequirement({ classId: topClass, unit: 'kg', required: 0.1 });
  await insertAllocation({ classId: mainClass, productId: mainId, required: 100 });
  await insertAllocation({ classId: bottomClass, productId: bottomId, required: 0.1 });
  await insertAllocation({ classId: topClass, productId: topId, required: 0.1 });
  ok('test production data created', Boolean(orderId && bomId && classIds.length));

  const setupBody = (lineId, machine1, machine2) => ({
    order_id: orderId,
    production_order_line_id: orderLineId,
    raw_material: `${mainClass}:${mainId}`,
    raw_lot_number: `RAW-${suffix}`,
    raw_expiry_date: '',
    portioning_machine_1_id: machine1,
    portioning_machine_2_id: machine2,
    bottom_film: `${bottomClass}:${bottomId}`,
    top_film: `${topClass}:${topId}`,
    bottom_lot_number: `BF-${suffix}`,
    top_lot_number: `TF-${suffix}`,
    bottom_expiry_date: '',
    top_expiry_date: '',
  });

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/setup`, setupBody(line1Id, p1, p2));
    const run = await runFor(line1Id);
    const films = run ? await q('SELECT * FROM production_line_films WHERE run_id = ? ORDER BY side', [run.id]) : [];
    ok('line 1 setup saved', res.status === 302 && Boolean(run), `${res.status}`);
    ok('setup stores product and material', run && Number(run.production_order_line_id) === orderLineId && Number(run.raw_material_product_id) === mainId);
    ok('setup stores both film coils', films.length === 2 && films.some((film) => film.side === 'bottom') && films.some((film) => film.side === 'top'));
    ok('setup defaults coil weight from the product page', films.every((film) => Number(film.coil_weight_kg) === 20));
  }

  {
    const page = await get(`/manufacturing/floor?order_id=${orderId}`);
    const html = await page.text();
    ok('production floor renders', page.status === 200, `${page.status}`);
    ok('film options are filtered by the selected BOM', html.includes(`QA Bottom film ${suffix}`) && !html.includes(`QA Extra film ${suffix}`));
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line2Id}/setup`, setupBody(line2Id, p1, p3));
    const run = await runFor(line2Id);
    ok('same portioning machine is rejected on the other line', res.status === 302 && !run);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line2Id}/setup`, setupBody(line2Id, p3, p4));
    const run = await runFor(line2Id);
    ok('same product can run on both lines', res.status === 302 && Boolean(run));
  }

  {
    const stockBefore = await stockOf(mainId);
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, {
      order_id: orderId, input_type: 'raw_material', quantity_mode: 'unit', lot_number: `RAW-${suffix}`,
    });
    const run = await runFor(line1Id);
    const input = await one(
      "SELECT * FROM production_line_inputs WHERE run_id = ? AND input_type = 'raw_material' ORDER BY id DESC LIMIT 1",
      [run.id],
    );
    const movement = input ? await one('SELECT * FROM stock_movements WHERE id = ?', [input.stock_movement_id]) : null;
    const requirement = await one('SELECT * FROM production_order_requirements WHERE id = ?', [requirementIds[mainClass]]);
    ok('raw material input records', res.status === 302 && input && Number(input.quantity) === 1 && Number(input.stock_posted) === 1);
    ok('raw material input deducts stock', (await stockOf(mainId)) === stockBefore - 1);
    ok('raw material input records a production_input movement', movement && movement.movement_type === 'production_input' && Number(movement.quantity) === -1);
    ok('raw material input updates requirement consumption', Number(requirement.quantity_consumed) === 1);
    ok('first input starts the line', run.status === 'running');
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/setup`, setupBody(line1Id, p1, p2));
    const run = await runFor(line1Id);
    ok('setup is locked after first input', res.status === 302 && run.status === 'running');
  }

  {
    const stockBefore = await stockOf(mainId);
    const res = await post(`/manufacturing/floor/lines/${line1Id}/undo`, { order_id: orderId });
    const adjustment = await one(
      "SELECT * FROM production_line_inputs WHERE input_type = 'adjustment' ORDER BY id DESC LIMIT 1",
    );
    const requirement = await one('SELECT * FROM production_order_requirements WHERE id = ?', [requirementIds[mainClass]]);
    ok('raw material undo records a reversal', res.status === 302 && adjustment && Number(adjustment.quantity) === -1 && Number(adjustment.stock_quantity) === 1);
    ok('raw material undo returns stock', (await stockOf(mainId)) === stockBefore + 1);
    ok('raw material undo reverses consumption', Number(requirement.quantity_consumed) === 0);
  }

  {
    await db.query('UPDATE production_order_requirements SET quantity_required = 0.5 WHERE id = ?', [requirementIds[mainClass]]);
    await pause();
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, {
      order_id: orderId, input_type: 'raw_material', quantity_mode: 'two', lot_number: `RAW-${suffix}`,
    });
    await pause(250);
    const page = await get(`/manufacturing/floor?order_id=${orderId}`);
    const html = await page.text();
    const latest = await one(
      "SELECT * FROM production_line_inputs WHERE input_type = 'raw_material' ORDER BY id DESC LIMIT 1",
    );
    const flashText = (html.match(/data-flash[\s\S]{0,700}/) || [''])[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    ok('over-consumption is allowed with a warning', res.status === 302 && html.includes('exceeds the BOM requirement'), `status=${res.status} stock=${await stockOf(mainId)} last=${latest && latest.quantity}/${latest && latest.stock_posted} flash=${flashText}`);
    await post(`/manufacturing/floor/lines/${line1Id}/undo`, { order_id: orderId });
    await db.query(
      'UPDATE production_order_requirements SET quantity_required = 100, quantity_consumed = 0 WHERE id = ?',
      [requirementIds[mainClass]],
    );
  }

  {
    await db.query('UPDATE products SET stock_qty = 0 WHERE id = ?', [mainId]);
    const before = await one("SELECT COUNT(*) AS total FROM production_line_inputs WHERE input_type = 'raw_material'");
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, {
      order_id: orderId, input_type: 'raw_material', quantity_mode: 'unit',
    });
    const after = await one("SELECT COUNT(*) AS total FROM production_line_inputs WHERE input_type = 'raw_material'");
    ok('insufficient stock blocks the input', res.status === 302 && Number(after.total) === Number(before.total) && (await stockOf(mainId)) === 0);
    await db.query('UPDATE products SET stock_qty = 1000 WHERE id = ?', [mainId]);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, {
      order_id: orderId, input_type: 'raw_material', quantity_mode: 'unit',
    });
    const requirement = await one('SELECT * FROM production_order_requirements WHERE id = ?', [requirementIds[mainClass]]);
    ok('raw material can be entered again after an undo', res.status === 302 && (await stockOf(mainId)) === 999 && Number(requirement.quantity_consumed) === 1);
  }

  {
    const stockBefore = await stockOf(bottomId);
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, { order_id: orderId, input_type: 'film_bottom' });
    const run = await runFor(line1Id);
    const film = await one("SELECT * FROM production_line_films WHERE run_id = ? AND side = 'bottom'", [run.id]);
    const input = await one(
      "SELECT * FROM production_line_inputs WHERE run_id = ? AND input_type = 'film_bottom' ORDER BY id DESC LIMIT 1",
      [run.id],
    );
    ok('bottom film coil loads', res.status === 302 && film && film.loaded_at);
    ok('film load defaults to the product weight', input && Number(input.quantity) === 20 && input.unit === 'kg');
    ok('film stock converts kg to the product stock unit', (await stockOf(bottomId)) === stockBefore - 1);
    ok('film load records a production_input movement', input && Number(input.stock_quantity) === -1 && Number(input.stock_posted) === 1);
  }

  {
    const stockBefore = await stockOf(bottomId);
    const res = await post(`/manufacturing/floor/lines/${line1Id}/film-return`, {
      order_id: orderId, side: 'bottom', returned_quantity: '5',
    });
    const run = await runFor(line1Id);
    const film = await one("SELECT * FROM production_line_films WHERE run_id = ? AND side = 'bottom'", [run.id]);
    const returned = await one(
      "SELECT * FROM production_line_inputs WHERE run_id = ? AND input_type = 'film_return' ORDER BY id DESC LIMIT 1",
      [run.id],
    );
    const movement = returned ? await one('SELECT * FROM stock_movements WHERE id = ?', [returned.stock_movement_id]) : null;
    ok('partial film return is recorded', res.status === 302 && film && !film.loaded_at && Number(film.returned_quantity) === 5);
    ok('partial film return adds stock', Math.abs((await stockOf(bottomId)) - (stockBefore + 0.25)) < 0.0005);
    ok('partial film return records a production_return movement', returned && movement && movement.movement_type === 'production_return' && Number(movement.quantity) === 0.25);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, { order_id: orderId, input_type: 'film_bottom' });
    const run = await runFor(line1Id);
    const film = await one("SELECT * FROM production_line_films WHERE run_id = ? AND side = 'bottom'", [run.id]);
    ok('a new coil can be loaded after a return', res.status === 302 && film && film.loaded_at);
  }

  {
    const stockBefore = await stockOf(topId);
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, { order_id: orderId, input_type: 'film_top' });
    const run = await runFor(line1Id);
    const input = await one(
      "SELECT * FROM production_line_inputs WHERE run_id = ? AND input_type = 'film_top' ORDER BY id DESC LIMIT 1",
      [run.id],
    );
    ok('top film is deducted in kilograms', res.status === 302 && input && Number(input.quantity) === 20 && (await stockOf(topId)) === stockBefore - 20);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/status`, { order_id: orderId, target: 'pause' });
    const paused = await runFor(line1Id);
    const resumed = await post(`/manufacturing/floor/lines/${line1Id}/status`, { order_id: orderId, target: 'resume' });
    const running = await runFor(line1Id);
    ok('line can pause and resume', res.status === 302 && paused.status === 'paused' && resumed.status === 302 && running.status === 'running');
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/status`, { order_id: orderId, target: 'end' });
    const run = await runFor(line1Id);
    ok('a line cannot end while a coil is loaded', res.status === 302 && run.status !== 'closed');
  }

  {
    await post(`/manufacturing/floor/lines/${line1Id}/film-return`, { order_id: orderId, side: 'bottom', returned_quantity: '0' });
    await post(`/manufacturing/floor/lines/${line1Id}/film-return`, { order_id: orderId, side: 'top', returned_quantity: '0' });
    const res = await post(`/manufacturing/floor/lines/${line1Id}/status`, { order_id: orderId, target: 'end' });
    const run = await runFor(line1Id);
    ok('line ends after returning its coils', res.status === 302 && run.status === 'closed');
  }

  {
    const mainBefore = await stockOf(mainId);
    const bottomBefore = await stockOf(bottomId);
    const topBefore = await stockOf(topId);
    const res = await post(`/manufacturing/production-orders/${orderId}/status`, { status: 'completed' });
    const order = await one('SELECT status FROM production_orders WHERE id = ?', [orderId]);
    const requirement = await one('SELECT * FROM production_order_requirements WHERE id = ?', [requirementIds[mainClass]]);
    const movements = await one(
      "SELECT COALESCE(SUM(quantity), 0) AS total FROM stock_movements WHERE product_id = ?",
      [mainId],
    );
    ok('production order completes', res.status === 302 && order.status === 'completed');
    const mainAfter = await stockOf(mainId);
    ok('completion consumes only the remaining requirement', mainAfter === mainBefore - 99, `before=${mainBefore} after=${mainAfter} expected=${mainBefore - 99}`);
    ok('completion does not deduct posted film again', (await stockOf(bottomId)) === bottomBefore && (await stockOf(topId)) === topBefore);
    ok('completion reconciles requirement consumption', Number(requirement.quantity_consumed) === 100, `consumed=${requirement.quantity_consumed}`);
    ok('total material movements match the full requirement', Math.abs(Number(movements.total) + 100) < 0.0005, `total=${movements.total}`);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL unexpected error', error.message);
  console.log(error.stack);
} finally {
  await cleanup();
  await db.end();
  console.log(failures ? `${failures} production floor check(s) failed.` : 'All production floor checks passed.');
  process.exitCode = failures ? 1 : 0;
}
