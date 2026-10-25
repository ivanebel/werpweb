'use strict';

const { translator } = require('./i18n');
const { forLocale } = require('./helpers');
const { getSettings } = require('./settings');
const { renderEmail } = require('./email');
const DOCUMENT_TYPES = require('./documentTypes');
const { loadDocumentData, localizeDocConfig } = require('../routes/documents');
const paymentRoutes = require('../routes/payments');
const deliveryRoutes = require('../routes/deliveries');

const TYPES = {
  purchase_order: {
    view: 'document',
    configKey: 'purchase_order',
    label: 'Purchase Order',
    showPath: (id) => `/purchase-orders/${id}`,
  },
  purchase_invoice: {
    view: 'document',
    configKey: 'purchase_invoice',
    label: 'Purchase Invoice',
    showPath: (id) => `/purchases/${id}`,
  },
  sales_order: {
    view: 'document',
    configKey: 'sales_order',
    label: 'Sales Order',
    showPath: (id) => `/sales-orders/${id}`,
  },
  sales_invoice: {
    view: 'document',
    configKey: 'sales_invoice',
    label: 'Sales Invoice',
    showPath: (id) => `/sales/${id}`,
  },
  supplier_payment: {
    view: 'payment',
    label: 'Supplier payment order',
    showPath: (id) => `/payments/${id}`,
  },
  customer_payment: {
    view: 'payment',
    label: 'Customer payment order',
    showPath: (id) => `/payments/${id}`,
  },
  delivery: {
    view: 'delivery',
    label: 'Delivery note',
    showPath: (id) => `/deliveries/${id}`,
  },
};

function emailLabel(type, locale) {
  const def = TYPES[type];
  if (!def) return type;
  return translator(locale)(def.label);
}

function defaultGreeting(t, contact) {
  return contact ? t('Dear {name},', { name: contact }) : t('Hello,');
}

function defaultMessage(t, label, number, contact) {
  return `${defaultGreeting(t, contact)}\n\n${t('Please find {document} {number} below.', {
    document: label,
    number,
  })}`;
}

function companySignature(settings) {
  return String(settings.email_signature || settings.company_name || 'WerpWeb').trim();
}

function subjectFor(t, label, number, settings) {
  const company = String(settings.company_name || '').trim();
  return company ? `${label} ${number} - ${company}` : `${label} ${number}`;
}

function documentPlainText(email, message) {
  const { doc, row, items, linkedOrder, t, h, money } = email.data;
  const signature = email.signature;
  const lines = [message, '', `${email.title} ${email.number}`];
  lines.push(`${doc.dateLabel}: ${h.formatDate(row[doc.dateField])}`);
  if (row[doc.dueField]) lines.push(`${doc.dueLabel}: ${h.formatDate(row[doc.dueField])}`);
  lines.push(`${doc.party.label}: ${email.partyName}`);
  if (email.partyEmail) lines.push(`${t('Email')}: ${email.partyEmail}`);
  if (linkedOrder) lines.push(`${t('Linked order:')} ${linkedOrder.order_no}`);
  const customerOrder = doc.customerOrder
    ? row
    : (linkedOrder && linkedOrder.customer_order_no !== undefined ? linkedOrder : null);
  if (customerOrder) {
    if (customerOrder.customer_order_no) lines.push(`${t('Customer order no.')}: ${customerOrder.customer_order_no}`);
    if (customerOrder.warehouse_name) {
      lines.push(
        `${t('Destination warehouse')}: ${customerOrder.warehouse_name}${customerOrder.warehouse_code ? ` (${customerOrder.warehouse_code})` : ''}`,
      );
    }
    if (customerOrder.docking_station) lines.push(`${t('Docking station')}: ${customerOrder.docking_station}`);
    if (customerOrder.reception_at) lines.push(`${t('Reception date & time')}: ${h.formatDateTime(customerOrder.reception_at)}`);
  }
  lines.push('');
  for (const item of items) {
    const customerCode = item.customer_code ? ` [${t('Customer code')}: ${item.customer_code}]` : '';
    lines.push(
      `- ${item.name} (${item.sku})${customerCode} x ${h.formatQty(item.quantity)} ${item.unit || ''} @ ${money(item.unit_price)} = ${money(item.line_total)}`,
    );
  }
  lines.push('');
  lines.push(`${t('Subtotal (incl. VAT)')}: ${money(row.subtotal)}`);
  if (Number(row.discount_total) > 0) lines.push(`${t('Discount')}: -${money(row.discount_total)}`);
  lines.push(`${t('VAT included')}: ${money(row.tax_total)}`);
  lines.push(`${t('Total')}: ${money(row.total)}`);
  if (doc.hasAmountPaid) {
    lines.push(`${t('Paid')}: ${money(row.amount_paid)}`);
    lines.push(`${t('Balance due')}: ${money(Number(row.total) - Number(row.amount_paid || 0))}`);
  }
  if (row.notes) lines.push('', `${t('Notes')}: ${row.notes}`);
  lines.push('', signature);
  return lines.join('\n');
}

function paymentPlainText(email, message) {
  const { payment, methodLabels, adjustmentLabels, t, h, money } = email.data;
  const signature = email.signature;
  const lines = [message, '', `${email.title} ${email.number}`];
  lines.push(`${t('Payment date')}: ${h.formatDate(payment.payment_date)}`);
  if (payment.reference) lines.push(`${t('Reference')}: ${payment.reference}`);
  lines.push(`${t('Party')}: ${email.partyName}`);
  if (email.partyEmail) lines.push(`${t('Email')}: ${email.partyEmail}`);
  lines.push('');
  lines.push(`${t('Total sources')}: ${money(payment.total_amount)}`);
  lines.push(`${t('Applied to invoices')}: ${money(payment.applied_amount)}`);
  lines.push(`${t('Unapplied credit')}: ${money(payment.unapplied_amount)}`);
  if (payment.methods.length) {
    lines.push('', `${t('Payment methods')}:`);
    for (const method of payment.methods) {
      lines.push(
        `- ${methodLabels[method.method] || method.method}: ${money(method.amount)}${method.reference ? ` (${method.reference})` : ''}`,
      );
    }
  }
  if (payment.adjustments && payment.adjustments.length) {
    lines.push('', `${t('Adjustments')}:`);
    for (const adjustment of payment.adjustments) {
      lines.push(
        `- ${adjustmentLabels[adjustment.kind] || adjustment.kind}: ${money(adjustment.amount)}${adjustment.reference ? ` (${adjustment.reference})` : ''}`,
      );
    }
  }
  if (payment.allocations.length) {
    lines.push('', `${t('Invoice allocations')}:`);
    for (const allocation of payment.allocations) {
      lines.push(`- ${allocation.invoice_no}: ${money(allocation.amount)}`);
    }
  }
  if (payment.notes) lines.push('', `${t('Notes')}: ${payment.notes}`);
  lines.push('', signature);
  return lines.join('\n');
}

function deliveryPlainText(email, message) {
  const { delivery, items, t, h } = email.data;
  const signature = email.signature;
  const lines = [message, '', `${email.title} ${email.number}`];
  lines.push(`${t('Delivery date:')} ${h.formatDate(delivery.delivery_date)}`);
  if (delivery.cai_number) lines.push(`CAI: ${delivery.cai_number}`);
  if (delivery.cot) lines.push(`COT: ${delivery.cot}`);
  lines.push(`${t('Delivery reference')}: ${delivery.delivery_no}`);
  lines.push(`${t('Ship to')}: ${email.partyName}`);
  if (email.partyEmail) lines.push(`${t('Email')}: ${email.partyEmail}`);
  lines.push('');
  const packingTotals = items.reduce((sum, item) => ({
    pallets: sum.pallets + Number(item.slip_pallets || 0),
    boxes: sum.boxes + Number(item.slip_boxes || 0),
    units: sum.units + Number(item.slip_units ?? item.quantity ?? 0),
    weight: sum.weight + Number(item.slip_weight_kg || 0),
  }), { pallets: 0, boxes: 0, units: 0, weight: 0 });
  for (const item of items) {
    lines.push(
      `- ${item.name} (${item.sku}) · ${t('Pallets')}: ${h.formatQty(item.slip_pallets || 0)}`
      + ` · ${t('Boxes')}: ${h.formatQty(item.slip_boxes || 0)}`
      + ` · ${t('Units')}: ${h.formatQty(item.slip_units ?? item.quantity)}`
      + ` · ${t('Weight (kg)')}: ${h.formatQty(item.slip_weight_kg || 0)}`,
    );
  }
  lines.push(
    '',
    `${t('Totals')} · ${t('Pallets')}: ${h.formatQty(packingTotals.pallets)}`
    + ` · ${t('Boxes')}: ${h.formatQty(packingTotals.boxes)}`
    + ` · ${t('Units')}: ${h.formatQty(packingTotals.units)}`
    + ` · ${t('Weight (kg)')}: ${h.formatQty(packingTotals.weight)}`,
  );
  if (delivery.carrier) lines.push('', `${t('Carrier:')} ${delivery.carrier}`);
  if (delivery.tracking_number) lines.push(`${t('Tracking:')} ${delivery.tracking_number}`);
  if (delivery.notes) lines.push('', `${t('Notes')}: ${delivery.notes}`);
  lines.push('', signature);
  return lines.join('\n');
}

async function loadEmailDocument(type, id, locale) {
  const def = TYPES[type];
  if (!def) return null;
  const t = translator(locale);
  const settings = await getSettings();
  const h = forLocale(locale);
  const money = (value) => h.formatMoney(value, settings.currency || 'USD');
  const label = t(def.label);
  const publicSettings = { ...settings };
  delete publicSettings.smtp_password;

  if (def.view === 'document') {
    const config = DOCUMENT_TYPES[def.configKey];
    const loaded = await loadDocumentData(config, id);
    if (!loaded) return null;
    const { row, items, linkedOrder } = loaded;
    const doc = localizeDocConfig(config, locale);
    const number = String(row[config.numberField]);
    const email = {
      type,
      view: def.view,
      template: 'document.ejs',
      title: label,
      number,
      showPath: def.showPath(row.id),
      partyName: row.party_name,
      partyEmail: row.party_email || '',
      partyContact: row.party_contact || '',
      subject: subjectFor(t, label, number, settings),
      message: defaultMessage(t, label, number, row.party_contact),
      signature: companySignature(settings),
      data: {
        locale,
        t,
        h,
        money,
        settings: publicSettings,
        doc,
        row,
        items,
        linkedOrder,
        title: label,
        number,
      },
    };
    return email;
  }

  if (def.view === 'payment') {
    const payment = await paymentRoutes.loadPaymentDetail(id);
    if (!payment) return null;
    const number = String(payment.payment_no);
    const paymentType = paymentRoutes.localizeType(payment.direction, locale);
    const email = {
      type,
      view: def.view,
      template: 'payment.ejs',
      title: label,
      number,
      showPath: def.showPath(payment.id),
      partyName: payment.party_name,
      partyEmail: payment.party_email || '',
      partyContact: payment.party_contact || '',
      subject: subjectFor(t, label, number, settings),
      message: defaultMessage(t, label, number, payment.party_contact),
      signature: companySignature(settings),
      data: {
        locale,
        t,
        h,
        money,
        settings: publicSettings,
        payment,
        paymentType,
        typeKey: payment.direction,
        methodLabels: Object.fromEntries(
          Object.entries(paymentRoutes.METHOD_LABELS).map(([value, key]) => [value, t(key)]),
        ),
        adjustmentLabels: Object.fromEntries(
          Object.entries(paymentRoutes.ADJUSTMENT_LABELS).map(([value, key]) => [value, t(key)]),
        ),
        title: label,
        number,
      },
    };
    return email;
  }

  if (def.view === 'delivery') {
    const delivery = await deliveryRoutes.loadDelivery(id);
    if (!delivery) return null;
    const items = await deliveryRoutes.loadDeliveryItems(delivery, true);
    const number = String(delivery.packing_slip_no || delivery.delivery_no);
    const email = {
      type,
      view: def.view,
      template: 'delivery.ejs',
      title: label,
      number,
      showPath: def.showPath(delivery.id),
      partyName: delivery.customer_name,
      partyEmail: delivery.customer_email || '',
      partyContact: delivery.customer_contact || '',
      subject: subjectFor(t, label, number, settings),
      message: defaultMessage(t, label, number, delivery.customer_contact),
      signature: companySignature(settings),
      data: {
        locale,
        t,
        h,
        money,
        settings: publicSettings,
        delivery,
        items,
        title: label,
        number,
      },
    };
    return email;
  }

  return null;
}

async function buildEmailContent(email, message) {
  const data = {
    ...email.data,
    message,
    signature: email.signature,
  };
  const html = await renderEmail(email.template, data);
  let text;
  if (email.view === 'document') text = documentPlainText(email, message);
  else if (email.view === 'payment') text = paymentPlainText(email, message);
  else text = deliveryPlainText(email, message);
  return { html, text };
}

module.exports = {
  TYPES,
  emailLabel,
  loadEmailDocument,
  buildEmailContent,
};
