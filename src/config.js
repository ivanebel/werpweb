'use strict';

const path = require('node:path');
const fs = require('node:fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const root = path.join(__dirname, '..');

const config = {
  root,
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: int(process.env.PORT, 3000),
  sessionSecret: process.env.SESSION_SECRET || 'werp-dev-secret-change-me',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'werp_erp',
    ssl: bool(process.env.DB_SSL),
    ssh: {
      enabled: bool(process.env.DB_SSH_ENABLED),
      host: process.env.SSH_HOST || '',
      port: int(process.env.SSH_PORT, 22),
      user: process.env.SSH_USER || '',
      password: process.env.SSH_PASSWORD || '',
      privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH || '',
      passphrase: process.env.SSH_PRIVATE_KEY_PASSPHRASE || '',
      remoteHost: process.env.DB_REMOTE_HOST || '127.0.0.1',
      remotePort: int(process.env.DB_REMOTE_PORT, 3306),
    },
  },
};

// Read the private key once so the tunnel can reconnect without disk access.
if (config.db.ssh.enabled && config.db.ssh.privateKeyPath) {
  const keyPath = path.isAbsolute(config.db.ssh.privateKeyPath)
    ? config.db.ssh.privateKeyPath
    : path.join(root, config.db.ssh.privateKeyPath);
  if (fs.existsSync(keyPath)) {
    config.db.ssh.privateKey = fs.readFileSync(keyPath);
  } else {
    console.warn(`[config] SSH private key not found: ${keyPath}`);
  }
}

module.exports = config;
