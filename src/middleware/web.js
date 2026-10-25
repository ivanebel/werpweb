'use strict';

const crypto = require('node:crypto');
const { getSettings } = require('../lib/settings');
const helpers = require('../lib/helpers');
const i18n = require('../lib/i18n');

function locale(req, res, next) {
  const selected = i18n.getRequestLocale(req);
  req.locale = selected;
  req.t = i18n.translator(selected);
  res.locals.locale = selected;
  res.locals.locales = i18n.LOCALES;
  res.locals.localeLabel = i18n.localeLabel(selected);
  res.locals.t = req.t;
  next();
}

function sessionFlash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.flash = (type, message, params) => {
    req.session.flash = { type, message, params: params || null };
  };
  next();
}

function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const supplied = (req.body && req.body._csrf) || req.get('x-csrf-token');
    if (!supplied || supplied !== req.session.csrfToken) {
      const err = new Error(
        req.t('Your form session expired or the request was invalid. Please reload the page and try again.'),
      );
      err.status = 403;
      return next(err);
    }
  }
  return next();
}

async function webLocals(req, res, next) {
  try {
    const settings = await getSettings();
    const currency = settings.currency || 'USD';
    const h = helpers.forLocale(req.locale);
    // Credentials are only for server-side email code. Never expose the SMTP
    // password to EJS templates or client-side scripts.
    const publicSettings = { ...settings };
    delete publicSettings.smtp_password;
    res.locals.settings = publicSettings;
    res.locals.currency = currency;
    res.locals.currentUser = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.query = req.query || {};
    res.locals.money = (v) => h.formatMoney(v, currency);
    res.locals.compactMoney = (v) => h.compactMoney(v, currency);
    res.locals.statusBadge = h.statusBadge;
    res.locals.statusTone = h.statusTone;
    res.locals.statusDot = h.statusDot;
    res.locals.h = h;
    res.locals.htmlLang = req.locale;
    res.locals.jsMessages = {
      vatIncluded: req.t('VAT included'),
      taxIncluded: req.t('incl. {amount} VAT', { amount: '{amount}' }),
      customerCode: req.t('Customer code'),
      customerCodeLine: req.t('Customer code: {code}', { code: '{code}' }),
      lightMode: req.t('Light mode'),
      darkMode: req.t('Dark mode'),
      collapseSidebar: req.t('Collapse sidebar'),
      expandSidebar: req.t('Expand sidebar'),
      revenue: req.t('Revenue'),
      purchases: req.t('Purchases'),
      orders: req.t('Orders'),
      tickets: req.t('Tickets'),
      sales90: req.t('90-day sales'),
      noData: req.t('No data'),
    };
    res.locals.title = req.t('Dashboard');
    res.locals.active = '';
    res.locals.breadcrumbs = [];
    res.locals.bodyClass = '';
    next();
  } catch (err) {
    next(err);
  }
}

function localizeResponses(req, res, next) {
  const originalRender = res.render.bind(res);
  res.render = (view, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const locals = typeof options === 'function' ? {} : options || {};
    originalRender(view, locals, (err, html) => {
      if (err) {
        if (done) return done(err);
        return next(err);
      }
      const localized = i18n.localizeHtml(html, req.locale);
      if (done) return done(null, localized);
      return res.send(localized);
    });
  };
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.method === 'GET' && req.accepts('html')) {
      const target = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?next=${target}`);
    }
    return res.status(401).json({ error: req.t('Authentication required') });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      const err = new Error(req.t('You do not have permission to access this page.'));
      err.status = 403;
      return next(err);
    }
    return next();
  };
}

function guestOnly(req, res, next) {
  if (req.session.user) return res.redirect('/dashboard');
  return next();
}

module.exports = {
  locale,
  sessionFlash,
  csrf,
  webLocals,
  localizeResponses,
  requireAuth,
  requireRole,
  guestOnly,
};
