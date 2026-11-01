/**
 * Integration checks for the production floor setup and input events.
 *
 * Phase 1 deliberately does not touch stock.
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

async function insertProduct({ sku, name, type, unit = 'kg', stock = 0, unitsPerPack = 0, manufactured = 0 }) {
  const [result] = await db.query(
    `INSERT INTO products (sku, name, type, unit, stock_qty, cost_price, sale_price, units_per_pack, is_manufactured, status)
     VALUES (?, ?, ?, ?, ?, 1, 2, ?, ?, 'active')`,
    [sku, name, type, unit, stock, unitsPerPack, manufactured],
  );
  created.products.push(result.insertId);
  return result.insertId;
}

async function insertClass({ code, name, bottom = 0, top = 0, coil = 0 }) {
  const [result] = await db.query(
    `INSERT INTO material_classes (code, name, unit, status, is_bottom_film, is_top_film, coil_quantity)
     VALUES (?, ?, 'kg', 'active', ?, ?, ?)`,
    [code, name, bottom, top, coil],
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

async function cleanup() {
  try {
    if (orderId) await q('DELETE FROM production_orders WHERE id = ?', [orderId]);
    if (bomId) await q('DELETE FROM boms WHERE id = ?', [bomId]);
    if (classIds.length) await q(`DELETE FROM material_classes WHERE id IN (${classIds.map(() => '?').join(',')})`, classIds);
    if (created.products.length) await q(`DELETE FROM products WHERE id IN (${created.products.map(() => '?').join(',')})`, created.products);
    if (testLineIds.length) await q(`DELETE FROM production_lines WHERE id IN (${testLineIds.map(() => '?').join(',')})`, testLineIds);
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
  const finishedId = await insertProduct({ sku: `QA-FIN-${suffix}`, name: `QA Finished ${suffix}`, type: 'finished_good', unit: 'unit', manufactured: 1 });
  const mainId = await insertProduct({ sku: `QA-MAIN-${suffix}`, name: `QA Main ${suffix}`, type: 'raw_material', stock: 1000, unitsPerPack: 20 });
  const bottomId = await insertProduct({ sku: `QA-BOT-${suffix}`, name: `QA Bottom film ${suffix}`, type: 'raw_material', stock: 100, unitsPerPack: 1 });
  const topId = await insertProduct({ sku: `QA-TOP-${suffix}`, name: `QA Top film ${suffix}`, type: 'raw_material', stock: 100, unitsPerPack: 1 });
  const mainClass = await insertClass({ code: `QA-M-${suffix}`, name: `QA Main class ${suffix}` });
  const bottomClass = await insertClass({ code: `QA-B-${suffix}`, name: `QA Bottom class ${suffix}`, bottom: 1, coil: 20 });
  const topClass = await insertClass({ code: `QA-T-${suffix}`, name: `QA Top class ${suffix}`, top: 1, coil: 20 });
  for (const [classId, productId] of [[mainClass, mainId], [bottomClass, bottomId], [topClass, topId]]) {
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
  await db.query('INSERT INTO production_order_requirements (production_order_id, material_class_id, unit, quantity_required, quantity_allocated, quantity_consumed, shortage_qty, source_count, sort_order) VALUES (?, ?, "kg", 100, 100, 0, 0, 1, 0)', [orderId, mainClass]);
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
    const run = await one('SELECT * FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, line1Id]);
    const films = run ? await q('SELECT * FROM production_line_films WHERE run_id = ? ORDER BY side', [run.id]) : [];
    ok('line 1 setup saved', res.status === 302 && Boolean(run), `${res.status}`);
    ok('setup stores product and material', run && Number(run.production_order_line_id) === orderLineId && Number(run.raw_material_product_id) === mainId);
    ok('setup stores both film coils', films.length === 2 && films.some((film) => film.side === 'bottom') && films.some((film) => film.side === 'top'));
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line2Id}/setup`, setupBody(line2Id, p1, p3));
    const run = await one('SELECT * FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, line2Id]);
    ok('same portioning machine is rejected on the other line', res.status === 302 && !run);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line2Id}/setup`, setupBody(line2Id, p3, p4));
    const run = await one('SELECT * FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, line2Id]);
    ok('same product can run on both lines', res.status === 302 && Boolean(run));
  }

  {
    const stockBefore = Number((await one('SELECT stock_qty FROM products WHERE id = ?', [mainId])).stock_qty);
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, {
      order_id: orderId, input_type: 'raw_material', quantity_mode: 'unit', lot_number: `RAW-${suffix}`,
    });
    const run = await one('SELECT status FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, line1Id]);
    const input = await one("SELECT * FROM production_line_inputs WHERE run_id = (SELECT id FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?) AND input_type = 'raw_material'", [orderId, line1Id]);
    const stockAfter = Number((await one('SELECT stock_qty FROM products WHERE id = ?', [mainId])).stock_qty);
    ok('raw material input records', res.status === 302 && input && Number(input.quantity) === 1 && Number(input.stock_posted) === 0);
    ok('first input starts the line', run.status === 'running');
    ok('phase 1 leaves stock unchanged', stockBefore === stockAfter);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/setup`, setupBody(line1Id, p1, p2));
    const run = await one('SELECT status FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, line1Id]);
    ok('setup is locked after first input', res.status === 302 && run.status === 'running');
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, { order_id: orderId, input_type: 'film_bottom' });
    const film = await one("SELECT * FROM production_line_films WHERE run_id = (SELECT id FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?) AND side = 'bottom'", [orderId, line1Id]);
    ok('bottom film coil loads', res.status === 302 && film && film.loaded_at);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/film-return`, { order_id: orderId, side: 'bottom', returned_quantity: '5' });
    const film = await one("SELECT * FROM production_line_films WHERE run_id = (SELECT id FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?) AND side = 'bottom'", [orderId, line1Id]);
    const returned = await one("SELECT * FROM production_line_inputs WHERE input_type = 'film_return' ORDER BY id DESC LIMIT 1");
    ok('partial film return is recorded', res.status === 302 && film && !film.loaded_at && Number(film.returned_quantity) === 5);
    ok('film return creates an event', returned && Number(returned.quantity) === 5 && Number(returned.stock_posted) === 0);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/input`, { order_id: orderId, input_type: 'film_bottom' });
    const film = await one("SELECT * FROM production_line_films WHERE run_id = (SELECT id FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?) AND side = 'bottom'", [orderId, line1Id]);
    ok('a new coil can be loaded after a return', res.status === 302 && film && film.loaded_at);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/undo`, { order_id: orderId });
    const adjustment = await one("SELECT * FROM production_line_inputs WHERE input_type = 'adjustment' ORDER BY id DESC LIMIT 1");
    ok('raw material undo records a reversal', res.status === 302 && adjustment && Number(adjustment.quantity) === -1);
  }

  {
    const res = await post(`/manufacturing/floor/lines/${line1Id}/status`, { order_id: orderId, target: 'pause' });
    const paused = await one('SELECT status FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, line1Id]);
    const resumed = await post(`/manufacturing/floor/lines/${line1Id}/status`, { order_id: orderId, target: 'resume' });
    const running = await one('SELECT status FROM production_line_runs WHERE production_order_id = ? AND production_line_id = ?', [orderId, line1Id]);
    ok('line can pause and resume', res.status === 302 && paused.status === 'paused' && resumed.status === 302 && running.status === 'running');
  }

  {
    const page = await get(`/manufacturing/floor?order_id=${orderId}`);
    ok('production floor renders', page.status === 200, `${page.status}`);
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
