'use strict';

const { one } = require('../db');

function formatNumber(value, length) {
  return String(Number(value)).padStart(length, '0');
}

function formatPackingSlipNo(prefix, sequence) {
  return `${formatNumber(prefix, 5)}-${formatNumber(sequence, 8)}`;
}

function usedCount(cai) {
  return Math.max(0, Number(cai.next_number) - Number(cai.range_start));
}

function remainingCount(cai) {
  return Math.max(0, Number(cai.range_end) - Number(cai.next_number) + 1);
}

class NoActiveCaiError extends Error {
  constructor() {
    super('No active CAI authorization with available packing slips.');
    this.name = 'NoActiveCaiError';
    this.code = 'NO_ACTIVE_CAI';
  }
}

/**
 * Reserves the next packing slip number inside the caller's transaction.
 * The oldest active authorization with remaining numbers is used first.
 */
async function allocatePackingSlip(conn) {
  const [rows] = await conn.query(
    `SELECT * FROM cai_authorizations
      WHERE status = 'active' AND next_number <= range_end
      ORDER BY created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE`,
  );
  if (!rows.length) throw new NoActiveCaiError();

  const cai = rows[0];
  const sequence = Number(cai.next_number);
  const next = sequence + 1;
  const status = next > Number(cai.range_end) ? 'exhausted' : 'active';
  await conn.query(
    'UPDATE cai_authorizations SET next_number = ?, status = ? WHERE id = ?',
    [next, status, cai.id],
  );

  return {
    id: cai.id,
    caiNumber: cai.cai_number,
    sequence,
    packingSlipNo: formatPackingSlipNo(cai.prefix, sequence),
  };
}

async function activeCai() {
  return one(
    `SELECT * FROM cai_authorizations
      WHERE status = 'active' AND next_number <= range_end
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
  );
}

module.exports = {
  formatPackingSlipNo,
  usedCount,
  remainingCount,
  NoActiveCaiError,
  allocatePackingSlip,
  activeCai,
};
