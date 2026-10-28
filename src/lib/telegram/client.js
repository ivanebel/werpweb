'use strict';

const config = require('../../config');

const API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 35000;

function token() {
  if (!config.telegram.token) {
    throw new Error('Telegram bot token is not configured.');
  }
  return config.telegram.token;
}

async function call(method, payload = {}, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(`${API_BASE}/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: signal || AbortSignal.timeout(timeoutMs),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || !body || body.ok !== true) {
    const error = new Error(
      (body && body.description) || `Telegram API request failed (${response.status}).`,
    );
    error.status = response.status;
    error.telegram = body;
    throw error;
  }
  return body.result;
}

function getMe(options = {}) {
  return call('getMe', {}, options);
}

function getUpdates(offset, timeoutSeconds, signal) {
  return call(
    'getUpdates',
    {
      offset,
      timeout: Math.max(0, Math.min(50, Number(timeoutSeconds) || 25)),
      allowed_updates: ['message'],
    },
    { signal, timeoutMs: (Number(timeoutSeconds) || 25) * 1000 + 15000 },
  );
}

function sendMessage(chatId, text, options = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text: String(text || '').slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...options,
  });
}

module.exports = {
  call,
  getMe,
  getUpdates,
  sendMessage,
};
