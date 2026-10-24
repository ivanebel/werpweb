'use strict';

/**
 * Adds optional demo data for the Unit #2 POS module to an existing database.
 * Usage: npm run db:seed-pos
 *        FORCE_SEED=1 npm run db:seed-pos
 */
const { initDb, withTransaction, closeDb, one } = require('./index');
const { seedPosDemo } = require('./posSeed');

const FORCE = process.env.FORCE_SEED === '1';

async function main() {
  await initDb();

  await withTransaction(async (conn) => {
    const admin = await one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    const result = await seedPosDemo(conn, { adminId: admin ? admin.id : null, force: FORCE });
    if (result.skipped) {
      console.log(`[seed-pos] skipped: ${result.reason}.`);
      return;
    }
    console.log(
      `[seed-pos] created ${result.locations} points of sale and ${result.sales} demo POS sales.`,
    );
  });
}

main()
  .catch((err) => {
    console.error('[seed-pos] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
