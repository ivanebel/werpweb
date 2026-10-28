'use strict';

const crypto = require('node:crypto');
const { query, one, withTransaction } = require('../../db');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MINUTES = 10;

function generateCode(length = CODE_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

async function createLinkCode(userId) {
  return withTransaction(async (conn) => {
    await conn.query('DELETE FROM telegram_link_codes WHERE user_id = ?', [userId]);
    let code = null;
    for (let attempt = 0; attempt < 5 && !code; attempt += 1) {
      const candidate = generateCode();
      try {
        await conn.query(
          `INSERT INTO telegram_link_codes (user_id, code, expires_at)
           VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
          [userId, candidate, CODE_TTL_MINUTES],
        );
        code = candidate;
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
      }
    }
    if (!code) throw new Error('Could not generate a Telegram linking code.');
    return code;
  });
}

async function loadPendingCode(userId) {
  return one(
    `SELECT code, expires_at
       FROM telegram_link_codes
      WHERE user_id = ?
        AND used_at IS NULL
        AND expires_at > NOW()
      ORDER BY id DESC
      LIMIT 1`,
    [userId],
  );
}

async function loadActiveLinkForUser(userId) {
  return one(
    `SELECT l.*, u.name AS user_name, u.role, u.is_active
       FROM telegram_links l
       JOIN users u ON u.id = l.user_id
      WHERE l.user_id = ?
        AND l.revoked_at IS NULL
      ORDER BY l.id DESC
      LIMIT 1`,
    [userId],
  );
}

async function loadLinkByTelegramUser(telegramUserId) {
  return one(
    `SELECT l.*, u.name AS user_name, u.role, u.is_active
       FROM telegram_links l
       JOIN users u ON u.id = l.user_id
      WHERE l.telegram_user_id = ?
        AND l.revoked_at IS NULL
      LIMIT 1`,
    [telegramUserId],
  );
}

async function linkTelegramUser(code, telegramUser) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return { ok: false, reason: 'missing_code' };

  return withTransaction(async (conn) => {
    const [codes] = await conn.query(
      `SELECT c.id, c.user_id, u.name, u.role, u.is_active
         FROM telegram_link_codes c
         JOIN users u ON u.id = c.user_id
        WHERE c.code = ?
          AND c.used_at IS NULL
          AND c.expires_at > NOW()
        LIMIT 1
        FOR UPDATE`,
      [normalized],
    );
    if (!codes.length) return { ok: false, reason: 'invalid_code' };
    const codeRow = codes[0];
    if (Number(codeRow.is_active) !== 1) return { ok: false, reason: 'inactive_user' };

    await conn.query(
      `UPDATE telegram_links
          SET revoked_at = NOW()
        WHERE revoked_at IS NULL
          AND (user_id = ? OR telegram_user_id = ?)`,
      [codeRow.user_id, telegramUser.id],
    );
    await conn.query(
      `INSERT INTO telegram_links
         (user_id, telegram_user_id, chat_id, username, first_name, last_name,
          linked_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL)
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         chat_id = VALUES(chat_id),
         username = VALUES(username),
         first_name = VALUES(first_name),
         last_name = VALUES(last_name),
         linked_at = NOW(),
         last_seen_at = NOW(),
         revoked_at = NULL`,
      [
        codeRow.user_id,
        telegramUser.id,
        telegramUser.chatId,
        telegramUser.username || null,
        telegramUser.firstName || null,
        telegramUser.lastName || null,
      ],
    );
    await conn.query(
      'UPDATE telegram_link_codes SET used_at = NOW() WHERE id = ?',
      [codeRow.id],
    );
    await conn.query(
      'DELETE FROM telegram_link_codes WHERE user_id = ? AND id <> ?',
      [codeRow.user_id, codeRow.id],
    );
    return {
      ok: true,
      user: {
        id: Number(codeRow.user_id),
        name: codeRow.name,
        role: codeRow.role,
      },
    };
  });
}

async function revokeTelegramLink(telegramUserId) {
  const result = await query(
    `UPDATE telegram_links
        SET revoked_at = NOW()
      WHERE telegram_user_id = ?
        AND revoked_at IS NULL`,
    [telegramUserId],
  );
  return result;
}

async function revokeTelegramLinkForUser(userId) {
  return query(
    `UPDATE telegram_links
        SET revoked_at = NOW()
      WHERE user_id = ?
        AND revoked_at IS NULL`,
    [userId],
  );
}

async function touchLink(linkId) {
  await query('UPDATE telegram_links SET last_seen_at = NOW() WHERE id = ?', [linkId]);
}

async function logAudit({
  direction = 'in',
  userId = null,
  telegramUserId = null,
  chatId = null,
  command = '',
  success = true,
  response = '',
}) {
  try {
    await query(
      `INSERT INTO telegram_audit_log
         (direction, user_id, telegram_user_id, chat_id, command, success, response)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        direction === 'out' ? 'out' : 'in',
        userId || null,
        telegramUserId || null,
        chatId || null,
        String(command || '').slice(0, 120) || null,
        success ? 1 : 0,
        String(response || '').slice(0, 500) || null,
      ],
    );
  } catch (error) {
    console.error('[telegram] could not write audit log:', error.message);
  }
}

module.exports = {
  CODE_TTL_MINUTES,
  generateCode,
  createLinkCode,
  loadPendingCode,
  loadActiveLinkForUser,
  loadLinkByTelegramUser,
  linkTelegramUser,
  revokeTelegramLink,
  revokeTelegramLinkForUser,
  touchLink,
  logAudit,
};
