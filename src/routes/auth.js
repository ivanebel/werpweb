'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { one, getPool } = require('../db');
const { guestOnly, requireAuth } = require('../middleware/web');

const router = express.Router();

// Very small in-memory throttle: 8 failed attempts per email/IP per 15 minutes.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function key(req, email) {
  return `${req.ip}|${String(email).toLowerCase()}`;
}

function tooMany(req, email) {
  const entry = attempts.get(key(req, email));
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(key(req, email));
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(req, email) {
  const k = key(req, email);
  const entry = attempts.get(k);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(k, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

function safeNext(value, fallback = '/dashboard') {
  const next = String(value || '');
  if (next.startsWith('/') && !next.startsWith('//')) return next;
  return fallback;
}

router.get('/login', guestOnly, (req, res) => {
  res.render('auth/login', {
    title: req.t('Sign in'),
    layout: false,
    next: safeNext(req.query.next, ''),
    email: '',
  });
});

router.post('/login', guestOnly, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const nextUrl = safeNext(req.body.next || req.query.next, '/dashboard');

    if (!email || !password) {
      req.flash('error', 'Enter your email address and password.');
      return res.redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
    }
    if (tooMany(req, email)) {
      req.flash('error', 'Too many failed attempts. Please wait 15 minutes and try again.');
      return res.redirect('/login');
    }

    const user = await one('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    const ok = user && user.is_active && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      recordFailure(req, email);
      req.flash('error', 'Invalid email or password.');
      return res.redirect(`/login?next=${encodeURIComponent(nextUrl)}`);
    }

    attempts.delete(key(req, email));
    await getPool().query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    const selectedLocale = req.session.locale;

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      };
      if (selectedLocale) req.session.locale = selectedLocale;
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.redirect(nextUrl);
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('werp.sid');
    res.redirect('/login');
  });
});

module.exports = router;
