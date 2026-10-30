'use strict';

const express = require('express');
const { getPool, query, one, withTransaction } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { pagination, toNumber, todayISO, addDaysISO, formatMoney } = require('../lib/helpers');
const { translator } = require('../lib/i18n');
const {
  normalizeInvoiceNumber,
  getFiscalType,
  fiscalFamily,
  isNoteCode,
  isRegularInvoiceCode,
  invoiceTypeCodes,
} = require('../lib/fiscalDocumentTypes');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function localizeDocConfig(config, locale) {
  const t = translator(locale);
  const title = t(config.title);
  const singular = t(config.singular);
  return {
    ...config,
    title,
    singular,
    titleLower: title.toLowerCase(),
    singularLower: singular.toLowerCase(),
    newLabel: t(`New ${config.singular}`),
    editLabel: t(`Edit ${config.singular}`),
    indexSubtitle: t('Track {items}, their status and outstanding value.', { items: title.toLowerCase() }),
    party: { ...config.party, label: t(config.party.label) },
    dateLabel: t(config.dateLabel),
    dueLabel: t(config.dueLabel),
    qtyLabel: t(config.qtyLabel),
    newTitle: t(`New ${config.singular}`),
    customerOrder: config.customerOrder
      ? {
          ...config.customerOrder,
          orderNoLabel: t(config.customerOrder.orderNoLabel),
          warehouseLabel: t(config.customerOrder.warehouseLabel),
          dockingLabel: t(config.customerOrder.dockingLabel),
          receptionLabel: t(config.customerOrder.receptionLabel),
        }
      : null,
  };
}

function arr(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseItems(body, config, defaultTaxRate) {
  const ids = arr(body.item_product_id);
  const descriptions = arr(body.item_description);
  const quantities = arr(body.item_quantity);
  const prices = arr(body.item_unit_price);
  const taxes = arr(body.item_tax_rate);
  const items = [];

  for (let i = 0; i < ids.length; i++) {
    const productId = Number.parseInt(ids[i], 10);
    if (!productId) continue;
    const quantity = toNumber(quantities[i], 0);
    const unitPrice = toNumber(prices[i], 0);
    const taxRate = taxes[i] === undefined || taxes[i] === '' ? Number(defaultTaxRate || 0) : toNumber(taxes[i], 0);
    if (quantity <= 0) continue;
    items.push({
      product_id: productId,
      description: String(descriptions[i] || '').slice(0, 255) || null,
      quantity,
      unit_price: round2(unitPrice),
      tax_rate: taxRate,
      line_total: round2(quantity * unitPrice),
    });
  }
  return items;
}

function computeTotals(items, discount) {
  const subtotal = round2(items.reduce((s, it) => s + it.line_total, 0));
  // Document prices are tax-inclusive. Tax is extracted from the line total,
  // never added on top of it.
  const tax_total = round2(
    items.reduce((s, it) => {
      const rate = Number(it.tax_rate) || 0;
      return s + (rate > 0 ? it.line_total * (rate / (100 + rate)) : 0);
    }, 0),
  );
  const discount_total = round2(Math.min(Math.max(Number(discount) || 0, 0), subtotal));
  return { subtotal, tax_total, discount_total, total: round2(subtotal - discount_total) };
}

function validDateValue(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime());
}

function parseIdList(value) {
  return [...new Set(arr(value).map((item) => Number.parseInt(item, 10)).filter((id) => id > 0))];
}

async function loadFiscalTypes(includeCode = null) {
  const rows = await query(
    `SELECT code, name, active FROM fiscal_document_types
      WHERE active = 1 OR code = ?
      ORDER BY code`,
    [Number(includeCode) || 0],
  );
  return rows.map((row) => ({
    code: Number(row.code),
    name: row.name,
    active: Number(row.active) === 1,
    family: fiscalFamily(row.code),
  }));
}

async function loadDeliveryOptions(config) {
  if (config.kind !== 'sales_invoice') return [];
  return query(
    `SELECT d.id, d.delivery_no, d.packing_slip_no, d.delivery_date, d.status,
            d.customer_id, c.company_name
       FROM deliveries d
       JOIN customers c ON c.id = d.customer_id
      WHERE d.status <> 'cancelled'
        AND d.sales_order_id IS NOT NULL
      ORDER BY d.delivery_date DESC, d.id DESC
      LIMIT 500`,
  );
}

async function loadNoteInvoiceOptions(config, excludeId = 0) {
  const codes = invoiceTypeCodes();
  const placeholders = codes.map(() => '?').join(', ');
  const rows = await query(
    `SELECT i.id, i.\`${config.numberField}\` AS number, i.invoice_date, i.total, i.status,
            i.document_type_code, i.\`${config.party.field}\` AS party_id, party.company_name,
            fdt.name AS document_type_name
       FROM \`${config.table}\` i
       JOIN \`${config.party.table}\` party ON party.id = i.\`${config.party.field}\`
       LEFT JOIN fiscal_document_types fdt ON fdt.code = i.document_type_code
      WHERE i.id <> ?
        AND i.status <> 'cancelled'
        AND (i.document_type_code IS NULL OR i.document_type_code IN (${placeholders}))
      ORDER BY i.invoice_date DESC, i.id DESC
      LIMIT 500`,
    [excludeId, ...codes],
  );
  return rows;
}

async function loadSelectedDeliveryIds(config, invoiceId) {
  if (!config.deliveryLinkTable) return [];
  const rows = await query(
    `SELECT delivery_id FROM \`${config.deliveryLinkTable}\` WHERE invoice_id = ? ORDER BY delivery_id`,
    [invoiceId],
  );
  return rows.map((row) => Number(row.delivery_id));
}

async function loadSelectedNoteInvoiceIds(config, noteId) {
  if (!config.fiscalRelationTable) return [];
  const rows = await query(
    `SELECT invoice_id FROM \`${config.fiscalRelationTable}\` WHERE note_id = ? ORDER BY invoice_id`,
    [noteId],
  );
  return rows.map((row) => Number(row.invoice_id));
}

async function loadInvoiceFormOptions(config, { existing = null, posted = null } = {}) {
  if (!config.isInvoice) {
    return {
      fiscalTypes: [],
      deliveryOptions: [],
      noteInvoiceOptions: [],
      selectedDeliveryIds: [],
      selectedNoteInvoiceIds: [],
    };
  }
  const postedType = posted ? Number.parseInt(posted.document_type_code, 10) : null;
  const includeCode = existing
    ? existing.document_type_code
    : (postedType || 1);
  const fiscalTypes = await loadFiscalTypes(includeCode);
  const deliveryOptions = await loadDeliveryOptions(config);
  const noteInvoiceOptions = await loadNoteInvoiceOptions(config, existing ? existing.id : 0);
  const selectedDeliveryIds = posted
    ? parseIdList(posted.delivery_ids)
    : existing
      ? await loadSelectedDeliveryIds(config, existing.id)
      : [];
  const selectedNoteInvoiceIds = posted
    ? parseIdList(posted.note_invoice_ids)
    : existing
      ? await loadSelectedNoteInvoiceIds(config, existing.id)
      : [];
  return { fiscalTypes, deliveryOptions, noteInvoiceOptions, selectedDeliveryIds, selectedNoteInvoiceIds };
}

async function validateInvoiceNumber(config, body, req, existing = null) {
  if (!config.isInvoice) return { value: null, errors: {} };
  const raw = String(body[config.numberField] || '').trim();
  if (existing && (!raw || raw === String(existing[config.numberField] || ''))) {
    return { value: existing[config.numberField], errors: {} };
  }
  const normalized = normalizeInvoiceNumber(raw);
  if (!normalized) {
    return {
      value: null,
      errors: {
        [config.numberField]: req.t('Use the invoice number format 00000-00000000 (point of sale and document number).'),
      },
    };
  }
  const duplicate = await one(
    `SELECT id FROM \`${config.table}\` WHERE \`${config.numberField}\` = ? AND id <> ? LIMIT 1`,
    [normalized, existing ? existing.id : 0],
  );
  if (duplicate) {
    return { value: normalized, errors: { [config.numberField]: req.t('This invoice number already exists.') } };
  }
  return { value: normalized, errors: {} };
}

async function validateFiscalFields(config, body, req, existing = null) {
  if (!config.isInvoice) {
    return {
      errors: {},
      values: {
        document_type_code: null,
        cae: null,
        cae_expiry_date: null,
        cbu: null,
        transfer_option: null,
        payment_expiry_date: null,
        packing_slip_no: null,
      },
    };
  }

  const errors = {};
  const values = {
    document_type_code: null,
    cae: null,
    cae_expiry_date: null,
    cbu: null,
    transfer_option: null,
    payment_expiry_date: null,
    packing_slip_no: null,
  };

  const rawType = String(body.document_type_code || '').trim();
  if (rawType) {
    const code = Number.parseInt(rawType, 10);
    const type = getFiscalType(code);
    if (!type) {
      errors.document_type_code = req.t('Select a valid fiscal document type.');
    } else if (!type.active && (!existing || Number(existing.document_type_code) !== code)) {
      errors.document_type_code = req.t('This fiscal document type is not active.');
    } else {
      values.document_type_code = code;
    }
  } else if (existing && existing.document_type_code) {
    values.document_type_code = Number(existing.document_type_code);
  }
  if (config.isInvoice && !values.document_type_code && !(existing && !existing.document_type_code)) {
    errors.document_type_code = req.t('Select a fiscal document type.');
  }

  if (config.kind === 'sales_invoice') {
    const cae = String(body.cae || '').trim();
    if (cae) {
      if (!/^\d{14}$/.test(cae)) {
        errors.cae = req.t('The CAE number must contain exactly 14 digits.');
      } else {
        values.cae = cae;
      }
    }
    const caeExpiry = String(body.cae_expiry_date || '').slice(0, 10);
    if (caeExpiry) {
      if (!validDateValue(caeExpiry)) {
        errors.cae_expiry_date = req.t('Enter a valid CAE expiry date.');
      } else {
        values.cae_expiry_date = caeExpiry;
      }
    }
    const cbu = String(body.cbu || '').replace(/[\s-]/g, '');
    if (cbu) {
      if (!/^\d{22}$/.test(cbu)) {
        errors.cbu = req.t('The CBU must contain exactly 22 digits.');
      } else {
        values.cbu = cbu;
      }
    }
    const transfer = String(body.transfer_option || '').trim().toUpperCase();
    if (transfer) {
      if (!['ADC', 'SCA'].includes(transfer)) {
        errors.transfer_option = req.t('Invalid transfer option.');
      } else {
        values.transfer_option = transfer;
      }
    }
    const paymentExpiry = String(body.payment_expiry_date || '').slice(0, 10);
    if (paymentExpiry) {
      if (!validDateValue(paymentExpiry)) {
        errors.payment_expiry_date = req.t('Enter a valid payment expiry date.');
      } else {
        values.payment_expiry_date = paymentExpiry;
      }
    }
  }

  if (config.kind === 'purchase_invoice') {
    const packingSlip = String(body.packing_slip_no || '').trim().slice(0, 30);
    values.packing_slip_no = packingSlip || null;
  }

  return { errors, values };
}

async function validateDeliveryIds(ids, customerId) {
  if (!ids.length) return { ids: [], invalid: false };
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await query(
    `SELECT id FROM deliveries
      WHERE id IN (${placeholders})
        AND customer_id = ?
        AND sales_order_id IS NOT NULL
        AND status <> 'cancelled'`,
    [...ids, customerId],
  );
  return { ids: rows.map((row) => Number(row.id)), invalid: rows.length !== ids.length };
}

async function validateRelatedInvoiceIds(ids, config, partyId, currentId) {
  if (!ids.length) return { ids: [], invalid: false };
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await query(
    `SELECT id, document_type_code FROM \`${config.table}\`
      WHERE id IN (${placeholders})
        AND \`${config.party.field}\` = ?
        AND id <> ?
        AND status <> 'cancelled'`,
    [...ids, partyId, currentId],
  );
  const regular = rows.filter((row) => isRegularInvoiceCode(row.document_type_code));
  return { ids: regular.map((row) => Number(row.id)), invalid: regular.length !== ids.length };
}

async function saveInvoiceLinks(conn, config, id, { fiscalCode, deliveryIds, relatedInvoiceIds }) {
  if (!config.isInvoice) return;
  if (config.deliveryLinkTable) {
    await conn.query(`DELETE FROM \`${config.deliveryLinkTable}\` WHERE invoice_id = ?`, [id]);
    if (!isNoteCode(fiscalCode) && deliveryIds.length) {
      await conn.query(
        `INSERT INTO \`${config.deliveryLinkTable}\` (invoice_id, delivery_id) VALUES ?`,
        [deliveryIds.map((deliveryId) => [id, deliveryId])],
      );
    }
  }
  if (config.fiscalRelationTable) {
    await conn.query(`DELETE FROM \`${config.fiscalRelationTable}\` WHERE note_id = ?`, [id]);
    if (isNoteCode(fiscalCode) && relatedInvoiceIds.length) {
      await conn.query(
        `INSERT INTO \`${config.fiscalRelationTable}\` (note_id, invoice_id) VALUES ?`,
        [relatedInvoiceIds.map((invoiceId) => [id, invoiceId])],
      );
    }
  }
}

async function loadInvoiceAssociations(config, row) {
  const associations = { linkedDeliveries: [], relatedInvoices: [], relatedNotes: [] };
  if (!config.isInvoice) return associations;

  if (config.kind === 'sales_invoice') {
    associations.linkedDeliveries = await query(
      `SELECT d.*
         FROM deliveries d
         JOIN \`${config.deliveryLinkTable}\` link ON link.delivery_id = d.id
        WHERE link.invoice_id = ?
        ORDER BY d.delivery_date DESC, d.id DESC`,
      [row.id],
    );
  }

  if (isNoteCode(row.document_type_code)) {
    associations.relatedInvoices = await query(
      `SELECT i.id, i.\`${config.numberField}\` AS number, i.invoice_date, i.total, i.status,
              i.document_type_code, fdt.name AS document_type_name
         FROM \`${config.table}\` i
         JOIN \`${config.fiscalRelationTable}\` link ON link.invoice_id = i.id
         LEFT JOIN fiscal_document_types fdt ON fdt.code = i.document_type_code
        WHERE link.note_id = ?
        ORDER BY i.invoice_date, i.id`,
      [row.id],
    );
  } else {
    associations.relatedNotes = await query(
      `SELECT n.id, n.\`${config.numberField}\` AS number, n.invoice_date, n.total, n.status,
              n.document_type_code, fdt.name AS document_type_name
         FROM \`${config.table}\` n
         JOIN \`${config.fiscalRelationTable}\` link ON link.note_id = n.id
         LEFT JOIN fiscal_document_types fdt ON fdt.code = n.document_type_code
        WHERE link.invoice_id = ?
        ORDER BY n.invoice_date, n.id`,
      [row.id],
    );
  }

  return associations;
}

async function loadPartyOptions(config) {
  const rows = await query(
    `SELECT id, company_name AS name, contact_name, email FROM \`${config.party.table}\` ORDER BY company_name ASC`,
  );
  return rows.map((r) => ({ value: String(r.id), label: r.name, email: r.email, contact: r.contact_name }));
}

async function loadProductOptions(config) {
  const rows = await query(
    `SELECT p.id, p.sku, p.name, p.unit, p.sale_price, p.cost_price,
            p.sale_vat_rate, p.cost_vat_rate, p.sold_by_weight,
            b.name AS brand_name
       FROM products p
       LEFT JOIN brands b ON b.id = p.brand_id
      WHERE ${config.productWhere}
      ORDER BY COALESCE(b.name, ''), p.name ASC`,
  );
  return rows.map((p) => ({
    value: String(p.id),
    label: p.brand_name ? `${p.brand_name} - ${p.name}` : p.name,
    name: p.name,
    brand: p.brand_name || '',
    sku: p.sku,
    unit: p.unit,
    price: config.priceField === 'cost_price' ? Number(p.cost_price) : Number(p.sale_price),
    taxRate: config.priceField === 'cost_price' ? Number(p.cost_vat_rate || 0) : Number(p.sale_vat_rate || 0),
    weighted: Number(p.sold_by_weight) === 1,
  }));
}

async function loadCustomerCodes() {
  const rows = await query('SELECT customer_id, product_id, code FROM customer_product_codes');
  const map = {};
  for (const row of rows) {
    if (!map[row.customer_id]) map[row.customer_id] = {};
    map[row.customer_id][row.product_id] = row.code;
  }
  return map;
}

async function loadWarehouseOptions() {
  const rows = await query(
    `SELECT id, customer_id, code, name, status, city, state
       FROM customer_warehouses
      ORDER BY customer_id ASC, status = 'active' DESC, name ASC`,
  );
  return rows.map((w) => ({
    value: String(w.id),
    customerId: String(w.customer_id),
    name: w.name,
    code: w.code || '',
    status: w.status,
    city: w.city || '',
    state: w.state || '',
    label: `${w.name}${w.code ? ` — ${w.code}` : ''}${w.status === 'inactive' ? ` (${w.status})` : ''}`,
  }));
}

function normalizeDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[2].slice(0, 2));
  const minute = Number(match[2].slice(3, 5));
  if (hour > 23 || minute > 59) return null;
  return `${match[1]} ${match[2]}:${match[3] || '00'}`;
}

async function ensureWarehouseForCustomer(conn, customerId) {
  const [existing] = await conn.query(
    `SELECT id FROM customer_warehouses WHERE customer_id = ?
      ORDER BY status = 'active' DESC, id ASC LIMIT 1`,
    [customerId],
  );
  if (existing.length) return Number(existing[0].id);

  const [customers] = await conn.query(
    `SELECT contact_name, email, phone, address_line1, address_line2, city, state, postal_code, country
       FROM customers WHERE id = ? LIMIT 1`,
    [customerId],
  );
  if (!customers.length) return null;
  const c = customers[0];
  const [result] = await conn.query(
    `INSERT INTO customer_warehouses
       (customer_id, code, name, contact_name, email, phone, address_line1, address_line2,
        city, state, postal_code, country, status)
     VALUES (?, 'MAIN', 'Main warehouse', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      customerId, c.contact_name, c.email, c.phone, c.address_line1, c.address_line2,
      c.city, c.state, c.postal_code, c.country,
    ],
  );
  return Number(result.insertId);
}

async function findDoc(config, id) {
  const warehouseSelect = config.customerOrder
    ? `, cw.name AS warehouse_name, cw.code AS warehouse_code,
         cw.contact_name AS warehouse_contact, cw.phone AS warehouse_phone,
         cw.address_line1 AS warehouse_address, cw.address_line2 AS warehouse_address2,
         cw.city AS warehouse_city, cw.state AS warehouse_state,
         cw.postal_code AS warehouse_postal, cw.country AS warehouse_country`
    : '';
  const warehouseJoin = config.customerOrder
    ? 'LEFT JOIN customer_warehouses cw ON cw.id = t.customer_warehouse_id'
    : '';
  const fiscalSelect = config.isInvoice ? ', fdt.name AS document_type_name' : '';
  const fiscalJoin = config.isInvoice
    ? 'LEFT JOIN fiscal_document_types fdt ON fdt.code = t.document_type_code'
    : '';
  return one(
    `SELECT t.*, party.company_name AS party_name, party.contact_name AS party_contact,
            party.email AS party_email, party.phone AS party_phone, party.address_line1 AS party_address,
            party.city AS party_city, party.state AS party_state, party.postal_code AS party_postal,
            party.country AS party_country, party.tax_id AS party_tax_id${warehouseSelect}${fiscalSelect}
       FROM \`${config.table}\` t
       JOIN \`${config.party.table}\` party ON party.id = t.\`${config.party.field}\`
       ${warehouseJoin}
       ${fiscalJoin}
      WHERE t.id = ? LIMIT 1`,
    [id],
  );
}

async function loadItems(config, id, customerId = null) {
  const codeJoin = customerId
    ? 'LEFT JOIN customer_product_codes cpc ON cpc.customer_id = ? AND cpc.product_id = i.product_id'
    : '';
  const codeSelect = customerId ? ', cpc.code AS customer_code' : '';
  const params = customerId ? [customerId, id] : [id];
  return query(
    `SELECT i.*, p.sku, p.name, p.unit, p.type AS product_type${codeSelect}
       FROM \`${config.itemTable}\` i
       JOIN products p ON p.id = i.product_id
       ${codeJoin}
      WHERE i.\`${config.itemFk}\` = ?
      ORDER BY i.id ASC`,
    params,
  );
}

function statusesFor(config, kind) {
  return config.statuses;
}

async function loadDocumentData(config, id) {
  const row = await findDoc(config, id);
  if (!row) return null;
  const items = await loadItems(config, row.id, config.party.table === 'customers' ? row[config.party.field] : null);

  let linkedOrder = null;
  if (config.linkOrder && row[config.linkOrder.field]) {
    if (config.linkOrder.table === 'sales_orders') {
      linkedOrder = await one(
        `SELECT so.*, cw.name AS warehouse_name, cw.code AS warehouse_code,
                cw.address_line1 AS warehouse_address, cw.city AS warehouse_city,
                cw.state AS warehouse_state, cw.postal_code AS warehouse_postal,
                cw.country AS warehouse_country
           FROM sales_orders so
           LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
          WHERE so.id = ? LIMIT 1`,
        [row[config.linkOrder.field]],
      );
    } else {
      linkedOrder = await one(
        `SELECT * FROM \`${config.linkOrder.table}\` WHERE id = ?`,
        [row[config.linkOrder.field]],
      );
    }
  }

  return { row, items, linkedOrder };
}

function actionsFor(config, row, locale) {
  const t = translator(locale);
  const base = `${config.basePath}/${row.id}`;
  const actions = [];
  const add = (action, value, label, tone = 'secondary', confirm = false, extra = null) =>
    actions.push({ action, value, label: t(label), tone, confirm, ...(extra || {}) });
  const link = (href, label, tone) => actions.push({ href, label: t(label), tone });

  if (config.kind === 'sales_order') {
    if (row.status === 'draft') add('status', 'confirmed', 'Confirm order', 'primary');
    if (['confirmed', 'partially_delivered'].includes(row.status)) {
      link(`/deliveries/new?sales_order_id=${row.id}`, 'Create delivery', 'primary');
      link(`/sales/new?sales_order_id=${row.id}`, 'Create invoice', 'secondary');
    }
    if (['confirmed', 'partially_delivered'].includes(row.status)) {
      add('production', '', 'Generate production orders', 'secondary');
    }
    if (!['delivered', 'cancelled'].includes(row.status)) add('status', 'cancelled', 'Cancel', 'danger', true);
  }

  if (config.kind === 'purchase_order') {
    if (row.status === 'draft') add('status', 'confirmed', 'Confirm order', 'primary');
    if (['confirmed', 'partially_received'].includes(row.status)) {
      link(`/purchases/new?purchase_order_id=${row.id}`, 'Create bill', 'secondary');
    }
    if (!['received', 'cancelled'].includes(row.status)) add('status', 'cancelled', 'Cancel', 'danger', true);
  }

  if (config.kind === 'sales_invoice') {
    if (row.status === 'draft') add('status', 'sent', 'Mark as sent', 'primary');
    if (['draft', 'sent', 'overdue'].includes(row.status)) {
      add('status', 'paid', 'Mark as paid', 'success');
    }
    if (['sent', 'overdue'].includes(row.status) && Number(row.total) - Number(row.amount_paid) > 0.005) {
      link(`/payments/new?type=customer&party_id=${row.customer_id}&invoice_id=${row.id}`, 'Record payment', 'primary');
    }
    if (!['paid', 'cancelled'].includes(row.status)) add('status', 'cancelled', 'Cancel', 'danger', true);
    link(`${base}/print`, 'Print / PDF', 'secondary');
  }

  if (config.kind === 'purchase_invoice') {
    if (row.status === 'draft') {
      add('status', 'received', 'Receive stock', 'primary', true);
      add('status', 'received', 'Mark as received (no stock)', 'secondary', true, { skipStock: true });
    }
    if (['draft', 'received', 'overdue'].includes(row.status)) add('status', 'paid', 'Mark as paid', 'success');
    if (['received', 'overdue'].includes(row.status) && Number(row.total) - Number(row.amount_paid) > 0.005) {
      link(`/payments/new?type=supplier&party_id=${row.supplier_id}&invoice_id=${row.id}`, 'Record payment', 'primary');
    }
    if (!['paid', 'cancelled'].includes(row.status)) add('status', 'cancelled', 'Cancel', 'danger', true);
    link(`${base}/print`, 'Print / PDF', 'secondary');
  }

  link(`/emails/compose?type=${config.kind}&id=${row.id}`, 'Email', 'secondary');

  return actions;
}

const TRANSITIONS = {
  sales_order: {
    draft: ['confirmed', 'cancelled'],
    confirmed: ['partially_delivered', 'delivered', 'cancelled'],
    partially_delivered: ['delivered', 'cancelled'],
    delivered: [],
    cancelled: [],
  },
  purchase_order: {
    draft: ['confirmed', 'cancelled'],
    confirmed: ['partially_received', 'received', 'cancelled'],
    partially_received: ['received', 'cancelled'],
    received: [],
    cancelled: [],
  },
  sales_invoice: {
    draft: ['sent', 'cancelled'],
    sent: ['paid', 'overdue', 'cancelled'],
    overdue: ['paid', 'cancelled'],
    paid: [],
    cancelled: [],
  },
  purchase_invoice: {
    draft: ['received', 'paid', 'cancelled'],
    received: ['paid', 'overdue', 'cancelled'],
    overdue: ['paid', 'cancelled'],
    paid: [],
    cancelled: [],
  },
};

function canTransition(kind, from, to) {
  if (from === to) return true;
  return (TRANSITIONS[kind] || {})[from]?.includes(to) || false;
}

function makeDocumentRouter(config) {
  const router = express.Router();
  const basePath = config.basePath;

  async function applyPurchaseStock(conn, invoiceId, direction, label) {
    const [rows] = await conn.query(
      `SELECT i.product_id, i.quantity, i.unit_price FROM \`${config.itemTable}\` i WHERE i.\`${config.itemFk}\` = ?`,
      [invoiceId],
    );
    for (const item of rows) {
      const qty = Number(item.quantity) * direction;
      await conn.query('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [qty, item.product_id]);
      await conn.query(
        `INSERT INTO stock_movements (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes)
         VALUES (?, 'purchase_in', ?, ?, ?, ?, ?)`,
        [item.product_id, qty, item.unit_price, 'purchase_invoice', invoiceId, label],
      );
    }
  }

  async function handleStatusChange(conn, id, fromStatus, toStatus, req, { skipStock = false } = {}) {
    if (config.hasStockPosting) {
      const [rows] = await conn.query(
        'SELECT stock_posted, stock_skipped FROM purchase_invoices WHERE id = ? FOR UPDATE',
        [id],
      );
      const posted = Boolean(rows[0] && rows[0].stock_posted);
      const skipped = Boolean(rows[0] && rows[0].stock_skipped);
      const receiving = ['received', 'paid'].includes(toStatus);
      if (receiving) {
        if (skipStock || skipped) {
          if (!skipped) {
            await conn.query(
              'UPDATE purchase_invoices SET stock_skipped = 1, stock_posted = 0 WHERE id = ?',
              [id],
            );
          }
        } else if (!posted) {
          await applyPurchaseStock(conn, id, 1, `Received via ${config.numberPrefix}-${id}`);
          await conn.query('UPDATE purchase_invoices SET stock_posted = 1, stock_skipped = 0 WHERE id = ?', [id]);
        }
      } else if (posted) {
        await applyPurchaseStock(conn, id, -1, `Stock reversal for ${config.numberPrefix}-${id}`);
        await conn.query('UPDATE purchase_invoices SET stock_posted = 0 WHERE id = ?', [id]);
      }
    }
    if (toStatus === 'paid' && config.hasAmountPaid) {
      await conn.query(`UPDATE \`${config.table}\` SET amount_paid = total WHERE id = ?`, [id]);
    }
    if (typeof config.afterStatusChange === 'function') {
      await config.afterStatusChange(conn, id, fromStatus, toStatus, req);
    }
  }

  const usesCustomerCodes = config.party.table === 'customers';

  async function loadFormData(req) {
    const partyOptions = await loadPartyOptions(config);
    const productOptions = await loadProductOptions(config);
    const customerCodes = usesCustomerCodes ? await loadCustomerCodes() : {};
    const warehouseOptions = config.customerOrder ? await loadWarehouseOptions() : [];
    const defaults = {
      [config.numberField]: '',
      [config.party.field]: '',
      [config.dateField]: todayISO(),
      [config.dueField]: addDaysISO(todayISO(), config.defaultDueDays || 14),
      discount_total: 0,
      status: config.defaultStatus || 'draft',
      notes: '',
    };
    if (config.hasAmountPaid) defaults.amount_paid = 0;
    if (config.linkOrder) defaults[config.linkOrder.field] = '';
    if (config.isInvoice) {
      defaults.document_type_code = 1;
      if (config.kind === 'sales_invoice') {
        defaults.cae = '';
        defaults.cae_expiry_date = '';
        defaults.cbu = '';
        defaults.transfer_option = '';
        defaults.payment_expiry_date = addDaysISO(todayISO(), 7);
      }
      if (config.kind === 'purchase_invoice') {
        defaults.packing_slip_no = '';
      }
    }
    if (config.customerOrder) {
      defaults[config.customerOrder.orderNoField] = '';
      defaults[config.customerOrder.warehouseField] = '';
      defaults[config.customerOrder.dockingField] = '';
      defaults[config.customerOrder.receptionField] = '';
    }

    const directParty = Number.parseInt(req.query[config.party.field], 10);
    if (directParty) defaults[config.party.field] = String(directParty);
    if (config.customerOrder && directParty) {
      const own = warehouseOptions.filter((w) => w.customerId === String(directParty));
      if (own.length === 1) defaults[config.customerOrder.warehouseField] = own[0].value;
    }

    const prefillOrderId = Number.parseInt(
      req.query[config.linkOrder ? config.linkOrder.queryParam : '__none'],
      10,
    );
    if (config.linkOrder && prefillOrderId) {
      const order = await one(
        `SELECT t.*, party.company_name AS party_name FROM \`${config.linkOrder.table}\` t
           JOIN \`${config.party.table}\` party ON party.id = t.\`${config.party.field}\`
          WHERE t.id = ? LIMIT 1`,
        [prefillOrderId],
      );
      if (order) {
        defaults[config.party.field] = String(order[config.party.field]);
        defaults[config.linkOrder.field] = order.id;
        defaults.discount_total = order.discount_total;
        defaults.notes = order.notes || '';
        const items = await query(
          `SELECT i.* FROM \`${config.linkOrder.itemTable}\` i WHERE i.\`${config.linkOrder.itemFk}\` = ? ORDER BY i.id`,
          [order.id],
        );
        return { partyOptions, productOptions, customerCodes, warehouseOptions, defaults, items, prefill: order };
      }
    }

    const fallbackItems = [
      { product_id: '', description: '', quantity: 1, unit_price: 0, tax_rate: config.defaultTaxRate, sku: '', name: '', unit: '' },
    ];
    return { partyOptions, productOptions, customerCodes, warehouseOptions, defaults, items: fallbackItems, prefill: null };
  }

  // ---------------------------------------------------------------- index
  router.get('/', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const search = String(req.query.q || '').trim();
      const status = String(req.query.status || '');
      const where = [];
      const params = [];
      if (search) {
        const customerOrderSearch = config.customerOrder ? ' OR t.customer_order_no LIKE ?' : '';
        where.push(`(t.\`${config.numberField}\` LIKE ? OR party.company_name LIKE ? OR t.notes LIKE ?${customerOrderSearch})`);
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        if (config.customerOrder) params.push(`%${search}%`);
      }
      if (status) {
        where.push('t.status = ?');
        params.push(status);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const perPage = 12;
      const total = Number(
        (await require('../db').scalar(
          `SELECT COUNT(*) FROM \`${config.table}\` t JOIN \`${config.party.table}\` party ON party.id = t.\`${config.party.field}\` ${whereSql}`,
          params,
        )) || 0,
      );
      const pag = pagination(total, page, perPage);
      const linkJoin = config.linkOrder
        ? `LEFT JOIN \`${config.linkOrder.table}\` linked ON linked.id = t.\`${config.linkOrder.field}\``
        : '';
      const linkSelect = config.linkOrder ? ', linked.order_no AS linked_order_no' : '';
      const linkWarehouseJoin = !config.customerOrder && config.linkOrder && config.linkOrder.table === 'sales_orders'
        ? 'LEFT JOIN customer_warehouses lw ON lw.id = linked.customer_warehouse_id'
        : '';
      const linkCustomerOrderSelect = linkWarehouseJoin
        ? ', linked.customer_order_no AS linked_customer_order_no, lw.name AS linked_warehouse_name, lw.code AS linked_warehouse_code'
        : '';
      const warehouseJoin = config.customerOrder
        ? 'LEFT JOIN customer_warehouses cw ON cw.id = t.customer_warehouse_id'
        : '';
      const warehouseSelect = config.customerOrder
        ? ', cw.name AS warehouse_name, cw.code AS warehouse_code'
        : '';
      const fiscalJoin = config.isInvoice
        ? 'LEFT JOIN fiscal_document_types fdt ON fdt.code = t.document_type_code'
        : '';
      const fiscalSelect = config.isInvoice ? ', fdt.name AS document_type_name' : '';
      const rows = await query(
        `SELECT t.*, party.company_name AS party_name${linkSelect}${linkCustomerOrderSelect}${warehouseSelect}${fiscalSelect}
           FROM \`${config.table}\` t
           JOIN \`${config.party.table}\` party ON party.id = t.\`${config.party.field}\`
           ${linkJoin}
           ${linkWarehouseJoin}
           ${warehouseJoin}
           ${fiscalJoin}
           ${whereSql}
          ORDER BY t.\`${config.dateField}\` DESC, t.id DESC
          LIMIT ? OFFSET ?`,
        [...params, perPage, (pag.page - 1) * perPage],
      );

      const openStatuses = config.openStatuses || [];
      let openValue = 0;
      let openCount = 0;
      let totalValue = 0;
      if (openStatuses.length) {
        const stats = await one(
          `SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS v FROM \`${config.table}\` WHERE status IN (${openStatuses
            .map(() => '?')
            .join(',')})`,
          openStatuses,
        );
        openCount = Number(stats.c);
        openValue = Number(stats.v);
      }
      const totals = await one(
        `SELECT COALESCE(SUM(total),0) AS v FROM \`${config.table}\` WHERE status NOT IN ('cancelled','draft')`,
      );
      totalValue = Number(totals.v);

      res.render('documents/index', {
        title: lc.title,
        active: config.active,
        breadcrumbs: [{ label: lc.title }],
        doc: { ...lc, statuses: statusesFor(config) },
        rows,
        pagination: pag,
        search,
        activeStatus: status,
        stats: {
          openCount,
          openValue,
          totalValue,
          label: req.t(config.kind.includes('invoice') ? 'Invoiced (non-draft)' : 'Open value'),
          openLabel: req.t(config.kind.includes('invoice') ? 'Unpaid invoices' : 'Open orders'),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ------------------------------------------------------------------ new
  router.get('/new', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const { partyOptions, productOptions, customerCodes, warehouseOptions, defaults, items, prefill } = await loadFormData(req);
      const invoiceOptions = await loadInvoiceFormOptions(config);
      const settings = require('../lib/settings');
      const appSettings = await settings.getSettings();
      res.render('documents/form', {
        title: lc.newLabel,
        active: config.active,
        breadcrumbs: [{ label: lc.title, href: basePath }, { label: lc.newLabel }],
        doc: { ...lc, statuses: statusesFor(config) },
        partyOptions,
        productOptions,
        customerCodes,
        warehouseOptions,
        ...invoiceOptions,
        row: defaults,
        items,
        errors: {},
        itemErrors: [],
        mode: 'create',
        action: basePath,
        defaultTaxRate: Number(appSettings.default_tax_rate || 0),
        prefill,
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------------------- create
  router.post('/', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const appSettings = await require('../lib/settings').getSettings();
      const defaultTaxRate = Number(appSettings.default_tax_rate || 0);
      const partyId = Number.parseInt(req.body[config.party.field], 10);
      const skipStock = Boolean(config.hasStockPosting && req.body.skip_stock);
      const items = parseItems(req.body, config, defaultTaxRate);
      const errors = {};
      const itemErrors = [];
      const date = (req.body[config.dateField] || '').slice(0, 10);
      const dueDate = req.body[config.dueField] ? req.body[config.dueField].slice(0, 10) : null;

      const invoiceNumber = await validateInvoiceNumber(config, req.body, req);
      Object.assign(errors, invoiceNumber.errors);
      const fiscal = await validateFiscalFields(config, req.body, req);
      Object.assign(errors, fiscal.errors);
      const fiscalCode = fiscal.values.document_type_code;

      if (!partyId) errors[config.party.field] = req.t('{party} is required.', { party: lc.party.label });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors[config.dateField] = req.t('A valid date is required.');
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) errors[config.dueField] = req.t('Invalid date.');
      if (items.length === 0) {
        itemErrors.push(req.t('Add at least one line item with a quantity greater than zero.'));
      }
      if (!config.statuses.includes(req.body.status)) errors.status = req.t('Invalid status.');

      let deliveryIds = [];
      let relatedInvoiceIds = [];
      if (config.isInvoice && partyId) {
        if (config.deliveryLinkTable && !isNoteCode(fiscalCode)) {
          const checked = await validateDeliveryIds(parseIdList(req.body.delivery_ids), partyId);
          if (checked.invalid) {
            errors.delivery_ids = req.t('Select only packing slips that belong to the selected customer.');
          } else {
            deliveryIds = checked.ids;
          }
        }
        if (config.fiscalRelationTable && isNoteCode(fiscalCode)) {
          const checked = await validateRelatedInvoiceIds(parseIdList(req.body.note_invoice_ids), config, partyId, 0);
          if (checked.invalid) {
            errors.note_invoice_ids = req.t('Select only regular invoices for the same party.');
          } else {
            relatedInvoiceIds = checked.ids;
          }
        }
      }

      let warehouseId = 0;
      let customerOrderValues = null;
      if (config.customerOrder) {
        const co = config.customerOrder;
        customerOrderValues = {
          [co.orderNoField]: String(req.body[co.orderNoField] || '').trim().slice(0, 60) || null,
          [co.dockingField]: String(req.body[co.dockingField] || '').trim().slice(0, 60) || null,
          [co.receptionField]: normalizeDateTime(req.body[co.receptionField]),
        };
        if (String(req.body[co.receptionField] || '').trim() && !customerOrderValues[co.receptionField]) {
          errors[co.receptionField] = req.t('Enter a valid reception date and time.');
        }
        warehouseId = Number.parseInt(req.body[co.warehouseField], 10) || 0;
        if (partyId && warehouseId) {
          const selectedWarehouse = await one(
            'SELECT id, customer_id FROM customer_warehouses WHERE id = ? LIMIT 1',
            [warehouseId],
          );
          if (!selectedWarehouse || Number(selectedWarehouse.customer_id) !== partyId) {
            errors[co.warehouseField] = req.t('Choose a destination warehouse that belongs to the selected customer.');
            warehouseId = 0;
          }
        }
      }

      const totals = computeTotals(items, req.body.discount_total);
      let amountPaid = 0;
      if (config.hasAmountPaid) {
        amountPaid = Math.max(0, Math.min(toNumber(req.body.amount_paid, 0), totals.total));
      }
      if (Object.keys(errors).length || itemErrors.length) {
        const { partyOptions, productOptions, customerCodes, warehouseOptions } = await loadFormData({ query: {} });
        const invoiceOptions = await loadInvoiceFormOptions(config, { posted: req.body });
        return res.status(422).render('documents/form', {
          title: lc.newLabel,
          active: config.active,
          breadcrumbs: [{ label: lc.title, href: basePath }, { label: lc.newLabel }],
          doc: { ...lc, statuses: statusesFor(config) },
          partyOptions,
          productOptions,
          customerCodes,
          warehouseOptions,
          ...invoiceOptions,
          row: { ...req.body, status: req.body.status || 'draft' },
          items: items.length ? items : [{}],
          errors,
          itemErrors,
          mode: 'create',
          action: basePath,
          defaultTaxRate,
          prefill: null,
        });
      }

      const insertedId = await withTransaction(async (conn) => {
        const [partyRows] = await conn.query(
          `SELECT id FROM \`${config.party.table}\` WHERE id = ?`,
          [partyId],
        );
        if (!partyRows.length) {
          throw Object.assign(
            new Error(req.t('Selected {party} does not exist.', { party: lc.party.label })),
            { status: 422 },
          );
        }

        if (config.customerOrder && !warehouseId) {
          warehouseId = await ensureWarehouseForCustomer(conn, partyId);
        }

        const number = config.isInvoice
          ? invoiceNumber.value
          : await nextNumber({
              prefix: config.numberPrefix,
              table: config.table,
              column: config.numberField,
              date,
              conn,
            });
        const status = req.body.status || 'draft';
        const customerOrderColumns = config.customerOrder
          ? `, \`${config.customerOrder.orderNoField}\`, \`${config.customerOrder.warehouseField}\`, \`${config.customerOrder.dockingField}\`, \`${config.customerOrder.receptionField}\``
          : '';
        const customerOrderPlaceholders = config.customerOrder ? ', ?, ?, ?, ?' : '';
        const fiscalColumns = config.isInvoice
          ? `, document_type_code${config.kind === 'sales_invoice' ? ', cae, cae_expiry_date, cbu, transfer_option, payment_expiry_date' : ''}${config.kind === 'purchase_invoice' ? ', packing_slip_no' : ''}`
          : '';
        const fiscalPlaceholders = config.isInvoice
          ? `, ?${config.kind === 'sales_invoice' ? ', ?, ?, ?, ?, ?' : ''}${config.kind === 'purchase_invoice' ? ', ?' : ''}`
          : '';

        const [result] = await conn.query(
          `INSERT INTO \`${config.table}\` (\`${config.numberField}\`, \`${config.party.field}\`, \`${config.dateField}\`, \`${config.dueField}\`, status, subtotal, discount_total, tax_total, total, notes, created_by${config.hasAmountPaid ? ', amount_paid' : ''}${config.linkOrder ? `, \`${config.linkOrder.field}\`` : ''}${customerOrderColumns}${fiscalColumns})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${config.hasAmountPaid ? ', ?' : ''}${config.linkOrder ? ', ?' : ''}${customerOrderPlaceholders}${fiscalPlaceholders})`,
          [
            number,
            partyId,
            date,
            dueDate,
            status,
            totals.subtotal,
            totals.discount_total,
            totals.tax_total,
            totals.total,
            (req.body.notes || '').slice(0, 5000) || null,
            req.session.user.id,
            ...(config.hasAmountPaid ? [status === 'paid' ? totals.total : amountPaid] : []),
            ...(config.linkOrder ? [Number.parseInt(req.body[config.linkOrder.field], 10) || null] : []),
            ...(config.customerOrder
              ? [
                  customerOrderValues[config.customerOrder.orderNoField],
                  warehouseId,
                  customerOrderValues[config.customerOrder.dockingField],
                  customerOrderValues[config.customerOrder.receptionField],
                ]
              : []),
            ...(config.isInvoice ? [fiscal.values.document_type_code] : []),
            ...(config.kind === 'sales_invoice'
              ? [
                  fiscal.values.cae,
                  fiscal.values.cae_expiry_date,
                  fiscal.values.cbu,
                  fiscal.values.transfer_option,
                  fiscal.values.payment_expiry_date,
                ]
              : []),
            ...(config.kind === 'purchase_invoice' ? [fiscal.values.packing_slip_no] : []),
          ],
        );
        const id = result.insertId;

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await conn.query(
            `INSERT INTO \`${config.itemTable}\` (\`${config.itemFk}\`, product_id, description, quantity, unit_price, tax_rate, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, it.product_id, it.description, it.quantity, it.unit_price, it.tax_rate, it.line_total],
          );
        }

        await saveInvoiceLinks(conn, config, id, {
          fiscalCode: fiscal.values.document_type_code,
          deliveryIds,
          relatedInvoiceIds,
        });

        if (config.hasStockPosting && ['received', 'paid'].includes(status)) {
          if (skipStock) {
            await conn.query(
              'UPDATE purchase_invoices SET stock_skipped = 1, stock_posted = 0 WHERE id = ?',
              [id],
            );
          } else {
            await applyPurchaseStock(conn, id, 1, `Received via ${number}`);
            await conn.query('UPDATE purchase_invoices SET stock_posted = 1, stock_skipped = 0 WHERE id = ?', [id]);
          }
        }

        if (typeof config.afterCreate === 'function') await config.afterCreate(conn, id, req);
        return id;
      });

      req.flash('success', '{item} created successfully.', { item: lc.singular });
      res.redirect(`${basePath}/${insertedId}`);
    } catch (err) {
      if (err.status === 422) {
        req.flash('error', err.message);
        return res.redirect(`${basePath}/new`);
      }
      if (err.code === 'ER_DUP_ENTRY') {
        req.flash('error', 'This invoice number already exists.');
        return res.redirect(`${basePath}/new`);
      }
      next(err);
    }
  });

  // ---------------------------------------------------------------- show
  router.get('/:id(\\d+)', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const row = await findDoc(config, req.params.id);
      if (!row) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }
      const items = await loadItems(config, row.id, usesCustomerCodes ? row[config.party.field] : null);
      const invoiceAssociations = await loadInvoiceAssociations(config, row);

      let linkedOrder = null;
      if (config.linkOrder && row[config.linkOrder.field]) {
        if (config.linkOrder.table === 'sales_orders') {
          linkedOrder = await one(
            `SELECT so.*, cw.name AS warehouse_name, cw.code AS warehouse_code,
                    cw.address_line1 AS warehouse_address, cw.city AS warehouse_city,
                    cw.state AS warehouse_state, cw.postal_code AS warehouse_postal,
                    cw.country AS warehouse_country
               FROM sales_orders so
               LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
              WHERE so.id = ? LIMIT 1`,
            [row[config.linkOrder.field]],
          );
        } else {
          linkedOrder = await one(
            `SELECT * FROM \`${config.linkOrder.table}\` WHERE id = ?`,
            [row[config.linkOrder.field]],
          );
        }
      }

      let deliveries = [];
      let invoices = [];
      let productionOrders = [];
      if (config.kind === 'sales_order') {
        deliveries = await query(
          `SELECT d.*, (SELECT COUNT(*) FROM delivery_items di WHERE di.delivery_id = d.id) AS item_count
             FROM deliveries d WHERE d.sales_order_id = ? ORDER BY d.delivery_date DESC`,
          [row.id],
        );
        invoices = await query(
          'SELECT * FROM sales_invoices WHERE sales_order_id = ? ORDER BY invoice_date DESC',
          [row.id],
        );
        productionOrders = await query(
          `SELECT po.*,
                  (SELECT COUNT(*) FROM production_order_lines l WHERE l.production_order_id = po.id) AS line_count,
                  (SELECT p.name FROM production_order_lines l
                     JOIN products p ON p.id = l.product_id
                    WHERE l.production_order_id = po.id
                    ORDER BY l.sort_order, l.id LIMIT 1) AS first_product_name
             FROM production_orders po
            WHERE po.sales_order_id = ?
            ORDER BY po.id DESC`,
          [row.id],
        );
      }
      if (config.kind === 'purchase_order') {
        invoices = await query(
          'SELECT * FROM purchase_invoices WHERE purchase_order_id = ? ORDER BY invoice_date DESC',
          [row.id],
        );
      }

      res.render('documents/show', {
        title: row[config.numberField],
        active: config.active,
        breadcrumbs: [{ label: lc.title, href: basePath }, { label: row[config.numberField] }],
        doc: { ...lc, statuses: statusesFor(config) },
        row,
        items,
        linkedOrder,
        ...invoiceAssociations,
        deliveries,
        invoices,
        productionOrders,
        actions: actionsFor(config, row, req.locale),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------- edit
  router.get('/:id(\\d+)/edit', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const row = await findDoc(config, req.params.id);
      if (!row) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }
      if (config.lockedStatuses && config.lockedStatuses.includes(row.status)) {
        req.flash('error', '{item} is {status} and can no longer be edited.', {
          item: lc.singular,
          status: require('../lib/helpers').statusInfo(row.status, req.locale).label,
        });
        return res.redirect(`${basePath}/${row.id}`);
      }
      if (config.kind === 'sales_order') {
        const delivered = await require('../db').scalar(
          'SELECT COUNT(*) FROM deliveries WHERE sales_order_id = ? AND status <> "cancelled"',
          [row.id],
        );
        if (Number(delivered) > 0 && row.status !== 'draft') {
          req.flash('error', 'This order already has deliveries. Cancel the delivery first or create a new order.');
          return res.redirect(`${basePath}/${row.id}`);
        }
      }

      const { partyOptions, productOptions, customerCodes, warehouseOptions } = await loadFormData({ query: {} });
      const items = await loadItems(config, row.id, usesCustomerCodes ? row[config.party.field] : null);
      const invoiceOptions = await loadInvoiceFormOptions(config, { existing: row });
      const appSettings = await require('../lib/settings').getSettings();
      res.render('documents/form', {
        title: lc.editLabel,
        active: config.active,
        breadcrumbs: [
          { label: lc.title, href: basePath },
          { label: row[config.numberField], href: `${basePath}/${row.id}` },
          { label: req.t('Edit') },
        ],
        doc: { ...lc, statuses: statusesFor(config) },
        partyOptions,
        productOptions,
        customerCodes,
        warehouseOptions,
        ...invoiceOptions,
        row,
        items,
        errors: {},
        itemErrors: [],
        mode: 'edit',
        action: `${basePath}/${row.id}`,
        defaultTaxRate: Number(appSettings.default_tax_rate || 0),
        prefill: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------- update
  router.post('/:id(\\d+)', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const existing = await findDoc(config, req.params.id);
      if (!existing) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }

      if (config.lockedStatuses && config.lockedStatuses.includes(existing.status)) {
        req.flash('error', '{item} is {status} and can no longer be edited.', {
          item: lc.singular,
          status: require('../lib/helpers').statusInfo(existing.status, req.locale).label,
        });
        return res.redirect(`${basePath}/${existing.id}`);
      }

      let lockedPaymentAmount = null;
      if (config.hasAmountPaid && config.kind.includes('invoice')) {
        const invoiceType = config.kind === 'sales_invoice' ? 'sales' : 'purchase';
        const linked = await one(
          'SELECT COUNT(*) AS count FROM payment_allocations WHERE invoice_type = ? AND invoice_id = ?',
          [invoiceType, existing.id],
        );
        if (Number(linked.count) > 0) {
          if (req.body.status !== existing.status) {
            req.flash('error', 'This invoice has payment allocations. Reverse the payment before changing its status.');
            return res.redirect(`${basePath}/${existing.id}`);
          }
          if (Number.parseInt(req.body[config.party.field], 10) !== Number(existing[config.party.field])) {
            req.flash('error', 'This invoice has payment allocations. Reverse the payment before changing its party.');
            return res.redirect(`${basePath}/${existing.id}`);
          }
          lockedPaymentAmount = Number(existing.amount_paid || 0);
        }
      }
      if (config.kind === 'sales_order') {
        const delivered = await require('../db').scalar(
          'SELECT COUNT(*) FROM deliveries WHERE sales_order_id = ? AND status <> "cancelled"',
          [existing.id],
        );
        if (Number(delivered) > 0 && existing.status !== 'draft') {
          req.flash('error', 'This order already has deliveries. Cancel the delivery first or create a new order.');
          return res.redirect(`${basePath}/${existing.id}`);
        }
      }

      const appSettings = await require('../lib/settings').getSettings();
      const defaultTaxRate = Number(appSettings.default_tax_rate || 0);
      const partyId = Number.parseInt(req.body[config.party.field], 10);
      const skipStock = Boolean(config.hasStockPosting && req.body.skip_stock);
      const items = parseItems(req.body, config, defaultTaxRate);
      const errors = {};
      const itemErrors = [];
      const date = (req.body[config.dateField] || '').slice(0, 10);
      const dueDate = req.body[config.dueField] ? req.body[config.dueField].slice(0, 10) : null;

      const invoiceNumber = await validateInvoiceNumber(config, req.body, req, existing);
      Object.assign(errors, invoiceNumber.errors);
      const fiscal = await validateFiscalFields(config, req.body, req, existing);
      Object.assign(errors, fiscal.errors);
      const fiscalCode = fiscal.values.document_type_code;

      if (!partyId) errors[config.party.field] = req.t('{party} is required.', { party: lc.party.label });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors[config.dateField] = req.t('A valid date is required.');
      if (items.length === 0) {
        itemErrors.push(req.t('Add at least one line item with a quantity greater than zero.'));
      }
      if (!config.statuses.includes(req.body.status)) errors.status = req.t('Invalid status.');

      let deliveryIds = [];
      let relatedInvoiceIds = [];
      if (config.isInvoice && partyId) {
        if (config.deliveryLinkTable && !isNoteCode(fiscalCode)) {
          const checked = await validateDeliveryIds(parseIdList(req.body.delivery_ids), partyId);
          if (checked.invalid) {
            errors.delivery_ids = req.t('Select only packing slips that belong to the selected customer.');
          } else {
            deliveryIds = checked.ids;
          }
        }
        if (config.fiscalRelationTable && isNoteCode(fiscalCode)) {
          const checked = await validateRelatedInvoiceIds(
            parseIdList(req.body.note_invoice_ids),
            config,
            partyId,
            existing.id,
          );
          if (checked.invalid) {
            errors.note_invoice_ids = req.t('Select only regular invoices for the same party.');
          } else {
            relatedInvoiceIds = checked.ids;
          }
        }
      }

      let warehouseId = 0;
      let customerOrderValues = null;
      if (config.customerOrder) {
        const co = config.customerOrder;
        customerOrderValues = {
          [co.orderNoField]: String(req.body[co.orderNoField] || '').trim().slice(0, 60) || null,
          [co.dockingField]: String(req.body[co.dockingField] || '').trim().slice(0, 60) || null,
          [co.receptionField]: normalizeDateTime(req.body[co.receptionField]),
        };
        if (String(req.body[co.receptionField] || '').trim() && !customerOrderValues[co.receptionField]) {
          errors[co.receptionField] = req.t('Enter a valid reception date and time.');
        }
        const postedWarehouse = Number.parseInt(req.body[co.warehouseField], 10) || 0;
        warehouseId = postedWarehouse || Number(existing[co.warehouseField]) || 0;
        if (partyId && warehouseId) {
          const selectedWarehouse = await one(
            'SELECT id, customer_id FROM customer_warehouses WHERE id = ? LIMIT 1',
            [warehouseId],
          );
          if (!selectedWarehouse || Number(selectedWarehouse.customer_id) !== partyId) {
            errors[co.warehouseField] = req.t('Choose a destination warehouse that belongs to the selected customer.');
            warehouseId = 0;
          }
        }
      }

      const totals = computeTotals(items, req.body.discount_total);
      if (lockedPaymentAmount !== null && totals.total < lockedPaymentAmount - 0.005) {
        req.flash('error', 'The invoice total cannot be less than the amount already paid.');
        return res.redirect(`${basePath}/${existing.id}`);
      }
      if (Object.keys(errors).length || itemErrors.length) {
        const { partyOptions, productOptions, customerCodes, warehouseOptions } = await loadFormData({ query: {} });
        const invoiceOptions = await loadInvoiceFormOptions(config, { existing, posted: req.body });
        return res.status(422).render('documents/form', {
          title: lc.editLabel,
          active: config.active,
          breadcrumbs: [
            { label: lc.title, href: basePath },
            { label: existing[config.numberField], href: `${basePath}/${existing.id}` },
            { label: req.t('Edit') },
          ],
          doc: { ...lc, statuses: statusesFor(config) },
          partyOptions,
          productOptions,
          customerCodes,
          warehouseOptions,
          ...invoiceOptions,
          row: { ...existing, ...req.body },
          items: items.length ? items : [{}],
          errors,
          itemErrors,
          mode: 'edit',
          action: `${basePath}/${existing.id}`,
          defaultTaxRate,
          prefill: null,
        });
      }

      if (lockedPaymentAmount !== null && config.isInvoice && invoiceNumber.value !== existing[config.numberField]) {
        req.flash('error', 'This invoice has payment allocations. Reverse the payment before changing its number.');
        return res.redirect(`${basePath}/${existing.id}`);
      }

      if (!canTransition(config.kind, existing.status, req.body.status) && existing.status !== req.body.status) {
        const statusInfo = require('../lib/helpers').statusInfo;
        req.flash('error', 'Cannot change status from {from} to {to}.', {
          from: statusInfo(existing.status, req.locale).label,
          to: statusInfo(req.body.status, req.locale).label,
        });
        return res.redirect(`${basePath}/${existing.id}`);
      }

      await withTransaction(async (conn) => {
        if (config.customerOrder && !warehouseId) {
          warehouseId = await ensureWarehouseForCustomer(conn, partyId);
        }
        const customerOrderSet = config.customerOrder
          ? `, \`${config.customerOrder.orderNoField}\` = ?, \`${config.customerOrder.warehouseField}\` = ?, \`${config.customerOrder.dockingField}\` = ?, \`${config.customerOrder.receptionField}\` = ?`
          : '';
        const numberSet = config.isInvoice ? `, \`${config.numberField}\` = ?` : '';
        const fiscalSet = config.isInvoice
          ? `, document_type_code = ?${config.kind === 'sales_invoice' ? ', cae = ?, cae_expiry_date = ?, cbu = ?, transfer_option = ?, payment_expiry_date = ?' : ''}${config.kind === 'purchase_invoice' ? ', packing_slip_no = ?' : ''}`
          : '';
        await conn.query(
          `UPDATE \`${config.table}\` SET \`${config.party.field}\` = ?, \`${config.dateField}\` = ?, \`${config.dueField}\` = ?, status = ?, subtotal = ?, discount_total = ?, tax_total = ?, total = ?, notes = ?${config.hasAmountPaid ? ', amount_paid = ?' : ''}${numberSet}${customerOrderSet}${fiscalSet} WHERE id = ?`,
          [
            partyId,
            date,
            dueDate,
            req.body.status,
            totals.subtotal,
            totals.discount_total,
            totals.tax_total,
            totals.total,
            (req.body.notes || '').slice(0, 5000) || null,
            ...(config.hasAmountPaid
              ? [
                  lockedPaymentAmount !== null
                    ? lockedPaymentAmount
                    : req.body.status === 'paid'
                      ? totals.total
                      : Math.max(0, Math.min(toNumber(req.body.amount_paid, 0), totals.total)),
                ]
              : []),
            ...(config.isInvoice ? [invoiceNumber.value] : []),
            ...(config.customerOrder
              ? [
                  customerOrderValues[config.customerOrder.orderNoField],
                  warehouseId,
                  customerOrderValues[config.customerOrder.dockingField],
                  customerOrderValues[config.customerOrder.receptionField],
                ]
              : []),
            ...(config.isInvoice ? [fiscal.values.document_type_code] : []),
            ...(config.kind === 'sales_invoice'
              ? [
                  fiscal.values.cae,
                  fiscal.values.cae_expiry_date,
                  fiscal.values.cbu,
                  fiscal.values.transfer_option,
                  fiscal.values.payment_expiry_date,
                ]
              : []),
            ...(config.kind === 'purchase_invoice' ? [fiscal.values.packing_slip_no] : []),
            existing.id,
          ],
        );

        await conn.query(`DELETE FROM \`${config.itemTable}\` WHERE \`${config.itemFk}\` = ?`, [existing.id]);
        for (const it of items) {
          await conn.query(
            `INSERT INTO \`${config.itemTable}\` (\`${config.itemFk}\`, product_id, description, quantity, unit_price, tax_rate, line_total)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [existing.id, it.product_id, it.description, it.quantity, it.unit_price, it.tax_rate, it.line_total],
          );
        }

        await saveInvoiceLinks(conn, config, existing.id, {
          fiscalCode: fiscal.values.document_type_code,
          deliveryIds,
          relatedInvoiceIds,
        });

        if (existing.status !== req.body.status) {
          await handleStatusChange(conn, existing.id, existing.status, req.body.status, req, { skipStock });
        }
        if (typeof config.afterUpdate === 'function') await config.afterUpdate(conn, existing, req);
      });

      req.flash('success', '{item} updated successfully.', { item: lc.singular });
      res.redirect(`${basePath}/${existing.id}`);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        req.flash('error', 'This invoice number already exists.');
        return res.redirect(`${basePath}/${existing.id}/edit`);
      }
      next(err);
    }
  });

  // -------------------------------------------------------------- status
  router.post('/:id(\\d+)/status', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const row = await findDoc(config, req.params.id);
      if (!row) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }
      const target = req.body.status;
      const skipStock = Boolean(config.hasStockPosting && req.body.skip_stock);
      if (!config.statuses.includes(target)) {
        req.flash('error', 'Unknown status.');
        return res.redirect(`${basePath}/${row.id}`);
      }
      if (!canTransition(config.kind, row.status, target)) {
        const statusInfo = require('../lib/helpers').statusInfo;
        req.flash('error', 'Cannot change status from {from} to {to}.', {
          from: statusInfo(row.status, req.locale).label,
          to: statusInfo(target, req.locale).label,
        });
        return res.redirect(`${basePath}/${row.id}`);
      }
      if (target === 'cancelled' && config.kind.includes('invoice')) {
        const invoiceType = config.kind === 'sales_invoice' ? 'sales' : 'purchase';
        const linked = await one(
          'SELECT COUNT(*) AS count FROM payment_allocations WHERE invoice_type = ? AND invoice_id = ?',
          [invoiceType, row.id],
        );
        if (Number(linked.count) > 0) {
          req.flash('error', 'This invoice has payment allocations. Reverse the payment before cancelling the invoice.');
          return res.redirect(`${basePath}/${row.id}`);
        }
      }

      await withTransaction(async (conn) => {
        await conn.query('UPDATE `' + config.table + '` SET status = ? WHERE id = ?', [target, row.id]);
        await handleStatusChange(conn, row.id, row.status, target, req, { skipStock });
        if (config.kind === 'sales_order' && target === 'delivered') {
          await conn.query('UPDATE sales_order_items SET delivered_qty = quantity WHERE order_id = ?', [row.id]);
        }
        if (config.kind === 'purchase_order' && target === 'received') {
          await conn.query('UPDATE purchase_order_items SET received_qty = quantity WHERE order_id = ?', [row.id]);
        }
      });

      req.flash('success', '{item} marked as {status}.', {
        item: lc.singular,
        status: require('../lib/helpers').statusInfo(target, req.locale).label,
      });
      res.redirect(`${basePath}/${row.id}`);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------- delete
  router.post('/:id(\\d+)/delete', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const row = await findDoc(config, req.params.id);
      if (!row) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }
      if (!['draft', 'cancelled'].includes(row.status)) {
        req.flash('error', 'Only draft or cancelled documents can be deleted. Cancel it first.');
        return res.redirect(`${basePath}/${row.id}`);
      }
      await require('../db').getPool().query(`DELETE FROM \`${config.table}\` WHERE id = ?`, [row.id]);
      req.flash('success', '{item} deleted.', { item: lc.singular });
      res.redirect(basePath);
    } catch (err) {
      if (err.code === 'ER_ROW_IS_REFERENCED_2') {
        req.flash('error', 'This document is referenced by other records and cannot be deleted.');
        return res.redirect(`${basePath}/${req.params.id}`);
      }
      next(err);
    }
  });

  // -------------------------------------------------------------- print
  router.get('/:id(\\d+)/print', async (req, res, next) => {
    try {
      const lc = localizeDocConfig(config, req.locale);
      const row = await findDoc(config, req.params.id);
      if (!row) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }
      const items = await loadItems(config, row.id, usesCustomerCodes ? row[config.party.field] : null);
      let linkedOrder = null;
      if (config.linkOrder && row[config.linkOrder.field]) {
        if (config.linkOrder.table === 'sales_orders') {
          linkedOrder = await one(
            `SELECT so.*, cw.name AS warehouse_name, cw.code AS warehouse_code,
                    cw.address_line1 AS warehouse_address, cw.city AS warehouse_city,
                    cw.state AS warehouse_state, cw.postal_code AS warehouse_postal,
                    cw.country AS warehouse_country
               FROM sales_orders so
               LEFT JOIN customer_warehouses cw ON cw.id = so.customer_warehouse_id
              WHERE so.id = ? LIMIT 1`,
            [row[config.linkOrder.field]],
          );
        } else {
          linkedOrder = await one(
            `SELECT * FROM \`${config.linkOrder.table}\` WHERE id = ?`,
            [row[config.linkOrder.field]],
          );
        }
      }
      const settings = await require('../lib/settings').getSettings();
      const invoiceAssociations = await loadInvoiceAssociations(config, row);
      res.render('documents/print', {
        layout: false,
        title: `${lc.singular} ${row[config.numberField]}`,
        doc: lc,
        row,
        items,
        linkedOrder,
        ...invoiceAssociations,
        settings,
        money: (v) => formatMoney(v, settings.currency || 'USD', req.locale),
      });
    } catch (err) {
      next(err);
    }
  });

  // --------------------------------------------------- generate production
  if (config.kind === 'sales_order') {
    router.post('/:id(\\d+)/production', async (req, res, next) => {
      try {
        const { createProductionFromSalesOrder } = require('../lib/production');
        const result = await createProductionFromSalesOrder(Number(req.params.id), req.session.user.id);
        if (result.created === 0) {
          req.flash('error', result.message || 'No production orders were created.');
        } else if (result.skipped.length) {
          req.flash('success', 'Production order created. Skipped: {items}.', {
            items: result.skipped.join(', '),
          });
        } else {
          req.flash(
            'success',
            result.created === 1 ? '{count} production order created.' : '{count} production orders created.',
            { count: result.created },
          );
        }
        res.redirect(`${basePath}/${req.params.id}`);
      } catch (err) {
        if (err.status === 422) {
          req.flash('error', err.message);
          return res.redirect(`${basePath}/${req.params.id}`);
        }
        next(err);
      }
    });
  }

  return router;
}

module.exports = {
  makeDocumentRouter,
  loadDocumentData,
  localizeDocConfig,
  loadProductOptions,
  loadPartyOptions,
  computeTotals,
};
