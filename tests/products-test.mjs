/**
 * Integration test for duplicating a product.
 *
 * Start the app first, then run:
 *   npm run test:products
 *
 * The test creates its own source product, follows the duplicate link, checks
 * the prefilled form and creates the copy through the normal product form. All
 * created rows are removed at the end, even when an assertion fails.
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
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
    else sp.append(k, String(v));
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
  if (condition) {
    console.log('PASS', name);
  } else {
    failures += 1;
    console.log('FAIL', name, extra);
  }
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
const stamp = Date.now().toString(36).slice(-7).toUpperCase();
const digits = String(Date.now()).slice(-9);

let sourceId = 0;
let copyId = 0;

async function cleanup() {
  try {
    if (copyId) await q('DELETE FROM products WHERE id = ?', [copyId]);
    if (sourceId) await q('DELETE FROM products WHERE id = ?', [sourceId]);
  } catch (error) {
    console.log('CLEANUP WARNING', error.message);
  }
}

try {
  await cleanup();

  // ------------------------------------------------------------------ login
  {
    const loginPage = await get('/login');
    const html = await loginPage.text();
    csrf = (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const login = await post('/login', { email: 'admin@werp.local', password: 'Admin123!' });
    ok('login', login.status === 302, `${login.status}`);
    const dashboard = await get('/dashboard');
    const dashboardHtml = await dashboard.text();
    csrf = (dashboardHtml.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
    ok('csrf token', Boolean(csrf));
  }

  // -------------------------------------------------------- source product
  const sourceName = `QA Duplicate Source ${stamp}`;
  const sourceSku = `QA-PROD-${stamp}`;
  const sourceDescription = `Source product for duplicate test ${stamp}`;
  const ean13 = `9${digits}123`;
  const dun14 = `9${digits}1234`;
  const plu = Number(digits.slice(-7));

  const category = await one('SELECT id FROM product_categories ORDER BY id LIMIT 1');
  const brand = await one('SELECT id FROM brands ORDER BY id LIMIT 1');
  const supplier = await one('SELECT id FROM suppliers ORDER BY id LIMIT 1');

  {
    const [res] = await db.query(
      `INSERT INTO products
         (sku, old_id, name, category_id, brand_id, supplier_id, ean13, dun14, plu,
          units_per_pack, packs_per_pallet, sold_by_weight, weight_kg, type, unit,
          cost_gross_price, cost_vat_rate, cost_levy_rate, cost_price,
          sale_gross_price, sale_vat_rate, sale_price, stock_qty, reorder_level,
          track_stock, is_sellable, is_purchasable, is_manufactured, status, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1.5, 'finished_good', 'pcs',
               12.34, 21, 2.5, 15.24, 20, 0, 20, 7.5, 4, 1, 1, 1, 0, 'active', ?)`,
      [
        sourceSku,
        987654,
        sourceName,
        category ? category.id : null,
        brand ? brand.id : null,
        supplier ? supplier.id : null,
        ean13,
        dun14,
        plu,
        10,
        120,
        sourceDescription,
      ],
    );
    sourceId = res.insertId;
    ok('source product created', Boolean(sourceId), `${sourceId}`);
  }

  // ----------------------------------------------------------- duplicate link
  let duplicatePath = '';
  {
    const res = await get(`/products/${sourceId}/duplicate`);
    duplicatePath = res.headers.get('location') || '';
    ok('duplicate redirects to new product', res.status === 302, `${res.status}`);
    ok('duplicate points at product form', duplicatePath.startsWith('/products/new?'), duplicatePath);

    const params = new URL(duplicatePath, base).searchParams;
    ok('normal fields are copied', params.get('name') === sourceName && params.get('unit') === 'pcs' && params.get('type') === 'finished_good');
    ok('description is copied', params.get('description') === sourceDescription);
    ok('pricing is copied', near(params.get('cost_gross_price'), 12.34) && near(params.get('cost_vat_rate'), 21));
    ok('packaging and reorder values are copied', params.get('units_per_pack') === '10' && params.get('reorder_level') === '4');
    if (category) ok('category is copied', params.get('category_id') === String(category.id), params.get('category_id'));
    if (brand) ok('brand is copied', params.get('brand_id') === String(brand.id), params.get('brand_id'));
    if (supplier) ok('supplier is copied', params.get('supplier_id') === String(supplier.id), params.get('supplier_id'));

    ok('sku is not copied', !params.has('sku'));
    ok('old id is not copied', !params.has('old_id'));
    ok('unique identifiers are not copied', !params.has('ean13') && !params.has('dun14') && !params.has('plu'));
    ok('stock starts at zero', params.get('stock_qty') === '0', params.get('stock_qty'));
    ok('duplicate flag is set', params.get('duplicated') === '1');
  }

  // ---------------------------------------------------------- prefilled form
  {
    const res = await get(duplicatePath);
    const html = await res.text();
    ok('prefilled form renders', res.status === 200 && html.includes(sourceName), `${res.status}`);
    ok('sku input is blank', /<input[^>]*name="sku"[^>]*value=""/.test(html));
    ok('source vat rate is preserved', /<input[^>]*name="sale_vat_rate"[^>]*value="0"/.test(html));
  }

  // ------------------------------------------------------ create the duplicate
  {
    const duplicateParams = Object.fromEntries(new URL(duplicatePath, base).searchParams);
    delete duplicateParams.duplicated;
    delete duplicateParams.sku;
    duplicateParams.name = `${sourceName} Copy`;

    const res = await post('/products', duplicateParams);
    const location = res.headers.get('location') || '';
    copyId = Number((location.match(/\/products\/(\d+)/) || [])[1]);
    ok('duplicate creates a product', res.status === 302 && Boolean(copyId), `${res.status} ${location}`);

    const copy = await one('SELECT * FROM products WHERE id = ?', [copyId]);
    const source = await one('SELECT * FROM products WHERE id = ?', [sourceId]);
    ok('new record has its own id', copy && copy.id !== sourceId, JSON.stringify(copy));
    ok('new record has a generated sku', copy && copy.sku && copy.sku !== sourceSku, copy ? copy.sku : '');
    ok('identifiers stay empty', copy && copy.old_id === null && copy.ean13 === null && copy.dun14 === null && copy.plu === null, JSON.stringify(copy));
    ok('stock starts at zero', copy && near(copy.stock_qty, 0), copy ? copy.stock_qty : '');
    ok('normal fields match the source', copy && copy.description === sourceDescription && copy.unit === 'pcs' && copy.type === 'finished_good');
    ok('pricing matches the source', copy && near(copy.cost_gross_price, 12.34) && near(copy.cost_vat_rate, 21) && near(copy.sale_vat_rate, 0));
    ok('source product is unchanged', source && source.sku === sourceSku && near(source.stock_qty, 7.5) && source.ean13 === ean13 && source.dun14 === dun14 && source.plu === plu);
  }
} catch (error) {
  failures += 1;
  console.log('FAIL uncaught', error.stack || error.message);
} finally {
  await cleanup();
  await db.end();
}

console.log(failures === 0 ? '\nAll product tests passed.' : `\n${failures} product test(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
