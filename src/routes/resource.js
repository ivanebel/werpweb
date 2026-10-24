'use strict';

const express = require('express');
const { query, one, scalar } = require('../db');
const { nextNumber } = require('../lib/sequences');
const { translator } = require('../lib/i18n');

const PER_PAGE = 12;

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function defaultsFrom(fields) {
  const row = {};
  for (const f of fields) {
    row[f.name] = f.default !== undefined ? f.default : f.type === 'checkbox' ? 0 : '';
  }
  return row;
}

async function resolveOptions(fields) {
  return Promise.all(
    fields.map(async (f) => {
      if (typeof f.optionsFrom !== 'function') return f;
      try {
        return { ...f, options: await f.optionsFrom() };
      } catch (err) {
        console.error(`[resource] options for ${f.name} failed:`, err.message);
        return { ...f, options: [] };
      }
    }),
  );
}

function localizeFields(fields, t) {
  return fields.map((f) => ({
    ...f,
    label: t(f.label),
    help: f.help ? t(f.help) : f.help,
    placeholder: f.placeholder ? t(f.placeholder) : f.placeholder,
    section: f.section ? t(f.section) : f.section,
    options: f.options ? f.options.map((o) => ({ ...o, label: t(o.label) })) : f.options,
  }));
}

function localizeFilters(filters, t) {
  return filters.map((f) => {
    const label = t(f.label);
    return {
      ...f,
      label,
      allLabel: t(`All ${String(f.label).toLowerCase()}`),
      options: f.options ? f.options.map((o) => ({ ...o, label: t(o.label) })) : f.options,
    };
  });
}

function localizeColumns(columns, t) {
  return columns.map((c) => ({ ...c, label: t(c.label) }));
}

function localizeRelated(sections, t) {
  return (sections || []).map((section) => ({
    ...section,
    title: t(section.title),
    emptyText: section.emptyText ? t(section.emptyText) : section.emptyText,
    columns: localizeColumns(section.columns || [], t),
  }));
}

function localizedConfig(config, locale) {
  const t = translator(locale);
  const title = t(config.title);
  const singular = t(config.singular);
  return {
    ...config,
    title,
    singular,
    singularLower: singular.toLowerCase(),
    titleLower: title.toLowerCase(),
    newLabel: t(`New ${config.singular}`),
    editLabel: t(`Edit ${config.singular}`),
    indexSubtitle: t('Create, edit and review your {items}.', { items: title.toLowerCase() }),
    fields: localizeFields(config.fields || [], t),
    filters: localizeFilters(config.filters || [], t),
    columns: localizeColumns(config.columns || [], t),
  };
}

function collect(fields, body, existing = null, t = (value) => value) {
  const data = {};
  const errors = {};
  for (const f of fields) {
    if (f.readonly) {
      if (existing) data[f.name] = existing[f.name];
      else if (f.default !== undefined) data[f.name] = f.default;
      continue;
    }

    let raw = body[f.name];
    if (Array.isArray(raw)) raw = raw[raw.length - 1];
    if (typeof raw === 'string') raw = raw.trim();

    if (f.type === 'checkbox') {
      data[f.name] = raw === '1' || raw === 'on' || raw === 'true' || raw === true ? 1 : 0;
      continue;
    }

    if (raw === undefined || raw === null || raw === '') {
      if (f.required) {
        errors[f.name] = t('{label} is required.', { label: f.label });
        data[f.name] = '';
      } else if ((f.type === 'number' || f.type === 'decimal') && f.default !== undefined) {
        data[f.name] = f.default;
      } else {
        data[f.name] = null;
      }
      continue;
    }

    if (f.type === 'number' || f.type === 'decimal') {
      const num = Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(num)) {
        errors[f.name] = t('{label} must be a valid number.', { label: f.label });
        data[f.name] = raw;
      } else if (f.min !== undefined && num < f.min) {
        errors[f.name] = t('{label} must be at least {min}.', { label: f.label, min: f.min });
        data[f.name] = raw;
      } else if (f.max !== undefined && num > f.max) {
        errors[f.name] = t('{label} must not exceed {max}.', { label: f.label, max: f.max });
        data[f.name] = raw;
      } else {
        data[f.name] = f.type === 'number' && f.integer ? Math.trunc(num) : num;
      }
      continue;
    }

    if (f.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        errors[f.name] = t('{label} must be a valid date.', { label: f.label });
        data[f.name] = raw;
      } else {
        data[f.name] = raw;
      }
      continue;
    }

    if (f.type === 'email' && !isEmail(raw)) {
      errors[f.name] = t('{label} must be a valid email address.', { label: f.label });
      data[f.name] = raw;
      continue;
    }

    if (f.type === 'select') {
      const allowed = (f.options || []).map((o) => String(o.value));
      if (allowed.length && !allowed.includes(String(raw))) {
        errors[f.name] = t('Please choose a valid {label}.', { label: f.label.toLowerCase() });
        data[f.name] = raw;
      } else {
        data[f.name] = raw;
      }
      continue;
    }

    if (raw.length > (f.maxLength || 255)) {
      errors[f.name] = t('{label} must be {max} characters or fewer.', { label: f.label, max: f.maxLength || 255 });
      data[f.name] = raw;
      continue;
    }

    data[f.name] = raw;
  }
  return { data, errors };
}

function duplicateMessage(err, t = (value) => value) {
  if (err && err.code === 'ER_DUP_ENTRY') {
    return t('A record with the same unique value already exists. Please check the number / code / email and try again.');
  }
  if (err && err.code === 'ER_ROW_IS_REFERENCED_2') {
    return t('This record is used by other documents and cannot be deleted. Mark it inactive instead.');
  }
  return null;
}

function makeResourceRouter(config) {
  const router = express.Router();
  const basePath = config.basePath;
  const fields = config.fields;
  const filterDefs = config.filters || [];
  const listColumns = config.columns || [];
  const orderBy = config.orderBy || 't.id DESC';
  const select = config.select || 't.*';
  const joins = config.joins || '';

  async function findById(id, opts = {}) {
    return one(
      `SELECT ${opts.select || select} FROM \`${config.table}\` t ${joins} WHERE t.id = ? LIMIT 1`,
      [id],
    );
  }

  router.get('/', async (req, res, next) => {
    try {
      const search = String(req.query.q || '').trim();
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const lc = localizedConfig(config, req.locale);

      const filters = localizeFilters(await resolveOptions(filterDefs), req.t);
      const activeFilters = [];
      const where = [];
      const params = [];

      if (search) {
        const like = `%${search}%`;
        const cols = (config.searchFields || ['t.id']).map((c) => `\`${c.replace(/\./g, '`.`')}\` LIKE ?`);
        where.push(`(${cols.join(' OR ')})`);
        (config.searchFields || []).forEach(() => params.push(like));
      }

      for (const filter of filters) {
        const value = String(req.query[filter.name] || '');
        if (!value) continue;
        activeFilters.push({ name: filter.name, value });
        where.push(`t.\`${filter.name}\` ${filter.operator || '='} ?`);
        params.push(value);
      }

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = Number(
        (await scalar(`SELECT COUNT(*) FROM \`${config.table}\` t ${joins} ${whereSql}`, params)) || 0,
      );
      const pagination = require('../lib/helpers').pagination(total, page, config.perPage || PER_PAGE);
      const rows = await query(
        `SELECT ${select} FROM \`${config.table}\` t ${joins} ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...params, pagination.perPage, (pagination.page - 1) * pagination.perPage],
      );

      const counts = {};
      if (config.counts) {
        const rowsCount = await query(`SELECT ${config.counts} FROM \`${config.table}\` t ${joins} ${whereSql}`, params);
        Object.assign(counts, rowsCount[0] || {});
      }

      res.render('resource/index', {
        title: lc.title,
        active: config.active || config.key,
        breadcrumbs: [{ label: lc.title }],
        resource: { ...lc, basePath },
        filters,
        activeFilters,
        search,
        rows,
        pagination,
        counts,
        rowCount: total,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/new', async (req, res, next) => {
    try {
      const lc = localizedConfig(config, req.locale);
      const formFields = localizeFields(await resolveOptions(fields), req.t);
      const row = defaultsFrom(fields);
      for (const [k, v] of Object.entries(req.query)) {
        if (fields.some((f) => f.name === k)) row[k] = v;
      }
      res.render('resource/form', {
        title: lc.newLabel,
        active: config.active || config.key,
        breadcrumbs: [{ label: lc.title, href: basePath }, { label: lc.newLabel }],
        resource: { ...lc, basePath },
        formFields,
        row,
        errors: {},
        mode: 'create',
        action: basePath,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const lc = localizedConfig(config, req.locale);
      const formFields = localizeFields(await resolveOptions(fields), req.t);
      const { data, errors } = collect(formFields, req.body, null, req.t);

      if (Object.keys(errors).length === 0 && config.number && config.numberField) {
        if (!data[config.numberField]) {
          data[config.numberField] = await nextNumber({
            prefix: config.number.prefix,
            table: config.table,
            column: config.numberField,
            year: config.number.year !== false,
            pad: config.number.pad || 4,
          });
        }
      }

      if (Object.keys(errors).length === 0 && typeof config.beforeCreate === 'function') {
        const hookErrors = await config.beforeCreate(data, req);
        if (hookErrors) Object.assign(errors, hookErrors);
      }

      if (Object.keys(errors).length > 0) {
        return res.status(422).render('resource/form', {
          title: lc.newLabel,
          active: config.active || config.key,
          breadcrumbs: [{ label: lc.title, href: basePath }, { label: lc.newLabel }],
          resource: { ...lc, basePath },
          formFields,
          row: { ...defaultsFrom(fields), ...data },
          errors,
          mode: 'create',
          action: basePath,
        });
      }

      const columns = Object.keys(data);
      const sql = `INSERT INTO \`${config.table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`;
      const [result] = await require('../db').getPool().query(sql, Object.values(data));

      if (typeof config.afterCreate === 'function') {
        await config.afterCreate(result.insertId, data, req);
      }

      req.flash('success', '{item} created successfully.', { item: lc.singular });
      res.redirect(`${basePath}/${result.insertId}`);
    } catch (err) {
      const message = duplicateMessage(err, req.t);
      if (message) {
        req.flash('error', message);
        return res.redirect(`${basePath}/new`);
      }
      next(err);
    }
  });

  router.get('/:id(\\d+)', async (req, res, next) => {
    try {
      const lc = localizedConfig(config, req.locale);
      const row = await findById(req.params.id);
      if (!row) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }

      const detailFields = localizeFields(
        await resolveOptions(fields.filter((f) => f.type !== 'password' && !f.hideInDetail)),
        req.t,
      );
      let related = [];
      if (typeof config.relatedLoader === 'function') {
        related = localizeRelated((await config.relatedLoader(row, req)) || [], req.t);
      }

      res.render('resource/show', {
        title: row[config.titleField || 'name'] || lc.singular,
        active: config.active || config.key,
        breadcrumbs: [
          { label: lc.title, href: basePath },
          { label: row[config.titleField || 'name'] || `#${row.id}` },
        ],
        resource: { ...lc, basePath },
        row,
        detailFields,
        related,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id(\\d+)/edit', async (req, res, next) => {
    try {
      const lc = localizedConfig(config, req.locale);
      const row = await findById(req.params.id);
      if (!row) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }
      const formFields = localizeFields(await resolveOptions(fields), req.t);

      res.render('resource/form', {
        title: lc.editLabel,
        active: config.active || config.key,
        breadcrumbs: [
          { label: lc.title, href: basePath },
          { label: row[config.titleField || 'name'] || `#${row.id}`, href: `${basePath}/${row.id}` },
          { label: req.t('Edit') },
        ],
        resource: { ...lc, basePath },
        formFields,
        row,
        errors: {},
        mode: 'edit',
        action: `${basePath}/${row.id}`,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id(\\d+)', async (req, res, next) => {
    try {
      const lc = localizedConfig(config, req.locale);
      const existing = await findById(req.params.id);
      if (!existing) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }

      const formFields = localizeFields(await resolveOptions(fields), req.t);
      const { data, errors } = collect(formFields, req.body, existing, req.t);

      // Never wipe a required document number/code when the field is submitted empty.
      if (config.number && config.numberField && !data[config.numberField]) {
        data[config.numberField] = existing[config.numberField];
      }

      if (Object.keys(errors).length === 0 && typeof config.beforeUpdate === 'function') {
        const hookErrors = await config.beforeUpdate(data, req, existing);
        if (hookErrors) Object.assign(errors, hookErrors);
      }

      if (Object.keys(errors).length > 0) {
        return res.status(422).render('resource/form', {
          title: lc.editLabel,
          active: config.active || config.key,
          breadcrumbs: [
            { label: lc.title, href: basePath },
            { label: existing[config.titleField || 'name'] || `#${existing.id}`, href: `${basePath}/${existing.id}` },
            { label: req.t('Edit') },
          ],
          resource: { ...lc, basePath },
          formFields,
          row: { ...existing, ...data },
          errors,
          mode: 'edit',
          action: `${basePath}/${existing.id}`,
        });
      }

      const columns = Object.keys(data);
      const sql = `UPDATE \`${config.table}\` SET ${columns.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`;
      await require('../db').getPool().query(sql, [...Object.values(data), existing.id]);

      if (typeof config.afterUpdate === 'function') {
        await config.afterUpdate(existing.id, data, existing, req);
      }

      req.flash('success', '{item} updated successfully.', { item: lc.singular });
      res.redirect(`${basePath}/${existing.id}`);
    } catch (err) {
      const message = duplicateMessage(err, req.t);
      if (message) {
        req.flash('error', message);
        return res.redirect(`${basePath}/${req.params.id}/edit`);
      }
      next(err);
    }
  });

  router.post('/:id(\\d+)/delete', async (req, res, next) => {
    try {
      const lc = localizedConfig(config, req.locale);
      const existing = await findById(req.params.id);
      if (!existing) {
        return next(Object.assign(new Error(req.t('{item} not found.', { item: lc.singular })), { status: 404 }));
      }

      if (typeof config.beforeDelete === 'function') {
        const message = await config.beforeDelete(existing, req);
        if (message) {
          req.flash('error', message);
          return res.redirect(`${basePath}/${existing.id}`);
        }
      }

      await require('../db').getPool().query(`DELETE FROM \`${config.table}\` WHERE id = ?`, [existing.id]);
      if (typeof config.afterDelete === 'function') await config.afterDelete(existing, req);
      req.flash('success', '{item} deleted.', { item: lc.singular });
      res.redirect(basePath);
    } catch (err) {
      const message = duplicateMessage(err, req.t);
      if (message) {
        req.flash('error', message);
        return res.redirect(`${basePath}/${req.params.id}`);
      }
      next(err);
    }
  });

  return router;
}

module.exports = { makeResourceRouter, PER_PAGE };
