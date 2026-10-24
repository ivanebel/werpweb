'use strict';

const config = require('./config');
const { initDb, closeDb } = require('./db');
const { createApp } = require('./app');

async function start() {
  try {
    console.log('[startup] connecting to database…');
    await initDb();
    console.log('[startup] database ready');

    const app = await createApp();

    const server = app.listen(config.port, () => {
      console.log(`\n  WerpWeb ERP running at http://localhost:${config.port}`);
      console.log(`  Environment: ${config.env}\n`);
    });

    const shutdown = async (signal) => {
      console.log(`\n[shutdown] ${signal} received, closing…`);
      server.close(async () => {
        await closeDb();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return server;
  } catch (err) {
    console.error('\n[startup] failed:', err.message);
    if (err.message.includes('MySQL')) {
      console.error('Check the database settings in your .env file. For SSH tunnels, verify the SSH_HOST / SSH_USER settings.');
    }
    process.exit(1);
  }
}

start();
