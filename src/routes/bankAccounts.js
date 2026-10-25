'use strict';

const express = require('express');
const { query, one } = require('../db');
const { pagination } = require('../lib/helpers');

const router = express.Router();
const basePath = '/bank-accounts';

function parseOwner(value) {
  const raw = String(value || '').trim();
  if (raw === 'company') return { type: 'company', id: null };
  const match = raw.match(/^(customer|supplier):(\d+)$/);
  if (!match) return null;
  const id = Number.parseInt(match[2], 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { type: match[1], id };
}

function ownerValue(account) {
  return account.owner_type === 'company' ? 'company' : `${account.owner_type}:${account.owner_id}`;
}

async function ownerOptions() {
  const [customers, suppliers] = await Promise.all([
    query('SELECT id, company_name FROM customers ORDER BY company_name'),
    query('SELECT id, company_name FROM suppliers ORDER BY company_name'),
  ]);
  return { customers, suppliers };
}

async function validateAccount(body, existingId = 0) {
  const errors = {};
  const owner = parseOwner(body.owner);
  if (!owner) {
    errors.owner = 'Choose the account owner.';
  } else if (owner.type === 'customer' && owner.id) {
    const customer = await one('SELECT id FROM customers WHERE id = ? LIMIT 1', [owner.id]);
    if (!customer) errors.owner = 'The selected owner was not found.';
  } else if (owner.type === 'supplier' && owner.id) {
    const supplier = await one('SELECT id FROM suppliers WHERE id = ? LIMIT 1', [owner.id]);
    if (!supplier) errors.owner = 'The selected owner was not found.';
  }

  const bankName = String(body.bank_name || '').trim().slice(0, 120);
  if (!bankName) errors.bank_name = 'Bank name is required.';

  const accountNumber = String(body.account_number || '').trim().slice(0, 60) || null;
  const cbu = String(body.cbu || '').replace(/[\s-]/g, '').trim() || null;
  const alias = String(body.alias || '').trim().slice(0, 60) || null;
  const notes = String(body.notes || '').trim().slice(0, 500) || null;

  if (cbu && !/^\d{22}$/.test(cbu)) {
    errors.cbu = 'CBU must contain exactly 22 digits.';
  }
  if (!accountNumber && !cbu && !alias) {
    errors._form = ['Enter an account number, CBU or alias.'];
  }

  if (cbu && !errors.cbu) {
    const duplicate = await one(
      `SELECT id FROM bank_accounts WHERE cbu = ? ${existingId ? 'AND id <> ?' : ''} LIMIT 1`,
      existingId ? [cbu, existingId] : [cbu],
    );
    if (duplicate) errors.cbu = 'This CBU is already registered.';
  }
  if (alias) {
    const duplicate = await one(
      `SELECT id FROM bank_accounts WHERE alias = ? ${existingId ? 'AND id <> ?' : ''} LIMIT 1`,
      existingId ? [alias, existingId] : [alias],
    );
    if (duplicate) errors.alias = 'This alias is already registered.';
  }

  return {
    errors,
    data: {
      owner_type: owner ? owner.type : 'company',
      owner_id: owner ? owner.id : null,
      bank_name: bankName,
      account_number: accountNumber,
      cbu,
      alias,
      notes,
    },
  };
}

async function renderForm(req, res, status, options) {
  const owners = await ownerOptions();
  return res.status(status).render('bank-accounts/form', {
    title: options.title,
    active: 'bank-accounts',
    breadcrumbs: [
      { label: req.t('Bank accounts'), href: basePath },
      { label: options.title },
    ],
    mode: options.mode,
    action: options.action,
    account: options.account || null,
    row: options.row,
    errors: options.errors || {},
    owners,
  });
}

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const ownerType = ['company', 'customer', 'supplier'].includes(String(req.query.owner_type || ''))
      ? String(req.query.owner_type)
      : '';
    const where = [];
    const params = [];
    if (search) {
      where.push(`(ba.bank_name LIKE ? OR ba.account_number LIKE ? OR ba.cbu LIKE ? OR ba.alias LIKE ? OR ba.notes LIKE ? OR c.company_name LIKE ? OR s.company_name LIKE ?)`);
      params.push(
        `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`,
        `%${search}%`, `%${search}%`, `%${search}%`,
      );
    }
    if (ownerType) {
      where.push('ba.owner_type = ?');
      params.push(ownerType);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const joins = `
      LEFT JOIN customers c ON ba.owner_type = 'customer' AND c.id = ba.owner_id
      LEFT JOIN suppliers s ON ba.owner_type = 'supplier' AND s.id = ba.owner_id`;
    const total = Number(
      (await one(`SELECT COUNT(*) AS total FROM bank_accounts ba ${joins} ${whereSql}`, params)).total || 0,
    );
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pag = pagination(total, page, 20);
    const rows = await query(
      `SELECT ba.*,
              CASE ba.owner_type
                WHEN 'customer' THEN c.company_name
                WHEN 'supplier' THEN s.company_name
                ELSE NULL
              END AS owner_name
         FROM bank_accounts ba
         ${joins}
         ${whereSql}
        ORDER BY ba.owner_type ASC, owner_name ASC, ba.bank_name ASC, ba.id ASC
        LIMIT ? OFFSET ?`,
      [...params, pag.perPage, (pag.page - 1) * pag.perPage],
    );

    res.render('bank-accounts/index', {
      title: req.t('Bank accounts'),
      active: 'bank-accounts',
      breadcrumbs: [{ label: req.t('Bank accounts') }],
      rows,
      pagination: pag,
      search,
      ownerType,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const requestedOwner = parseOwner(req.query.owner);
    await renderForm(req, res, 200, {
      title: req.t('New bank account'),
      mode: 'create',
      action: basePath,
      row: {
        owner: requestedOwner ? (requestedOwner.type === 'company' ? 'company' : `${requestedOwner.type}:${requestedOwner.id}`) : 'company',
        bank_name: '',
        account_number: '',
        cbu: '',
        alias: '',
        notes: '',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = await validateAccount(req.body);
    if (Object.keys(errors).length) {
      return renderForm(req, res, 422, {
        title: req.t('New bank account'),
        mode: 'create',
        action: basePath,
        row: req.body,
        errors,
      });
    }
    await query(
      `INSERT INTO bank_accounts
         (owner_type, owner_id, bank_name, account_number, cbu, alias, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.owner_type, data.owner_id, data.bank_name, data.account_number, data.cbu, data.alias, data.notes],
    );
    req.flash('success', 'Bank account created.');
    res.redirect(basePath);
  } catch (err) {
    next(err);
  }
});

router.get('/:id(\\d+)/edit', async (req, res, next) => {
  try {
    const account = await one('SELECT * FROM bank_accounts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!account) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Bank account') })), { status: 404 }));
    }
    await renderForm(req, res, 200, {
      title: req.t('Edit bank account'),
      mode: 'edit',
      action: `${basePath}/${account.id}`,
      account,
      row: { ...account, owner: ownerValue(account) },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)', async (req, res, next) => {
  try {
    const account = await one('SELECT * FROM bank_accounts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!account) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Bank account') })), { status: 404 }));
    }
    const { errors, data } = await validateAccount(req.body, account.id);
    if (Object.keys(errors).length) {
      return renderForm(req, res, 422, {
        title: req.t('Edit bank account'),
        mode: 'edit',
        action: `${basePath}/${account.id}`,
        account,
        row: req.body,
        errors,
      });
    }
    await query(
      `UPDATE bank_accounts
          SET owner_type = ?, owner_id = ?, bank_name = ?, account_number = ?,
              cbu = ?, alias = ?, notes = ?
        WHERE id = ?`,
      [data.owner_type, data.owner_id, data.bank_name, data.account_number, data.cbu, data.alias, data.notes, account.id],
    );
    req.flash('success', 'Bank account updated.');
    res.redirect(basePath);
  } catch (err) {
    next(err);
  }
});

router.post('/:id(\\d+)/delete', async (req, res, next) => {
  try {
    const account = await one('SELECT id FROM bank_accounts WHERE id = ? LIMIT 1', [req.params.id]);
    if (!account) {
      return next(Object.assign(new Error(req.t('{item} not found.', { item: req.t('Bank account') })), { status: 404 }));
    }
    await query('DELETE FROM bank_accounts WHERE id = ?', [account.id]);
    req.flash('success', 'Bank account deleted.');
    res.redirect(basePath);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
