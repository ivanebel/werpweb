'use strict';

const path = require('node:path');
const ejs = require('ejs');
const nodemailer = require('nodemailer');
const config = require('../config');
const { getSettings } = require('./settings');

const VIEWS_DIR = path.join(config.root, 'src', 'views');
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function fromEmail(settings) {
  return String(settings.smtp_from_email || settings.company_email || '').trim();
}

function isEmailConfigured(settings) {
  return Boolean(String(settings.smtp_host || '').trim() && fromEmail(settings));
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function recipientAddresses(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/<([^>]+)>/);
      return (match ? match[1] : part).trim();
    });
}

function normalizeRecipientList(value) {
  return recipientAddresses(value).join(', ');
}

function invalidRecipients(value) {
  return recipientAddresses(value).filter((address) => !EMAIL_RE.test(address));
}

function validateEmailAddress(value) {
  return EMAIL_RE.test(normalizeEmail(value));
}

function validateEmailSettings(settings) {
  const errors = {};
  const host = String(settings.smtp_host || '').trim();
  const port = String(settings.smtp_port || '').trim();
  const from = fromEmail(settings);
  const replyTo = String(settings.smtp_reply_to || '').trim();
  if (host && !port) errors.smtp_port = 'Enter the SMTP port.';
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
    errors.smtp_port = 'Enter a valid SMTP port between 1 and 65535.';
  }
  if (host && !from) errors.smtp_from_email = 'Enter the address emails should be sent from.';
  if (from && !validateEmailAddress(from)) errors.smtp_from_email = 'Enter a valid sender email address.';
  if (replyTo && !validateEmailAddress(replyTo)) errors.smtp_reply_to = 'Enter a valid reply-to email address.';
  return errors;
}

function createTransport(settings) {
  const port = Number(settings.smtp_port || 587);
  const secure = String(settings.smtp_secure || '0') === '1' || port === 465;
  const user = String(settings.smtp_user || '').trim();
  const pass = String(settings.smtp_password || '');
  return nodemailer.createTransport({
    host: String(settings.smtp_host || '').trim(),
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    tls: { rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

function senderFrom(settings) {
  return {
    name: String(settings.smtp_from_name || settings.company_name || 'WerpWeb').trim(),
    address: fromEmail(settings),
  };
}

async function sendMail({ to, cc, bcc, subject, html, text }) {
  const settings = await getSettings(true);
  if (!isEmailConfigured(settings)) {
    throw Object.assign(new Error('Email is not configured. Ask an administrator to set up SMTP in Email settings.'), {
      status: 422,
      code: 'EMAIL_NOT_CONFIGURED',
    });
  }
  const transport = createTransport(settings);
  try {
    return await transport.sendMail({
      from: senderFrom(settings),
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      replyTo: settings.smtp_reply_to || undefined,
      subject,
      html,
      text: text || undefined,
    });
  } finally {
    transport.close();
  }
}

async function sendTestEmail(to) {
  const settings = await getSettings(true);
  const subject = `WerpWeb test email - ${settings.company_name || 'ERP'}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1d2939;line-height:1.6">
      <h2 style="margin:0 0 12px">WerpWeb email test</h2>
      <p>This is a test message from <strong>${escapeHtml(settings.company_name || 'WerpWeb')}</strong>.</p>
      <p>If you received it, your SMTP configuration is working.</p>
    </div>`;
  return sendMail({
    to,
    subject,
    html,
    text: `WerpWeb email test\n\nThis is a test message from ${settings.company_name || 'WerpWeb'}. If you received it, your SMTP configuration is working.`,
  });
}

async function renderEmail(template, data) {
  const file = path.join(VIEWS_DIR, 'emails', template);
  return ejs.renderFile(file, data, { root: VIEWS_DIR });
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  isEmailConfigured,
  fromEmail,
  normalizeEmail,
  normalizeRecipientList,
  invalidRecipients,
  validateEmailAddress,
  validateEmailSettings,
  createTransport,
  sendMail,
  sendTestEmail,
  renderEmail,
  escapeHtml,
};
