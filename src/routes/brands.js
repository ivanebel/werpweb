'use strict';

const { makeResourceRouter } = require('./resource');
const { query } = require('../db');

const statusOptions = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const fields = [
  { name: 'name', label: 'Brand name', type: 'text', required: true, full: true, section: 'Brand', maxLength: 120 },
  { name: 'status', label: 'Status', type: 'select', options: statusOptions, default: 'active', section: 'Brand' },
  { name: 'website', label: 'Website', type: 'url', section: 'Brand', maxLength: 190 },
  { name: 'description', label: 'Description', type: 'textarea', full: true, section: 'Brand', maxLength: 255 },
];

module.exports = makeResourceRouter({
  key: 'brands',
  basePath: '/brands',
  title: 'Brands',
  singular: 'Brand',
  table: 'brands',
  titleField: 'name',
  searchFields: ['t.name', 't.description', 't.website'],
  filters: [{ name: 'status', label: 'Status', options: statusOptions }],
  orderBy: 't.name ASC',
  fields,
  columns: [
    { key: 'name', label: 'Brand', type: 'primary' },
    { key: 'description', label: 'Description' },
    { key: 'product_count', label: 'Products', type: 'number', align: 'right' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  select: 't.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = t.id) AS product_count',
  relatedLoader: async (row) => {
    const products = await query(
      `SELECT id, sku, name, type, stock_qty, sale_price, status
         FROM products WHERE brand_id = ? ORDER BY name LIMIT 20`,
      [row.id],
    );
    return [
      {
        title: 'Products with this brand',
        href: `/products?brand_id=${row.id}`,
        columns: [
          { key: 'name', label: 'Product' },
          { key: 'sku', label: 'SKU' },
          { key: 'type', label: 'Type', type: 'status' },
          { key: 'stock_qty', label: 'Stock', type: 'number', align: 'right' },
          { key: 'sale_price', label: 'Sale price', type: 'money', align: 'right' },
        ],
        rows: products,
        linkBase: '/products',
        emptyText: 'No products are assigned to this brand yet.',
      },
    ];
  },
});
