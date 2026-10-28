'use strict';

const config = require('../../config');

const STATUS_LABELS = {
  planned: 'Planificada',
  released: 'Liberada',
  in_progress: 'En proceso',
  completed: 'Completada',
  cancelled: 'Cancelada',
};

const STATUS_FILTERS = {
  planificadas: ['planned'],
  planificada: ['planned'],
  liberadas: ['released'],
  liberada: ['released'],
  'en-proceso': ['in_progress'],
  'en proceso': ['in_progress'],
  proceso: ['in_progress'],
  completadas: ['completed'],
  completada: ['completed'],
  canceladas: ['cancelled'],
  cancelada: ['cancelled'],
  activas: ['planned', 'released', 'in_progress'],
  todas: ['planned', 'released', 'in_progress', 'completed', 'cancelled'],
};

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatQty(value) {
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 }).format(n);
  } catch {
    return String(n);
  }
}

function formatDate(value) {
  if (!value) return '—';
  const raw = String(value).slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return escapeHtml(raw);
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || escapeHtml(status || '');
}

function statusesForFilter(filter) {
  const normalized = String(filter || '').trim().toLowerCase();
  return STATUS_FILTERS[normalized] || STATUS_FILTERS.activas;
}

function filterLabel(statuses) {
  const labels = (statuses || []).map(statusLabel);
  return labels.length ? labels.join(', ') : 'Activas';
}

function orderLink(order) {
  const base = config.telegram.appPublicUrl;
  if (!base || !order || !order.id) return '';
  return `<a href="${escapeHtml(base)}/manufacturing/production-orders/${Number(order.id)}/readonly">Abrir en el ERP</a>`;
}

function helpMessage() {
  const bot = config.telegram.username ? `@${config.telegram.username}` : null;
  const botPhrase = bot ? ` a ${escapeHtml(bot)}` : ' al bot de Telegram de la empresa';
  return [
    '<b>Consultas de producción</b>',
    '',
    '/produccion — órdenes activas',
    '/produccion planificadas',
    '/produccion liberadas',
    '/produccion en-proceso',
    '/produccion todas',
    '/orden PRD-2026-0006 — detalle de una orden',
    '/faltantes — órdenes con faltantes de materiales',
    '/vincular CODIGO — vincular tu cuenta del ERP',
    '/desvincular — quitar el vínculo actual',
    '',
    `Para vincular tu cuenta, ingresá a <b>Mi perfil</b> en el ERP, generá un código y enviá <code>/vincular CODIGO</code>${botPhrase}.`,
  ].join('\n');
}

function linkInstructions() {
  const bot = config.telegram.username ? `@${config.telegram.username}` : null;
  const botPhrase = bot ? ` a ${escapeHtml(bot)}` : ' al bot de Telegram de la empresa';
  return [
    '<b>Tu cuenta todavía no está vinculada.</b>',
    '',
    '1. Ingresá a <b>Mi perfil</b> en el ERP.',
    '2. Generá un código de vinculación de Telegram.',
    `3. Enviá <code>/vincular CODIGO</code>${botPhrase}.`,
    '',
    'El código vence a los 10 minutos.',
  ].join('\n');
}

function linkedMessage(user) {
  return [
    `<b>Cuenta vinculada</b> como ${escapeHtml(user.name)} (${escapeHtml(user.role)}).`,
    '',
    'Ya podés usar /produccion, /orden y /faltantes.',
  ].join('\n');
}

function formatOrderList(result, statuses) {
  const orders = result.orders || [];
  if (!orders.length) {
    return `No hay órdenes de producción para el filtro <b>${escapeHtml(filterLabel(statuses))}</b>.`;
  }
  const parts = [`<b>Órdenes de producción</b> · ${escapeHtml(filterLabel(statuses))}`, ''];
  for (const order of orders) {
    parts.push(`<b>${escapeHtml(order.production_no)}</b> · ${statusLabel(order.status)}`);
    if (order.products && order.products.length) {
      for (const product of order.products) {
        parts.push(`• ${escapeHtml(product.name)} — ${formatQty(product.quantity)} ${escapeHtml(product.unit)}`);
      }
    } else {
      parts.push('• Sin productos cargados');
    }
    if (order.due_date) parts.push(`Vence: ${formatDate(order.due_date)}`);
    if (order.customer_name || order.order_no) {
      parts.push(`Cliente: ${escapeHtml(order.customer_name || '')}${order.order_no ? ` · ${escapeHtml(order.order_no)}` : ''}`);
    }
    const link = orderLink(order);
    if (link) parts.push(link);
    parts.push('');
  }
  if (result.total > result.shown) {
    parts.push(`Hay ${result.total - result.shown} orden(es) más. Usá un filtro más específico o mirá el ERP.`);
    parts.push('');
  }
  parts.push(`Total: ${result.total} orden(es)`);
  return parts.join('\n');
}

function formatOrderDetail(order, lines, requirements) {
  const parts = [
    `<b>${escapeHtml(order.production_no)}</b> · ${statusLabel(order.status)}`,
  ];
  if (order.start_date) parts.push(`Inicio: ${formatDate(order.start_date)}`);
  if (order.due_date) parts.push(`Vence: ${formatDate(order.due_date)}`);
  if (order.completed_at) parts.push(`Completada: ${formatDate(order.completed_at)}`);
  if (order.customer_name || order.order_no) {
    parts.push(`Cliente: ${escapeHtml(order.customer_name || '')}${order.order_no ? ` · ${escapeHtml(order.order_no)}` : ''}`);
  }
  parts.push('', '<b>Productos</b>');
  if (lines.length) {
    for (const line of lines) {
      parts.push(`• ${escapeHtml(line.name)} — ${formatQty(line.quantity)} ${escapeHtml(line.unit)}`);
      if (line.lot_number) parts.push(`  Lote: ${escapeHtml(line.lot_number)}`);
      if (line.expiry_date) parts.push(`  Vence: ${formatDate(line.expiry_date)}`);
    }
  } else {
    parts.push('• Sin productos cargados');
  }

  parts.push('', '<b>Materiales</b>');
  if (requirements.length) {
    const visible = requirements.slice(0, 15);
    for (const requirement of visible) {
      const name = requirement.material_name || requirement.class_name || requirement.component_name || 'Material';
      parts.push(`• ${escapeHtml(name)}: ${formatQty(requirement.quantity_required)} ${escapeHtml(requirement.unit)}`);
      parts.push(
        `  Asignado ${formatQty(requirement.quantity_allocated)} · Consumido ${formatQty(requirement.quantity_consumed)} · Faltante ${formatQty(requirement.shortage_qty)}`,
      );
    }
    if (requirements.length > visible.length) {
      parts.push(`… y ${requirements.length - visible.length} material(es) más.`);
    }
    const shortage = requirements.filter((row) => Number(row.shortage_qty) > 0.0005);
    parts.push('');
    parts.push(shortage.length ? '<b>Hay faltantes de materiales.</b>' : '<b>Sin faltantes de materiales.</b>');
  } else {
    parts.push('• Sin requerimientos de materiales.');
  }

  const link = orderLink(order);
  if (link) parts.push('', link);
  return parts.join('\n');
}

function formatShortages(result) {
  const orders = result.orders || [];
  if (!orders.length) return '<b>Sin faltantes</b>\nNo hay órdenes activas con faltantes de materiales.';
  const parts = ['<b>Órdenes con faltantes de materiales</b>', ''];
  for (const order of orders) {
    parts.push(`<b>${escapeHtml(order.production_no)}</b> · ${statusLabel(order.status)}`);
    if (order.due_date) parts.push(`Vence: ${formatDate(order.due_date)}`);
    for (const material of order.materials) {
      parts.push(`• ${escapeHtml(material.name)}: faltan ${formatQty(material.shortage_qty)} ${escapeHtml(material.unit)}`);
    }
    const link = orderLink(order);
    if (link) parts.push(link);
    parts.push('');
  }
  if (result.total > result.shown) {
    parts.push(`Hay ${result.total - result.shown} orden(es) más con faltantes.`);
    parts.push('');
  }
  parts.push(`Total: ${result.total} orden(es)`);
  return parts.join('\n');
}

function trimMessage(text) {
  const value = String(text || '');
  if (value.length <= 4096) return value;
  return `${value.slice(0, 3900)}\n… mensaje truncado.`;
}

module.exports = {
  STATUS_LABELS,
  STATUS_FILTERS,
  escapeHtml,
  formatQty,
  formatDate,
  statusLabel,
  statusesForFilter,
  filterLabel,
  orderLink,
  helpMessage,
  linkInstructions,
  linkedMessage,
  formatOrderList,
  formatOrderDetail,
  formatShortages,
  trimMessage,
};
