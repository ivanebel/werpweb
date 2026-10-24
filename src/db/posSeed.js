'use strict';

/**
 * Demo data for Unit #2 (retail points of sale).
 *
 * This module only inserts reporting records. It never touches product stock,
 * stock_movements or any Unit #1 document.
 */

const LOCATIONS = [
  {
    code: 'OAK-01',
    name: 'Uptown Oakland',
    address_line1: '1801 Broadway',
    city: 'Oakland',
    state: 'CA',
    postal_code: '94612',
    phone: '+1 (510) 555-0142',
  },
  {
    code: 'OAK-02',
    name: 'Jack London Square',
    address_line1: '55 Water Street',
    city: 'Oakland',
    state: 'CA',
    postal_code: '94607',
    phone: '+1 (510) 555-0187',
  },
  {
    code: 'OAK-03',
    name: 'Rockridge',
    address_line1: '5433 College Avenue',
    city: 'Oakland',
    state: 'CA',
    postal_code: '94618',
    phone: '+1 (510) 555-0164',
  },
];

const CUSTOMERS = [
  'Walk-in customer',
  'Maya Chen',
  'Daniel Ortiz',
  'Sofia Ramirez',
  'Noah Williams',
  'Ava Thompson',
  'Liam Brooks',
  'Isabella Rossi',
  'Ethan Park',
  'Mia Johnson',
  'Lucas Bennett',
];

const PAYMENT_METHODS = ['cash', 'card', 'card', 'card', 'transfer'];
const TICKET_TYPES = ['Ticket', 'Ticket', 'Ticket', 'Ticket', 'Invoice'];

const PRODUCT_WEIGHTS = [
  'AUR-P100',
  'AUR-P100',
  'AUR-P100',
  'AUR-L200',
  'AUR-L200',
  'AUR-D50',
  'AUR-D50',
  'AUR-S300',
  'AUR-S300',
  'SRV-INST',
  'SRV-DESIGN',
];

function mulberry32(seed) {
  return function random() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261022);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (min, max) => min + rand() * (max - min);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

async function insert(conn, table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO \`${table}\` (${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (${keys
    .map(() => '?')
    .join(', ')})`;
  const [res] = await conn.query(sql, keys.map((k) => data[k]));
  return res.insertId;
}

function computeTotals(items, discount = 0) {
  const subtotal = round2(items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0));
  const taxTotal = round2(
    items.reduce((sum, item) => {
      const line = item.quantity * item.unit_price;
      return sum + (item.tax_rate > 0 ? line * (item.tax_rate / (100 + item.tax_rate)) : 0);
    }, 0),
  );
  const discountTotal = round2(Math.min(Math.max(Number(discount) || 0, 0), subtotal));
  return {
    subtotal,
    tax_total: taxTotal,
    discount_total: discountTotal,
    total: round2(subtotal - discountTotal),
  };
}

async function seedPosDemo(conn, { adminId = null, force = false } = {}) {
  // FORCE_SEED explicitly replaces the POS demo dataset so repeated demo runs stay deterministic.
  if (force) {
    await conn.query('DELETE FROM pos_sale_items');
    await conn.query('DELETE FROM pos_sales');
    await conn.query('DELETE FROM pos_locations');
  }

  const [[locationCount]] = await conn.query('SELECT COUNT(*) AS count FROM pos_locations');
  if (locationCount.count > 0 && !force) {
    return { skipped: true, reason: 'pos locations already exist', locations: 0, sales: 0 };
  }

  const [[salesCount]] = await conn.query('SELECT COUNT(*) AS count FROM pos_sales');
  if (salesCount.count > 0 && !force) {
    return { skipped: true, reason: 'pos sales already exist', locations: 0, sales: 0 };
  }

  const locationIds = [];
  for (const location of LOCATIONS) {
    const [existing] = await conn.query('SELECT id FROM pos_locations WHERE code = ? LIMIT 1', [
      location.code,
    ]);
    if (existing.length) {
      locationIds.push(existing[0].id);
      continue;
    }
    const id = await insert(conn, 'pos_locations', {
      ...location,
      status: 'active',
      notes: null,
    });
    locationIds.push(id);
  }

  const [products] = await conn.query(
    `SELECT id, sku, name, sale_price, sale_vat_rate, sold_by_weight
       FROM products
      WHERE is_sellable = 1 AND sale_price > 0
      ORDER BY id ASC`,
  );
  if (!products.length) {
    return { skipped: true, reason: 'no sellable products', locations: locationIds.length, sales: 0 };
  }

  const bySku = Object.fromEntries(products.map((product) => [product.sku, product]));
  const weightedProducts = PRODUCT_WEIGHTS.map((sku) => bySku[sku]).filter(Boolean);
  const fallbackProducts = products.slice();
  const productPool = weightedProducts.length ? weightedProducts : fallbackProducts;

  let sequence = salesCount.count;
  const totalSales = 240;

  for (let i = 0; i < totalSales; i++) {
    // Uptown is the busiest shop, Rockridge second, Jack London third.
    const shopRoll = rand();
    const locationIndex = shopRoll < 0.44 ? 0 : shopRoll < 0.76 ? 2 : 1;
    const location = LOCATIONS[locationIndex];
    const posId = locationIds[locationIndex];
    const saleDate = daysAgo(Math.floor(between(0, 210)));

    const ticketRoll = rand();
    const ticketType = ticketRoll < 0.86 ? TICKET_TYPES[0] : TICKET_TYPES[4];
    const paymentMethod = pick(PAYMENT_METHODS);
    const customerName =
      ticketType === 'Invoice'
        ? pick(CUSTOMERS.filter((name) => name !== 'Walk-in customer'))
        : null;

    const lineCount = Math.floor(between(1, 4.99));
    const used = new Set();
    const items = [];
    for (let line = 0; line < lineCount; line++) {
      let product = pick(productPool);
      let guard = 0;
      while (used.has(product.id) && guard++ < 12) product = pick(productPool);
      used.add(product.id);

      const weighted = Number(product.sold_by_weight) === 1;
      const quantity = weighted ? round2(between(0.5, 3.5)) : Math.floor(between(1, 5));
      const price = round2(Number(product.sale_price) * (rand() < 0.12 ? 0.95 : 1));
      items.push({
        product_id: product.id,
        description: null,
        quantity,
        unit_price: price,
        tax_rate: Number(product.sale_vat_rate || 0),
        line_total: round2(quantity * price),
      });
    }

    const discount = rand() < 0.1 ? round2(between(5, 20)) : 0;
    const totals = computeTotals(items, discount);
    const typeCode = ticketType === 'Invoice' ? 'INV' : 'TKT';
    sequence += 1;
    const ticketNumber = `${location.code}-${typeCode}-${String(sequence).padStart(5, '0')}`;

    const saleId = await insert(conn, 'pos_sales', {
      pos_id: posId,
      ticket_type: ticketType,
      ticket_number: ticketNumber,
      sale_date: saleDate,
      payment_method: paymentMethod,
      customer_name: customerName,
      subtotal: totals.subtotal,
      discount_total: totals.discount_total,
      tax_total: totals.tax_total,
      total: totals.total,
      notes: null,
      created_by: adminId || null,
    });

    for (const item of items) {
      await insert(conn, 'pos_sale_items', {
        sale_id: saleId,
        ...item,
      });
    }
  }

  return { skipped: false, locations: locationIds.length, sales: totalSales };
}

module.exports = { seedPosDemo, LOCATIONS };
