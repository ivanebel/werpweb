'use strict';

const materials = require('./materials');

const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
const round4 = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;

/**
 * Film stock is measured in kilograms, but a film product can be stocked in
 * pieces/coils. Convert the entered coil weight to product stock units.
 */
function filmStockUnits(product, weightKg) {
  const weight = Math.max(0, Number(weightKg) || 0);
  const unit = String(product && product.unit || '').trim().toLowerCase();
  if (unit === 'kg' || unit === 'kgs' || unit === 'kilogram' || unit === 'kilograms') {
    return round3(weight);
  }
  const perPiece = Math.max(0, Number(product && product.weight_kg) || 0);
  return perPiece > 0 ? round3(weight / perPiece) : round3(weight);
}

async function lockProduct(conn, productId) {
  const [rows] = await conn.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [productId]);
  if (!rows.length) throw Object.assign(new Error('Product not found.'), { status: 404 });
  return rows[0];
}

/**
 * Post a signed stock delta and return the movement id. Negative quantities
 * consume stock; positive quantities return stock.
 */
async function postStockMovement(conn, {
  productId,
  quantity,
  movementType,
  referenceType = 'production_line_run',
  referenceId = null,
  notes = null,
  userId = null,
  t = (value) => value,
}) {
  const product = await lockProduct(conn, productId);
  const qty = round4(quantity);
  if (Math.abs(qty) < 0.00005) {
    return { product, movementId: null, tracked: Number(product.track_stock) === 1 };
  }
  if (Number(product.track_stock) !== 1) {
    return { product, movementId: null, tracked: false };
  }
  const stock = Number(product.stock_qty) || 0;
  if (qty < 0 && stock + qty < -0.00005) {
    throw Object.assign(
      new Error(t('Insufficient stock for {product}: need {need}, available {stock}.', {
        product: product.name,
        need: Math.abs(qty),
        stock,
      })),
      { status: 422 },
    );
  }
  await conn.query('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?', [qty, productId]);
  const [result] = await conn.query(
    `INSERT INTO stock_movements
       (product_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productId,
      movementType,
      qty,
      materials.memberUnitCost(product),
      referenceType,
      referenceId,
      notes,
      userId,
    ],
  );
  return {
    product,
    movementId: result.insertId,
    tracked: true,
    unitCost: materials.memberUnitCost(product),
  };
}

/**
 * Update the production requirement and the actual member allocation so
 * completion only consumes the remaining unposted quantity.
 */
async function recordConsumption(conn, {
  productionOrderId,
  requirementId,
  productId,
  stockQuantity,
  classQuantity,
  conversionFactor,
  unitCost,
}) {
  if (!requirementId) return;
  const stockQty = round4(stockQuantity);
  const classQty = round4(classQuantity);
  await conn.query(
    `UPDATE production_order_requirements
        SET quantity_consumed = GREATEST(0, quantity_consumed + ?)
      WHERE id = ? AND production_order_id = ?`,
    [classQty, requirementId, productionOrderId],
  );
  const [existing] = await conn.query(
    `SELECT id FROM production_order_materials
      WHERE requirement_id = ? AND component_id = ? LIMIT 1`,
    [requirementId, productId],
  );
  if (existing.length) {
    await conn.query(
      `UPDATE production_order_materials
          SET quantity_consumed = GREATEST(0, quantity_consumed + ?)
        WHERE id = ?`,
      [stockQty, existing[0].id],
    );
  } else if (Math.abs(stockQty) > 0.00005) {
    await conn.query(
      `INSERT INTO production_order_materials
         (production_order_id, requirement_id, material_class_id, component_id,
          quantity_required, quantity_consumed, source_count, priority,
          conversion_factor, unit_cost, is_substitute)
       VALUES (?, ?, NULL, ?, 0, ?, 1, 0, ?, ?, 1)`,
      [
        productionOrderId,
        requirementId,
        productId,
        Math.max(0, stockQty),
        conversionFactor || 1,
        unitCost || 0,
      ],
    );
  }
}

module.exports = {
  filmStockUnits,
  postStockMovement,
  recordConsumption,
};
