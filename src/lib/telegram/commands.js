'use strict';

const links = require('./links');
const queries = require('./queries');
const format = require('./formatters');

function normalizeWord(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return { command: null, args: '' };
  const parts = raw.split(/\s+/);
  const command = normalizeWord(parts[0].slice(1).split('@')[0]);
  return { command, args: parts.slice(1).join(' ').trim() };
}

function telegramUserFromMessage(message, chat) {
  const from = message.from || {};
  return {
    id: Number(from.id),
    chatId: Number(chat.id),
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null,
  };
}

async function handleMessage(message, chat) {
  const text = String(message.text || '');
  const { command, args } = parseCommand(text);
  const telegramUser = telegramUserFromMessage(message, chat);

  if (!command) {
    const existing = await links.loadLinkByTelegramUser(telegramUser.id);
    return {
      text: existing && existing.is_active ? format.helpMessage() : format.linkInstructions(),
      user: existing || null,
    };
  }

  if (command === 'vincular' || command === 'link') {
    const code = args.split(/\s+/)[0] || '';
    if (!code) {
      return {
        text: 'Usá <code>/vincular CODIGO</code> con el código que generaste en <b>Mi perfil</b>.',
        user: null,
      };
    }
    const result = await links.linkTelegramUser(code, telegramUser);
    if (result.ok) {
      return { text: format.linkedMessage(result.user), user: result.user };
    }
    if (result.reason === 'inactive_user') {
      return { text: 'El usuario del ERP está inactivo. Hablá con un administrador.', user: null };
    }
    return {
      text: 'Código inválido o vencido. Generá uno nuevo desde <b>Mi perfil</b> en el ERP.',
      user: null,
    };
  }

  if (command === 'desvincular' || command === 'unlink') {
    await links.revokeTelegramLink(telegramUser.id);
    return {
      text: 'Tu cuenta de Telegram fue desvinculada del ERP.',
      user: null,
    };
  }

  if (['start', 'ayuda', 'help', 'comandos'].includes(command)) {
    return { text: format.helpMessage(), user: null };
  }

  const link = await links.loadLinkByTelegramUser(telegramUser.id);
  if (!link || Number(link.is_active) !== 1) {
    return { text: format.linkInstructions(), user: null };
  }
  await links.touchLink(link.id);

  if (['produccion', 'producciones', 'ordenes'].includes(command)) {
    const statuses = format.statusesForFilter(args || 'activas');
    const result = await queries.listProductionOrders(statuses, 10);
    return { text: format.formatOrderList(result, statuses), user: link };
  }

  if (['orden', 'op', 'detalle'].includes(command)) {
    const reference = args.split(/\s+/)[0] || '';
    if (!reference) {
      return { text: 'Usá <code>/orden PRD-2026-0006</code>.', user: link };
    }
    const order = await queries.findProductionOrder(reference);
    if (!order) {
      return {
        text: `No encontré la orden <b>${format.escapeHtml(reference)}</b>. Probá con <code>/produccion</code> para ver las órdenes activas.`,
        user: link,
      };
    }
    const [orderLines, requirements] = await Promise.all([
      queries.getOrderLines(order.id),
      queries.getOrderRequirements(order.id),
    ]);
    return {
      text: format.formatOrderDetail(order, orderLines, requirements),
      user: link,
    };
  }

  if (command === 'faltantes' || command === 'faltante') {
    const result = await queries.listShortageOrders(queries.ACTIVE_STATUSES, 10);
    return { text: format.formatShortages(result), user: link };
  }

  return { text: format.helpMessage(), user: link };
}

module.exports = {
  normalizeWord,
  parseCommand,
  telegramUserFromMessage,
  handleMessage,
};
