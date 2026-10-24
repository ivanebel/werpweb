'use strict';

const express = require('express');
const { makeResourceRouter } = require('./resource');
const { query, one, getPool } = require('../db');
const { analyzeBarcode, barcodeFilename, renderBarcodeSvg } = require('../lib/barcodes');

const typeOptions = [
  { value: 'finished_good', label: 'Finished good' },
  { value: 'raw_material', label: 'Raw material' },
  { value: 'consumable', label: 'Consumable' },
  { value: 'service', label: 'Service' },
];

const statusOptions = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

async function brandOptions() {
  const rows = await query('SELECT id, name FROM brands ORDER BY name');
  return rows.map((r) => ({ value: String(r.id), label: r.name }));
}

async function supplierOptions() {
  const rows = await query(
    `SELECT id, company_name, default_vat_rate, default_levy_rate
       FROM suppliers ORDER BY company_name`,
  );
  return rows.map((r) => ({
    value: String(r.id),
    label: r.company_name,
    data: {
      vat: Number(r.default_vat_rate || 0),
      levy: Number(r.default_levy_rate || 0),
    },
  }));
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const rateAmount = (gross, rate) => round2(Number(gross || 0) * (Number(rate || 0) / 100));

function netCost(gross, vatRate, levyRate) {
  return round2(Number(gross || 0) + rateAmount(gross, vatRate) + rateAmount(gross, levyRate));
}

function netSale(gross, vatRate) {
  return round2(Number(gross || 0) + rateAmount(gross, vatRate));
}

function barcodeAsset(type, code) {
  const info = analyzeBarcode(type, code);
  const queryCode = encodeURIComponent(info.code);
  return {
    type,
    label: info.label || (type === 'ean13' ? 'EAN-13' : 'DUN-14'),
    code: info.code,
    barcodeCode: info.barcodeCode || info.code,
    valid: info.valid,
    canRender: info.canRender,
    corrected: Boolean(info.corrected),
    expectedCheckDigit: info.expectedCheckDigit,
    reason: info.reason,
    imageUrl: info.canRender
      ? `/products/barcode?type=${encodeURIComponent(type)}&code=${queryCode}`
      : null,
    downloadUrl: info.canRender
      ? `/products/barcode?type=${encodeURIComponent(type)}&code=${queryCode}&download=1`
      : null,
  };
}

function productBarcodes(row) {
  return [
    row.ean13 ? barcodeAsset('ean13', row.ean13) : null,
    row.dun14 ? barcodeAsset('dun14', row.dun14) : null,
  ].filter(Boolean);
}

async function applyPricingAndRules(data, existing = null) {
  const errors = {};

  // Normalise nullable identifiers / integer packaging values.
  for (const key of ['ean13', 'dun14']) {
    if (data[key] === null || data[key] === undefined) continue;
    const value = String(data[key]).replace(/\s+/g, '');
    data[key] = value || null;
  }
  for (const key of ['units_per_pack', 'packs_per_pallet']) {
    const n = Number(data[key]);
    data[key] = Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  }
  data.brand_id = data.brand_id ? Number.parseInt(data.brand_id, 10) : null;
  data.supplier_id = data.supplier_id ? Number.parseInt(data.supplier_id, 10) : null;
  data.sold_by_weight = Number(data.sold_by_weight) === 1 ? 1 : 0;

  if (data.ean13 && !/^\d{13}$/.test(data.ean13)) {
    errors.ean13 = 'EAN-13 must contain exactly 13 digits.';
  }
  if (data.dun14 && !/^\d{14}$/.test(data.dun14)) {
    errors.dun14 = 'DUN-14 must contain exactly 14 digits.';
  }

  const excludeId = existing ? existing.id : 0;
  if (data.ean13) {
    const dup = await one('SELECT id FROM products WHERE ean13 = ? AND id <> ? LIMIT 1', [data.ean13, excludeId]);
    if (dup) errors.ean13 = 'Another product already uses this EAN-13.';
  }
  if (data.dun14) {
    const dup = await one('SELECT id FROM products WHERE dun14 = ? AND id <> ? LIMIT 1', [data.dun14, excludeId]);
    if (dup) errors.dun14 = 'Another product already uses this DUN-14.';
  }

  data.cost_gross_price = round2(Math.max(0, Number(data.cost_gross_price || 0)));
  data.sale_gross_price = round2(Math.max(0, Number(data.sale_gross_price || 0)));
  data.cost_vat_rate = Math.min(100, Math.max(0, Number(data.cost_vat_rate || 0)));
  data.cost_levy_rate = Math.min(100, Math.max(0, Number(data.cost_levy_rate || 0)));
  data.sale_vat_rate = Math.min(100, Math.max(0, Number(data.sale_vat_rate || 0)));

  // Supplier defaults are applied when a supplier is selected and no explicit
  // cost VAT/levy rates have been supplied.
  if (data.supplier_id && Number(data.cost_vat_rate) === 0 && Number(data.cost_levy_rate) === 0) {
    const supplier = await one(
      'SELECT default_vat_rate, default_levy_rate FROM suppliers WHERE id = ? LIMIT 1',
      [data.supplier_id],
    );
    if (supplier) {
      data.cost_vat_rate = Number(supplier.default_vat_rate || 0);
      data.cost_levy_rate = Number(supplier.default_levy_rate || 0);
    }
  }

  data.cost_price = netCost(data.cost_gross_price, data.cost_vat_rate, data.cost_levy_rate);
  data.sale_price = netSale(data.sale_gross_price, data.sale_vat_rate);

  if (data.type === 'raw_material') {
    data.is_sellable = 0;
    data.is_purchasable = 1;
    data.is_manufactured = 0;
  }
  if (data.type === 'service') {
    data.track_stock = 0;
    data.is_manufactured = 0;
  }

  return Object.keys(errors).length ? errors : null;
}

const fields = [
  { name: 'sku', label: 'SKU', type: 'text', section: 'Product', help: 'Leave blank to generate automatically.', maxLength: 50 },
  { name: 'status', label: 'Status', type: 'select', options: statusOptions, default: 'active', section: 'Product' },
  { name: 'name', label: 'Product name', type: 'text', required: true, full: true, section: 'Product' },
  { name: 'category_id', label: 'Category', type: 'select', section: 'Product', optionsFrom: async () => {
    const rows = await query('SELECT id, name FROM product_categories ORDER BY name');
    return rows.map((r) => ({ value: String(r.id), label: r.name }));
  } },
  { name: 'brand_id', label: 'Brand', type: 'select', section: 'Product', optionsFrom: brandOptions },
  { name: 'type', label: 'Product type', type: 'select', options: typeOptions, default: 'finished_good', section: 'Product', help: 'Raw materials are purchased but not sold. Finished goods can be produced from a BOM.' },
  { name: 'unit', label: 'Unit of measure', type: 'text', default: 'pcs', section: 'Product', help: 'Used as the quantity label, e.g. pcs, pack, kg or m.' },
  { name: 'ean13', label: 'EAN-13', type: 'text', section: 'Identifiers', maxLength: 13, placeholder: '13 digits, optional', help: 'Retail barcode. Leave blank when the product has none.' },
  { name: 'dun14', label: 'DUN-14', type: 'text', section: 'Identifiers', maxLength: 14, placeholder: '14 digits, optional', help: 'Case / pallet barcode. Leave blank when the product has none.' },
  { name: 'units_per_pack', label: 'Units per pack', type: 'number', min: 0, integer: true, section: 'Packaging', help: 'Number of selling units in one supplier pack.' },
  { name: 'packs_per_pallet', label: 'Packs per pallet', type: 'number', min: 0, integer: true, section: 'Packaging', help: 'Number of packs on a full pallet.' },
  { name: 'sold_by_weight', label: 'Sold / bought by weight', type: 'checkbox', default: 0, section: 'Packaging', help: 'Allows decimal quantities and indicates a weight-based product (kg / g).' },

  { name: 'supplier_id', label: 'Default supplier', type: 'select', section: 'Pricing', optionsFrom: supplierOptions, help: 'Selecting a supplier fills the cost VAT and levy rates from its defaults.' },
  { name: 'cost_gross_price', label: 'Cost gross price', type: 'decimal', min: 0, default: 0, section: 'Pricing' },
  { name: 'cost_vat_rate', label: 'Cost VAT rate (%)', type: 'decimal', min: 0, max: 100, default: 0, section: 'Pricing' },
  { name: 'cost_levy_rate', label: 'Supplier levy rate (%)', type: 'decimal', min: 0, max: 100, default: 0, section: 'Pricing', help: 'Levies vary by supplier; the default comes from the selected supplier.' },
  { name: 'cost_price', label: 'Net cost price', type: 'decimal', min: 0, default: 0, readonly: true, section: 'Pricing', help: 'Calculated as gross + VAT + levies. Used for stock valuation and purchasing.' },
  { name: 'sale_gross_price', label: 'Sale gross price', type: 'decimal', min: 0, default: 0, section: 'Pricing' },
  { name: 'sale_vat_rate', label: 'Sale VAT rate (%)', type: 'decimal', min: 0, max: 100, default: 0, section: 'Pricing' },
  { name: 'sale_price', label: 'Net sale price (incl. VAT)', type: 'decimal', min: 0, default: 0, readonly: true, section: 'Pricing', help: 'Calculated as gross + VAT. This is the tax-inclusive price used on documents.' },

  { name: 'stock_qty', label: 'Stock on hand', type: 'decimal', default: 0, section: 'Inventory', help: 'Changing this value records a manual stock adjustment.' },
  { name: 'reorder_level', label: 'Reorder level', type: 'decimal', min: 0, default: 0, section: 'Inventory' },
  { name: 'track_stock', label: 'Track stock', type: 'checkbox', default: 1, section: 'Inventory' },
  { name: 'is_sellable', label: 'Can be sold', type: 'checkbox', default: 1, section: 'Sales & purchasing' },
  { name: 'is_purchasable', label: 'Can be purchased', type: 'checkbox', default: 1, section: 'Sales & purchasing' },
  { name: 'is_manufactured', label: 'Manufactured in-house', type: 'checkbox', default: 0, section: 'Sales & purchasing' },
  { name: 'description', label: 'Description', type: 'textarea', full: true, section: 'Notes' },
];

const resourceRouter = makeResourceRouter({
  key: 'products',
  basePath: '/products',
  title: 'Products',
  singular: 'Product',
  table: 'products',
  numberField: 'sku',
  number: { prefix: 'SKU', year: false, pad: 5 },
  titleField: 'name',
  searchFields: ['t.sku', 't.name', 't.description', 't.ean13', 't.dun14', 'pc.name', 'b.name'],
  filters: [
    { name: 'type', label: 'Type', options: typeOptions },
    { name: 'brand_id', label: 'Brand', optionsFrom: brandOptions },
    { name: 'status', label: 'Status', options: statusOptions },
  ],
  orderBy: 't.name ASC',
  select: 't.*, pc.name AS category_name, b.name AS brand_name',
  joins: 'LEFT JOIN product_categories pc ON pc.id = t.category_id LEFT JOIN brands b ON b.id = t.brand_id',
  fields,
  columns: [
    { key: 'name', label: 'Product', type: 'primary', sub: 'sku' },
    { key: 'brand_name', label: 'Brand' },
    { key: 'category_name', label: 'Category' },
    { key: 'type', label: 'Type', type: 'status' },
    { key: 'stock_qty', label: 'In stock', type: 'stock', align: 'right', unitKey: 'unit', reorderKey: 'reorder_level', trackKey: 'track_stock' },
    { key: 'sale_price', label: 'Sale price (incl. VAT)', type: 'money', align: 'right' },
    { key: 'cost_price', label: 'Net cost', type: 'money', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  showData: async (row) => ({ productBarcodes: productBarcodes(row) }),
  beforeCreate: async (data) => applyPricingAndRules(data, null),
  beforeUpdate: async (data, req, existing) => applyPricingAndRules(data, existing),
  afterUpdate: async (id, data, existing, req) => {
    const before = Number(existing.stock_qty || 0);
    const after = Number(data.stock_qty || 0);
    if (Math.abs(after - before) > 0.0001) {
      await getPool().query(
        `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
         VALUES (?, 'adjustment', ?, ?, 'manual', ?, ?, ?)`,
        [
          id,
          after - before,
          data.cost_price || 0,
          id,
          'Manual adjustment via product form',
          req.session.user.id,
        ],
      );
    }
  },
  relatedLoader: async (row) => {
    const movements = await query(
      `SELECT id, movement_type, quantity, unit_cost, notes, created_at
         FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT 10`,
      [row.id],
    );
    const boms = await query(
      `SELECT b.id, b.name, b.version, b.output_qty, b.status,
              (SELECT COUNT(*) FROM bom_items bi WHERE bi.bom_id = b.id) AS component_count
         FROM boms b WHERE b.product_id = ? ORDER BY b.id DESC`,
      [row.id],
    );
    const customerCodes = await query(
      `SELECT cpc.id, c.company_name AS customer_name, cpc.code, cpc.description
         FROM customer_product_codes cpc
         JOIN customers c ON c.id = cpc.customer_id
        WHERE cpc.product_id = ? ORDER BY c.company_name`,
      [row.id],
    );
    return [
      {
        title: 'Customer product codes',
        href: null,
        columns: [
          { key: 'customer_name', label: 'Customer' },
          { key: 'code', label: 'Customer code' },
          { key: 'description', label: 'Description' },
        ],
        rows: customerCodes,
        emptyText: 'No customer-specific codes are assigned to this product.',
      },
      {
        title: 'Stock movements',
        href: null,
        columns: [
          { key: 'created_at', label: 'Date', type: 'datetime' },
          { key: 'movement_type', label: 'Type', type: 'status' },
          { key: 'quantity', label: 'Qty', type: 'signed', align: 'right' },
          { key: 'notes', label: 'Notes', type: 'stock_note' },
        ],
        rows: movements,
        emptyText: 'No stock movements recorded yet.',
      },
      {
        title: 'Bills of materials',
        href: `/manufacturing/boms?q=${encodeURIComponent(row.sku)}`,
        columns: [
          { key: 'name', label: 'BOM' },
          { key: 'version', label: 'Version' },
          { key: 'component_count', label: 'Components', type: 'number', align: 'right' },
          { key: 'status', label: 'Status', type: 'status' },
        ],
        rows: boms,
        linkBase: '/manufacturing/boms',
        emptyText: 'No BOM uses this product.',
      },
    ];
  },
});

const router = express.Router();

router.get('/barcode', (req, res) => {
  const type = String(req.query.type || '').toLowerCase();
  const code = String(req.query.code || '');
  const download = String(req.query.download || '') === '1';

  let rendered;
  try {
    rendered = renderBarcodeSvg(type, code);
  } catch (err) {
    return res.status(400).type('text/plain').send('Invalid barcode value.');
  }

  res.set({
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  if (download) {
    res.set('Content-Disposition', `attachment; filename="${barcodeFilename(type, rendered.info)}"`);
  }
  return res.send(rendered.svg);
});

router.use(resourceRouter);

module.exports = router;
