'use strict';

const { query } = require('../db');

async function run(conn, sql, params) {
  if (conn) {
    const [rows] = await conn.query(sql, params);
    return rows;
  }
  return query(sql, params);
}

/**
 * Generates the next sequential document number, e.g. SO-2026-0007 or CUS-00042.
 * Identifier values come from server-side config, never from user input.
 */
async function nextNumber({ prefix, table, column, year = true, pad = 4, conn = null, date = null }) {
  const y = (date ? String(date) : new Date().toISOString()).slice(0, 4);
  const stem = year ? `${prefix}-${y}-` : `${prefix}-`;
  const rows = await run(
    conn,
    `SELECT \`${column}\` AS num FROM \`${table}\` WHERE \`${column}\` LIKE ? ORDER BY \`${column}\` DESC LIMIT 1`,
    [`${stem}%`],
  );
  let seq = 1;
  if (rows.length) {
    const tail = String(rows[0].num).slice(stem.length);
    const parsed = Number.parseInt(tail, 10);
    if (Number.isFinite(parsed)) seq = parsed + 1;
  }
  return `${stem}${String(seq).padStart(pad, '0')}`;
}

module.exports = { nextNumber };
