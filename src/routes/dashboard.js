'use strict';

const express = require('express');
const { query, one } = require('../db');
const { percentChange, statusInfo } = require('../lib/helpers');

const router = express.Router();

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function monthStart(offset = 0) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

router.get(['/', '/dashboard'], async (req, res, next) => {
  try {
    const thisMonth = iso(monthStart(0));
    const nextMonth = iso(monthStart(1));
    const prevMonth = iso(monthStart(-1));
    const chartStart = iso(monthStart(-5));
    const ninetyDaysAgo = iso(new Date(Date.now() - 90 * 86400000));

    const [
      revenueMonth,
      revenuePrev,
      purchasesMonth,
      purchasesPrev,
      openOrders,
      activeProduction,
      pendingDeliveries,
      lowStockCount,
      stockValue,
      customerCount,
      monthlySales,
      monthlyPurchases,
      categorySales,
      topProducts,
      productionByStatus,
      recentOrders,
      lowStock,
      activity,
    ] = await Promise.all([
      one(
        `SELECT COALESCE(SUM(total),0) v, COUNT(*) c FROM sales_invoices
          WHERE status IN ('sent','paid','overdue') AND invoice_date >= ? AND invoice_date < ?`,
        [thisMonth, nextMonth],
      ),
      one(
        `SELECT COALESCE(SUM(total),0) v FROM sales_invoices
          WHERE status IN ('sent','paid','overdue') AND invoice_date >= ? AND invoice_date < ?`,
        [prevMonth, thisMonth],
      ),
      one(
        `SELECT COALESCE(SUM(total),0) v FROM purchase_invoices
          WHERE status IN ('received','paid','overdue') AND invoice_date >= ? AND invoice_date < ?`,
        [thisMonth, nextMonth],
      ),
      one(
        `SELECT COALESCE(SUM(total),0) v FROM purchase_invoices
          WHERE status IN ('received','paid','overdue') AND invoice_date >= ? AND invoice_date < ?`,
        [prevMonth, thisMonth],
      ),
      one(
        `SELECT COUNT(*) c, COALESCE(SUM(total),0) v FROM sales_orders
          WHERE status IN ('draft','confirmed','partially_delivered')`,
      ),
      one(
        `SELECT COUNT(*) c FROM production_orders WHERE status IN ('released','in_progress')`,
      ),
      one(`SELECT COUNT(*) c FROM deliveries WHERE status = 'pending'`),
      one(
        `SELECT COUNT(*) c FROM products
          WHERE track_stock = 1 AND status = 'active' AND stock_qty <= reorder_level`,
      ),
      one(
        `SELECT COALESCE(SUM(stock_qty * cost_price),0) v FROM products WHERE track_stock = 1`,
      ),
      one(`SELECT COUNT(*) c FROM customers WHERE status = 'active'`),
      query(
        `SELECT DATE_FORMAT(invoice_date, '%Y-%m') ym, COALESCE(SUM(total),0) v
           FROM sales_invoices
          WHERE status IN ('sent','paid','overdue') AND invoice_date >= ?
          GROUP BY ym ORDER BY ym`,
        [chartStart],
      ),
      query(
        `SELECT DATE_FORMAT(invoice_date, '%Y-%m') ym, COALESCE(SUM(total),0) v
           FROM purchase_invoices
          WHERE status IN ('received','paid','overdue') AND invoice_date >= ?
          GROUP BY ym ORDER BY ym`,
        [chartStart],
      ),
      query(
        `SELECT COALESCE(pc.name, 'Uncategorised') AS label, COALESCE(SUM(ii.line_total),0) AS value
           FROM sales_invoice_items ii
           JOIN sales_invoices si ON si.id = ii.invoice_id
           JOIN products p ON p.id = ii.product_id
           LEFT JOIN product_categories pc ON pc.id = p.category_id
          WHERE si.status IN ('sent','paid','overdue') AND si.invoice_date >= ?
          GROUP BY label ORDER BY value DESC LIMIT 6`,
        [ninetyDaysAgo],
      ),
      query(
        `SELECT p.id, p.sku, p.name, SUM(ii.quantity) AS qty, SUM(ii.line_total) AS revenue
           FROM sales_invoice_items ii
           JOIN sales_invoices si ON si.id = ii.invoice_id
           JOIN products p ON p.id = ii.product_id
          WHERE si.status IN ('sent','paid','overdue') AND si.invoice_date >= ?
          GROUP BY p.id, p.sku, p.name ORDER BY revenue DESC LIMIT 5`,
        [ninetyDaysAgo],
      ),
      query(
        `SELECT status, COUNT(*) AS count FROM production_orders
          GROUP BY status ORDER BY FIELD(status, 'planned','released','in_progress','completed','cancelled')`,
      ),
      query(
        `SELECT so.id, so.order_no, so.order_date, so.status, so.total, c.company_name
           FROM sales_orders so JOIN customers c ON c.id = so.customer_id
          ORDER BY so.order_date DESC, so.id DESC LIMIT 6`,
      ),
      query(
        `SELECT id, sku, name, stock_qty, reorder_level, unit
           FROM products
          WHERE track_stock = 1 AND status = 'active' AND stock_qty <= reorder_level
          ORDER BY (stock_qty - reorder_level) ASC, name ASC LIMIT 6`,
      ),
      query(
        `SELECT sm.id, sm.movement_type, sm.quantity, sm.notes, sm.created_at, p.sku, p.name
           FROM stock_movements sm JOIN products p ON p.id = sm.product_id
          ORDER BY sm.created_at DESC, sm.id DESC LIMIT 8`,
      ),
    ]);

    const monthKeys = [];
    for (let i = -5; i <= 0; i++) {
      const d = monthStart(i);
      monthKeys.push(d.toISOString().slice(0, 7));
    }
    const salesMap = Object.fromEntries(monthlySales.map((r) => [r.ym, Number(r.v)]));
    const purchasesMap = Object.fromEntries(monthlyPurchases.map((r) => [r.ym, Number(r.v)]));
    const monthLabels = monthKeys.map((k) =>
      new Intl.DateTimeFormat(req.locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${k}-01T00:00:00Z`)),
    );

    const totalRevenue = monthlySales.reduce((s, r) => s + Number(r.v), 0);
    const totalPurchases = monthlyPurchases.reduce((s, r) => s + Number(r.v), 0);

    const stats = {
      revenue: Number(revenueMonth.v),
      revenueDelta: percentChange(Number(revenueMonth.v), Number(revenuePrev.v)),
      revenueCount: Number(revenueMonth.c),
      purchases: Number(purchasesMonth.v),
      purchasesDelta: percentChange(Number(purchasesMonth.v), Number(purchasesPrev.v)),
      openOrders: Number(openOrders.c),
      openOrderValue: Number(openOrders.v),
      activeProduction: Number(activeProduction.c),
      pendingDeliveries: Number(pendingDeliveries.c),
      lowStock: Number(lowStockCount.c),
      stockValue: Number(stockValue.v),
      customers: Number(customerCount.c),
      grossProfit: totalRevenue - totalPurchases,
    };

    const charts = {
      months: monthLabels,
      revenue: monthKeys.map((k) => salesMap[k] || 0),
      purchases: monthKeys.map((k) => purchasesMap[k] || 0),
      categories: {
        labels: categorySales.map((r) => (r.label === 'Uncategorised' ? req.t('Uncategorised') : r.label)),
        values: categorySales.map((r) => Number(r.value)),
      },
      production: {
        labels: productionByStatus.map((r) => statusInfo(r.status, req.locale).label),
        values: productionByStatus.map((r) => Number(r.count)),
      },
      topProducts: topProducts.map((r) => ({
        name: r.name,
        sku: r.sku,
        qty: Number(r.qty),
        revenue: Number(r.revenue),
      })),
    };

    res.render('dashboard', {
      title: req.t('Dashboard'),
      active: 'dashboard',
      breadcrumbs: [{ label: req.t('Dashboard') }],
      stats,
      charts,
      recentOrders,
      lowStock,
      activity,
      greetingName: (req.session.user.name || 'there').split(' ')[0],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
