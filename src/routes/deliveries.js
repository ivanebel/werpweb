'use strict';

const express = require('express');
const { query, one, scalar, getPool, withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { pagination, todayISO, toNumber, statusBadge, statusInfo, formatMoney, forLocale } = require('../lib/helpers');
const { requireRole } = require('../middleware/web');
const { round3, packingDefaults } = require('../lib/packing');
const {
  formatPackingSlipNo,
  usedCount,
  remainingCount,
  allocatePackingSlip,
  activeCai,
} = require('../lib/packingSlips');

const router = express.Router();
const basePath = '/deliveries';

function caiFormValues(body = {}) {
  return {
    cai_number: String(body.cai_number || '').trim(),
    prefix: String(body.prefix || '').trim(),
    range_start: String(body.range_start || '').trim(),
    range_end: String(body.range_end || '').trim(),
    status: ['active', 'cancelled'].includes(body.status) ? body.status : 'active',
    notes: String(body.notes || '').trim(),
  };
}

async function validateCai(input, existing = null) {
  const errors = {};
  if (!input.cai_number) {
    errors.cai_number = 'CAI number is required.';
  } else if (input.cai_number.length > 60) {
    errors.cai_number = 'CAI number is too long.';
  }
  if (!/^\d{5}$/.test(input.prefix)) {
    errors.prefix = 'Prefix must contain exactly five digits.';
  }
  const start = Number.parseInt(input.range_start, 10);
  const end = Number.parseInt(input.range_end, 10);
  if (!Number.isInteger(start) || start < 1 || start > 99999999) {
    errors.range_start = 'Range start must be a number between 1 and 99,999,999.';
  }
  if (!Number.isInteger(end) || end < 1 || end > 99999999) {
    errors.range_end = 'Range end must be a number between 1 and 99,999,999.';
  }
  if (Number.isInteger(start) && Number.isInteger(end) && start > end) {
    errors.range_end = 'Range end must be greater than or equal to the start.';
  }
  if (!errors.cai_number) {
    const duplicate = await one(
      `SELECT id FROM cai_authorizations WHERE cai_number = ? ${existing ? 'AND id <> ?' : ''} LIMIT 1`,
      existing ? [input.cai_number, existing.id] : [input.cai_number],
    );
    if (duplicate) errors.cai_number = 'This CAI number already exists.';
  }
  if (!errors.prefix && !errors.range_start && !errors.range_end) {
    const overlap = await one(
      `SELECT id FROM cai_authorizations
        WHERE prefix = ? AND status <> 'cancelled'
          AND range_start <= ? AND range_end >= ?
          ${existing ? 'AND id <> ?' : ''}
        LIMIT 1`,
      existing ? [input.prefix, end, start, existing.id] : [input.prefix, end, start],
    );
    if (overlap) errors.range_start = 'This CAI range overlaps another authorization for the same prefix.';
  }
  return errors;
}

function caiStatusFor(input, nextNumber) {
  if (input.status === 'cancelled') return 'cancelled';
  const remaining = Math.max(0, Number(input.range_end) - Number(nextNumber) + 1);
  return remaining > 0 ? 'active' : 'exhausted';
}

async function carrierOptions(currentId = null) {
  return query(
    `SELECT id, company_name, driver_name, driver_id, license_plate, status
       FROM carriers
      WHERE status = 'active' ${currentId ? 'OR id = ?' : ''}
      ORDER BY company_name`,
    currentId ? [currentId] : [],
  );
}

async function resolveCarrier(body, existing = null) {
  const carrierId = Number.parseInt(body.carrier_id, 10) || null;
  const carrier = carrierId
    ? await one('SELECT * FROM carriers WHERE id = ? LIMIT 1', [carrierId])
    : null;
  const legacy = String(body.legacy_carrier || existing?.carrier || '').trim();
  const company = (carrier ? carrier.company_name : legacy).slice(0, 120) || null;
  const driverName = (String(body.carrier_driver_name || '').trim() || carrier?.driver_name || '').slice(0, 120) || null;
  const driverId = (String(body.carrier_driver_id || '').trim() || carrier?.driver_id || '').slice(0, 40) || null;
  const licensePlate = (String(body.carrier_license_plate || '').trim() || carrier?.license_plate || '').slice(0, 20) || null;
  return {
    carrierId: carrier ? carrier.id : null,
    company,
    driverName,
    driverId,
    licensePlate,
  };
}

async function loadOrderItems(orderId, excludeDeliveryId = 0) {
  return query(
    `SELECT i.id AS so_item_id, i.product_id, i.quantity, i.delivered_qty,
            p.sku, p.name, p.unit, p.units_per_pack, p.packs_per_pallet, p.weight_kg,
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

function withCurrentPacking(items, deliveredRows) {
  const bySoItem = new Map(deliveredRows.map((d) => [String(d.sales_order_item_id), d]));
  return items
    .filter((i) => remainingOf(i) > 0 || bySoItem.has(String(i.so_item_id)))
    .map((i) => {
      const current = bySoItem.get(String(i.so_item_id));
      return {
        ...i,
        current_qty: current ? Number(current.quantity) : 0,
        current_pallets: current ? Number(current.slip_pallets) : null,
        current_boxes: current ? Number(current.slip_boxes) : null,
        current_units: current ? Number(current.slip_units) : null,
        current_weight: current ? Number(current.slip_weight_kg) : null,
      };
    });
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
      where.push('(d.delivery_no LIKE ? OR d.packing_slip_no LIKE ? OR d.cai_number LIKE ? OR d.cot LIKE ? OR d.carrier LIKE ? OR d.carrier_driver_name LIKE ? OR d.carrier_driver_id LIKE ? OR d.carrier_license_plate LIKE ? OR c.company_name LIKE ? OR so.order_no LIKE ? OR so.customer_order_no LIKE ? OR cw.name LIKE ? OR d.tracking_number LIKE ?)');
      params.push(
        `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`,
        `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`,
        `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`,
      );
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
    const currentCai = await activeCai();

    res.render('deliveries/index', {
      title: req.t('Deliveries'),
      active: 'deliveries',
      breadcrumbs: [{ label: req.t('Deliveries') }],
      rows,
      pagination: pag,
      search,
      activeStatus: status,
      activeCai: currentCai,
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
    const currentCai = await activeCai();
    const carriers = await carrierOptions();
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
        activeCai: currentCai,
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
      activeCai: currentCai,
      nextPackingSlip: currentCai ? formatPackingSlipNo(currentCai.prefix, currentCai.next_number) : null,
      packingDefaults,
      carriers,
      row: {
        delivery_date: todayISO(),
        carrier_id: '',
        carrier_driver_name: '',
        carrier_driver_id: '',
        carrier_license_plate: '',
        legacy_carrier: '',
        tracking_number: '',
        cot: '',
        notes: '',
      },
    });
  } catch (err) {
    next(err);
  }
});

async function collectItems(body, orderId, excludeDeliveryId = 0, t = (value) => value) {
  const ids = Array.isArray(body.so_item_id) ? body.so_item_id : [body.so_item_id];
  const qtys = Array.isArray(body.item_quantity) ? body.item_quantity : [body.item_quantity];
  const pallets = Array.isArray(body.slip_pallets) ? body.slip_pallets : [body.slip_pallets];
  const boxes = Array.isArray(body.slip_boxes) ? body.slip_boxes : [body.slip_boxes];
  const units = Array.isArray(body.slip_units) ? body.slip_units : [body.slip_units];
  const weights = Array.isArray(body.slip_weight_kg) ? body.slip_weight_kg : [body.slip_weight_kg];
  const available = await loadOrderItems(orderId, excludeDeliveryId);
  const byId = new Map(available.map((i) => [String(i.so_item_id), i]));
  const items = [];
  const errors = [];
  const packingValue = (list, index, fallback) => {
    const raw = list[index];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    return round3(Math.max(0, toNumber(raw, fallback)));
  };
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
    const defaultPacking = packingDefaults(qty, line);
    items.push({
      so_item_id: soItemId,
      product_id: line.product_id,
      quantity: qty,
      slip_pallets: packingValue(pallets, i, defaultPacking.pallets),
      slip_boxes: packingValue(boxes, i, defaultPacking.boxes),
      slip_units: packingValue(units, i, defaultPacking.units),
      slip_weight_kg: packingValue(weights, i, defaultPacking.weight),
    });
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

    const renderCreateError = async (messages) => {
      const available = (await loadOrderItems(orderId)).filter((i) => remainingOf(i) > 0);
      const currentCai = await activeCai();
      const carriers = await carrierOptions();
      return res.status(422).render('deliveries/form', {
        title: req.t('New delivery'),
        active: 'deliveries',
        breadcrumbs: [{ label: req.t('Deliveries'), href: basePath }, { label: req.t('New delivery') }],
        delivery: null,
        order,
        items: available,
        mode: 'create',
        action: basePath,
        errors: { _form: messages },
        activeCai: currentCai,
        nextPackingSlip: currentCai ? formatPackingSlipNo(currentCai.prefix, currentCai.next_number) : null,
        packingDefaults,
        carriers,
        row: req.body,
      });
    };

    if (errors.length) return renderCreateError(errors);
    const carrier = await resolveCarrier(req.body);

    let deliveryId;
    try {
      deliveryId = await withTransaction(async (conn) => {
        const slip = await allocatePackingSlip(conn);
        const deliveryNo = await nextNumber({
          prefix: 'DLV',
          table: 'deliveries',
          column: 'delivery_no',
          date: deliveryDate,
          conn,
        });
        const [result] = await conn.query(
          `INSERT INTO deliveries
             (delivery_no, packing_slip_no, cai_authorization_id, cai_number, cot,
              carrier_id, carrier, carrier_driver_name, carrier_driver_id, carrier_license_plate,
              sales_order_id, customer_id, delivery_date, tracking_number, status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [
            deliveryNo,
            slip.packingSlipNo,
            slip.id,
            slip.caiNumber,
            (req.body.cot || '').slice(0, 80) || null,
            carrier.carrierId,
            carrier.company,
            carrier.driverName,
            carrier.driverId,
            carrier.licensePlate,
            orderId,
            order.customer_id,
            deliveryDate,
            (req.body.tracking_number || '').slice(0, 120) || null,
            (req.body.notes || '').slice(0, 5000) || null,
          ],
        );
        for (const item of items) {
          await conn.query(
            `INSERT INTO delivery_items
               (delivery_id, sales_order_item_id, product_id, quantity,
                slip_pallets, slip_boxes, slip_units, slip_weight_kg)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              result.insertId,
              item.so_item_id,
              item.product_id,
              item.quantity,
              item.slip_pallets,
              item.slip_boxes,
              item.slip_units,
              item.slip_weight_kg,
            ],
          );
        }
        return result.insertId;
      });
    } catch (err) {
      if (err.code === 'NO_ACTIVE_CAI') {
        return renderCreateError([
          req.t('No active CAI authorization with available packing slips. Ask an administrator to add or activate one before creating a delivery.'),
        ]);
      }
      throw err;
    }

    req.flash('success', 'Delivery created. Mark it as shipped to update stock.');
    res.redirect(`${basePath}/${deliveryId}`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------ CAI authorizations
router.get('/cai', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT c.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM deliveries d WHERE d.cai_authorization_id = c.id) AS delivery_count
         FROM cai_authorizations c
         LEFT JOIN users u ON u.id = c.created_by
        ORDER BY c.created_at DESC, c.id DESC`,
    );
    const cais = rows.map((c) => {
      const used = usedCount(c);
      const remaining = remainingCount(c);
      return {
        ...c,
        used,
        remaining,
        rangeStartLabel: formatPackingSlipNo(c.prefix, c.range_start),
        rangeEndLabel: formatPackingSlipNo(c.prefix, c.range_end),
        nextSlipLabel: c.status === 'active' && remaining > 0 ? formatPackingSlipNo(c.prefix, c.next_number) : null,
      };
    });
    const stats = {
      total: cais.length,
      active: cais.filter((c) => c.status === 'active' && c.remaining > 0).length,
      available: cais.reduce((sum, c) => sum + (c.status === 'active' ? c.remaining : 0), 0),
      issued: cais.reduce((sum, c) => sum + c.used, 0),
    };
    const currentRow = await activeCai();
    const currentCai = currentRow ? cais.find((c) => c.id === currentRow.id) || null : null;
    const unassignedDeliveries = Number(
      (await scalar('SELECT COUNT(*) FROM deliveries WHERE packing_slip_no IS NULL')) || 0,
    );

    res.render('deliveries/cai/index', {
      title: req.t('CAI authorizations'),
      active: 'deliveries-cai',
      breadcrumbs: [{ label: req.t('Deliveries'), href: basePath }, { label: req.t('CAI authorizations') }],
      cais,
      stats,
      currentCai,
      unassignedDeliveries,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/cai/new', requireRole('admin'), (req, res) => {
  res.render('deliveries/cai/form', {
    title: req.t('New CAI authorization'),
    active: 'deliveries-cai',
    breadcrumbs: [
      { label: req.t('Deliveries'), href: basePath },
      { label: req.t('CAI authorizations'), href: `${basePath}/cai` },
      { label: req.t('New CAI authorization') },
    ],
    mode: 'create',
    action: `${basePath}/cai`,
    cai: null,
    row: { cai_number: '', prefix: '00001', range_start: '', range_end: '', status: 'active', notes: '' },
    errors: {},
    used: 0,
    remaining: null,
    canEditRange: true,
  });
});

router.post('/cai', requireRole('admin'), async (req, res, next) => {
  try {
    const input = caiFormValues(req.body);
    const errors = await validateCai(input);
    if (Object.keys(errors).length) {
      return res.status(422).render('deliveries/cai/form', {
        title: req.t('New CAI authorization'),
        active: 'deliveries-cai',
        breadcrumbs: [
          { label: req.t('Deliveries'), href: basePath },
          { label: req.t('CAI authorizations'), href: `${basePath}/cai` },
          { label: req.t('New CAI authorization') },
        ],
        mode: 'create',
        action: `${basePath}/cai`,
        cai: null,
        row: input,
        errors,
        used: 0,
        remaining: null,
        canEditRange: true,
      });
    }

    const start = Number.parseInt(input.range_start, 10);
    const end = Number.parseInt(input.range_end, 10);
    await getPool().query(
      `INSERT INTO cai_authorizations
         (cai_number, prefix, range_start, range_end, next_number, status, notes, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [input.cai_number, input.prefix, start, end, start, input.notes || null, req.session.user.id],
    );
    req.flash('success', 'CAI authorization created.');
    res.redirect(`${basePath}/cai`);
  } catch (err) {
    next(err);
  }
});

router.post('/cai/assign-missing', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await withTransaction(async (conn) => {
      const [deliveries] = await conn.query(
        `SELECT id FROM deliveries
          WHERE packing_slip_no IS NULL
          ORDER BY delivery_date ASC, id ASC
          FOR UPDATE`,
      );
      let assigned = 0;
      for (const delivery of deliveries) {
        let slip;
        try {
          slip = await allocatePackingSlip(conn);
        } catch (err) {
          if (err.code === 'NO_ACTIVE_CAI') break;
          throw err;
        }
        await conn.query(
          'UPDATE deliveries SET packing_slip_no = ?, cai_authorization_id = ?, cai_number = ? WHERE id = ?',
          [slip.packingSlipNo, slip.id, slip.caiNumber, delivery.id],
        );
        assigned += 1;
      }
      return { assigned, remaining: deliveries.length - assigned };
    });

    if (!result.assigned) {
      req.flash('error', 'No missing packing slips were assigned. Check that an active CAI authorization has numbers available.');
    } else if (result.remaining > 0) {
      req.flash('success', 'Assigned {count} missing packing slips. {remaining} deliveries still need an available CAI range.', {
        count: result.assigned,
        remaining: result.remaining,
      });
    } else {
      req.flash('success', 'Assigned {count} missing packing slips.', { count: result.assigned });
    }
    res.redirect(`${basePath}/cai`);
  } catch (err) {
    next(err);
  }
});

router.get('/cai/:id(\\d+)/edit', requireRole('admin'), async (req, res, next) => {
  try {
    const cai = await one('SELECT * FROM cai_authorizations WHERE id = ? LIMIT 1', [req.params.id]);
    if (!cai) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('CAI authorization') })), { status: 404 }));
    }
    const used = usedCount(cai);
    const remaining = remainingCount(cai);
    res.render('deliveries/cai/form', {
      title: req.t('Edit CAI authorization'),
      active: 'deliveries-cai',
      breadcrumbs: [
        { label: req.t('Deliveries'), href: basePath },
        { label: req.t('CAI authorizations'), href: `${basePath}/cai` },
        { label: req.t('Edit CAI authorization') },
      ],
      mode: 'edit',
      action: `${basePath}/cai/${cai.id}`,
      cai,
      row: {
        ...cai,
        range_start: String(cai.range_start),
        range_end: String(cai.range_end),
      },
      errors: {},
      used,
      remaining,
      canEditRange: used === 0,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/cai/:id(\\d+)', requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await one('SELECT * FROM cai_authorizations WHERE id = ? LIMIT 1', [req.params.id]);
    if (!existing) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('CAI authorization') })), { status: 404 }));
    }

    const used = usedCount(existing);
    const input = caiFormValues(req.body);
    const errors = {};
    if (used > 0) {
      const start = Number.parseInt(input.range_start, 10);
      const end = Number.parseInt(input.range_end, 10);
      if (
        input.prefix !== existing.prefix
        || start !== Number(existing.range_start)
        || end !== Number(existing.range_end)
      ) {
        errors._form = ['This CAI has already issued packing slips. Only its number, notes and status can be changed.'];
      }
      input.prefix = existing.prefix;
      input.range_start = String(existing.range_start);
      input.range_end = String(existing.range_end);
    }
    Object.assign(errors, await validateCai(input, existing));

    if (Object.keys(errors).length) {
      return res.status(422).render('deliveries/cai/form', {
        title: req.t('Edit CAI authorization'),
        active: 'deliveries-cai',
        breadcrumbs: [
          { label: req.t('Deliveries'), href: basePath },
          { label: req.t('CAI authorizations'), href: `${basePath}/cai` },
          { label: req.t('Edit CAI authorization') },
        ],
        mode: 'edit',
        action: `${basePath}/cai/${existing.id}`,
        cai: existing,
        row: input,
        errors,
        used,
        remaining: remainingCount(existing),
        canEditRange: used === 0,
      });
    }

    const start = Number.parseInt(input.range_start, 10);
    const end = Number.parseInt(input.range_end, 10);
    const nextNumber = used === 0 ? start : existing.next_number;
    const status = caiStatusFor(input, nextNumber);
    await getPool().query(
      `UPDATE cai_authorizations
          SET cai_number = ?, prefix = ?, range_start = ?, range_end = ?, next_number = ?, status = ?, notes = ?
        WHERE id = ?`,
      [input.cai_number, input.prefix, start, end, nextNumber, status, input.notes || null, existing.id],
    );
    req.flash('success', 'CAI authorization updated.');
    res.redirect(`${basePath}/cai`);
  } catch (err) {
    next(err);
  }
});

router.post('/cai/:id(\\d+)/delete', requireRole('admin'), async (req, res, next) => {
  try {
    const cai = await one('SELECT * FROM cai_authorizations WHERE id = ? LIMIT 1', [req.params.id]);
    if (!cai) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('CAI authorization') })), { status: 404 }));
    }
    if (usedCount(cai) > 0) {
      req.flash('error', 'This CAI has issued packing slips and cannot be deleted. Cancel it instead.');
      return res.redirect(`${basePath}/cai`);
    }
    const references = Number(
      (await scalar('SELECT COUNT(*) FROM deliveries WHERE cai_authorization_id = ?', [cai.id])) || 0,
    );
    if (references > 0) {
      req.flash('error', 'This CAI is linked to deliveries and cannot be deleted. Cancel it instead.');
      return res.redirect(`${basePath}/cai`);
    }
    await getPool().query('DELETE FROM cai_authorizations WHERE id = ?', [cai.id]);
    req.flash('success', 'CAI authorization deleted.');
    res.redirect(`${basePath}/cai`);
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
    if (delivery.packing_slip_no) {
      actions.push({ href: `${basePath}/${delivery.id}/print`, label: req.t('Print packing slip'), tone: 'secondary' });
    }
    actions.push({ href: `${basePath}/${delivery.id}/packing`, label: req.t('Edit packing quantities'), tone: 'secondary' });
    actions.push({ href: `${basePath}/${delivery.id}/transport`, label: req.t('Edit transport'), tone: 'secondary' });
    actions.push({ href: `/emails/compose?type=delivery&id=${delivery.id}`, label: req.t('Email'), tone: 'secondary' });

    const pageNumber = delivery.packing_slip_no || delivery.delivery_no;
    res.render('deliveries/show', {
      title: pageNumber,
      active: 'deliveries',
      breadcrumbs: [{ label: req.t('Deliveries'), href: basePath }, { label: pageNumber }],
      delivery,
      items,
      actions,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/transport', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 }));
    }
    const carriers = await carrierOptions(delivery.carrier_id);
    const pageNumber = delivery.packing_slip_no || delivery.delivery_no;

    res.render('deliveries/transport', {
      title: req.t('Transport details'),
      active: 'deliveries',
      breadcrumbs: [
        { label: req.t('Deliveries'), href: basePath },
        { label: pageNumber, href: `${basePath}/${delivery.id}` },
        { label: req.t('Transport details') },
      ],
      delivery,
      carriers,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/transport', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 }));
    }
    const carrier = await resolveCarrier(req.body, delivery);
    await getPool().query(
      `UPDATE deliveries
          SET carrier_id = ?, carrier = ?, carrier_driver_name = ?, carrier_driver_id = ?,
              carrier_license_plate = ?, tracking_number = ?
        WHERE id = ?`,
      [
        carrier.carrierId,
        carrier.company,
        carrier.driverName,
        carrier.driverId,
        carrier.licensePlate,
        (req.body.tracking_number || '').slice(0, 120) || null,
        delivery.id,
      ],
    );
    req.flash('success', 'Transport details updated.');
    res.redirect(`${basePath}/${delivery.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/packing', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 }));
    }
    const items = await query(
      `SELECT di.*, p.sku, p.name, p.unit, p.units_per_pack, p.packs_per_pallet, p.weight_kg
         FROM delivery_items di
         JOIN products p ON p.id = di.product_id
        WHERE di.delivery_id = ?
        ORDER BY di.id`,
      [delivery.id],
    );
    const totals = items.reduce((sum, item) => ({
      pallets: sum.pallets + Number(item.slip_pallets || 0),
      boxes: sum.boxes + Number(item.slip_boxes || 0),
      units: sum.units + Number(item.slip_units || 0),
      weight: sum.weight + Number(item.slip_weight_kg || 0),
    }), { pallets: 0, boxes: 0, units: 0, weight: 0 });
    const pageNumber = delivery.packing_slip_no || delivery.delivery_no;

    res.render('deliveries/packing', {
      title: req.t('Packing quantities'),
      active: 'deliveries',
      breadcrumbs: [
        { label: req.t('Deliveries'), href: basePath },
        { label: pageNumber, href: `${basePath}/${delivery.id}` },
        { label: req.t('Packing quantities') },
      ],
      delivery,
      items,
      totals,
      packingDefaults,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/packing', async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 }));
    }
    const rows = await query('SELECT id FROM delivery_items WHERE delivery_id = ?', [delivery.id]);
    const validIds = new Set(rows.map((row) => String(row.id)));
    const ids = Array.isArray(req.body.delivery_item_id) ? req.body.delivery_item_id : [req.body.delivery_item_id];
    const pallets = Array.isArray(req.body.slip_pallets) ? req.body.slip_pallets : [req.body.slip_pallets];
    const boxes = Array.isArray(req.body.slip_boxes) ? req.body.slip_boxes : [req.body.slip_boxes];
    const units = Array.isArray(req.body.slip_units) ? req.body.slip_units : [req.body.slip_units];
    const weights = Array.isArray(req.body.slip_weight_kg) ? req.body.slip_weight_kg : [req.body.slip_weight_kg];
    const valueAt = (list, index) => round3(Math.max(0, toNumber(list[index], 0)));

    await withTransaction(async (conn) => {
      for (let i = 0; i < ids.length; i++) {
        const itemId = Number.parseInt(ids[i], 10);
        if (!itemId || !validIds.has(String(itemId))) continue;
        await conn.query(
          `UPDATE delivery_items
              SET slip_pallets = ?, slip_boxes = ?, slip_units = ?, slip_weight_kg = ?
            WHERE id = ? AND delivery_id = ?`,
          [valueAt(pallets, i), valueAt(boxes, i), valueAt(units, i), valueAt(weights, i), itemId, delivery.id],
        );
      }
    });

    req.flash('success', 'Packing quantities updated.');
    res.redirect(`${basePath}/${delivery.id}`);
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
    const items = withCurrentPacking(currentItems, delivered);
    const currentCai = await activeCai();
    const carriers = await carrierOptions(delivery.carrier_id);
    const pageNumber = delivery.packing_slip_no || delivery.delivery_no;

    res.render('deliveries/form', {
      title: req.t('Edit {number}', { number: pageNumber }),
      active: 'deliveries',
      breadcrumbs: [
        { label: req.t('Deliveries'), href: basePath },
        { label: pageNumber, href: `${basePath}/${delivery.id}` },
        { label: req.t('Edit') },
      ],
      delivery,
      order,
      items,
      mode: 'edit',
      action: `${basePath}/${delivery.id}`,
      errors: {},
      activeCai: currentCai,
      nextPackingSlip: currentCai ? formatPackingSlipNo(currentCai.prefix, currentCai.next_number) : null,
      packingDefaults,
      carriers,
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
      const items = withCurrentPacking(currentItems, deliveredRows);
      const currentCai = await activeCai();
      const carriers = await carrierOptions(delivery.carrier_id);
      const pageNumber = delivery.packing_slip_no || delivery.delivery_no;
      return res.status(422).render('deliveries/form', {
        title: req.t('Edit {number}', { number: pageNumber }),
        active: 'deliveries',
        breadcrumbs: [
          { label: req.t('Deliveries'), href: basePath },
          { label: pageNumber, href: `${basePath}/${delivery.id}` },
          { label: req.t('Edit') },
        ],
        delivery,
        order,
        items,
        mode: 'edit',
        action: `${basePath}/${delivery.id}`,
        errors: { _form: errors },
        activeCai: currentCai,
        nextPackingSlip: currentCai ? formatPackingSlipNo(currentCai.prefix, currentCai.next_number) : null,
        packingDefaults,
        carriers,
        row: req.body,
      });
    }

    const carrier = await resolveCarrier(req.body, delivery);
    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE deliveries
            SET delivery_date = ?, carrier_id = ?, carrier = ?,
                carrier_driver_name = ?, carrier_driver_id = ?, carrier_license_plate = ?,
                tracking_number = ?, cot = ?, notes = ?
          WHERE id = ?`,
        [
          deliveryDate,
          carrier.carrierId,
          carrier.company,
          carrier.driverName,
          carrier.driverId,
          carrier.licensePlate,
          (req.body.tracking_number || '').slice(0, 120) || null,
          (req.body.cot || '').slice(0, 80) || null,
          (req.body.notes || '').slice(0, 5000) || null,
          delivery.id,
        ],
      );
      await conn.query('DELETE FROM delivery_items WHERE delivery_id = ?', [delivery.id]);
      for (const item of items) {
        await conn.query(
          `INSERT INTO delivery_items
             (delivery_id, sales_order_item_id, product_id, quantity,
              slip_pallets, slip_boxes, slip_units, slip_weight_kg)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            delivery.id,
            item.so_item_id,
            item.product_id,
            item.quantity,
            item.slip_pallets,
            item.slip_boxes,
            item.slip_units,
            item.slip_weight_kg,
          ],
        );
      }
    });

    req.flash('success', 'Delivery updated.');
    res.redirect(`${basePath}/${delivery.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/assign-packing-slip', requireRole('admin'), async (req, res, next) => {
  try {
    const delivery = await loadDelivery(req.params.id);
    if (!delivery) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Delivery') })), { status: 404 }));
    }
    if (delivery.packing_slip_no) {
      req.flash('error', 'This delivery already has a packing slip number.');
      return res.redirect(`${basePath}/${delivery.id}`);
    }

    let slip;
    try {
      slip = await withTransaction(async (conn) => {
        const allocated = await allocatePackingSlip(conn);
        await conn.query(
          'UPDATE deliveries SET packing_slip_no = ?, cai_authorization_id = ?, cai_number = ? WHERE id = ?',
          [allocated.packingSlipNo, allocated.id, allocated.caiNumber, delivery.id],
        );
        return allocated;
      });
    } catch (err) {
      if (err.code === 'NO_ACTIVE_CAI') {
        req.flash('error', 'No active CAI authorization with available packing slips. Add or activate one first.');
        return res.redirect(`${basePath}/${delivery.id}`);
      }
      throw err;
    }

    req.flash('success', 'Packing slip {number} assigned.', { number: slip.packingSlipNo });
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
    if (delivery.packing_slip_no) {
      req.flash('error', 'Deliveries with an assigned packing slip cannot be deleted. Cancel the delivery instead.');
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
    if (!delivery.packing_slip_no) {
      req.flash('error', 'This delivery does not have a packing slip number. Assign one before printing.');
      return res.redirect(`${basePath}/${delivery.id}`);
    }
    const items = await loadDeliveryItems(delivery, false);
    const settings = await require('../lib/settings').getSettings();
    res.render('deliveries/print', {
      layout: false,
      title: req.t('Packing slip {number}', { number: delivery.packing_slip_no }),
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
