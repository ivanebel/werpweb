'use strict';

const { getPool } = require('../db');

function dateValue(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  return raw.length > 19 ? raw.slice(0, 19) : raw;
}

function intValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimalValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusValue(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim().toUpperCase().slice(0, 1);
  if (raw === 'A') return { legacyStatus: 'A', inRange: 1 };
  if (raw === 'R') return { legacyStatus: 'R', inRange: 0 };
  return { legacyStatus: raw || null, inRange: null };
}

function labelValue(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim().slice(0, 80) || null;
}

function duplicateLabelIds(rows) {
  return [...new Set(rows
    .map((row) => labelValue(row.label_id ?? row.id_etiqueta))
    .filter((label) => label && label !== '0'))];
}

async function resolveProductMap(db, legacyProductIds) {
  const ids = [...new Set(legacyProductIds.map((id) => intValue(id)).filter((id) => id !== null && id > 0))];
  if (!ids.length) return new Map();
  const [rows] = await db.query(
    `SELECT id, old_id
       FROM products
      WHERE old_id IN (${ids.map(() => '?').join(',')})
      ORDER BY id`,
    ids,
  );
  const map = new Map();
  for (const row of rows) {
    const oldId = Number(row.old_id);
    if (!map.has(oldId)) map.set(oldId, Number(row.id));
  }
  return map;
}

async function flagDuplicateLabels(db, labelIds) {
  const labels = [...new Set(labelIds.filter((label) => label && label !== '0'))];
  if (!labels.length) return;
  await db.query(
    `UPDATE scale_records sr
       JOIN (
         SELECT label_id
           FROM scale_records
          WHERE label_id IN (${labels.map(() => '?').join(',')})
            AND label_id IS NOT NULL
            AND label_id <> ''
            AND label_id <> '0'
          GROUP BY label_id
         HAVING COUNT(*) > 1
       ) dup ON dup.label_id = sr.label_id
        SET sr.duplicate_label = 1`,
    labels,
  );
}

async function relinkProducts(db = getPool()) {
  await db.query(
    `UPDATE scale_records sr
       JOIN (
         SELECT old_id, MIN(id) AS id
           FROM products
          WHERE old_id IS NOT NULL
          GROUP BY old_id
       ) p ON p.old_id = sr.legacy_product_id
        SET sr.product_id = p.id
      WHERE sr.product_id IS NULL
        AND sr.legacy_product_id IS NOT NULL`,
  );
}

async function importLegacyRows(rows, options = {}) {
  const db = options.db || getPool();
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { imported: 0, duplicateCandidates: 0 };

  const productMap = await resolveProductMap(
    db,
    list.map((row) => row.producto ?? row.legacy_product_id),
  );

  const values = list.map((row) => {
    const legacyProductId = intValue(row.producto ?? row.legacy_product_id);
    const status = statusValue(row.estado ?? row.legacy_status);
    return [
      intValue(row.id ?? row.legacy_id),
      legacyProductId,
      legacyProductId !== null ? (productMap.get(legacyProductId) || null) : null,
      intValue(row.plu),
      row.numero_lote === undefined ? null : String(row.numero_lote || '').trim().slice(0, 100) || null,
      dateValue(row.fecha_vencimiento ?? row.expiry_date),
      dateValue(row.fecha_creacion ?? row.created_at),
      dateValue(row.timestamp ?? row.weighed_at),
      status.inRange,
      status.legacyStatus,
      decimalValue(row.peso_real ?? row.real_weight),
      decimalValue(row.peso_impreso ?? row.printed_weight),
      decimalValue(row.precio_venta ?? row.printed_price),
      labelValue(row.id_etiqueta ?? row.label_id),
      labelValue(row.id_bulto ?? row.box_id),
      labelValue(row.id_pallet ?? row.pallet_id),
    ];
  });

  await db.query(
    `INSERT INTO scale_records
       (legacy_id, legacy_product_id, product_id, plu, lot_number, expiry_date,
        created_at, weighed_at, in_range, legacy_status, real_weight, printed_weight,
        printed_price, label_id, box_id, pallet_id)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       legacy_product_id = VALUES(legacy_product_id),
       product_id = VALUES(product_id),
       plu = VALUES(plu),
       lot_number = VALUES(lot_number),
       expiry_date = VALUES(expiry_date),
       created_at = VALUES(created_at),
       weighed_at = VALUES(weighed_at),
       in_range = VALUES(in_range),
       legacy_status = VALUES(legacy_status),
       real_weight = VALUES(real_weight),
       printed_weight = VALUES(printed_weight),
       printed_price = VALUES(printed_price),
       label_id = VALUES(label_id),
       box_id = VALUES(box_id),
       pallet_id = VALUES(pallet_id),
       imported_at = CURRENT_TIMESTAMP`,
    [values],
  );

  await flagDuplicateLabels(db, duplicateLabelIds(list));
  return { imported: list.length, duplicateCandidates: duplicateLabelIds(list).length };
}

module.exports = {
  dateValue,
  intValue,
  statusValue,
  labelValue,
  duplicateLabelIds,
  resolveProductMap,
  flagDuplicateLabels,
  relinkProducts,
  importLegacyRows,
};
