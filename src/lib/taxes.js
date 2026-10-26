'use strict';

const { query } = require('../db');
const { todayISO } = require('./helpers');

const SALES_STATUSES = ['sent', 'paid', 'overdue'];
const PURCHASE_STATUSES = ['received', 'paid', 'overdue'];
const WITHHOLDING_TYPES = ['none', 'iibb', 'income', 'other'];

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function validDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime()) ? null : raw;
}

function lastDayOfMonth(period) {
  const [year, month] = String(period).split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function monthRange(date = todayISO(), offset = 0) {
  const base = validDate(date) || todayISO();
  const [year, month] = base.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + Number(offset || 0), 1));
  const period = shifted.toISOString().slice(0, 7);
  return { from: `${period}-01`, to: lastDayOfMonth(period) };
}

function normalizeRange(from, to) {
  const today = todayISO();
  const defaultRange = monthRange(today, 0);
  const start = validDate(from) || defaultRange.from;
  const end = validDate(to) || defaultRange.to;
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

function isCreditNote(typeName) {
  const normalized = String(typeName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  return normalized.includes('NOTA DE CREDITO');
}

function documentSign(typeName) {
  return isCreditNote(typeName) ? -1 : 1;
}

function includedStatus(kind, status) {
  return (kind === 'sales' ? SALES_STATUSES : PURCHASE_STATUSES).includes(String(status));
}

function invoiceTax(invoice, items) {
  const subtotal = Math.max(0, Number(invoice.subtotal) || 0);
  const total = Math.max(0, Number(invoice.total) || 0);
  const ratio = subtotal > 0 ? Math.min(1, Math.max(0, total / subtotal)) : 1;
  const sign = documentSign(invoice.document_type_name);
  const byRate = new Map();
  let vatRaw = 0;

  for (const item of items || []) {
    const rate = Math.max(0, Number(item.tax_rate) || 0);
    const lineTotal = Math.max(0, Number(item.line_total) || 0) * ratio;
    const base = rate > 0 ? lineTotal / (1 + rate / 100) : lineTotal;
    const itemVat = lineTotal - base;
    vatRaw += itemVat;
    const entry = byRate.get(rate) || { rate, base: 0, vat: 0 };
    entry.base += base;
    entry.vat += itemVat;
    byRate.set(rate, entry);
  }

  // Fall back to the stored invoice tax if an old invoice has no item rows.
  if (!byRate.size && Number(invoice.tax_total) > 0) {
    const vat = Number(invoice.tax_total) * ratio;
    vatRaw = vat;
    byRate.set(0, { rate: 0, base: total - vat, vat });
  }

  const gross = round2(total * sign);
  const vat = round2(vatRaw * sign);
  return {
    sign,
    ratio,
    gross,
    net: round2(gross - vat),
    vat,
    by_rate: [...byRate.values()]
      .map((entry) => ({
        rate: entry.rate,
        base: round2(entry.base * sign),
        vat: round2(entry.vat * sign),
      }))
      .sort((a, b) => a.rate - b.rate),
  };
}

function addVatRate(target, entry, kind) {
  const current = target.get(entry.rate) || {
    rate: entry.rate,
    sales_base: 0,
    sales_vat: 0,
    purchase_base: 0,
    purchase_vat: 0,
  };
  if (kind === 'sales') {
    current.sales_base += entry.base;
    current.sales_vat += entry.vat;
  } else {
    current.purchase_base += entry.base;
    current.purchase_vat += entry.vat;
  }
  target.set(entry.rate, current);
}

function buildVatByRate(salesInvoices, purchaseInvoices) {
  const rates = new Map();
  for (const invoice of salesInvoices) {
    for (const entry of invoice.by_rate) addVatRate(rates, entry, 'sales');
  }
  for (const invoice of purchaseInvoices) {
    for (const entry of invoice.by_rate) addVatRate(rates, entry, 'purchase');
  }
  return [...rates.values()]
    .map((entry) => ({
      ...entry,
      sales_base: round2(entry.sales_base),
      sales_vat: round2(entry.sales_vat),
      purchase_base: round2(entry.purchase_base),
      purchase_vat: round2(entry.purchase_vat),
      net_vat: round2(entry.sales_vat - entry.purchase_vat),
    }))
    .sort((a, b) => a.rate - b.rate);
}

function buildIibbRows({ grossSales, defaultJurisdiction, jurisdictions, perceptions, withholdings }) {
  const rows = new Map();
  const defaultId = defaultJurisdiction ? Number(defaultJurisdiction.id) : null;
  const ensure = (jurisdiction) => {
    const id = jurisdiction && jurisdiction.id !== null && jurisdiction.id !== undefined ? Number(jurisdiction.id) : null;
    const key = id === null ? 'unassigned' : String(id);
    if (!rows.has(key)) {
      rows.set(key, {
        jurisdiction_id: id,
        code: jurisdiction ? jurisdiction.code : '',
        name: jurisdiction ? jurisdiction.name : '',
        unassigned: id === null,
        sales_share: 0,
        sales_base: 0,
        rate: 0,
        calculated: 0,
        perceptions: 0,
        withholdings: 0,
        net: 0,
        is_default: id !== null && id === defaultId,
      });
    }
    return rows.get(key);
  };

  for (const jurisdiction of jurisdictions || []) {
    const id = Number(jurisdiction.id);
    const share = jurisdiction.status === 'active' ? Math.max(0, Number(jurisdiction.sales_share) || 0) : 0;
    if (share <= 0 && id !== defaultId && !perceptions.has(id) && !withholdings.has(id)) continue;
    const row = ensure(jurisdiction);
    row.sales_share = round2(share);
    row.sales_base = round2(grossSales * share / 100);
    row.rate = Number(jurisdiction.iibb_rate) || 0;
    row.calculated = round2(row.sales_base * row.rate / 100);
  }

  for (const [key, amount] of perceptions.entries()) {
    const jurisdiction = (jurisdictions || []).find((item) => Number(item.id) === Number(key));
    const row = ensure(jurisdiction || { id: Number(key), code: '', name: '' });
    row.perceptions = round2(row.perceptions + amount);
  }

  for (const [key, amount] of withholdings.entries()) {
    if (key === null || key === undefined) {
      ensure(null);
    } else {
      const jurisdiction = (jurisdictions || []).find((item) => Number(item.id) === Number(key));
      ensure(jurisdiction || { id: Number(key), code: '', name: '' });
    }
    const row = rows.get(key === null || key === undefined ? 'unassigned' : String(key));
    row.withholdings = round2(row.withholdings + amount);
  }

  const result = [...rows.values()].map((row) => ({
    ...row,
    net: round2(row.calculated - row.perceptions - row.withholdings),
  }));
  result.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

async function loadTaxSettings() {
  const rows = await query('SELECT * FROM tax_settings WHERE id = 1 LIMIT 1');
  return rows[0] || null;
}

async function loadJurisdictions({ activeOnly = false } = {}) {
  return query(
    `SELECT * FROM tax_jurisdictions
      ${activeOnly ? "WHERE status = 'active'" : ''}
      ORDER BY name`,
  );
}

async function loadInvoiceItems(table, foreignKey, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await query(
    `SELECT \`${foreignKey}\` AS invoice_id, tax_rate, line_total
       FROM \`${table}\`
      WHERE \`${foreignKey}\` IN (${placeholders})`,
    ids,
  );
  const map = new Map();
  for (const row of rows) {
    const id = Number(row.invoice_id);
    const list = map.get(id) || [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}

async function loadSalesInvoices(from, to) {
  return query(
    `SELECT i.id, i.invoice_no AS number, i.invoice_date AS date, i.subtotal, i.discount_total,
            i.tax_total, i.total, i.status, i.document_type_code,
            fdt.name AS document_type_name, c.company_name AS party_name
       FROM sales_invoices i
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN fiscal_document_types fdt ON fdt.code = i.document_type_code
      WHERE i.invoice_date BETWEEN ? AND ?
        AND i.status IN (${SALES_STATUSES.map(() => '?').join(',')})
      ORDER BY i.invoice_date, i.id`,
    [from, to, ...SALES_STATUSES],
  );
}

async function loadPurchaseInvoices(from, to) {
  return query(
    `SELECT i.id, i.bill_no AS number, i.invoice_date AS date, i.subtotal, i.discount_total,
            i.tax_total, i.total, i.status, i.document_type_code,
            fdt.name AS document_type_name, s.company_name AS party_name
       FROM purchase_invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN fiscal_document_types fdt ON fdt.code = i.document_type_code
      WHERE i.invoice_date BETWEEN ? AND ?
        AND i.status IN (${PURCHASE_STATUSES.map(() => '?').join(',')})
      ORDER BY i.invoice_date, i.id`,
    [from, to, ...PURCHASE_STATUSES],
  );
}

async function loadPerceptions(from, to) {
  return query(
    `SELECT p.id, p.invoice_id, p.amount, p.reference, p.notes,
            j.id AS jurisdiction_id, j.code AS jurisdiction_code, j.name AS jurisdiction_name,
            i.bill_no AS number, i.invoice_date AS date,
            fdt.name AS document_type_name, s.company_name AS party_name
       FROM purchase_invoice_perceptions p
       JOIN purchase_invoices i ON i.id = p.invoice_id
       JOIN suppliers s ON s.id = i.supplier_id
       JOIN tax_jurisdictions j ON j.id = p.jurisdiction_id
       LEFT JOIN fiscal_document_types fdt ON fdt.code = i.document_type_code
      WHERE i.invoice_date BETWEEN ? AND ?
        AND i.status IN (${PURCHASE_STATUSES.map(() => '?').join(',')})
      ORDER BY i.invoice_date, i.id, j.name`,
    [from, to, ...PURCHASE_STATUSES],
  );
}

async function loadWithholdings(from, to) {
  return query(
    `SELECT pa.id, pa.payment_id, pa.amount, pa.reference, pa.notes, pa.tax_type,
            pa.jurisdiction_id, j.code AS jurisdiction_code, j.name AS jurisdiction_name,
            p.payment_no AS number, p.payment_date AS date, c.company_name AS party_name
       FROM payment_adjustments pa
       JOIN payments p ON p.id = pa.payment_id
       JOIN customers c ON c.id = p.customer_id
       LEFT JOIN tax_jurisdictions j ON j.id = pa.jurisdiction_id
      WHERE pa.kind = 'withholding'
        AND p.direction = 'customer'
        AND p.payment_date BETWEEN ? AND ?
      ORDER BY p.payment_date, p.id, pa.sort_order, pa.id`,
    [from, to],
  );
}

async function buildTaxReport(from, to) {
  const range = normalizeRange(from, to);
  const [settings, jurisdictions, salesInvoices, purchaseInvoices, perceptions, withholdings] = await Promise.all([
    loadTaxSettings(),
    loadJurisdictions(),
    loadSalesInvoices(range.from, range.to),
    loadPurchaseInvoices(range.from, range.to),
    loadPerceptions(range.from, range.to),
    loadWithholdings(range.from, range.to),
  ]);

  const [salesItems, purchaseItems] = await Promise.all([
    loadInvoiceItems('sales_invoice_items', 'invoice_id', salesInvoices.map((row) => Number(row.id))),
    loadInvoiceItems('purchase_invoice_items', 'invoice_id', purchaseInvoices.map((row) => Number(row.id))),
  ]);

  const sales = salesInvoices.map((invoice) => ({
    ...invoice,
    ...invoiceTax(invoice, salesItems.get(Number(invoice.id)) || []),
  }));
  const purchases = purchaseInvoices.map((invoice) => ({
    ...invoice,
    ...invoiceTax(invoice, purchaseItems.get(Number(invoice.id)) || []),
  }));

  const grossSales = round2(sales.reduce((sum, invoice) => sum + invoice.gross, 0));
  const netSales = round2(sales.reduce((sum, invoice) => sum + invoice.net, 0));
  const outputVat = round2(sales.reduce((sum, invoice) => sum + invoice.vat, 0));
  const grossPurchases = round2(purchases.reduce((sum, invoice) => sum + invoice.gross, 0));
  const netPurchases = round2(purchases.reduce((sum, invoice) => sum + invoice.net, 0));
  const inputVat = round2(purchases.reduce((sum, invoice) => sum + invoice.vat, 0));
  const vatByRate = buildVatByRate(sales, purchases);
  const vatNet = round2(outputVat - inputVat);

  const perceptionByJurisdiction = new Map();
  const perceptionRows = perceptions.map((row) => {
    const sign = documentSign(row.document_type_name);
    const signed = round2(Number(row.amount) * sign);
    const jurisdictionId = Number(row.jurisdiction_id);
    perceptionByJurisdiction.set(
      jurisdictionId,
      round2((perceptionByJurisdiction.get(jurisdictionId) || 0) + signed),
    );
    return {
      ...row,
      sign,
      signed_amount: signed,
      is_credit_note: sign < 0,
    };
  });

  const withholdingByJurisdiction = new Map();
  const withholdingByType = { iibb: 0, income: 0, other: 0, none: 0 };
  let unclassifiedCount = 0;
  let unassignedIibbCount = 0;
  const withholdingRows = withholdings.map((row) => {
    const type = WITHHOLDING_TYPES.includes(row.tax_type) ? row.tax_type : 'none';
    const amount = round2(Number(row.amount) || 0);
    const jurisdictionId = row.jurisdiction_id === null || row.jurisdiction_id === undefined
      ? null
      : Number(row.jurisdiction_id);
    withholdingByType[type] = round2(withholdingByType[type] + amount);
    if (type === 'none') unclassifiedCount += 1;
    if (type === 'iibb') {
      if (jurisdictionId === null) {
        unassignedIibbCount += 1;
        withholdingByJurisdiction.set(null, round2((withholdingByJurisdiction.get(null) || 0) + amount));
      } else {
        withholdingByJurisdiction.set(
          jurisdictionId,
          round2((withholdingByJurisdiction.get(jurisdictionId) || 0) + amount),
        );
      }
    }
    return { ...row, tax_type: type, jurisdiction_id: jurisdictionId };
  });

  const defaultId = settings && settings.default_jurisdiction_id
    ? Number(settings.default_jurisdiction_id)
    : null;
  const defaultJurisdiction = defaultId
    ? jurisdictions.find((row) => Number(row.id) === defaultId && row.status === 'active') || null
    : null;

  const iibbRows = buildIibbRows({
    grossSales,
    defaultJurisdiction,
    jurisdictions,
    perceptions: perceptionByJurisdiction,
    withholdings: withholdingByJurisdiction,
  });
  const activeJurisdictions = jurisdictions.filter((row) => row.status === 'active');
  const salesShareTotal = round2(activeJurisdictions.reduce((sum, row) => sum + (Number(row.sales_share) || 0), 0));
  const iibbSalesBase = round2(iibbRows.reduce((sum, row) => sum + row.sales_base, 0));
  const iibbCalculated = round2(iibbRows.reduce((sum, row) => sum + row.calculated, 0));
  const iibbPerceptions = round2(iibbRows.reduce((sum, row) => sum + row.perceptions, 0));
  const iibbWithholdings = round2(iibbRows.reduce((sum, row) => sum + row.withholdings, 0));
  const iibbNet = round2(iibbRows.reduce((sum, row) => sum + row.net, 0));

  const municipalRate = defaultJurisdiction ? Number(defaultJurisdiction.municipal_rate) || 0 : 0;
  const municipalTax = round2(grossSales * municipalRate / 100);
  const totalPosition = round2(vatNet + iibbNet + municipalTax);

  const alerts = [];
  if (!defaultJurisdiction) {
    alerts.push({ code: 'no_default_jurisdiction', tone: 'warning' });
  } else {
    if (Number(defaultJurisdiction.iibb_rate) <= 0) {
      alerts.push({ code: 'zero_iibb_rate', tone: 'warning', jurisdiction: defaultJurisdiction.name });
    }
    if (Number(defaultJurisdiction.municipal_rate) <= 0) {
      alerts.push({ code: 'zero_municipal_rate', tone: 'info', jurisdiction: defaultJurisdiction.name });
    }
  }
  if (activeJurisdictions.length && Math.abs(salesShareTotal - 100) > 0.01) {
    alerts.push({ code: 'sales_share_total', tone: 'warning', total: salesShareTotal });
  }
  if (!sales.length) alerts.push({ code: 'no_sales', tone: 'info' });
  if (!purchases.length) alerts.push({ code: 'no_purchases', tone: 'info' });
  if (unclassifiedCount > 0) alerts.push({ code: 'unclassified_withholdings', tone: 'warning', count: unclassifiedCount });
  if (unassignedIibbCount > 0) alerts.push({ code: 'unassigned_iibb', tone: 'warning', count: unassignedIibbCount });

  return {
    range,
    settings: settings || null,
    jurisdictions,
    defaultJurisdiction,
    sales: {
      invoices: sales,
      gross: grossSales,
      net: netSales,
      vat: outputVat,
      count: sales.length,
    },
    purchases: {
      invoices: purchases,
      gross: grossPurchases,
      net: netPurchases,
      vat: inputVat,
      count: purchases.length,
    },
    vat: {
      output: outputVat,
      input: inputVat,
      net: vatNet,
      payable: Math.max(0, vatNet),
      credit: Math.max(0, round2(-vatNet)),
      byRate: vatByRate,
    },
    perceptions: {
      rows: perceptionRows,
      byJurisdiction: [...perceptionByJurisdiction.entries()].map(([jurisdictionId, amount]) => {
        const jurisdiction = jurisdictions.find((row) => Number(row.id) === Number(jurisdictionId));
        return {
          jurisdiction_id: Number(jurisdictionId),
          code: jurisdiction ? jurisdiction.code : '',
          name: jurisdiction ? jurisdiction.name : '',
          amount,
        };
      }),
      total: round2(perceptionRows.reduce((sum, row) => sum + row.signed_amount, 0)),
      count: perceptionRows.length,
    },
    withholdings: {
      rows: withholdingRows,
      byType: withholdingByType,
      byJurisdiction: [...withholdingByJurisdiction.entries()].map(([jurisdictionId, amount]) => {
        const jurisdiction = jurisdictionId === null
          ? null
          : jurisdictions.find((row) => Number(row.id) === Number(jurisdictionId));
        return {
          jurisdiction_id: jurisdictionId,
          code: jurisdiction ? jurisdiction.code : '',
          name: jurisdiction ? jurisdiction.name : '',
          amount,
        };
      }),
      total: round2(withholdingRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      count: withholdingRows.length,
      unclassified_count: unclassifiedCount,
      unassigned_iibb_count: unassignedIibbCount,
    },
    iibb: {
      rate: defaultJurisdiction ? Number(defaultJurisdiction.iibb_rate) || 0 : 0,
      sales_share_total: salesShareTotal,
      sales_base_total: iibbSalesBase,
      calculated: iibbCalculated,
      perceptions: iibbPerceptions,
      withholdings: iibbWithholdings,
      net: iibbNet,
      payable: Math.max(0, iibbNet),
      credit: Math.max(0, round2(-iibbNet)),
      rows: iibbRows,
    },
    municipal: {
      rate: municipalRate,
      base: grossSales,
      amount: municipalTax,
    },
    otherWithholdings: {
      income: withholdingByType.income,
      other: withholdingByType.other,
      unclassified: withholdingByType.none,
      rows: withholdingRows.filter((row) => row.tax_type !== 'iibb'),
    },
    totalPosition,
    alerts,
  };
}

module.exports = {
  SALES_STATUSES,
  PURCHASE_STATUSES,
  WITHHOLDING_TYPES,
  round2,
  validDate,
  monthRange,
  normalizeRange,
  isCreditNote,
  documentSign,
  includedStatus,
  invoiceTax,
  buildVatByRate,
  buildIibbRows,
  loadTaxSettings,
  loadJurisdictions,
  loadSalesInvoices,
  loadPurchaseInvoices,
  loadPerceptions,
  loadWithholdings,
  buildTaxReport,
};
