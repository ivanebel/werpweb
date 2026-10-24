'use strict';

const express = require('express');
const { query } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.render('search', {
        title: req.t('Search'),
        active: '',
        breadcrumbs: [{ label: req.t('Search') }],
        q: '',
        results: null,
      });
    }
    const like = `%${q}%`;
    const [customers, suppliers, products, salesOrders, purchaseOrders, invoices, posSales] = await Promise.all([
      query(
        `SELECT id, company_name AS title, customer_no AS ref, email AS meta FROM customers
          WHERE company_name LIKE ? OR contact_name LIKE ? OR email LIKE ? OR customer_no LIKE ?
          ORDER BY company_name LIMIT 5`,
        [like, like, like, like],
      ),
      query(
        `SELECT id, company_name AS title, supplier_no AS ref, email AS meta FROM suppliers
          WHERE company_name LIKE ? OR contact_name LIKE ? OR email LIKE ? OR supplier_no LIKE ?
          ORDER BY company_name LIMIT 5`,
        [like, like, like, like],
      ),
      query(
        `SELECT id, name AS title, sku AS ref, type AS meta FROM products
          WHERE name LIKE ? OR sku LIKE ? ORDER BY name LIMIT 5`,
        [like, like],
      ),
      query(
        `SELECT so.id, so.order_no AS title, c.company_name AS meta, so.total FROM sales_orders so
           JOIN customers c ON c.id = so.customer_id
          WHERE so.order_no LIKE ? OR c.company_name LIKE ? ORDER BY so.id DESC LIMIT 5`,
        [like, like],
      ),
      query(
        `SELECT po.id, po.order_no AS title, s.company_name AS meta, po.total FROM purchase_orders po
           JOIN suppliers s ON s.id = po.supplier_id
          WHERE po.order_no LIKE ? OR s.company_name LIKE ? ORDER BY po.id DESC LIMIT 5`,
        [like, like],
      ),
      query(
        `SELECT si.id, si.invoice_no AS title, c.company_name AS meta, si.total, 'sales' AS kind FROM sales_invoices si
           JOIN customers c ON c.id = si.customer_id
          WHERE si.invoice_no LIKE ? OR c.company_name LIKE ? ORDER BY si.id DESC LIMIT 5`,
        [like, like],
      ),
      query(
        `SELECT s.id, s.ticket_number AS title, s.ticket_type, s.sale_date, s.total,
                l.code AS pos_code, l.name AS pos_name
           FROM pos_sales s
           JOIN pos_locations l ON l.id = s.pos_id
          WHERE s.ticket_number LIKE ? OR s.ticket_type LIKE ? OR s.customer_name LIKE ?
             OR l.name LIKE ? OR l.code LIKE ?
          ORDER BY s.sale_date DESC, s.id DESC LIMIT 5`,
        [like, like, like, like, like],
      ),
    ]);

    res.render('search', {
      title: req.t('Search: {query}', { query: q }),
      active: '',
      breadcrumbs: [{ label: req.t('Search') }],
      q,
      results: { customers, suppliers, products, salesOrders, purchaseOrders, invoices, posSales },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
