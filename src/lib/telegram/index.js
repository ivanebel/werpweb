'use strict';

const config = require('../../config');
const { query, one } = require('../../db');
const client = require('./client');
const commands = require('./commands');
const links = require('./links');

const RATE_LIMIT_PER_MINUTE = 20;
let running = false;
let pollController = null;
let loopPromise = null;
const rateBuckets = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadOffset() {
  const row = await one('SELECT last_update_id FROM telegram_bot_state WHERE id = 1 LIMIT 1');
  return row ? Number(row.last_update_id) || 0 : 0;
}

async function saveOffset(offset) {
  await query(
    `INSERT INTO telegram_bot_state (id, last_update_id)
     VALUES (1, ?)
     ON DUPLICATE KEY UPDATE last_update_id = VALUES(last_update_id)`,
    [offset],
  );
}

function rateLimited(telegramUserId) {
  const now = Date.now();
  const recent = (rateBuckets.get(telegramUserId) || []).filter((time) => now - time < 60000);
  if (recent.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(telegramUserId, recent);
    return true;
  }
  recent.push(now);
  rateBuckets.set(telegramUserId, recent);
  if (rateBuckets.size > 500) {
    for (const [key, bucket] of rateBuckets.entries()) {
      if (!bucket.some((time) => now - time < 60000)) rateBuckets.delete(key);
    }
  }
  return false;
}

async function processUpdate(update) {
  const message = update.message;
  if (!message || !message.chat || !message.from) return;
  if (message.chat.type !== 'private') return;
  const text = String(message.text || '').trim();
  if (!text) return;

  const telegramUserId = Number(message.from.id);
  if (rateLimited(telegramUserId)) {
    try {
      await client.sendMessage(message.chat.id, 'Demasiadas consultas seguidas. Esperá un minuto e intentá de nuevo.');
    } catch {
      // Ignore rate-limit delivery errors.
    }
    await links.logAudit({
      userId: null,
      telegramUserId,
      chatId: message.chat.id,
      command: text,
      success: false,
      response: 'Rate limited',
    });
    return;
  }

  let result = null;
  try {
    result = await commands.handleMessage(message, message.chat);
    if (!result || !result.text) return;
    await client.sendMessage(message.chat.id, result.text);
    await links.logAudit({
      userId: result.user ? result.user.id : null,
      telegramUserId,
      chatId: message.chat.id,
      command: text,
      success: true,
      response: result.text,
    });
  } catch (error) {
    console.error('[telegram] command failed:', error.message);
    try {
      await client.sendMessage(
        message.chat.id,
        'No pude procesar el comando. Intentá de nuevo en unos segundos.',
      );
    } catch (sendError) {
      console.error('[telegram] could not send error message:', sendError.message);
    }
    await links.logAudit({
      userId: result && result.user ? result.user.id : null,
      telegramUserId,
      chatId: message.chat.id,
      command: text,
      success: false,
      response: error.message,
    });
  }
}

async function pollLoop() {
  let offset = await loadOffset();
  while (running) {
    pollController = new AbortController();
    try {
      const updates = await client.getUpdates(
        offset,
        config.telegram.pollTimeoutSeconds,
        pollController.signal,
      );
      for (const update of updates) {
        offset = Math.max(offset, Number(update.update_id) + 1);
        await processUpdate(update);
        await saveOffset(offset);
      }
    } catch (error) {
      if (!running) break;
      console.error('[telegram] polling error:', error.message);
      await sleep(5000);
    } finally {
      pollController = null;
    }
  }
}

async function startTelegramBot() {
  if (!config.telegram.enabled) {
    console.log('[telegram] disabled (TELEGRAM_ENABLED is not true)');
    return () => {};
  }
  if (!config.telegram.token) {
    console.log('[telegram] disabled (TELEGRAM_BOT_TOKEN is missing)');
    return () => {};
  }

  try {
    const me = await client.getMe();
    console.log(`[telegram] bot @${me.username || me.first_name || me.id} ready`);
  } catch (error) {
    console.error('[telegram] could not connect to Telegram:', error.message);
    return () => {};
  }

  running = true;
  loopPromise = pollLoop().catch((error) => {
    console.error('[telegram] polling stopped:', error.message);
  });
  const stop = async () => {
    running = false;
    if (pollController) pollController.abort();
    if (loopPromise) await loopPromise.catch(() => {});
    console.log('[telegram] stopped');
  };
  return stop;
}

async function stopTelegramBot() {
  running = false;
  if (pollController) pollController.abort();
  if (loopPromise) await loopPromise.catch(() => {});
}

module.exports = {
  startTelegramBot,
  stopTelegramBot,
  processUpdate,
  rateLimited,
};
