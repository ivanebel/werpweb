'use strict';

const { makeResourceRouter } = require('./resource');
const { query } = require('../db');

const fields = [
  { name: 'name', label: 'Category name', type: 'text', required: true, full: true, section: 'Category' },
  { name: 'description', label: 'Description', type: 'textarea', full: true, section: 'Category' },
];

module.exports = makeResourceRouter({
  key: 'product-categories',
  basePath: '/product-categories',
  title: 'Product categories',
  singular: 'Category',
  table: 'product_categories',
  titleField: 'name',
  searchFields: ['t.name', 't.description'],
  orderBy: 't.name ASC',
  fields,
  columns: [
    { key: 'name', label: 'Category', type: 'primary' },
    { key: 'description', label: 'Description' },
    { key: 'product_count', label: 'Products', type: 'number', align: 'right' },
  ],
  select: 't.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = t.id) AS product_count',
  relatedLoader: async (row) => {
    const products = await query(
      'SELECT id, sku, name, type, stock_qty, sale_price, status FROM products WHERE category_id = ? ORDER BY name LIMIT 20',
      [row.id],
    );
    return [
      {
        title: 'Products in this category',
        href: `/products?q=${encodeURIComponent(row.name)}`,
        columns: [
          { key: 'name', label: 'Product' },
          { key: 'sku', label: 'SKU' },
          { key: 'type', label: 'Type', type: 'status' },
          { key: 'stock_qty', label: 'Stock', type: 'number', align: 'right' },
          { key: 'sale_price', label: 'Sale price', type: 'money', align: 'right' },
        ],
        rows: products,
        linkBase: '/products',
        emptyText: 'No products in this category yet.',
      },
    ];
  },
});
