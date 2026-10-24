'use strict';

const express = require('express');
const i18n = require('../lib/i18n');

const router = express.Router();

function safeNext(value, fallback = '/dashboard') {
  const next = String(value || '');
  if (next.startsWith('/') && !next.startsWith('//')) return next;
  return fallback;
}

router.post('/language', (req, res, next) => {
  const selected = i18n.normalizeLocale(req.body.locale) || i18n.DEFAULT_LOCALE;
  req.session.locale = selected;
  res.cookie(i18n.LOCALE_COOKIE, selected, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: false,
    secure: req.secure,
    path: '/',
  });
  const fallback = req.session.user ? '/dashboard' : '/login';
  const target = safeNext(req.body.next, fallback);
  // Persist before redirecting so the next request renders in the new locale.
  req.session.save((err) => {
    if (err) return next(err);
    return res.redirect(target);
  });
});

module.exports = router;
