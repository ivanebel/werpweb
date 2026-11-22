'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const { getPool, baseOptions, withTransaction } = require('../db');
const { todayISO } = require('./helpers');

let legacyPool = null;
let queue = Promise.resolve();

function assertTableName(name) {
  const value = String(name || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`Unsafe legacy table name: ${name}`);
  return value;
}

function lineSaleColumn() {
  return assertTableName(config.posImport.lineSaleColumn);
}

function getLegacyPool() {
  if (legacyPool) return legacyPool;
  const scale = config.scale;
  legacyPool = mysql.createPool({
    ...baseOptions({
      host: scale.host,
      port: scale.port,
      user: scale.user,
      password: scale.password,
      database: scale.database,
      ssl: scale.ssl ? { rejectUnauthorized: false } : undefined,
    }),
    waitForConnections: true,
    connectionLimit: 3,
    maxIdle: 3,
    idleTimeout: 60000,
    connectTimeout: 10000,
    queueLimit: 0,
    enableKeepAlive: true,
  });
  return legacyPool;
}

async function stopPosImport() {
  if (!legacyPool) return;
  await legacyPool.end().catch(() => {});
  legacyPool = null;
}

function parseDateInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : null;
  }
  const match = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!match) return null;
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

function normalizeRange(fromRaw, toRaw) {
  const today = todayISO();
  const from = parseDateInput(fromRaw) || today;
  const to = parseDateInput(toRaw) || from;
  const [start, end] = from > to ? [to, from] : [from, to];
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  if (days > config.posImport.maxDays) {
    throw new Error(`The import range cannot exceed ${config.posImport.maxDays} days.`);
  }
  return {
    from: start,
    to: end,
    days,
    fromAt: `${start} 00:00:00`,
    toAt: `${end} 23:59:59`,
  };
}

function mapPaymentMethod(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text || text.startsWith('CE') || text.includes('EFECTIVO') || text.includes('CONTADO')) return 'cash';
  if (text.includes('TARJETA') || text.includes('CREDITO') || text.includes('DEBITO') || text.startsWith('TC') || text.startsWith('TD')) {
    return 'card';
  }
  if (text.includes('TRANSFER')) return 'transfer';
  return 'cash';
}

function fiscalCode(value) {
  const code = Number.parseInt(value, 10);
  if (!Number.isFinite(code) || code <= 0) return null;
  return code === 950 ? 999 : code;
}

function intOrNull(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dateTimeOrNull(value) {
  if (!value) return null;
  const match = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  if (Number(year) < 1900) return null;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

async function loadFiscalTypes(db, codes) {
  const unique = [...new Set(codes.filter((code) => code !== null && code > 0))];
  if (!unique.length) return new Map();
  const [rows] = await db.query(
    `SELECT code, name FROM fiscal_document_types WHERE code IN (${unique.map(() => '?').join(',')})`,
    unique,
  );
  return new Map(rows.map((row) => [Number(row.code), String(row.name || '').trim()]));
}

async function resolveProductMap(db, legacyIds) {
  const ids = [...new Set(legacyIds.map((id) => intOrNull(id)).filter((id) => id !== null && id > 0))];
  if (!ids.length) return new Map();
  const [rows] = await db.query(
    `SELECT id, old_id FROM products WHERE old_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids,
  );
  const map = new Map();
  for (const row of rows) {
    const oldId = Number(row.old_id);
    if (!map.has(oldId)) map.set(oldId, Number(row.id));
  }
  return map;
}

async function ensurePosLocations(db, legacyNumbers) {
  const numbers = [...new Set(legacyNumbers.map((n) => intOrNull(n)).filter((n) => n !== null && n > 0))];
  const map = new Map();
  let placeholders = 0;
  if (!numbers.length) return { map, placeholders };
  const [rows] = await db.query(
    `SELECT id, legacy_pos_number FROM pos_locations
      WHERE legacy_pos_number IN (${numbers.map(() => '?').join(',')})`,
    numbers,
  );
  for (const row of rows) map.set(Number(row.legacy_pos_number), Number(row.id));

  for (const number of numbers) {
    if (map.has(number)) continue;
    let attempt = 0;
    while (attempt < 6) {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const code = `LEGACY-${number}${suffix}`.slice(0, 20);
      try {
        const [result] = await db.query(
          `INSERT INTO pos_locations (code, name, legacy_pos_number, status)
           VALUES (?, ?, ?, 'active')`,
          [code, `POS ${number} (imported)`, number],
        );
        map.set(number, Number(result.insertId));
        placeholders += 1;
        break;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const [retry] = await db.query(
          'SELECT id FROM pos_locations WHERE legacy_pos_number = ? LIMIT 1',
          [number],
        );
        if (retry.length) {
          map.set(number, Number(retry[0].id));
          break;
        }
        attempt += 1;
      }
    }
  }
  return { map, placeholders };
}

async function loadSourceSales(range, lastId, limit) {
  const source = getLegacyPool();
  const salesTable = assertTableName(config.posImport.salesTable);
  const [rows] = await source.query(
    `SELECT m.*, COALESCE(m.fecha_movimiento, m.fecha_creacion) AS effective_date
       FROM \`${salesTable}\` m
      WHERE COALESCE(m.fecha_movimiento, m.fecha_creacion) >= ?
        AND COALESCE(m.fecha_movimiento, m.fecha_creacion) <= ?
        AND m.id > ?
      ORDER BY m.id ASC
      LIMIT ?`,
    [range.fromAt, range.toAt, lastId, limit],
  );
  return rows;
}

async function loadSourceLines(saleIds) {
  if (!saleIds.length) return [];
  const source = getLegacyPool();
  const linesTable = assertTableName(config.posImport.linesTable);
  const linkColumn = lineSaleColumn();
  const [rows] = await source.query(
    `SELECT * FROM \`${linesTable}\`
      WHERE \`${linkColumn}\` IN (${saleIds.map(() => '?').join(',')})
      ORDER BY id ASC`,
    saleIds,
  );
  return rows;
}

async function countSourceSales(range) {
  const source = getLegacyPool();
  const salesTable = assertTableName(config.posImport.salesTable);
  const [[row]] = await source.query(
    `SELECT COUNT(*) AS total
       FROM \`${salesTable}\`
      WHERE COALESCE(fecha_movimiento, fecha_creacion) >= ?
        AND COALESCE(fecha_movimiento, fecha_creacion) <= ?`,
    [range.fromAt, range.toAt],
  );
  return Number(row.total || 0);
}

async function createRun({ fromRaw, toRaw, userId = null }) {
  const range = normalizeRange(fromRaw, toRaw);
  const db = getPool();
  const [active] = await db.query(
    "SELECT id FROM pos_import_runs WHERE status IN ('pending','running') ORDER BY id DESC LIMIT 1",
  );
  if (active.length) {
    throw new Error('A POS import is already running. Wait for it to finish.');
  }
  const total = await countSourceSales(range);
  const [result] = await db.query(
    `INSERT INTO pos_import_runs (from_at, to_at, total_sales, created_by)
     VALUES (?, ?, ?, ?)`,
    [range.fromAt, range.toAt, total, userId],
  );
  const runId = Number(result.insertId);
  queue = queue
    .then(() => processRun(runId))
    .catch((error) => {
      console.error('[pos-import] run failed:', error.message);
    });
  return { id: runId, range, total };
}

async function recordError(conn, runId, legacySaleId, legacyLineId, scope, message) {
  await conn.query(
    `INSERT INTO pos_import_errors (run_id, legacy_sale_id, legacy_line_id, scope, message)
     VALUES (?, ?, ?, ?, ?)`,
    [runId, legacySaleId || null, legacyLineId || null, scope, String(message || '').slice(0, 500)],
  );
}

async function processRun(runId) {
  const db = getPool();
  let run = null;
  try {
    const [runs] = await db.query('SELECT * FROM pos_import_runs WHERE id = ? LIMIT 1', [runId]);
    run = runs[0];
    if (!run) return;
    if (!['pending', 'running'].includes(run.status)) return;

    await db.query(
      "UPDATE pos_import_runs SET status = 'running', started_at = NOW(), error_text = NULL WHERE id = ?",
      [runId],
    );
    const range = { fromAt: run.from_at, toAt: run.to_at };
    let lastId = Number(run.last_legacy_id || 0);
    let processed = Number(run.processed_sales || 0);
    let imported = Number(run.imported_sales || 0);
    let skipped = Number(run.skipped_sales || 0);
    let failed = Number(run.failed_sales || 0);
    let lines = Number(run.imported_lines || 0);
    let unmappedProducts = Number(run.unmapped_products || 0);
    let placeholderPos = Number(run.placeholder_pos || 0);

    while (true) {
      const batch = await loadSourceSales(range, lastId, config.posImport.batchSize);
      if (!batch.length) break;
      const batchIds = batch.map((sale) => Number(sale.id));
      lastId = Math.max(lastId, ...batchIds);

      const [existingRows] = await db.query(
        `SELECT legacy_id FROM pos_sales WHERE legacy_id IN (${batchIds.map(() => '?').join(',')})`,
        batchIds,
      );
      const existing = new Set(existingRows.map((row) => Number(row.legacy_id)));

      const sourceLines = await loadSourceLines(batchIds);
      const linesBySale = new Map();
      const linkColumn = lineSaleColumn();
      for (const line of sourceLines) {
        const key = Number(line[linkColumn]);
        if (!linesBySale.has(key)) linesBySale.set(key, []);
        linesBySale.get(key).push(line);
      }

      const productMap = await resolveProductMap(
        db,
        sourceLines.map((line) => line.producto),
      );
      const fiscalCodes = batch.map((sale) => fiscalCode(sale.id_documento)).filter((code) => code !== null);
      const fiscalTypes = await loadFiscalTypes(db, fiscalCodes);
      const locationResult = await ensurePosLocations(
        db,
        batch.map((sale) => sale.numero_punto_venta),
      );
      const locationMap = locationResult.map;
      placeholderPos += locationResult.placeholders;

      for (const sale of batch) {
        const legacySaleId = Number(sale.id);
        processed += 1;
        if (existing.has(legacySaleId)) {
          skipped += 1;
          continue;
        }
        const posId = locationMap.get(Number(sale.numero_punto_venta));
        if (!posId) {
          failed += 1;
          await recordError(db, runId, legacySaleId, null, 'sale', `Unmapped POS ${sale.numero_punto_venta}`);
          continue;
        }

        const code = fiscalCode(sale.id_documento);
        const ticketType = (code && fiscalTypes.get(code) || 'Ticket').slice(0, 40);
        const rawTicket = String(sale.numero_documento ?? '').trim();
        const ticketNumber = rawTicket && rawTicket !== '0'
          ? rawTicket.slice(0, 40)
          : `L-${legacySaleId}`;
        const saleDate = dateTimeOrNull(sale.effective_date) || dateTimeOrNull(sale.fecha_creacion);
        if (!saleDate) {
          failed += 1;
          await recordError(db, runId, legacySaleId, null, 'sale', 'Sale has no usable date.');
          continue;
        }
        const saleLines = linesBySale.get(legacySaleId) || [];
        let saleUnmapped = 0;
        for (const line of saleLines) {
          if (!productMap.has(Number(line.producto))) saleUnmapped += 1;
        }

        try {
          await withTransaction(async (conn) => {
            const [header] = await conn.query(
              `INSERT INTO pos_sales
                 (legacy_id, pos_id, ticket_type, ticket_number, ticket_id, sale_date,
                  payment_method, customer_name, legacy_customer_id, subtotal, discount_total,
                  tax_total, total, notes, created_by, imported_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NOW(), ?, ?)`,
              [
                legacySaleId,
                posId,
                ticketType,
                ticketNumber,
                code,
                saleDate,
                mapPaymentMethod(sale.forma_pago),
                intOrNull(sale.tercero),
                numberOrZero(sale.subtotal),
                numberOrZero(sale.descuento),
                numberOrZero(sale.iva),
                numberOrZero(sale.total),
                dateTimeOrNull(sale.fecha_creacion) || saleDate,
                dateTimeOrNull(sale.fecha_modificacion) || dateTimeOrNull(sale.fecha_creacion) || saleDate,
              ],
            );
            if (saleLines.length) {
              const values = saleLines.map((line) => {
                const legacyProductId = intOrNull(line.producto);
                const productId = legacyProductId !== null ? (productMap.get(legacyProductId) || null) : null;
                return [
                  intOrNull(line.id),
                  header.insertId,
                  productId,
                  legacyProductId,
                  String(line.nombre_producto || '').trim().slice(0, 255) || null,
                  numberOrZero(line.cantidad),
                  numberOrZero(line.precio_unitario),
                  21,
                  '0005',
                  numberOrZero(line.subtotal),
                ];
              });
              await conn.query(
                `INSERT INTO pos_sale_items
                   (legacy_id, sale_id, product_id, legacy_product_id, description,
                    quantity, unit_price, tax_rate, vat_code, line_total)
                 VALUES ?`,
                [values],
              );
            }
          });
          imported += 1;
          lines += saleLines.length;
          unmappedProducts += saleUnmapped;
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') {
            skipped += 1;
            await recordError(db, runId, legacySaleId, null, 'sale', 'Duplicate ticket or legacy sale ID.');
          } else {
            failed += 1;
            await recordError(db, runId, legacySaleId, null, 'sale', error.message);
          }
        }
      }

      await db.query(
        `UPDATE pos_import_runs
            SET processed_sales = ?, imported_sales = ?, skipped_sales = ?, failed_sales = ?,
                imported_lines = ?, unmapped_products = ?, placeholder_pos = ?, last_legacy_id = ?
          WHERE id = ?`,
        [processed, imported, skipped, failed, lines, unmappedProducts, placeholderPos, lastId, runId],
      );
      if (batch.length < config.posImport.batchSize) break;
    }

    await db.query(
      `UPDATE pos_import_runs
          SET status = ?, processed_sales = ?, imported_sales = ?, skipped_sales = ?, failed_sales = ?,
              imported_lines = ?, unmapped_products = ?, placeholder_pos = ?, last_legacy_id = ?,
              finished_at = NOW()
        WHERE id = ?`,
      [
        failed > 0 ? 'completed_with_errors' : 'completed',
        processed,
        imported,
        skipped,
        failed,
        lines,
        unmappedProducts,
        placeholderPos,
        lastId,
        runId,
      ],
    );
  } catch (error) {
    try {
      await db.query(
        `UPDATE pos_import_runs
            SET status = 'failed', error_text = ?, finished_at = NOW()
          WHERE id = ?`,
        [String(error.message || error).slice(0, 1000), runId],
      );
    } catch (stateError) {
      console.error('[pos-import] could not save failure:', stateError.message);
    }
    console.error('[pos-import] failed:', error.message);
  }
}

async function markInterruptedRuns() {
  const db = getPool();
  await db.query(
    `UPDATE pos_import_runs
        SET status = 'interrupted',
            error_text = COALESCE(error_text, 'Server restarted before the import finished.'),
            finished_at = COALESCE(finished_at, NOW())
      WHERE status IN ('pending', 'running')`,
  );
}

async function getRun(runId) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT r.*, u.name AS created_by_name
       FROM pos_import_runs r
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = ? LIMIT 1`,
    [runId],
  );
  return rows[0] || null;
}

async function getRunErrors(runId, limit = 50) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT * FROM pos_import_errors WHERE run_id = ? ORDER BY id ASC LIMIT ?`,
    [runId, limit],
  );
  return rows;
}

async function getRecentRuns(limit = 20) {
  const db = getPool();
  const [rows] = await db.query(
    `SELECT r.*, u.name AS created_by_name
       FROM pos_import_runs r
       LEFT JOIN users u ON u.id = r.created_by
      ORDER BY r.id DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

module.exports = {
  normalizeRange,
  createRun,
  processRun,
  markInterruptedRuns,
  getRun,
  getRunErrors,
  getRecentRuns,
  getLegacyPool,
  stopPosImport,
};
