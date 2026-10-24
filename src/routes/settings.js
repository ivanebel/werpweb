'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { query, one, scalar } = require('../db');
const { updateSettings } = require('../lib/settings');
const { requireRole } = require('../middleware/web');

const router = express.Router();

router.get('/settings', async (req, res, next) => {
  try {
    res.render('settings/company', {
      title: req.t('Company settings'),
      active: 'settings',
      breadcrumbs: [{ label: req.t('Settings') }, { label: req.t('Company') }],
      values: res.locals.settings,
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings', requireRole('admin', 'manager'), async (req, res, next) => {
  try {
    const errors = {};
    const values = {
      company_name: String(req.body.company_name || '').trim().slice(0, 180),
      company_email: String(req.body.company_email || '').trim().slice(0, 190),
      company_phone: String(req.body.company_phone || '').trim().slice(0, 40),
      company_address: String(req.body.company_address || '').trim().slice(0, 500),
      company_tax_id: String(req.body.company_tax_id || '').trim().slice(0, 60),
      currency: String(req.body.currency || 'USD').trim().toUpperCase().slice(0, 3),
      default_tax_rate: String(req.body.default_tax_rate || '0').trim(),
      invoice_footer: String(req.body.invoice_footer || '').trim().slice(0, 500),
      fiscal_year_start: String(req.body.fiscal_year_start || '01-01').trim(),
    };
    if (!values.company_name) errors.company_name = req.t('Company name is required.');
    if (!/^[A-Z]{3}$/.test(values.currency)) {
      errors.currency = req.t('Use a 3-letter currency code, e.g. USD or EUR.');
    }
    if (Number.isNaN(Number(values.default_tax_rate)) || Number(values.default_tax_rate) < 0) {
      errors.default_tax_rate = req.t('Tax rate must be a positive number.');
    }
    if (Object.keys(errors).length) {
      return res.status(422).render('settings/company', {
        title: req.t('Company settings'),
        active: 'settings',
        breadcrumbs: [{ label: req.t('Settings') }, { label: req.t('Company') }],
        values: { ...res.locals.settings, ...values },
        errors,
      });
    }
    await updateSettings(values);
    req.flash('success', 'Company settings saved.');
    res.redirect('/settings');
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------- users
router.get('/settings/users', requireRole('admin'), async (req, res, next) => {
  try {
    const users = await query('SELECT id, name, email, role, is_active, last_login_at, created_at FROM users ORDER BY name');
    res.render('settings/users/index', {
      title: req.t('Users'),
      active: 'settings',
      breadcrumbs: [{ label: req.t('Settings') }, { label: req.t('Users') }],
      users,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/settings/users/new', requireRole('admin'), (req, res) => {
  res.render('settings/users/form', {
    title: req.t('New user'),
    active: 'settings',
    breadcrumbs: [
      { label: req.t('Settings') },
      { label: req.t('Users'), href: '/settings/users' },
      { label: req.t('New user') },
    ],
    row: { name: '', email: '', role: 'staff', is_active: 1 },
    errors: {},
    mode: 'create',
    action: '/settings/users',
  });
});

router.post('/settings/users', requireRole('admin'), async (req, res, next) => {
  try {
    const data = {
      name: String(req.body.name || '').trim().slice(0, 120),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 190),
      role: req.body.role,
      is_active: req.body.is_active ? 1 : 0,
      password: String(req.body.password || ''),
      password_confirm: String(req.body.password_confirm || ''),
    };
    const errors = validateUser(data, true, req.t);
    if (Object.keys(errors).length) {
      return res.status(422).render('settings/users/form', {
        title: req.t('New user'),
        active: 'settings',
        breadcrumbs: [
          { label: req.t('Settings') },
          { label: req.t('Users'), href: '/settings/users' },
          { label: req.t('New user') },
        ],
        row: data,
        errors,
        mode: 'create',
        action: '/settings/users',
      });
    }
    await require('../db').getPool().query(
      'INSERT INTO users (name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)',
      [data.name, data.email, bcrypt.hashSync(data.password, 10), data.role, data.is_active],
    );
    req.flash('success', 'User created.');
    res.redirect('/settings/users');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'A user with that email already exists.');
      return res.redirect('/settings/users/new');
    }
    next(err);
  }
});

router.get('/settings/users/:id(\\d+)/edit', requireRole('admin'), async (req, res, next) => {
  try {
    const row = await one('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [req.params.id]);
    if (!row) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('User') })), { status: 404 }));
    }
    res.render('settings/users/form', {
      title: req.t('Edit {name}', { name: row.name }),
      active: 'settings',
      breadcrumbs: [
        { label: req.t('Settings') },
        { label: req.t('Users'), href: '/settings/users' },
        { label: row.name },
      ],
      row,
      errors: {},
      mode: 'edit',
      action: `/settings/users/${row.id}`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/users/:id(\\d+)', requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!existing) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('User') })), { status: 404 }));
    }

    const data = {
      name: String(req.body.name || '').trim().slice(0, 120),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 190),
      role: req.body.role,
      is_active: req.body.is_active ? 1 : 0,
      password: String(req.body.password || ''),
      password_confirm: String(req.body.password_confirm || ''),
    };
    const errors = validateUser(data, false, req.t);
    if (existing.id === req.session.user.id && (data.role !== 'admin' || !data.is_active)) {
      errors.role = req.t('You cannot remove your own administrator access or deactivate yourself.');
    }
    if (existing.role === 'admin' && data.role !== 'admin') {
      const admins = await scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1");
      if (Number(admins) <= 1) errors.role = req.t('At least one active administrator is required.');
    }
    if (Object.keys(errors).length) {
      return res.status(422).render('settings/users/form', {
        title: req.t('Edit {name}', { name: existing.name }),
        active: 'settings',
        breadcrumbs: [
          { label: req.t('Settings') },
          { label: req.t('Users'), href: '/settings/users' },
          { label: existing.name },
        ],
        row: { ...existing, ...data },
        errors,
        mode: 'edit',
        action: `/settings/users/${existing.id}`,
      });
    }

    const sets = ['name = ?', 'email = ?', 'role = ?', 'is_active = ?'];
    const params = [data.name, data.email, data.role, data.is_active];
    if (data.password) {
      sets.push('password_hash = ?');
      params.push(bcrypt.hashSync(data.password, 10));
    }
    params.push(existing.id);
    await require('../db').getPool().query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

    if (existing.id === req.session.user.id) {
      req.session.user.name = data.name;
      req.session.user.email = data.email;
      req.session.user.role = data.role;
    }
    req.flash('success', 'User updated.');
    res.redirect('/settings/users');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'A user with that email already exists.');
      return res.redirect(`/settings/users/${req.params.id}/edit`);
    }
    next(err);
  }
});

router.post('/settings/users/:id(\\d+)/delete', requireRole('admin'), async (req, res, next) => {
  try {
    const existing = await one('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!existing) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('User') })), { status: 404 }));
    }
    if (existing.id === req.session.user.id) {
      req.flash('error', 'You cannot delete your own account.');
      return res.redirect('/settings/users');
    }
    if (existing.role === 'admin') {
      const admins = await scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1");
      if (Number(admins) <= 1) {
        req.flash('error', 'At least one active administrator is required.');
        return res.redirect('/settings/users');
      }
    }
    await require('../db').getPool().query('DELETE FROM users WHERE id = ?', [existing.id]);
    req.flash('success', 'User deleted.');
    res.redirect('/settings/users');
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- profile
router.get('/profile', async (req, res, next) => {
  try {
    const row = await one('SELECT id, name, email, role, last_login_at FROM users WHERE id = ?', [req.session.user.id]);
    res.render('settings/profile', {
      title: req.t('My profile'),
      active: 'profile',
      breadcrumbs: [{ label: req.t('My profile') }],
      row,
      errors: {},
    });
  } catch (err) {
    next(err);
  }
});

router.post('/profile', async (req, res, next) => {
  try {
    const row = await one('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const name = String(req.body.name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 190);
    const current_password = String(req.body.current_password || '');
    const password = String(req.body.password || '');
    const password_confirm = String(req.body.password_confirm || '');
    const errors = {};
    if (!name) errors.name = req.t('Name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = req.t('A valid email is required.');
    if (password && password.length < 8) errors.password = req.t('Password must be at least 8 characters.');
    if (password !== password_confirm) errors.password_confirm = req.t('Passwords do not match.');
    if ((password || email !== row.email) && !bcrypt.compareSync(current_password, row.password_hash)) {
      errors.current_password = req.t('Enter your current password to change your email or password.');
    }
    if (Object.keys(errors).length) {
      return res.status(422).render('settings/profile', {
        title: req.t('My profile'),
        active: 'profile',
        breadcrumbs: [{ label: req.t('My profile') }],
        row: { ...row, name, email },
        errors,
      });
    }

    const sets = ['name = ?', 'email = ?'];
    const params = [name, email];
    if (password) {
      sets.push('password_hash = ?');
      params.push(bcrypt.hashSync(password, 10));
    }
    params.push(row.id);
    await require('../db').getPool().query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    req.session.user.name = name;
    req.session.user.email = email;
    req.flash('success', 'Profile updated.');
    res.redirect('/profile');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'That email address is already in use.');
      return res.redirect('/profile');
    }
    next(err);
  }
});

function validateUser(data, requirePassword, t = (value) => value) {
  const errors = {};
  if (!data.name) errors.name = t('Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = t('A valid email is required.');
  if (!['admin', 'manager', 'staff'].includes(data.role)) errors.role = t('Choose a valid role.');
  if (requirePassword || data.password) {
    if (data.password.length < 8) errors.password = t('Password must be at least 8 characters.');
    if (data.password !== data.password_confirm) errors.password_confirm = t('Passwords do not match.');
  }
  return errors;
}

module.exports = router;
