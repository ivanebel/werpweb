'use strict';

const express = require('express');
const { query, one, scalar, getPool, withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { pagination, todayISO, toNumber, statusBadge, statusInfo, formatMoney, forLocale } = require('../lib/helpers');

const router = express.Router();
const basePath = '/deliveries';

async function loadOrderItems(orderId, excludeDeliveryId = 0) {
  return query(
    `SELECT i.id AS so_item_id, i.product_id, i.quantity, i.delivered_qty,
            p.sku, p.name, p.unit,
            COALESCE((
              SELECT SUM(di.quantity)
                FROM delivery_items di
                JOIN deliveries d ON d.id = di.delivery_id
               WHERE di.sales_order_item_id = i.id
                 AND d.status = 'pending'
                 AND d.id <> ?
            ), 0) AS reserved
       FROM sales_order_items i
       JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ?
      ORDER BY i.id`,
    [excludeDeliveryId, orderId],
  );
}

function remainingOf(item) {
  return Number(item.quantity) - Number(item.delivered_qty) - Number(item.reserved || 0);
}

async function loadDelivery(id) {
  return one(
    `SELECT d.*, c.company_name AS customer_name, c.contact_name AS customer_contact,
            c.email AS customer_email, c.phone AS customer_phone,
            c.address_line1 AS customer_address, c.city AS customer_city,
            c.state AS customer_state, c.postal_code AS customer_postal, c.country AS customer_country,
            so.order_no, so.customer_order_no, so.docking_station, so.reception_at,
            cw.id AS warehouse_id, cw.name AS warehouse_name, cw.code AS warehouse_code,
            cw.contact_name AS warehouse_contact, cw.phone AS warehouse_phone,
            cw.address_line1 AS warehouse_address, cw.address_line2 AS warehouse_address2,
            cw.city AS warehouse_city, cw.state AS warehouse_state,
            cw.postal_code AS warehouse_postal, cw.country AS warehouse_country
       FROM deliveries d
       JOIN customers c ON c.id = d.customer_id
       LEFT JOIN sales_orders so ON so.id = d.sales_order_id
       LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
      WHERE d.id = ? LIMIT 1`,
    [id],
  );
}

async function loadDeliveryItems(delivery, withOrderedQty = false) {
  const orderedSelect = withOrderedQty ? ', si.quantity AS ordered_qty' : '';
  const orderedJoin = withOrderedQty
    ? 'LEFT JOIN sales_order_items si ON si.id = di.sales_order_item_id'
    : '';
  return query(
    `SELECT di.*, p.sku, p.name, p.unit, cpc.code AS customer_code${orderedSelect}
       FROM delivery_items di
       JOIN products p ON p.id = di.product_id
       ${orderedJoin}
       LEFT JOIN customer_product_codes cpc ON cpc.customer_id = ? AND cpc.product_id = di.product_id
      WHERE di.delivery_id = ? ORDER BY di.id`,
    [delivery.customer_id, delivery.id],
  );
}

async function loadOrderWithWarehouse(orderId) {
  return one(
    `SELECT so.*, c.company_name AS customer_name,
            cw.name AS warehouse_name, cw.code AS warehouse_code,
            cw.contact_name AS warehouse_contact, cw.phone AS warehouse_phone,
            cw.address_line1 AS warehouse_address, cw.address_line2 AS warehouse_address2,
            cw.city AS warehouse_city, cw.state AS warehouse_state,
            cw.postal_code AS warehouse_postal, cw.country AS warehouse_country
       FROM sales_orders so
       JOIN customers c ON c.id = so.customer_id
       LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
      WHERE so.id = ? LIMIT 1`,
    [orderId],
  );
}

async function refreshSalesOrderStatus(conn, salesOrderId) {
  if (!salesOrderId) return;
  const [rows] = await conn.query(
    'SELECT COALESCE(SUM(quantity),0) AS qty, COALESCE(SUM(delivered_qty),0) AS delivered FROM sales_order_items WHERE order_id = ?',
    [salesOrderId],
  );
  const { qty, delivered } = rows[0];
  const [orders] = await conn.query('SELECT status FROM sales_orders WHERE id = ?', [salesOrderId]);
  if (!orders.length || orders[0].status === 'cancelled') return;
  let status = 'confirmed';
  if (Number(delivered) <= 0) status = 'confirmed';
  else if (Number(delivered) >= Number(qty) - 0.0001) status = 'delivered';
  else status = 'partially_delivered';
  await conn.query('UPDATE sales_orders SET status = ? WHERE id = ?', [status, salesOrderId]);
}

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    const where = [];
    const params = [];
    if (search) {
      where.push('(d.delivery_no LIKE ? OR c.company_name LIKE ? OR so.order_no LIKE ? OR so.customer_order_no LIKE ? OR cw.name LIKE ? OR d.tracking_number LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      where.push('d.status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const perPage = 12;
    const total = Number(
      (await scalar(
        `SELECT COUNT(*) FROM deliveries d
           JOIN customers c ON c.id = d.customer_id
           LEFT JOIN sales_orders so ON so.id = d.sales_order_id
           LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
          ${whereSql}`,
        params,
      )) || 0,
    );
    const pag = pagination(total, page, perPage);
    const rows = await query(
      `SELECT d.*, c.company_name AS customer_name, so.order_no, so.customer_order_no,
              cw.name AS warehouse_name, cw.code AS warehouse_code,
              (SELECT COUNT(*) FROM delivery_items di WHERE di.delivery_id = d.id) AS item_count
         FROM deliveries d
         JOIN customers c ON c.id = d.customer_id
         LEFT JOIN sales_orders so ON so.id = d.sales_order_id
         LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
         ${whereSql}
        ORDER BY d.delivery_date DESC, d.id DESC
        LIMIT ? OFFSET ?`,
      [...params, perPage, (pag.page - 1) * perPage],
    );

    const counts = await one(
      `SELECT SUM(status = 'pending') AS pending, SUM(status = 'shipped') AS shipped,
              SUM(status = 'delivered') AS delivered
         FROM deliveries`,
    );

    res.render('deliveries/index', {
      title: req.t('Deliveries'),
      active: 'deliveries',
      breadcrumbs: [{ label: req.t('Deliveries') }],
      rows,
      pagination: pag,
      search,
      activeStatus: status,
      counts: {
        pending: Number(counts.pending || 0),
        shipped: Number(counts.shipped || 0),
        delivered: Number(counts.delivered || 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const orderId = Number.parseInt(req.query.sales_order_id, 10);
    if (!orderId) {
      const orders = await query(
        `SELECT so.id, so.order_no, so.customer_order_no, so.order_date, so.status,
                c.company_name AS customer_name, cw.name AS warehouse_name, cw.code AS warehouse_code,
                (SELECT COUNT(*) FROM sales_order_items i WHERE i.order_id = so.id AND i.quantity > i.delivered_qty) AS open_lines
           FROM sales_orders so
           JOIN customers c ON c.id = so.customer_id
           LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
          WHERE so.status IN ('confirmed','partially_delivered')
          ORDER BY so.order_date DESC
          LIMIT 50`,
      );
      return res.render('deliveries/select-order', {
        title: req.t('New delivery'),
        active: 'deliveries',
        breadcrumbs: [{ label: req.t('Deliveries'), href: basePath }, { label: req.t('New delivery') }],
        orders,
      });
    }

    const order = await loadOrderWithWarehouse(orderId);
    if (!order) {
      req.flash('error', 'Sales order not found.');
      return res.redirect(basePath);
    }
    const items = (await loadOrderItems(orderId)).filter((i) => remainingOf(i) > 0);
    if (!items.length) {
      req.flash('error', 'This sales order has no items left to deliver.');
      return res.redirect(basePath);
    }

    return res.render('deliveries/form', {
      title: req.t('New delivery'),
      active: 'deliveries',
      breadcrumbs: [
        { label: req.t('Deliveries'), href: basePath },
        { label: req.t('New delivery') },
      ],
      delivery: null,
      order,
      items,
      mode: 'create',
      action: basePath,
      errors: {},
      row: { delivery_date: todayISO(), carrier: '', tracking_number: '', notes: '' },
    });
  } catch (err) {
    next(err);
  }
});

async function collectItems(body, orderId, excludeDeliveryId = 0, t = (value) => value) {
  const ids = Array.isArray(body.so_item_id) ? body.so_item_id : [body.so_item_id];
  const qtys = Array.isArray(body.item_quantity) ? body.item_quantity : [body.item_quantity];
  const available = await loadOrderItems(orderId, excludeDeliveryId);
  const byId = new Map(available.map((i) => [String(i.so_item_id), i]));
  const items = [];
  const errors = [];
  for (let i = 0; i < ids.length; i++) {
    const soItemId = Number.parseInt(ids[i], 10);
    if (!soItemId) continue;
    const qty = toNumber(qtys[i], 0);
    if (qty <= 0) continue;
    const line = byId.get(String(soItemId));
    if (!line) {
      errors.push(t('Invalid order line submitted.'));
      continue;
    }
    if (qty > remainingOf(line) + 0.0001) {
      errors.push(t('{sku}: quantity exceeds the {count} still open on the order.', {
        sku: line.sku,
        count: remainingOf(line),
      }));
      continue;
    }
    items.push({ so_item_id: soItemId, product_id: line.product_id, quantity: qty });
  }
  if (!items.length) errors.push(t('Add at least one item with a quantity greater than zero.'));
  return { items, errors };
}

router.post('/', async (req, res, next) => {
  try {
    const orderId = Number.parseInt(req.body.sales_order_id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      req.flash('error', 'Sales order not found.');
      return res.redirect(basePath);
    }
    const order = await loadOrderWithWarehouse(orderId);
    if (!order) {
      req.flash('error', 'Sales order not found.');
      return res.redirect(basePath);
    }

    const { items, errors } = await collectItems(req.body, orderId, 0, req.t);
    const deliveryDate = (req.body.delivery_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) errors.push(req.t('A valid delivery date is required.'));

    if (errors.length) {
      const available = (await loadOrderItems(orderId)).filter((i) => remainingOf(i) > 0);
      return res.status(422).render('deliveries/form', {
        title: req.t('New delivery'),
        active: 'deliveries',
        breadcrumbs: [{ label: req.t('Deliveries'), href: basePath }, { label: req.t('New delivery') }],
        delivery: null,
        order,
        items: available,
        mode: 'create',
        action: basePath,
        errors: { _form: errors },
        row: req.body,
      });
    }

    const deliveryId = await withTransaction(async (conn) => {
      const deliveryNo = await nextNumber({
        prefix: 'DLV',
        table: 'deliveries',
        column: 'delivery_no',
        date: deliveryDate,
        conn,
      });
      const [result] = await conn.query(
        `INSERT INTO deliveries (delivery_no, sales_order_id, customer_id, delivery_date, carrier, tracking_number, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          deliveryNo,
          orderId,
          order.customer_id,
          deliveryDate,
          (req.body.carrier || '').slice(0, 120) || null,
          (req.body.tracking_number || '').slice(0, 120) || null,
          (req.body.notes || '').slice(0, 5000) || null,
        ],
      );
      for (const item of items) {
        await conn.query(
          'INSERT INTO delivery_items (delivery_id, sales_order_item_id, product_id, quantity) VALUES (?, ?, ?, ?)',
          [result.insertId, item.so_item_id, item.product_id, item.quantity],
        );
      }
      return result.insertId;
    });

    req.flash('success', 'Delivery created. Mark it as shipped to update stock.');
    res.redirect(`${basePath}/${deliveryId}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) { return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 })); }
    const items = await loadDeliveryItems(delivery, true);
    const actions = [];
    if (delivery.status === 'pending') {
      actions.push({ action: 'status', value: 'shipped', label: req.t('Mark as shipped'), tone: 'primary', confirm: true });
      actions.push({ href: `${basePath}/${delivery.id}/edit`, label: req.t('Edit'), tone: 'secondary' });
      actions.push({ action: 'status', value: 'cancelled', label: req.t('Cancel'), tone: 'danger', confirm: true });
    } else if (delivery.status === 'shipped') {
      actions.push({ action: 'status', value: 'delivered', label: req.t('Mark as delivered'), tone: 'success' });
      actions.push({ action: 'status', value: 'cancelled', label: req.t('Cancel & restock'), tone: 'danger', confirm: true });
    }
    actions.push({ href: `${basePath}/${delivery.id}/print`, label: req.t('Print packing slip'), tone: 'secondary' });
    actions.push({ href: `/emails/compose?type=delivery&id=${delivery.id}`, label: req.t('Email'), tone: 'secondary' });

    res.render('deliveries/show', {
      title: delivery.delivery_no,
      active: 'deliveries',
      breadcrumbs: [{ label: req.t('Deliveries'), href: basePath }, { label: delivery.delivery_no }],
      delivery,
      items,
      actions,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) { return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 })); }
    if (delivery.status !== 'pending') {
      req.flash('error', 'Only pending deliveries can be edited.');
      return res.redirect(`${basePath}/${delivery.id}`);
    }
    const order = await loadOrderWithWarehouse(delivery.sales_order_id);
    const currentItems = await loadOrderItems(delivery.sales_order_id, delivery.id);
    const delivered = await query('SELECT * FROM delivery_items WHERE delivery_id = ?', [delivery.id]);
    const bySoItem = new Map(delivered.map((d) => [String(d.sales_order_item_id), d]));
    const items = currentItems
      .filter((i) => remainingOf(i) > 0 || bySoItem.has(String(i.so_item_id)))
      .map((i) => ({ ...i, current_qty: bySoItem.get(String(i.so_item_id))?.quantity || 0 }));

    res.render('deliveries/form', {
      title: req.t('Edit {number}', { number: delivery.delivery_no }),
      active: 'deliveries',
      breadcrumbs: [
        { label: req.t('Deliveries'), href: basePath },
        { label: delivery.delivery_no, href: `${basePath}/${delivery.id}` },
        { label: req.t('Edit') },
      ],
      delivery,
      order,
      items,
      mode: 'edit',
      action: `${basePath}/${delivery.id}`,
      errors: {},
      row: delivery,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) { return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 })); }
    if (delivery.status !== 'pending') {
      req.flash('error', 'Only pending deliveries can be edited.');
      return res.redirect(`${basePath}/${delivery.id}`);
    }
    const { items, errors } = await collectItems(req.body, delivery.sales_order_id, delivery.id, req.t);
    const deliveryDate = (req.body.delivery_date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) errors.push(req.t('A valid delivery date is required.'));

    if (errors.length) {
      const order = await loadOrderWithWarehouse(delivery.sales_order_id);
      const currentItems = await loadOrderItems(delivery.sales_order_id, delivery.id);
      const deliveredRows = await query('SELECT * FROM delivery_items WHERE delivery_id = ?', [delivery.id]);
      const bySoItem = new Map(deliveredRows.map((d) => [String(d.sales_order_item_id), d]));
      return res.status(422).render('deliveries/form', {
        title: req.t('Edit {number}', { number: delivery.delivery_no }),
        active: 'deliveries',
        breadcrumbs: [
          { label: req.t('Deliveries'), href: basePath },
          { label: delivery.delivery_no, href: `${basePath}/${delivery.id}` },
          { label: req.t('Edit') },
        ],
        delivery,
        order,
        items: currentItems
          .filter((i) => remainingOf(i) > 0 || bySoItem.has(String(i.so_item_id)))
          .map((i) => ({ ...i, current_qty: bySoItem.get(String(i.so_item_id))?.quantity || 0 })),
        mode: 'edit',
        action: `${basePath}/${delivery.id}`,
        errors: { _form: errors },
        row: req.body,
      });
    }

    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE deliveries SET delivery_date = ?, carrier = ?, tracking_number = ?, notes = ? WHERE id = ?`,
        [
          deliveryDate,
          (req.body.carrier || '').slice(0, 120) || null,
          (req.body.tracking_number || '').slice(0, 120) || null,
          (req.body.notes || '').slice(0, 5000) || null,
          delivery.id,
        ],
      );
      await conn.query('DELETE FROM delivery_items WHERE delivery_id = ?', [delivery.id]);
      for (const item of items) {
        await conn.query(
          'INSERT INTO delivery_items (delivery_id, sales_order_item_id, product_id, quantity) VALUES (?, ?, ?, ?)',
          [delivery.id, item.so_item_id, item.product_id, item.quantity],
        );
      }
    });

    req.flash('success', 'Delivery updated.');
    res.redirect(`${basePath}/${delivery.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/status', async (req, res, next) => {
  try {
    const target = req.body.status;
    const id = Number(req.params.id);
    const delivery = await loadDelivery(id);
    if (!delivery) { return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 })); }

    const allowed = { pending: ['shipped', 'cancelled'], shipped: ['delivered', 'cancelled'] };
    if (!(allowed[delivery.status] || []).includes(target)) {
      req.flash('error', 'Cannot change a {status} delivery to {target}.', {
        status: statusInfo(delivery.status, req.locale).label,
        target: statusInfo(target, req.locale).label,
      });
      return res.redirect(`${basePath}/${id}`);
    }

    await withTransaction(async (conn) => {
      const [items] = await conn.query(
        `SELECT di.*, p.sku, p.name, p.track_stock, p.stock_qty, p.cost_price
           FROM delivery_items di JOIN products p ON p.id = di.product_id
          WHERE di.delivery_id = ?`,
        [id],
      );

      if (target === 'shipped') {
        const shipments = new Map();
        for (const it of items) {
          if (!it.track_stock) continue;
          shipments.set(it.product_id, (shipments.get(it.product_id) || 0) + Number(it.quantity));
        }
        const shortages = [];
        for (const [productId, qty] of shipments) {
          const item = items.find((i) => i.product_id === productId);
          if (Number(item.stock_qty) < qty) shortages.push(`${item.sku} (need ${qty}, have ${item.stock_qty})`);
        }
        if (shortages.length) {
          throw Object.assign(
            new Error(req.t('Insufficient stock to ship: {items}.', { items: shortages.join('; ') })),
            { status: 422 },
          );
        }

        for (const [productId, qty] of shipments) {
          const item = items.find((i) => i.product_id === productId);
          await conn.query('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?', [qty, productId]);
          await conn.query(
            `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
             VALUES (?, 'sale_out', ?, ?, 'delivery', ?, ?, ?)`,
            [productId, -qty, item.cost_price || 0, id, `Shipped on ${delivery.delivery_no}`, req.session.user.id],
          );
        }
        for (const it of items) {
          if (it.sales_order_item_id) {
            await conn.query(
              'UPDATE sales_order_items SET delivered_qty = LEAST(quantity, delivered_qty + ?) WHERE id = ?',
              [it.quantity, it.sales_order_item_id],
            );
          }
        }
        await conn.query('UPDATE deliveries SET status = ?, stock_posted = 1 WHERE id = ?', [target, id]);
        await refreshSalesOrderStatus(conn, delivery.sales_order_id);
      } else if (target === 'cancelled' && delivery.stock_posted) {
        for (const it of items) {
          if (it.track_stock) {
            await conn.query('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [it.quantity, it.product_id]);
            await conn.query(
              `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
               VALUES (?, 'adjustment', ?, ?, 'delivery', ?, ?, ?)`,
              [it.product_id, it.quantity, it.cost_price || 0, id, `Cancelled delivery ${delivery.delivery_no}`, req.session.user.id],
            );
          }
          if (it.sales_order_item_id) {
            await conn.query(
              'UPDATE sales_order_items SET delivered_qty = GREATEST(0, delivered_qty - ?) WHERE id = ?',
              [it.quantity, it.sales_order_item_id],
            );
          }
        }
        await conn.query("UPDATE deliveries SET status = 'cancelled', stock_posted = 0 WHERE id = ?", [id]);
        await refreshSalesOrderStatus(conn, delivery.sales_order_id);
      } else {
        await conn.query('UPDATE deliveries SET status = ? WHERE id = ?', [target, id]);
      }
    });

    req.flash('success', '{item} marked as {status}.', {
      item: req.t('Delivery'),
      status: statusInfo(target, req.locale).label,
    });
    res.redirect(`${basePath}/${id}`);
  } catch (err) {
    if (err.status === 422) {
      req.flash('error', err.message);
      return res.redirect(`${basePath}/${req.params.id}`);
    }
    next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 }));
    }
    if (!['pending', 'cancelled'].includes(delivery.status)) {
      req.flash('error', 'Only pending or cancelled deliveries can be deleted.');
      return res.redirect(`${basePath}/${delivery.id}`);
    }
    await getPool().query('DELETE FROM deliveries WHERE id = ?', [delivery.id]);
    req.flash('success', 'Delivery deleted.');
    res.redirect(basePath);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/print', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 }));
    }
    const items = await loadDeliveryItems(delivery, false);
    const settings = await require('../lib/settings').getSettings();
    res.render('deliveries/print', {
      layout: false,
      title: req.t('Packing slip {number}', { number: delivery.delivery_no }),
      delivery,
      items,
      settings,
      money: (v) => formatMoney(v, settings.currency || 'USD', req.locale),
      statusBadge: forLocale(req.locale).statusBadge,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.loadDelivery = loadDelivery;
module.exports.loadDeliveryItems = loadDeliveryItems;
