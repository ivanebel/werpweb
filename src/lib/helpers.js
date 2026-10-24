'use strict';

const { translate, translator, DEFAULT_LOCALE } = require('./i18n');

const STATUS = {
  // generic
  active: { label: 'Active', tone: 'success' },
  inactive: { label: 'Inactive', tone: 'gray' },
  archived: { label: 'Archived', tone: 'gray' },
  // orders
  draft: { label: 'Draft', tone: 'gray' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  partially_delivered: { label: 'Partially delivered', tone: 'warning' },
  partially_received: { label: 'Partially received', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  received: { label: 'Received', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'error' },
  // invoices / deliveries
  sent: { label: 'Sent', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'error' },
  pending: { label: 'Pending', tone: 'warning' },
  shipped: { label: 'Shipped', tone: 'info' },
  // production
  planned: { label: 'Planned', tone: 'gray' },
  released: { label: 'Released', tone: 'purple' },
  in_progress: { label: 'In progress', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  // employees
  on_leave: { label: 'On leave', tone: 'warning' },
  full_time: { label: 'Full time', tone: 'info' },
  part_time: { label: 'Part time', tone: 'purple' },
  contract: { label: 'Contract', tone: 'warning' },
  intern: { label: 'Intern', tone: 'gray' },
  // products
  finished_good: { label: 'Finished good', tone: 'info' },
  raw_material: { label: 'Raw material', tone: 'warning' },
  consumable: { label: 'Consumable', tone: 'purple' },
  service: { label: 'Service', tone: 'gray' },
};

const TONES = {
  success: 'bg-success-50 text-success-700 ring-success-600/20 dark:bg-success-500/15 dark:text-success-400',
  error: 'bg-error-50 text-error-700 ring-error-600/20 dark:bg-error-500/15 dark:text-error-400',
  warning: 'bg-warning-50 text-warning-700 ring-warning-600/20 dark:bg-warning-500/15 dark:text-warning-400',
  info: 'bg-blue-light-50 text-blue-light-700 ring-blue-light-600/20 dark:bg-blue-light-500/15 dark:text-blue-light-400',
  purple: 'bg-purple-50 text-purple-700 ring-purple-600/20 dark:bg-purple-500/15 dark:text-purple-400',
  gray: 'bg-gray-100 text-gray-700 ring-gray-500/20 dark:bg-gray-500/15 dark:text-gray-400',
};

const TONE_DOTS = {
  success: 'bg-success-500',
  error: 'bg-error-500',
  warning: 'bg-warning-500',
  info: 'bg-blue-light-500',
  purple: 'bg-purple-500',
  gray: 'bg-gray-400',
};

function humanize(value) {
  if (value === null || value === undefined || value === '') return '';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusInfo(value, locale = DEFAULT_LOCALE) {
  const meta = STATUS[value] || { label: humanize(value), tone: 'gray' };
  return { ...meta, label: translate(locale, meta.label) };
}

function statusBadge(value, locale = DEFAULT_LOCALE) {
  if (!value) return '';
  const meta = statusInfo(value, locale);
  return `<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${TONES[meta.tone]}"><span class="h-1.5 w-1.5 rounded-full ${TONE_DOTS[meta.tone]}"></span>${meta.label}</span>`;
}

function statusTone(value, locale = DEFAULT_LOCALE) {
  return TONES[statusInfo(value, locale).tone];
}

function statusDot(value, locale = DEFAULT_LOCALE) {
  return TONE_DOTS[statusInfo(value, locale).tone];
}

function formatMoney(value, currency = 'USD', locale = DEFAULT_LOCALE) {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function compactMoney(value, currency = 'USD', locale = DEFAULT_LOCALE) {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    return `${currency} ${n}`;
  }
}

function formatNumber(value, digits = 2, locale = DEFAULT_LOCALE) {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number(value || 0));
}

function formatQty(value, locale = DEFAULT_LOCALE) {
  const n = Number(value || 0);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(n);
}

function formatDate(value, locale = DEFAULT_LOCALE) {
  if (!value) return '—';
  const raw = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : new Date(value);
  if (Number.isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function formatDateTime(value, locale = DEFAULT_LOCALE) {
  if (!value) return '—';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  }).format(d);
}

function relativeDate(value, locale = DEFAULT_LOCALE) {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.round((Date.now() - d.getTime()) / 86400000);
  if (diff <= 0) return translate(locale, 'Today');
  if (diff === 1) return translate(locale, 'Yesterday');
  if (diff < 30) {
    return locale === 'es-AR' ? `Hace ${diff} días` : `${diff} days ago`;
  }
  return formatDate(value, locale);
}

function initials(name = '') {
  return String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

function toNumber(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function dateOrNull(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function percentChange(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (p === 0) return c > 0 ? 100 : 0;
  return ((c - p) / Math.abs(p)) * 100;
}

function buildQuery(base, overrides = {}) {
  const params = new URLSearchParams();
  Object.entries(overrides).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, v);
  });
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pagination(total, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), totalPages);
  const pages = [];
  const push = (p) => pages.push({ page: p, current: p === current });
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) push(i);
  } else {
    push(1);
    if (current > 3) pages.push({ ellipsis: true });
    for (let i = Math.max(2, current - 1); i <= Math.min(totalPages - 1, current + 1); i++) push(i);
    if (current < totalPages - 2) pages.push({ ellipsis: true });
    push(totalPages);
  }
  return { total, page: current, perPage, totalPages, pages, from: total === 0 ? 0 : (current - 1) * perPage + 1, to: Math.min(current * perPage, total) };
}

function truncate(value, length = 60) {
  const s = String(value || '');
  return s.length > length ? `${s.slice(0, length - 1)}…` : s;
}

function pluralize(count, singular, plural = `${singular}s`, locale = DEFAULT_LOCALE) {
  const word = Number(count) === 1 ? singular : plural;
  return `${formatNumber(count, 0, locale)} ${translate(locale, word)}`;
}

// Stock movement notes are stored as stable English text so an audit trail
// reads correctly in every language. Translate known system notes on display.
function localizeStockNote(note, locale = DEFAULT_LOCALE) {
  const text = String(note || '').trim();
  if (!text) return text;
  const patterns = [
    [/^Received on (.+)$/, 'Received via {number}'],
    [/^Received via (.+)$/, 'Received via {number}'],
    [/^Delivered on (.+)$/, 'Delivered on {date}'],
    [/^Shipped on (.+)$/, 'Shipped on {number}'],
    [/^Cancelled delivery (.+)$/, 'Cancelled delivery {number}'],
    [/^Stock reversal for (.+)$/, 'Stock reversal for {number}'],
  ];
  for (const [pattern, key] of patterns) {
    const match = text.match(pattern);
    if (match) {
      return translate(locale, key, key.includes('{date}') ? { date: match[1] } : { number: match[1] });
    }
  }
  const exact = new Set([
    'Manual adjustment via product form',
    'Material consumed',
    'Finished goods produced',
    'Opening balance adjustment',
  ]);
  return exact.has(text) ? translate(locale, text) : text;
}

function paymentState(invoice, locale = DEFAULT_LOCALE) {
  if (!invoice) return null;
  if (invoice.status === 'paid') return { label: translate(locale, 'Paid'), tone: 'success' };
  const outstanding = Number(invoice.total || 0) - Number(invoice.amount_paid || 0);
  if (outstanding <= 0.005) return { label: translate(locale, 'Paid'), tone: 'success' };
  if (invoice.status === 'overdue') return { label: translate(locale, 'Overdue'), tone: 'error' };
  return { label: translate(locale, 'Outstanding'), tone: 'warning' };
}

function forLocale(locale = DEFAULT_LOCALE) {
  return {
    humanize,
    initials,
    toNumber,
    dateOrNull,
    percentChange,
    buildQuery,
    todayISO,
    addDaysISO,
    pagination,
    truncate,
    TONES,
    statusInfo: (value) => statusInfo(value, locale),
    statusBadge: (value) => statusBadge(value, locale),
    statusTone: (value) => statusTone(value, locale),
    statusDot: (value) => statusDot(value, locale),
    formatMoney: (value, currency = 'USD') => formatMoney(value, currency, locale),
    compactMoney: (value, currency = 'USD') => compactMoney(value, currency, locale),
    formatNumber: (value, digits = 2) => formatNumber(value, digits, locale),
    formatQty: (value) => formatQty(value, locale),
    formatDate: (value) => formatDate(value, locale),
    formatDateTime: (value) => formatDateTime(value, locale),
    relativeDate: (value) => relativeDate(value, locale),
    pluralize: (count, singular, plural) => pluralize(count, singular, plural, locale),
    paymentState: (invoice) => paymentState(invoice, locale),
    localizeStockNote: (note) => localizeStockNote(note, locale),
    t: translator(locale),
  };
}

module.exports = {
  humanize,
  statusInfo,
  statusBadge,
  statusTone,
  statusDot,
  formatMoney,
  compactMoney,
  formatNumber,
  formatQty,
  formatDate,
  formatDateTime,
  relativeDate,
  initials,
  toNumber,
  dateOrNull,
  percentChange,
  buildQuery,
  todayISO,
  addDaysISO,
  pagination,
  truncate,
  pluralize,
  paymentState,
  localizeStockNote,
  forLocale,
  TONES,
};
