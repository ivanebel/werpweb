'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const { createSshTunnel } = require('./tunnel');

let state = null;

function baseOptions(overrides = {}) {
  const ssl = config.db.ssl ? { rejectUnauthorized: false } : undefined;
  return {
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'utf8mb4',
    dateStrings: true,
    decimalNumbers: true,
    supportBigNumbers: true,
    connectTimeout: 20000,
    ssl,
    ...overrides,
  };
}

/**
 * Creates the shared mysql2 pool, opening the SSH tunnel first if configured.
 * Safe to call multiple times; the connection is only created once.
 */
async function initDb() {
  if (state) return state;

  let host = config.db.host;
  let port = config.db.port;
  let tunnel = null;

  if (config.db.ssh.enabled) {
    tunnel = await createSshTunnel({
      host: config.db.ssh.host,
      port: config.db.ssh.port,
      user: config.db.ssh.user,
      password: config.db.ssh.password,
      privateKey: config.db.ssh.privateKey,
      passphrase: config.db.ssh.passphrase,
      remoteHost: config.db.ssh.remoteHost,
      remotePort: config.db.ssh.remotePort,
    });
    host = tunnel.host;
    port = tunnel.port;
  }

  const pool = mysql.createPool(
    baseOptions({
      host,
      port,
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 10,
      idleTimeout: 60000,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    }),
  );

  try {
    const conn = await pool.getConnection();
    await conn.query('SELECT 1');
    conn.release();
  } catch (err) {
    await pool.end().catch(() => {});
    if (tunnel) await tunnel.close();
    throw new Error(
      `Could not connect to MySQL at ${host}:${port} (database "${config.db.database}"): ${err.message}`,
    );
  }

  state = { pool, tunnel };
  return state;
}

function getPool() {
  if (!state) throw new Error('Database not initialised. Call initDb() first.');
  return state.pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function scalar(sql, params = []) {
  const row = await one(sql, params);
  if (!row) return null;
  return Object.values(row)[0];
}

/**
 * Runs a callback with a dedicated connection inside a transaction.
 * The callback receives the connection and must use it for every query.
 */
async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function closeDb() {
  if (!state) return;
  await state.pool.end().catch(() => {});
  if (state.tunnel) await state.tunnel.close();
  state = null;
}

module.exports = { initDb, getPool, query, one, scalar, withTransaction, closeDb, baseOptions };
