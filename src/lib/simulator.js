'use strict';

const { query, one } = require('../db');
const finance = require('./finance');

const round2 = finance.round2;
const round3 = finance.round3;
const round4 = finance.round4;

const HORIZON_MIN = 1;
const HORIZON_MAX = 24;
const STATUSES = ['draft', 'active', 'locked', 'archived'];

function normalizeHorizon(value, fallback = 6) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(HORIZON_MIN, Math.min(HORIZON_MAX, parsed));
}

function periodsForScenario(startPeriod, horizon) {
  const start = finance.normalizePeriod(startPeriod);
  const count = normalizeHorizon(horizon);
  return Array.from({ length: count }, (_, index) => finance.shiftPeriod(start, index));
}

function defaultAssumptions() {
  return {
    collection_days: 30,
    payment_days: 30,
    inventory_days: 30,
    starting_cash: 0,
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseAssumptions(value) {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = {};
    }
  }
  if (!raw || typeof raw !== 'object') raw = {};
  return {
    collection_days: clampNumber(raw.collection_days, 0, 365, 30),
    payment_days: clampNumber(raw.payment_days, 0, 365, 30),
    inventory_days: clampNumber(raw.inventory_days, 0, 365, 30),
    starting_cash: Number(raw.starting_cash) || 0,
  };
}

function netSalePrice(product) {
  const sale = Math.max(0, Number(product.sale_price) || 0);
  const vat = Math.max(0, Number(product.sale_vat_rate) || 0);
  return round2(vat > 0 ? sale / (1 + vat / 100) : sale);
}

function netProductCost(product) {
  if (String(product.type) === 'service') return 0;
  const gross = Math.max(0, Number(product.cost_gross_price) || 0);
  const levy = Math.max(0, Number(product.cost_levy_rate) || 0);
  if (gross > 0) return round4(gross + (gross * levy) / 100);
  return round4(Math.max(0, Number(product.cost_price) || 0));
}

function subtractDays(dateString, days) {
  const date = new Date(`${String(dateString).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - Math.max(0, Number(days) || 0));
  return date.toISOString().slice(0, 10);
}

function roundOrderQuantity(quantity, minOrderQty, orderMultiple) {
  const required = Math.max(0, Number(quantity) || 0);
  if (required <= 0) return 0;
  const minimum = Math.max(0, Number(minOrderQty) || 0);
  const multiple = Math.max(0, Number(orderMultiple) || 0);
  let order = Math.max(required, minimum);
  if (multiple > 0) order = Math.ceil(order / multiple) * multiple;
  return round3(order);
}

async function loadScenario(id) {
  const scenario = await one('SELECT * FROM planning_scenarios WHERE id = ? LIMIT 1', [id]);
  if (!scenario) return null;
  scenario.assumptions = parseAssumptions(scenario.assumptions);
  return scenario;
}

async function loadScenarioLines(scenarioId) {
  return query(
    `SELECT sl.*,
            p.sku, p.name, p.type, p.category_id, p.unit,
            p.sale_price, p.sale_vat_rate, p.cost_gross_price, p.cost_levy_rate, p.cost_price,
            p.units_per_pack, p.packs_per_pallet, p.stock_qty, p.supplier_id,
            p.lead_time_days, p.min_order_qty, p.order_multiple, p.is_manufactured,
            p.reorder_level,
            s.company_name AS supplier_name,
            c.company_name AS customer_name
       FROM scenario_sales_lines sl
       JOIN products p ON p.id = sl.product_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN customers c ON c.id = sl.customer_id
      WHERE sl.scenario_id = ?
      ORDER BY p.name, c.company_name, sl.period`,
    [scenarioId],
  );
}

async function loadCostOverrides(scenarioId) {
  const rows = await query('SELECT * FROM scenario_cost_overrides WHERE scenario_id = ?', [scenarioId]);
  return new Map(rows.map((row) => [Number(row.cost_item_id), row]));
}

async function loadOpenPurchaseQuantities(productIds) {
  const ids = [...new Set(productIds.map(Number).filter((id) => id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await query(
    `SELECT poi.product_id, SUM(poi.quantity - poi.received_qty) AS open_qty
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.order_id
      WHERE po.status IN ('draft', 'confirmed', 'partially_received')
        AND poi.product_id IN (${placeholders})
      GROUP BY poi.product_id`,
    ids,
  );
  return new Map(rows.map((row) => [Number(row.product_id), Math.max(0, Number(row.open_qty) || 0)]));
}

async function loadBomData(productIds) {
  const ids = [...new Set(productIds.map(Number).filter((id) => id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await query(
    `SELECT b.id AS bom_id, b.product_id, b.output_qty,
            bi.component_id, bi.quantity, bi.scrap_percent, bi.sort_order,
            cp.sku AS component_sku, cp.name AS component_name, cp.unit,
            cp.type AS component_type, cp.cost_gross_price, cp.cost_levy_rate, cp.cost_price,
            cp.stock_qty, cp.supplier_id, cp.lead_time_days, cp.min_order_qty, cp.order_multiple,
            s.company_name AS supplier_name
       FROM boms b
       JOIN bom_items bi ON bi.bom_id = b.id
       JOIN products cp ON cp.id = bi.component_id
       LEFT JOIN suppliers s ON s.id = cp.supplier_id
      WHERE b.status = 'active'
        AND b.product_id IN (${placeholders})
      ORDER BY b.id DESC, bi.sort_order, bi.id`,
    ids,
  );

  const boms = new Map();
  for (const row of rows) {
    const productId = Number(row.product_id);
    const bomId = Number(row.bom_id);
    let bom = boms.get(productId);
    if (!bom) {
      bom = {
        bom_id: bomId,
        output_qty: Math.max(0.0001, Number(row.output_qty) || 1),
        components: [],
        unit_cost: 0,
      };
      boms.set(productId, bom);
    }
    if (bom.bom_id !== bomId) continue;
    const quantity = Math.max(0, Number(row.quantity) || 0);
    const scrap = Math.max(0, Number(row.scrap_percent) || 0);
    const unitCost = netProductCost(row);
    const requiredPerOutput = (quantity * (1 + scrap / 100)) / bom.output_qty;
    bom.unit_cost = round4(bom.unit_cost + requiredPerOutput * unitCost);
    bom.components.push({
      component_id: Number(row.component_id),
      sku: row.component_sku,
      name: row.component_name,
      unit: row.unit,
      type: row.component_type,
      quantity,
      scrap_percent: scrap,
      required_per_output: round4(requiredPerOutput),
      unit_cost: unitCost,
      stock_qty: Number(row.stock_qty) || 0,
      supplier_id: row.supplier_id ? Number(row.supplier_id) : null,
      supplier_name: row.supplier_name,
      lead_time_days: Number(row.lead_time_days) || 0,
      min_order_qty: Number(row.min_order_qty) || 0,
      order_multiple: Number(row.order_multiple) || 0,
      sort_order: Number(row.sort_order) || 0,
    });
  }
  return boms;
}

function grossVariableAmount(driverType, rate, bucket) {
  const value = Math.max(0, Number(rate) || 0);
  switch (String(driverType)) {
    case 'unit': return value * (Number(bucket.units) || 0);
    case 'revenue_percent': return (Number(bucket.revenue) || 0) * (value / 100);
    case 'material_percent': return (Number(bucket.material) || 0) * (value / 100);
    case 'invoice': return value * (Number(bucket.invoices) || 0);
    case 'pallet': return value * (Number(bucket.pallets) || 0);
    case 'labor_hour': return value * (Number(bucket.laborHours) || 0);
    default: return 0;
  }
}

function variableCostForItem(item, bucket, override) {
  const rate = override && override.driver_rate !== null && override.driver_rate !== undefined
    ? Number(override.driver_rate)
    : Number(item.driver_rate);
  const gross = grossVariableAmount(item.driver_type, rate, bucket);
  if (override && override.driver_rate !== null && override.driver_rate !== undefined) {
    return round2(gross);
  }
  return finance.netCostAmount({
    amount: gross,
    amount_basis: item.amount_basis,
    vat_rate: item.vat_rate,
    vat_recoverable: item.vat_recoverable,
  });
}

function fixedCostForItem(item, override) {
  if (override && override.amount !== null && override.amount !== undefined) {
    return round2(Math.max(0, Number(override.amount) || 0));
  }
  return finance.monthlyFixedAmount(item);
}

function oneOffCostForItem(item, override, periodRange) {
  if (String(item.frequency) !== 'one_off') return 0;
  const date = String(item.effective_from || '').slice(0, 10);
  if (date < periodRange.start || date > periodRange.end) return 0;
  if (override && override.amount !== null && override.amount !== undefined) {
    return round2(Math.max(0, Number(override.amount) || 0));
  }
  return finance.netCostAmount(item);
}

function shiftCash(values, days) {
  const cash = new Array(values.length).fill(0);
  const offset = Math.floor(Math.max(0, Number(days) || 0) / 30);
  const fraction = (Math.max(0, Number(days) || 0) % 30) / 30;
  values.forEach((value, index) => {
    const amount = Number(value) || 0;
    if (!amount) return;
    if (fraction > 0) {
      if (index + offset < cash.length) cash[index + offset] += amount * (1 - fraction);
      if (index + offset + 1 < cash.length) cash[index + offset + 1] += amount * fraction;
    } else if (index + offset < cash.length) {
      cash[index + offset] += amount;
    }
  });
  return cash.map(round2);
}

function emptyBucket() {
  return { units: 0, revenue: 0, material: 0, invoices: 0, pallets: 0, laborHours: 0 };
}

function bucketForItem(item, total, byProduct, byCategory) {
  const scope = String(item.scope_type || 'company');
  if (scope === 'product') return byProduct.get(Number(item.scope_product_id)) || emptyBucket();
  if (scope === 'category') return byCategory.get(Number(item.scope_category_id)) || emptyBucket();
  return total;
}

function appliesToProduct(item, product) {
  const scope = String(item.scope_type || 'company');
  if (scope === 'company') return true;
  if (scope === 'product') return Number(item.scope_product_id) === product.id;
  if (scope === 'category') return Number(item.scope_category_id) === product.category_id;
  return false;
}

async function buildScenarioResults(scenarioOrId) {
  const scenario = typeof scenarioOrId === 'object' && scenarioOrId !== null
    ? scenarioOrId
    : await loadScenario(scenarioOrId);
  if (!scenario) return null;

  const periods = periodsForScenario(scenario.start_period, scenario.horizon_months);
  const periodsSet = new Set(periods);
  const lines = await loadScenarioLines(scenario.id);
  const assumptions = parseAssumptions(scenario.assumptions);

  if (!lines.length) {
    return {
      scenario,
      periods,
      assumptions,
      lines: [],
      months: periods.map((period) => ({
        period,
        units: 0,
        revenue: 0,
        material: 0,
        variable: 0,
        contribution: 0,
        fixed: 0,
        oneOff: 0,
        operatingProfit: 0,
        purchases: 0,
        collections: 0,
        supplierPayments: 0,
        netCash: 0,
        closingCash: assumptions.starting_cash,
        ar: 0,
        ap: 0,
        inventory: 0,
      })),
      products: [],
      customers: [],
      purchasePlan: [],
      productionPlan: [],
      alerts: [{ code: 'no_lines', tone: 'info' }],
      totals: {
        units: 0, revenue: 0, material: 0, variable: 0, contribution: 0, fixed: 0,
        oneOff: 0, operatingProfit: 0, purchaseValue: 0, lowestCash: assumptions.starting_cash,
        netWorkingCapital: 0,
      },
      breakEven: {
        cmRatio: 0, cmPct: 0, monthlyFixed: 0, revenuePerMonth: null, revenueTotal: null,
        unitsPerMonth: null, marginOfSafety: null, contributionPerUnit: null,
      },
      chart: { periods, revenue: [], contribution: [], operatingProfit: [], closingCash: [] },
    };
  }

  const productIds = [...new Set(lines.map((line) => Number(line.product_id)))];
  const [costItems, overrides, bomByProduct] = await Promise.all([
    finance.loadCostItems({ activeOnly: true }),
    loadCostOverrides(scenario.id),
    loadBomData(productIds),
  ]);
  const requirementIds = new Set(productIds);
  for (const bom of bomByProduct.values()) {
    for (const component of bom.components) requirementIds.add(component.component_id);
  }
  const openPurchaseQuantities = await loadOpenPurchaseQuantities([...requirementIds]);

  const productMap = new Map();
  for (const line of lines) {
    const productId = Number(line.product_id);
    if (productMap.has(productId)) continue;
    const bom = bomByProduct.get(productId) || null;
    const cost = bom ? bom.unit_cost : netProductCost(line);
    productMap.set(productId, {
      id: productId,
      sku: line.sku,
      name: line.name,
      type: line.type,
      category_id: line.category_id ? Number(line.category_id) : null,
      unit: line.unit,
      is_manufactured: Number(line.is_manufactured) === 1,
      sale_price: Number(line.sale_price) || 0,
      sale_vat_rate: Number(line.sale_vat_rate) || 0,
      default_price: netSalePrice(line),
      unit_cost: round4(cost),
      bom,
      stock_qty: Number(line.stock_qty) || 0,
      supplier_id: line.supplier_id ? Number(line.supplier_id) : null,
      supplier_name: line.supplier_name,
      lead_time_days: Number(line.lead_time_days) || 0,
      min_order_qty: Number(line.min_order_qty) || 0,
      order_multiple: Number(line.order_multiple) || 0,
    });
  }

  const basket = new Map();
  for (const line of lines) {
    const product = productMap.get(Number(line.product_id));
    if (!product) continue;
    const key = `${line.product_id}:${line.customer_id || 0}`;
    let row = basket.get(key);
    if (!row) {
      row = {
        product,
        customer_id: line.customer_id ? Number(line.customer_id) : null,
        customer_name: line.customer_name || null,
        unit_price: Number(line.unit_price) > 0 ? Number(line.unit_price) : product.default_price,
        discount_pct: Math.max(0, Math.min(100, Number(line.discount_pct) || 0)),
        quantities: new Map(),
      };
      basket.set(key, row);
    }
    const period = String(line.period).slice(0, 7);
    if (!periodsSet.has(period)) continue;
    row.quantities.set(period, round3((row.quantities.get(period) || 0) + (Number(line.quantity) || 0)));
  }

  const productAggregates = new Map();
  const customerAggregates = new Map();
  const months = periods.map((period) => ({
    period,
    units: 0,
    revenue: 0,
    material: 0,
    variable: 0,
    contribution: 0,
    fixed: 0,
    oneOff: 0,
    operatingProfit: 0,
    purchases: 0,
    collections: 0,
    supplierPayments: 0,
    netCash: 0,
    closingCash: 0,
    ar: 0,
    ap: 0,
    inventory: 0,
  }));

  const purchaseRequirements = new Map();
  const productionPlan = new Map();

  const addRequirement = (product, period, quantity) => {
    if (!product || !quantity) return;
    const key = Number(product.id);
    let row = purchaseRequirements.get(key);
    if (!row) {
      row = {
        product,
        name: product.name,
        sku: product.sku,
        unit: product.unit,
        monthly: new Map(),
        total: 0,
        stock: Number(product.stock_qty) || 0,
        open_po: Number(openPurchaseQuantities.get(key)) || 0,
        unit_cost: Number(product.unit_cost) || 0,
        supplier_id: product.supplier_id || null,
        supplier_name: product.supplier_name || null,
        lead_time_days: Number(product.lead_time_days) || 0,
        min_order_qty: Number(product.min_order_qty) || 0,
        order_multiple: Number(product.order_multiple) || 0,
      };
      purchaseRequirements.set(key, row);
    }
    row.monthly.set(period, round3((row.monthly.get(period) || 0) + quantity));
    row.total = round3(row.total + quantity);
  };

  for (let monthIndex = 0; monthIndex < periods.length; monthIndex += 1) {
    const period = periods[monthIndex];
    const month = months[monthIndex];
    const byProduct = new Map();
    const byCategory = new Map();
    const total = emptyBucket();

    for (const row of basket.values()) {
      const quantity = Number(row.quantities.get(period)) || 0;
      if (quantity <= 0) continue;
      const product = row.product;
      const price = Math.max(0, Number(row.unit_price) || product.default_price || 0);
      const discount = Math.max(0, Math.min(100, Number(row.discount_pct) || 0));
      const revenue = round2(quantity * price * (1 - discount / 100));
      const material = round2(quantity * product.unit_cost);
      const unitsPerPack = Number(product.units_per_pack) || 0;
      const packsPerPallet = Number(product.packs_per_pallet) || 0;
      const pallets = unitsPerPack > 0 && packsPerPallet > 0
        ? round3(quantity / unitsPerPack / packsPerPallet)
        : 0;

      month.units = round3(month.units + quantity);
      month.revenue = round2(month.revenue + revenue);
      month.material = round2(month.material + material);

      const totalBucket = total;
      totalBucket.units = round3(totalBucket.units + quantity);
      totalBucket.revenue = round2(totalBucket.revenue + revenue);
      totalBucket.material = round2(totalBucket.material + material);
      totalBucket.invoices += 1;
      totalBucket.pallets = round3(totalBucket.pallets + pallets);

      const productKey = product.id;
      let productBucket = byProduct.get(productKey);
      if (!productBucket) {
        productBucket = emptyBucket();
        byProduct.set(productKey, productBucket);
      }
      productBucket.units = round3(productBucket.units + quantity);
      productBucket.revenue = round2(productBucket.revenue + revenue);
      productBucket.material = round2(productBucket.material + material);
      productBucket.invoices += 1;
      productBucket.pallets = round3(productBucket.pallets + pallets);

      const categoryKey = product.category_id || 0;
      let categoryBucket = byCategory.get(categoryKey);
      if (!categoryBucket) {
        categoryBucket = emptyBucket();
        byCategory.set(categoryKey, categoryBucket);
      }
      categoryBucket.units = round3(categoryBucket.units + quantity);
      categoryBucket.revenue = round2(categoryBucket.revenue + revenue);
      categoryBucket.material = round2(categoryBucket.material + material);
      categoryBucket.invoices += 1;
      categoryBucket.pallets = round3(categoryBucket.pallets + pallets);

      let productAgg = productAggregates.get(product.id);
      if (!productAgg) {
        productAgg = {
          id: product.id,
          sku: product.sku,
          name: product.name,
          unit: product.unit,
          units: 0,
          revenue: 0,
          material: 0,
          allocatedVariable: 0,
          contribution: 0,
          cmPct: null,
        };
        productAggregates.set(product.id, productAgg);
      }
      productAgg.units = round3(productAgg.units + quantity);
      productAgg.revenue = round2(productAgg.revenue + revenue);
      productAgg.material = round2(productAgg.material + material);

      const customerKey = row.customer_id || 0;
      let customerAgg = customerAggregates.get(customerKey);
      if (!customerAgg) {
        customerAgg = {
          id: row.customer_id,
          name: row.customer_name || null,
          units: 0,
          revenue: 0,
          material: 0,
          allocatedVariable: 0,
          contribution: 0,
          cmPct: null,
        };
        customerAggregates.set(customerKey, customerAgg);
      }
      customerAgg.units = round3(customerAgg.units + quantity);
      customerAgg.revenue = round2(customerAgg.revenue + revenue);
      customerAgg.material = round2(customerAgg.material + material);

      if (product.type === 'service') {
        // Services have no material purchase requirement.
      } else if (product.bom && product.bom.components.length) {
        let production = productionPlan.get(product.id);
        if (!production) {
          production = {
            id: product.id,
            sku: product.sku,
            name: product.name,
            unit: product.unit,
            monthly: new Map(),
            total: 0,
            material_cost: 0,
          };
          productionPlan.set(product.id, production);
        }
        production.monthly.set(period, round3((production.monthly.get(period) || 0) + quantity));
        production.total = round3(production.total + quantity);
        for (const component of product.bom.components) {
          addRequirement(
            {
              id: component.component_id,
              sku: component.sku,
              name: component.name,
              unit: component.unit,
              stock_qty: component.stock_qty,
              supplier_id: component.supplier_id,
              supplier_name: component.supplier_name,
              lead_time_days: component.lead_time_days,
              min_order_qty: component.min_order_qty,
              order_multiple: component.order_multiple,
              unit_cost: component.unit_cost,
            },
            period,
            quantity * component.required_per_output,
          );
        }
      } else {
        addRequirement(product, period, quantity);
      }
    }

    for (const item of costItems) {
      if (!finance.effectiveInPeriod(item, finance.periodRange(period))) continue;
      const override = overrides.get(Number(item.id));
      if (['variable', 'semi_variable'].includes(String(item.behavior)) && item.driver_type) {
        const bucket = bucketForItem(item, total, byProduct, byCategory);
        const amount = variableCostForItem(item, bucket, override);
        month.variable = round2(month.variable + amount);

        for (const productAgg of productAggregates.values()) {
          const productBucket = byProduct.get(productAgg.id);
          if (!productBucket) continue;
          if (!appliesToProduct(item, productAgg)) continue;
          if (!['unit', 'revenue_percent', 'material_percent'].includes(String(item.driver_type))) continue;
          productAgg.allocatedVariable = round2(
            productAgg.allocatedVariable + variableCostForItem(item, productBucket, override),
          );
        }

        for (const customerAgg of customerAggregates.values()) {
          if (String(item.scope_type) !== 'company') continue;
          if (!['unit', 'revenue_percent', 'material_percent'].includes(String(item.driver_type))) continue;
          const customerBucket = emptyBucket();
          for (const row of basket.values()) {
            if ((row.customer_id || 0) !== (customerAgg.id || 0)) continue;
            const quantity = Number(row.quantities.get(period)) || 0;
            if (quantity <= 0) continue;
            const revenue = quantity * (Number(row.unit_price) || row.product.default_price || 0)
              * (1 - Math.max(0, Math.min(100, Number(row.discount_pct) || 0)) / 100);
            customerBucket.units = round3(customerBucket.units + quantity);
            customerBucket.revenue = round2(customerBucket.revenue + revenue);
            customerBucket.material = round2(customerBucket.material + quantity * row.product.unit_cost);
          }
          customerAgg.allocatedVariable = round2(
            customerAgg.allocatedVariable + variableCostForItem(item, customerBucket, override),
          );
        }
      }

      if (['fixed', 'semi_variable', 'stepped'].includes(String(item.behavior))) {
        month.fixed = round2(month.fixed + fixedCostForItem(item, override));
      }
      month.oneOff = round2(
        month.oneOff + oneOffCostForItem(item, override, finance.periodRange(period)),
      );
    }

    month.contribution = round2(month.revenue - month.variable);
    month.operatingProfit = round2(month.contribution - month.fixed - month.oneOff);
  }

  // Purchase plan, net of stock and open purchase orders.
  const purchasePlan = [];
  for (const row of purchaseRequirements.values()) {
    const available = round3(row.stock + row.open_po);
    const netRequired = round3(Math.max(0, row.total - available));
    const orderQuantity = roundOrderQuantity(netRequired, row.min_order_qty, row.order_multiple);
    let cumulative = 0;
    let firstNeedPeriod = null;
    for (const period of periods) {
      const quantity = Number(row.monthly.get(period)) || 0;
      if (quantity <= 0) continue;
      cumulative = round3(cumulative + quantity);
      if (!firstNeedPeriod && cumulative > available) firstNeedPeriod = period;
    }
    const orderBy = firstNeedPeriod
      ? subtractDays(`${firstNeedPeriod}-01`, row.lead_time_days)
      : null;
    purchasePlan.push({
      ...row,
      available,
      net_required: netRequired,
      order_quantity: orderQuantity,
      total_cost: round2(orderQuantity * row.unit_cost),
      first_need_period: firstNeedPeriod,
      order_by: orderBy,
      monthly: Object.fromEntries(periods.map((period) => [period, Number(row.monthly.get(period)) || 0])),
    });
  }
  purchasePlan.sort((a, b) => {
    const supplier = String(a.supplier_name || '').localeCompare(String(b.supplier_name || ''));
    return supplier || String(a.name).localeCompare(String(b.name));
  });

  const production = [...productionPlan.values()].map((row) => {
    const product = productMap.get(row.id);
    return {
      ...row,
      material_cost: round2(row.total * (product && product.bom ? product.bom.unit_cost : 0)),
      monthly: Object.fromEntries(periods.map((period) => [period, Number(row.monthly.get(period)) || 0])),
    };
  });

  // Material purchases by month from the gross requirements, used for the cash estimate.
  const monthlyPurchaseValue = periods.map(() => 0);
  for (const row of purchaseRequirements.values()) {
    for (let index = 0; index < periods.length; index += 1) {
      const quantity = Number(row.monthly.get(periods[index])) || 0;
      monthlyPurchaseValue[index] = round2(monthlyPurchaseValue[index] + quantity * row.unit_cost);
    }
  }

  const revenueSeries = months.map((month) => month.revenue);
  const materialSeries = months.map((month) => month.material);
  const fixedSeries = months.map((month) => month.fixed + month.oneOff);
  const variableSeries = months.map((month) => month.variable);
  const collections = shiftCash(revenueSeries, assumptions.collection_days);
  const supplierPayments = shiftCash(monthlyPurchaseValue, assumptions.payment_days);
  const inventorySeries = materialSeries.map((value) => round2(value * assumptions.inventory_days / 30));

  let cash = assumptions.starting_cash;
  for (let index = 0; index < months.length; index += 1) {
    const month = months[index];
    const purchases = index === 0
      ? materialSeries[index]
      : round2(materialSeries[index] + inventorySeries[index] - inventorySeries[index - 1]);
    month.purchases = purchases;
    month.collections = collections[index];
    month.supplierPayments = supplierPayments[index];
    month.netCash = round2(
      collections[index] - supplierPayments[index] - fixedSeries[index] - variableSeries[index],
    );
    cash = round2(cash + month.netCash);
    month.closingCash = cash;
    month.ar = round2(month.revenue * assumptions.collection_days / 30);
    month.ap = round2(purchases * assumptions.payment_days / 30);
    month.inventory = inventorySeries[index];
  }

  const products = [...productAggregates.values()]
    .map((row) => {
      const contribution = round2(row.revenue - row.material - row.allocatedVariable);
      return {
        ...row,
        contribution,
        cmPct: row.revenue > 0 ? round2((contribution / row.revenue) * 100) : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const customers = [...customerAggregates.values()]
    .map((row) => {
      const contribution = round2(row.revenue - row.material - row.allocatedVariable);
      return {
        ...row,
        contribution,
        cmPct: row.revenue > 0 ? round2((contribution / row.revenue) * 100) : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const totals = months.reduce((sum, month) => ({
    units: round3(sum.units + month.units),
    revenue: round2(sum.revenue + month.revenue),
    material: round2(sum.material + month.material),
    variable: round2(sum.variable + month.variable),
    contribution: round2(sum.contribution + month.contribution),
    fixed: round2(sum.fixed + month.fixed),
    oneOff: round2(sum.oneOff + month.oneOff),
    operatingProfit: round2(sum.operatingProfit + month.operatingProfit),
    purchaseValue: 0,
    lowestCash: 0,
    netWorkingCapital: 0,
  }), {
    units: 0, revenue: 0, material: 0, variable: 0, contribution: 0, fixed: 0,
    oneOff: 0, operatingProfit: 0, purchaseValue: 0, lowestCash: 0, netWorkingCapital: 0,
  });
  totals.purchaseValue = round2(purchasePlan.reduce((sum, row) => sum + row.total_cost, 0));
  const lastMonth = months[months.length - 1] || { ar: 0, inventory: 0, ap: 0, closingCash: assumptions.starting_cash };
  totals.netWorkingCapital = round2(lastMonth.ar + lastMonth.inventory - lastMonth.ap);
  totals.lowestCash = round2(Math.min(...months.map((month) => month.closingCash), assumptions.starting_cash));

  const cmRatio = totals.revenue > 0 ? totals.contribution / totals.revenue : 0;
  const monthlyFixed = periods.length > 0 ? round2(totals.fixed / periods.length) : 0;
  const contributionPerUnit = totals.units > 0 ? round2(totals.contribution / totals.units) : null;
  const breakEvenRevenuePerMonth = cmRatio > 0 ? round2(monthlyFixed / cmRatio) : null;
  const breakEvenRevenueTotal = breakEvenRevenuePerMonth !== null
    ? round2(breakEvenRevenuePerMonth * periods.length)
    : null;
  const marginOfSafety = totals.revenue > 0 && breakEvenRevenueTotal !== null
    ? round2(((totals.revenue - breakEvenRevenueTotal) / totals.revenue) * 100)
    : null;
  const breakEvenUnitsPerMonth = contributionPerUnit && contributionPerUnit > 0
    ? round2(monthlyFixed / contributionPerUnit)
    : null;

  const alerts = [];
  if (!lines.length) alerts.push({ code: 'no_lines', tone: 'info' });
  if (!costItems.length) alerts.push({ code: 'no_costs', tone: 'info' });
  const missingCosts = products.filter((product) => {
    const source = productMap.get(product.id);
    return source && source.type !== 'service' && source.unit_cost <= 0;
  });
  if (missingCosts.length) alerts.push({ code: 'missing_costs', tone: 'warning', count: missingCosts.length });
  const noBom = [...productMap.values()].filter((product) => product.is_manufactured && !product.bom);
  if (noBom.length) alerts.push({ code: 'no_bom', tone: 'warning', count: noBom.length });
  const noSupplier = purchasePlan.filter((row) => !row.supplier_name);
  if (noSupplier.length) alerts.push({ code: 'no_supplier', tone: 'warning', count: noSupplier.length });
  const laborDrivers = costItems.filter((item) => item.driver_type === 'labor_hour');
  if (laborDrivers.length) alerts.push({ code: 'labor_driver', tone: 'info', count: laborDrivers.length });
  const scopedVariableCosts = costItems.filter((item) => ['variable', 'semi_variable'].includes(String(item.behavior))
    && String(item.scope_type) !== 'company');
  if (scopedVariableCosts.length) {
    alerts.push({ code: 'scoped_variable_costs', tone: 'info', count: scopedVariableCosts.length });
  }
  if (totals.contribution < 0) alerts.push({ code: 'negative_contribution', tone: 'error' });
  if (totals.operatingProfit < 0) alerts.push({ code: 'operating_loss', tone: 'warning' });
  if (!costItems.some((item) => ['fixed', 'semi_variable', 'stepped'].includes(String(item.behavior)))) {
    alerts.push({ code: 'no_fixed', tone: 'info' });
  }

  return {
    scenario,
    periods,
    assumptions,
    lines,
    months,
    products,
    customers,
    purchasePlan,
    productionPlan: production,
    alerts,
    totals,
    breakEven: {
      cmRatio,
      cmPct: round2(cmRatio * 100),
      monthlyFixed,
      revenuePerMonth: breakEvenRevenuePerMonth,
      revenueTotal: breakEvenRevenueTotal,
      unitsPerMonth: breakEvenUnitsPerMonth,
      marginOfSafety,
      contributionPerUnit,
    },
    chart: {
      periods,
      revenue: months.map((month) => month.revenue),
      contribution: months.map((month) => month.contribution),
      operatingProfit: months.map((month) => month.operatingProfit),
      closingCash: months.map((month) => month.closingCash),
    },
  };
}

async function loadScenarioSummaries() {
  const scenarios = await query(
    `SELECT s.*, u.name AS created_by_name,
            (SELECT COUNT(*) FROM scenario_sales_lines sl WHERE sl.scenario_id = s.id) AS line_count
       FROM planning_scenarios s
       LEFT JOIN users u ON u.id = s.created_by
      ORDER BY FIELD(s.status, 'active', 'draft', 'locked', 'archived'), s.updated_at DESC, s.id DESC`,
  );
  return scenarios.map((scenario) => ({
    ...scenario,
    assumptions: parseAssumptions(scenario.assumptions),
    periods: periodsForScenario(scenario.start_period, scenario.horizon_months),
  }));
}

module.exports = {
  STATUSES,
  HORIZON_MIN,
  HORIZON_MAX,
  normalizeHorizon,
  periodsForScenario,
  defaultAssumptions,
  parseAssumptions,
  netSalePrice,
  netProductCost,
  roundOrderQuantity,
  subtractDays,
  loadScenario,
  loadScenarioLines,
  loadCostOverrides,
  loadScenarioSummaries,
  buildScenarioResults,
};
