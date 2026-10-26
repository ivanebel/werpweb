'use strict';

const { query } = require('../db');

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
const round4 = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const BEHAVIORS = ['fixed', 'variable', 'semi_variable', 'stepped'];
const FREQUENCIES = ['monthly', 'quarterly', 'annual', 'one_off'];
const DRIVER_TYPES = ['unit', 'revenue_percent', 'material_percent', 'invoice', 'pallet', 'labor_hour'];
const SCOPES = ['company', 'product', 'category'];
const AMOUNT_BASES = ['net', 'gross'];

function normalizePeriod(value, fallback = new Date().toISOString().slice(0, 7)) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  return PERIOD_RE.test(raw) ? raw : fallback;
}

function periodRange(period) {
  const normalized = normalizePeriod(period);
  const [year, month] = normalized.split('-').map(Number);
  const start = `${normalized}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { period: normalized, year, month, start, end };
}

function shiftPeriod(period, delta) {
  const { year, month } = periodRange(period);
  const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isFixedBehavior(item) {
  return ['fixed', 'semi_variable', 'stepped'].includes(String(item.behavior));
}

function isVariableBehavior(item) {
  return ['variable', 'semi_variable'].includes(String(item.behavior));
}

/**
 * Normalise a cost amount to the management-analysis basis.
 *
 * Fixed costs and per-unit rates can be entered gross of VAT. Recoverable VAT
 * is extracted; non-recoverable VAT remains part of the cost. Percentage
 * drivers are normalised after applying the rate to a net driver base.
 */
function netCostAmount(item) {
  const value = Math.max(0, Number(item.amount !== undefined ? item.amount : item) || 0);
  if (String(item.amount_basis || 'net') === 'gross' && Number(item.vat_recoverable) === 1) {
    const rate = Math.max(0, Number(item.vat_rate) || 0);
    if (rate > 0) return round2(value / (1 + rate / 100));
  }
  return round2(value);
}

function monthlyFixedAmount(item) {
  const amount = netCostAmount(item);
  switch (String(item.frequency)) {
    case 'monthly': return amount;
    case 'quarterly': return round2(amount / 3);
    case 'annual': return round2(amount / 12);
    case 'one_off': return 0;
    default: return amount;
  }
}

function effectiveInPeriod(item, range) {
  const from = String(item.effective_from || '').slice(0, 10);
  const to = item.effective_to ? String(item.effective_to).slice(0, 10) : null;
  if (!from || from > range.end) return false;
  return !to || to >= range.start;
}

function emptyBucket() {
  return { units: 0, revenue: 0, material: 0, invoices: 0, pallets: 0, laborHours: 0 };
}

function bucketFromProduct(product) {
  return {
    units: Number(product.quantity) || 0,
    revenue: Number(product.net_revenue) || 0,
    material: Number(product.material_cost) || 0,
    invoices: product.invoiceIds ? product.invoiceIds.size : 0,
    pallets: Number(product.pallets) || 0,
    laborHours: 0,
  };
}

function bucketFromCategory(category) {
  return {
    units: Number(category.units) || 0,
    revenue: Number(category.revenue) || 0,
    material: Number(category.material) || 0,
    invoices: category.invoiceIds ? category.invoiceIds.size : 0,
    pallets: Number(category.pallets) || 0,
    laborHours: 0,
  };
}

function grossVariableAmount(item, bucket) {
  const rate = Math.max(0, Number(item.driver_rate) || 0);
  switch (String(item.driver_type)) {
    case 'unit': return rate * (Number(bucket.units) || 0);
    case 'revenue_percent': return (Number(bucket.revenue) || 0) * (rate / 100);
    case 'material_percent': return (Number(bucket.material) || 0) * (rate / 100);
    case 'invoice': return rate * (Number(bucket.invoices) || 0);
    case 'pallet': return rate * (Number(bucket.pallets) || 0);
    case 'labor_hour': return rate * (Number(bucket.laborHours) || 0);
    default: return 0;
  }
}

function variableAmount(item, bucket) {
  return netCostAmount({
    amount: grossVariableAmount(item, bucket),
    amount_basis: item.amount_basis,
    vat_rate: item.vat_rate,
    vat_recoverable: item.vat_recoverable,
  });
}

function productCost(product, bomByProduct) {
  if (String(product.product_type) === 'service') {
    return { unit_cost: 0, cost_source: 'service' };
  }
  const bom = bomByProduct.get(Number(product.id));
  if (bom && Number(bom.unit_cost) > 0) {
    return { unit_cost: round4(bom.unit_cost), cost_source: 'bom' };
  }
  const gross = Math.max(0, Number(product.cost_gross_price) || 0);
  const levy = Math.max(0, Number(product.cost_levy_rate) || 0);
  const net = gross > 0 ? gross + (gross * levy) / 100 : Math.max(0, Number(product.cost_price) || 0);
  return { unit_cost: round4(net), cost_source: gross > 0 ? 'product' : 'missing' };
}

async function loadCostItems({ activeOnly = false, period = null } = {}) {
  const params = [];
  const where = [];
  if (activeOnly) {
    if (period) {
      // Historical actuals must stay visible after a cost item is marked
      // inactive, otherwise past reports would silently change.
      const normalized = normalizePeriod(period);
      where.push("(ci.status = 'active' OR EXISTS (SELECT 1 FROM cost_actuals ca WHERE ca.cost_item_id = ci.id AND ca.period = ?))");
      params.push(normalized);
    } else {
      where.push("ci.status = 'active'");
    }
  }
  if (period) {
    const range = periodRange(period);
    where.push(`(
      (ci.effective_from <= ? AND (ci.effective_to IS NULL OR ci.effective_to >= ?))
      OR EXISTS (SELECT 1 FROM cost_actuals ca WHERE ca.cost_item_id = ci.id AND ca.period = ?)
    )`);
    params.push(range.end, range.start, range.period);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return query(
    `SELECT ci.*, cc.name AS category_name, ctr.name AS cost_center_name,
            p.name AS scope_product_name, p.sku AS scope_product_sku,
            pc.name AS scope_category_name, s.company_name AS supplier_name
       FROM cost_items ci
       LEFT JOIN cost_categories cc ON cc.id = ci.category_id
       LEFT JOIN cost_centers ctr ON ctr.id = ci.cost_center_id
       LEFT JOIN products p ON p.id = ci.scope_product_id
       LEFT JOIN product_categories pc ON pc.id = ci.scope_category_id
       LEFT JOIN suppliers s ON s.id = ci.supplier_id
       ${whereSql}
      ORDER BY FIELD(ci.behavior, 'fixed', 'semi_variable', 'stepped', 'variable'),
               cc.name, ctr.name, ci.name`,
    params,
  );
}

async function loadActuals(period) {
  const rows = await query(
    `SELECT cost_item_id, SUM(amount) AS amount
       FROM cost_actuals
      WHERE period = ?
      GROUP BY cost_item_id`,
    [period],
  );
  return new Map(rows.map((row) => [Number(row.cost_item_id), Number(row.amount) || 0]));
}

async function buildCostDashboard(period) {
  const range = periodRange(period);

  const [costItems, salesRows, invoiceTotalsRows, palletRows, laborRows, bomRows, actuals] = await Promise.all([
    loadCostItems({ activeOnly: true, period: range.period }),
    query(
      `SELECT ii.invoice_id, ii.product_id, p.category_id, p.sku, p.name, p.type AS product_type,
              p.cost_gross_price, p.cost_levy_rate, p.cost_price,
              SUM(ii.quantity * CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END) AS quantity,
              SUM(ii.line_total * ((si.total - si.tax_total) / NULLIF(si.total, 0)) *
                  CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END) AS net_revenue,
              MAX(CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END) AS document_sign,
              MAX(CASE WHEN fdt.name IS NULL
                         OR (UPPER(fdt.name) NOT LIKE '%NOTA DE CREDITO%'
                             AND UPPER(fdt.name) NOT LIKE '%NOTA DE DEBITO%')
                       THEN 1 ELSE 0 END) AS is_invoice
         FROM sales_invoice_items ii
         JOIN sales_invoices si ON si.id = ii.invoice_id
         JOIN products p ON p.id = ii.product_id
         LEFT JOIN fiscal_document_types fdt ON fdt.code = si.document_type_code
        WHERE si.status IN ('sent', 'paid', 'overdue')
          AND si.invoice_date BETWEEN ? AND ?
        GROUP BY ii.invoice_id, ii.product_id, p.category_id, p.sku, p.name, p.type,
                 p.cost_gross_price, p.cost_levy_rate, p.cost_price`,
      [range.start, range.end],
    ),
    query(
      `SELECT SUM(CASE WHEN is_invoice = 1 THEN 1 ELSE 0 END) AS invoice_count,
              COALESCE(SUM(gross_revenue * sign), 0) AS gross_revenue,
              COALESCE(SUM(tax_total * sign), 0) AS tax_total,
              COALESCE(SUM(net_revenue * sign), 0) AS net_revenue
         FROM (
           SELECT si.total AS gross_revenue,
                  si.tax_total,
                  (si.total - si.tax_total) AS net_revenue,
                  CASE WHEN UPPER(fdt.name) LIKE '%NOTA DE CREDITO%' THEN -1 ELSE 1 END AS sign,
                  CASE WHEN fdt.name IS NULL
                         OR (UPPER(fdt.name) NOT LIKE '%NOTA DE CREDITO%'
                             AND UPPER(fdt.name) NOT LIKE '%NOTA DE DEBITO%')
                       THEN 1 ELSE 0 END AS is_invoice
             FROM sales_invoices si
             LEFT JOIN fiscal_document_types fdt ON fdt.code = si.document_type_code
            WHERE si.status IN ('sent', 'paid', 'overdue')
              AND si.invoice_date BETWEEN ? AND ?
         ) documents`,
      [range.start, range.end],
    ),
    query(
      `SELECT di.product_id, p.category_id, SUM(di.slip_pallets) AS pallets
         FROM delivery_items di
         JOIN deliveries d ON d.id = di.delivery_id
         JOIN products p ON p.id = di.product_id
        WHERE d.status IN ('shipped', 'delivered')
          AND d.delivery_date BETWEEN ? AND ?
        GROUP BY di.product_id, p.category_id`,
      [range.start, range.end],
    ),
    query(
      `SELECT COALESCE(SUM(worked_minutes), 0) AS minutes
         FROM attendance_records
        WHERE work_date BETWEEN ? AND ?
          AND worked_minutes IS NOT NULL`,
      [range.start, range.end],
    ),
    query(
      `SELECT b.id, b.product_id, b.output_qty,
              SUM(bi.quantity * (1 + bi.scrap_percent / 100) *
                  COALESCE(
                    NULLIF(cp.cost_gross_price, 0) + (cp.cost_gross_price * cp.cost_levy_rate / 100),
                    cp.cost_price,
                    0
                  )) AS material_cost
         FROM boms b
         JOIN bom_items bi ON bi.bom_id = b.id
         JOIN products cp ON cp.id = bi.component_id
        WHERE b.status = 'active'
        GROUP BY b.id, b.product_id, b.output_qty
        ORDER BY b.id DESC`,
    ),
    loadActuals(range.period),
  ]);

  const bomByProduct = new Map();
  for (const row of bomRows) {
    const productId = Number(row.product_id);
    if (bomByProduct.has(productId)) continue;
    const output = Number(row.output_qty) || 1;
    bomByProduct.set(productId, {
      bom_id: Number(row.id),
      unit_cost: round4((Number(row.material_cost) || 0) / output),
    });
  }

  const palletsByProduct = new Map();
  for (const row of palletRows) {
    palletsByProduct.set(Number(row.product_id), Number(row.pallets) || 0);
  }

  const byProduct = new Map();
  for (const row of salesRows) {
    const productId = Number(row.product_id);
    let product = byProduct.get(productId);
    if (!product) {
      product = {
        id: productId,
        sku: row.sku,
        name: row.name,
        product_type: row.product_type,
        category_id: row.category_id ? Number(row.category_id) : null,
        cost_gross_price: Number(row.cost_gross_price) || 0,
        cost_levy_rate: Number(row.cost_levy_rate) || 0,
        cost_price: Number(row.cost_price) || 0,
        quantity: 0,
        net_revenue: 0,
        invoiceIds: new Set(),
        pallets: palletsByProduct.get(productId) || 0,
        unit_cost: 0,
        cost_source: 'missing',
        material_cost: 0,
        allocated_variable: 0,
      };
      byProduct.set(productId, product);
    }
    product.quantity += Number(row.quantity) || 0;
    product.net_revenue += Number(row.net_revenue) || 0;
    if (Number(row.document_sign) > 0 && Number(row.is_invoice) === 1) {
      product.invoiceIds.add(Number(row.invoice_id));
    }
  }

  for (const product of byProduct.values()) {
    const cost = productCost(product, bomByProduct);
    product.unit_cost = cost.unit_cost;
    product.cost_source = cost.cost_source;
    product.material_cost = round2(product.quantity * product.unit_cost);
  }

  const byCategory = new Map();
  for (const product of byProduct.values()) {
    const key = product.category_id || 0;
    let category = byCategory.get(key);
    if (!category) {
      category = {
        category_id: product.category_id,
        units: 0,
        revenue: 0,
        material: 0,
        pallets: 0,
        invoiceIds: new Set(),
      };
      byCategory.set(key, category);
    }
    category.units += product.quantity;
    category.revenue += product.net_revenue;
    category.material += product.material_cost;
    category.pallets += product.pallets || 0;
    for (const invoiceId of product.invoiceIds) category.invoiceIds.add(invoiceId);
  }

  const invoiceTotals = invoiceTotalsRows[0] || {};
  const netRevenue = round2(invoiceTotals.net_revenue);
  const grossRevenue = round2(invoiceTotals.gross_revenue);
  const taxTotal = round2(invoiceTotals.tax_total);
  const invoiceCount = Number(invoiceTotals.invoice_count) || 0;
  const totalUnits = round3([...byProduct.values()].reduce((sum, p) => sum + p.quantity, 0));
  const totalMaterial = round2([...byProduct.values()].reduce((sum, p) => sum + p.material_cost, 0));
  const totalPallets = round3([...byProduct.values()].reduce((sum, p) => sum + (p.pallets || 0), 0));
  const laborHours = round3((Number((laborRows[0] || {}).minutes) || 0) / 60);

  const totalBucket = {
    units: totalUnits,
    revenue: netRevenue,
    material: totalMaterial,
    invoices: invoiceCount,
    pallets: totalPallets,
    laborHours,
  };

  function bucketForItem(item) {
    const scope = String(item.scope_type || 'company');
    if (scope === 'product') {
      const product = byProduct.get(Number(item.scope_product_id));
      return product ? bucketFromProduct(product) : emptyBucket();
    }
    if (scope === 'category') {
      const category = byCategory.get(Number(item.scope_category_id));
      return category ? bucketFromCategory(category) : emptyBucket();
    }
    return totalBucket;
  }

  function appliesToProduct(item, product) {
    const scope = String(item.scope_type || 'company');
    if (scope === 'company') return true;
    if (scope === 'product') return Number(item.scope_product_id) === product.id;
    if (scope === 'category') return Number(item.scope_category_id) === product.category_id;
    return false;
  }

  let fixedRunRate = 0;
  let nonCashFixed = 0;
  let oneOffCost = 0;
  let totalVariable = 0;
  const rows = [];

  for (const item of costItems) {
    const isActive = String(item.status) === 'active';
    const effective = effectiveInPeriod(item, range);
    const fixedMonthly = isActive && effective && isFixedBehavior(item) ? monthlyFixedAmount(item) : 0;
    const oneOffInPeriod = isActive && effective && String(item.frequency) === 'one_off'
      && String(item.effective_from || '').slice(0, 10) >= range.start
      && String(item.effective_from || '').slice(0, 10) <= range.end
      ? netCostAmount(item)
      : 0;
    const variable = isActive && effective && isVariableBehavior(item) && item.driver_type
      ? variableAmount(item, bucketForItem(item))
      : 0;
    const calculated = round2(fixedMonthly + oneOffInPeriod + variable);
    const actual = round2(actuals.get(Number(item.id)) || 0);

    fixedRunRate = round2(fixedRunRate + fixedMonthly);
    if (Number(item.is_non_cash) === 1) nonCashFixed = round2(nonCashFixed + fixedMonthly);
    oneOffCost = round2(oneOffCost + oneOffInPeriod);
    totalVariable = round2(totalVariable + variable);

    if (isActive && effective && isVariableBehavior(item) && item.driver_type) {
      for (const product of byProduct.values()) {
        if (!appliesToProduct(item, product)) continue;
        if (!['unit', 'revenue_percent', 'material_percent'].includes(String(item.driver_type))) continue;
        product.allocated_variable = round2(
          product.allocated_variable + variableAmount(item, bucketFromProduct(product)),
        );
      }
    }

    rows.push({
      ...item,
      monthly_fixed: fixedMonthly,
      one_off_amount: oneOffInPeriod,
      variable_amount: variable,
      calculated,
      actual,
      variance: round2(actual - calculated),
      scope_label:
        String(item.scope_type) === 'product'
          ? item.scope_product_name
          : String(item.scope_type) === 'category'
            ? item.scope_category_name
            : null,
    });
  }

  const products = [...byProduct.values()]
    .map((product) => {
      const contribution = round2(product.net_revenue - product.material_cost - product.allocated_variable);
      return {
        id: product.id,
        sku: product.sku,
        name: product.name,
        product_type: product.product_type,
        category_id: product.category_id,
        quantity: round3(product.quantity),
        net_revenue: round2(product.net_revenue),
        unit_cost: product.unit_cost,
        material_cost: round2(product.material_cost),
        allocated_variable: round2(product.allocated_variable),
        contribution,
        cm_pct: product.net_revenue > 0 ? round2((contribution / product.net_revenue) * 100) : null,
        cost_source: product.cost_source,
        cost_missing: product.cost_source === 'missing' || (product.cost_source !== 'service' && product.unit_cost <= 0),
      };
    })
    .sort((a, b) => b.net_revenue - a.net_revenue);

  const allocatedVariable = round2(products.reduce((sum, product) => sum + product.allocated_variable, 0));
  const unallocatedVariable = round2(Math.max(0, totalVariable - allocatedVariable));
  const contribution = round2(netRevenue - totalVariable);
  const contributionPerUnit = totalUnits > 0 ? round2(contribution / totalUnits) : null;
  const cmRatio = netRevenue > 0 ? round2((contribution / netRevenue) * 100) / 100 : 0;
  const totalFixedForPeriod = round2(fixedRunRate + oneOffCost);
  const operatingProfit = round2(contribution - totalFixedForPeriod);
  const breakEvenRevenue = cmRatio > 0 ? round2(fixedRunRate / cmRatio) : null;
  const breakEvenUnits = contributionPerUnit && contributionPerUnit > 0
    ? round2(fixedRunRate / contributionPerUnit)
    : null;
  const cashFixed = Math.max(0, round2(fixedRunRate - nonCashFixed));
  const cashBreakEven = cmRatio > 0 ? round2(cashFixed / cmRatio) : null;
  const marginOfSafety = netRevenue > 0 && breakEvenRevenue !== null
    ? round2(((netRevenue - breakEvenRevenue) / netRevenue) * 100)
    : null;
  const operatingLeverage = operatingProfit > 0 ? round2(contribution / operatingProfit) : null;

  return {
    range,
    costItems,
    rows,
    products,
    actuals,
    netRevenue,
    grossRevenue,
    taxTotal,
    invoiceCount,
    totalUnits,
    totalMaterial,
    totalPallets,
    laborHours,
    totalVariable,
    allocatedVariable,
    unallocatedVariable,
    fixedRunRate,
    nonCashFixed,
    oneOffCost,
    totalFixedForPeriod,
    contribution,
    contributionPerUnit,
    cmRatio,
    cmPct: round2(cmRatio * 100),
    operatingProfit,
    breakEvenRevenue,
    breakEvenUnits,
    cashBreakEven,
    marginOfSafety,
    operatingLeverage,
    variableCostRatio: netRevenue > 0 ? round2(totalVariable / netRevenue) : null,
    variableCostPct: netRevenue > 0 ? round2((totalVariable / netRevenue) * 100) : null,
    fixedCostRatio: netRevenue > 0 ? round2(fixedRunRate / netRevenue) : null,
    fixedCostPct: netRevenue > 0 ? round2((fixedRunRate / netRevenue) * 100) : null,
    missingCostProducts: products.filter((product) => product.cost_missing),
    zeroRateItems: rows.filter((row) => row.status === 'active' && effectiveInPeriod(row, range)
      && isVariableBehavior(row) && Number(row.driver_rate) <= 0),
    invalidScopeItems: rows.filter((row) => row.status === 'active' && effectiveInPeriod(row, range)
      && isVariableBehavior(row)
      && ((String(row.scope_type) === 'product' && !row.scope_product_id)
        || (String(row.scope_type) === 'category' && !row.scope_category_id))),
    fixedWithoutActuals: rows.filter((row) => row.status === 'active' && effectiveInPeriod(row, range)
      && isFixedBehavior(row) && row.monthly_fixed > 0 && row.actual === 0),
  };
}

module.exports = {
  BEHAVIORS,
  FREQUENCIES,
  DRIVER_TYPES,
  SCOPES,
  AMOUNT_BASES,
  round2,
  round3,
  round4,
  normalizePeriod,
  periodRange,
  shiftPeriod,
  isFixedBehavior,
  isVariableBehavior,
  netCostAmount,
  monthlyFixedAmount,
  effectiveInPeriod,
  loadCostItems,
  loadActuals,
  buildCostDashboard,
};
