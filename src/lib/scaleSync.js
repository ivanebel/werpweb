'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const { getPool, baseOptions } = require('../db');
const { importLegacyRows, relinkProducts } = require('./scaleRecords');

let sourcePool = null;
let intervalTimer = null;
let initialTimer = null;
let running = false;

function assertTableName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(String(name || ''))) {
    throw new Error(`Unsafe legacy scale table name: ${name}`);
  }
  return name;
}

function getSourcePool() {
  if (sourcePool) return sourcePool;
  const scale = config.scale;
  sourcePool = mysql.createPool({
    ...baseOptions({
      host: scale.host,
      port: scale.port,
      user: scale.user,
      password: scale.password,
      database: scale.database,
      ssl: scale.ssl ? { rejectUnauthorized: false } : undefined,
    }),
    waitForConnections: true,
    connectionLimit: 2,
    maxIdle: 2,
    idleTimeout: 60000,
    connectTimeout: 10000,
    queueLimit: 0,
    enableKeepAlive: true,
  });
  return sourcePool;
}

async function closeSourcePool() {
  if (!sourcePool) return;
  await sourcePool.end().catch(() => {});
  sourcePool = null;
}

async function loadSyncState(db = getPool()) {
  let [rows] = await db.query('SELECT * FROM scale_sync_state WHERE id = 1');
  if (!rows.length) {
    await db.query('INSERT INTO scale_sync_state (id) VALUES (1)');
    [rows] = await db.query('SELECT * FROM scale_sync_state WHERE id = 1');
  }
  if (!rows[0].start_at) {
    await db.query(
      'UPDATE scale_sync_state SET start_at = ? WHERE id = 1 AND start_at IS NULL',
      [config.scale.startAt],
    );
    [rows] = await db.query('SELECT * FROM scale_sync_state WHERE id = 1');
  }
  return rows[0];
}

async function updateSyncState(db, values) {
  const sets = [];
  const params = [];
  for (const [column, value] of Object.entries(values)) {
    sets.push(`\`${column}\` = ?`);
    params.push(value);
  }
  if (!sets.length) return;
  await db.query(`UPDATE scale_sync_state SET ${sets.join(', ')} WHERE id = 1`, params);
}

async function runScaleSync({ trigger = 'auto', maxBatches = config.scale.maxBatches } = {}) {
  if (running) return { skipped: true, reason: 'already-running' };
  running = true;
  const db = getPool();
  let totalRows = 0;
  let batches = 0;
  let lastLegacyId = 0;
  try {
    const state = await loadSyncState(db);
    lastLegacyId = Number(state.last_legacy_id || 0);
    const startAt = state.start_at || config.scale.startAt;
    const table = assertTableName(config.scale.table);
    const source = getSourcePool();
    const limit = config.scale.batchSize;
    const overlap = config.scale.overlap;
    const batchLimit = Math.min(200, Math.max(1, Number(maxBatches) || 1));

    await updateSyncState(db, { last_status: 'running', last_error: null });

    while (batches < batchLimit) {
      const lowerId = Math.max(0, lastLegacyId - overlap);
      const [rows] = await source.query(
        `SELECT id, fecha_creacion, \`timestamp\`, producto, numero_lote, fecha_vencimiento,
                peso_real, peso_impreso, precio_unitario, precio_venta, id_etiqueta,
                id_bulto, id_pallet, estado, plu
           FROM \`${table}\`
          WHERE fecha_creacion >= ?
            AND id > ?
          ORDER BY id ASC
          LIMIT ?`,
        [startAt, lowerId, limit],
      );
      if (!rows.length) break;

      await importLegacyRows(rows, { db });
      const batchLastId = Number(rows[rows.length - 1].id);
      lastLegacyId = Math.max(lastLegacyId, batchLastId);
      totalRows += rows.length;
      batches += 1;
      await updateSyncState(db, {
        last_legacy_id: lastLegacyId,
        last_synced_at: new Date(),
        last_status: 'success',
        last_error: null,
        last_run_rows: totalRows,
      });
      await db.query(
        'UPDATE scale_sync_state SET imported_total = imported_total + ? WHERE id = 1',
        [rows.length],
      );
      if (rows.length < limit) break;
    }

    await relinkProducts(db);
    await updateSyncState(db, {
      last_legacy_id: lastLegacyId,
      last_synced_at: new Date(),
      last_status: 'success',
      last_error: null,
      last_run_rows: totalRows,
    });
    return { rows: totalRows, batches, lastLegacyId, trigger };
  } catch (error) {
    try {
      await updateSyncState(db, {
        last_status: 'error',
        last_synced_at: new Date(),
        last_error: String(error.message || error).slice(0, 1000),
        last_run_rows: totalRows,
      });
    } catch (stateError) {
      console.error('[scale-sync] could not save error state:', stateError.message);
    }
    console.error('[scale-sync] failed:', error.message);
    return { error: error.message, rows: totalRows, batches, lastLegacyId, trigger };
  } finally {
    running = false;
  }
}

function startScaleSync() {
  if (!config.scale.enabled) {
    console.log('[scale-sync] disabled');
    return;
  }
  const run = () => {
    runScaleSync({ trigger: 'auto' }).catch((error) => {
      console.error('[scale-sync] unexpected error:', error.message);
    });
  };
  initialTimer = setTimeout(run, 2000);
  initialTimer.unref?.();
  intervalTimer = setInterval(run, config.scale.intervalMs);
  intervalTimer.unref?.();
  console.log(`[scale-sync] enabled every ${config.scale.intervalMs} ms`);
}

async function stopScaleSync() {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
  await closeSourcePool();
}

module.exports = {
  runScaleSync,
  startScaleSync,
  stopScaleSync,
  loadSyncState,
};
