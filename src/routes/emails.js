'use strict';

const express = require('express');
const { query, scalar } = require('../db');
const { pagination } = require('../lib/helpers');
const { getSettings } = require('../lib/settings');
const {
  isEmailConfigured,
  fromEmail,
  validateEmailAddress,
  invalidRecipients,
  normalizeRecipientList,
  sendMail,
} = require('../lib/email');
const { TYPES, emailLabel, loadEmailDocument, buildEmailContent } = require('../lib/emailDocuments');

const router = express.Router();
const PER_PAGE = 20;

function documentIdOf(email) {
  if (email.data.row) return email.data.row.id;
  if (email.data.payment) return email.data.payment.id;
  if (email.data.delivery) return email.data.delivery.id;
  return null;
}

async function recentHistory(email) {
  return query(
    `SELECT el.*, u.name AS sent_by_name
       FROM email_log el
       LEFT JOIN users u ON u.id = el.sent_by
      WHERE el.document_type = ? AND el.document_id = ?
      ORDER BY el.id DESC
      LIMIT 5`,
    [email.type, documentIdOf(email)],
  );
}

async function renderCompose(req, res, email, values, errors = {}, status = 200) {
  const settings = email.data.settings || (await getSettings());
  return res.status(status).render('emails/compose', {
    title: `${req.t('Email')} ${email.number}`,
    active: 'emails',
    breadcrumbs: [
      { label: req.t('Email log'), href: '/emails' },
      { label: email.number },
    ],
    email,
    values,
    errors,
    emailConfigured: isEmailConfigured(settings),
    fromAddress: fromEmail(settings),
    history: await recentHistory(email),
  });
}

router.get('/compose', async (req, res, next) => {
  try {
    const type = String(req.query.type || '');
    const id = Number.parseInt(req.query.id, 10);
    if (!TYPES[type] || !id) {
      return next(Object.assign(new Error(req.t('Document not found.')), { status: 404 }));
    }
    const email = await loadEmailDocument(type, id, req.locale);
    if (!email) {
      return next(Object.assign(new Error(req.t('Document not found.')), { status: 404 }));
    }
    return renderCompose(req, res, email, {
      to: email.partyEmail,
      cc: '',
      subject: email.subject,
      message: email.message,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/send', async (req, res, next) => {
  try {
    const type = String(req.body.document_type || '');
    const id = Number.parseInt(req.body.document_id, 10);
    if (!TYPES[type] || !id) {
      return next(Object.assign(new Error(req.t('Document not found.')), { status: 404 }));
    }
    const email = await loadEmailDocument(type, id, req.locale);
    if (!email) {
      return next(Object.assign(new Error(req.t('Document not found.')), { status: 404 }));
    }

    const values = {
      to: String(req.body.to || '').trim().slice(0, 500),
      cc: String(req.body.cc || '').trim().slice(0, 500),
      subject: String(req.body.subject || '').trim().slice(0, 255),
      message: String(req.body.message || '').trim().slice(0, 10000),
    };
    const errors = {};
    if (!values.to) errors.to = req.t('Enter at least one recipient.');
    const invalidTo = invalidRecipients(values.to);
    if (values.to && invalidTo.length) {
      errors.to = req.t('Invalid email address: {value}', { value: invalidTo.join(', ') });
    }
    const invalidCc = values.cc ? invalidRecipients(values.cc) : [];
    if (invalidCc.length) {
      errors.cc = req.t('Invalid email address: {value}', { value: invalidCc.join(', ') });
    }
    if (!values.subject) errors.subject = req.t('Enter a subject.');

    const settings = email.data.settings || (await getSettings());
    if (!isEmailConfigured(settings)) {
      errors.form = req.t('Email is not configured. Ask an administrator to set up SMTP in Email settings.');
    }
    if (Object.keys(errors).length) {
      return renderCompose(req, res, email, values, errors, 422);
    }

    const to = normalizeRecipientList(values.to);
    const cc = normalizeRecipientList(values.cc);
    const content = await buildEmailContent(email, values.message);
    let status = 'sent';
    let errorText = null;
    let messageId = null;
    try {
      const info = await sendMail({
        to,
        cc,
        subject: values.subject,
        html: content.html,
        text: content.text,
      });
      messageId = info && info.messageId ? String(info.messageId).slice(0, 255) : null;
    } catch (err) {
      status = 'failed';
      errorText = String(err.message || err).slice(0, 4000);
    }

    try {
      await query(
        `INSERT INTO email_log
           (document_type, document_id, document_no, party_name, to_email, cc_email,
            subject, message, status, error_text, message_id, sent_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          email.type,
          documentIdOf(email),
          email.number,
          email.partyName,
          to,
          cc || null,
          values.subject,
          values.message,
          status,
          errorText,
          messageId,
          req.session.user.id,
        ],
      );
    } catch (logErr) {
      console.error('[email] could not write email log:', logErr);
    }

    if (status === 'failed') {
      return renderCompose(
        req,
        res,
        email,
        values,
        { form: req.t('Email could not be sent: {message}', { message: errorText }) },
        502,
      );
    }

    req.flash('success', 'Email sent to {email}.', { email: to });
    return res.redirect(email.showPath);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const search = String(req.query.q || '').trim();
    const type = TYPES[String(req.query.type || '')] ? String(req.query.type) : '';
    const status = ['sent', 'failed'].includes(String(req.query.status || '')) ? String(req.query.status) : '';
    const where = [];
    const params = [];
    if (search) {
      where.push('(el.document_no LIKE ? OR el.to_email LIKE ? OR el.subject LIKE ? OR el.party_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (type) {
      where.push('el.document_type = ?');
      params.push(type);
    }
    if (status) {
      where.push('el.status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const total = Number((await scalar(`SELECT COUNT(*) FROM email_log el ${whereSql}`, params)) || 0);
    const pag = pagination(total, page, PER_PAGE);
    const rows = await query(
      `SELECT el.*, u.name AS sent_by_name
         FROM email_log el
         LEFT JOIN users u ON u.id = el.sent_by
         ${whereSql}
        ORDER BY el.created_at DESC, el.id DESC
        LIMIT ? OFFSET ?`,
      [...params, PER_PAGE, (pag.page - 1) * PER_PAGE],
    );

    res.render('emails/index', {
      title: req.t('Email log'),
      active: 'emails',
      breadcrumbs: [{ label: req.t('Email log') }],
      rows,
      pagination: pag,
      search,
      type,
      status,
      types: Object.keys(TYPES).map((value) => ({ value, label: emailLabel(value, req.locale) })),
      emailLabel,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
