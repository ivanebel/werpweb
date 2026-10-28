/**
 * Unit checks for the Telegram command parser and Spanish formatters.
 *
 * These do not touch Telegram or the database. Run with:
 *   npm run test:telegram
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const commands = require('../src/lib/telegram/commands.js');
const format = require('../src/lib/telegram/formatters.js');
const config = require('../src/config.js');

assert.deepEqual(commands.parseCommand('/produccion'), { command: 'produccion', args: '' });
assert.deepEqual(commands.parseCommand('/produccion planificadas'), {
  command: 'produccion',
  args: 'planificadas',
});
assert.equal(commands.parseCommand('/producción').command, 'produccion');
assert.equal(commands.parseCommand('/produccion@company_bot').command, 'produccion');
assert.deepEqual(commands.parseCommand('/orden PRD-2026-0006'), {
  command: 'orden',
  args: 'PRD-2026-0006',
});
assert.equal(commands.parseCommand('hola').command, null);
assert.equal(commands.normalizeWord('En-Proceso'), 'en-proceso');

assert.deepEqual(format.statusesForFilter('planificadas'), ['planned']);
assert.deepEqual(format.statusesForFilter('en proceso'), ['in_progress']);
assert.deepEqual(format.statusesForFilter('todas'), [
  'planned', 'released', 'in_progress', 'completed', 'cancelled',
]);
assert.deepEqual(format.statusesForFilter('otra-cosa'), ['planned', 'released', 'in_progress']);

assert.equal(format.statusLabel('in_progress'), 'En proceso');
assert.equal(format.formatDate('2026-11-10'), '10/11/2026');
assert.equal(format.formatDate(null), '—');
assert.equal(format.formatQty(1234.5), '1.234,5');
assert.equal(format.escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');

const previousPublicUrl = config.telegram.appPublicUrl;
config.telegram.appPublicUrl = 'https://erp.example.com';
assert.equal(
  format.orderLink({ id: 8 }),
  '<a href="https://erp.example.com/manufacturing/production-orders/8/readonly">Abrir en el ERP</a>',
);
config.telegram.appPublicUrl = previousPublicUrl;

const listText = format.formatOrderList({
  total: 2,
  shown: 1,
  orders: [{
    id: 8,
    production_no: 'PRD-2026-0006',
    status: 'in_progress',
    due_date: '2026-11-10',
    products: [{ name: 'Aurora Pendant 100', quantity: 4, unit: 'pcs' }],
  }],
}, ['planned', 'released', 'in_progress']);
assert.ok(listText.includes('Órdenes de producción'));
assert.ok(listText.includes('PRD-2026-0006'));
assert.ok(listText.includes('En proceso'));
assert.ok(listText.includes('Aurora Pendant 100'));
assert.ok(listText.includes('Hay 1 orden(es) más.'));

const detailText = format.formatOrderDetail(
  {
    id: 8,
    production_no: 'PRD-2026-0006',
    status: 'in_progress',
    start_date: '2026-10-27',
    due_date: '2026-11-10',
  },
  [{ name: 'Aurora Pendant 100', quantity: 4, unit: 'pcs', lot_number: '27.10.26' }],
  [{
    material_name: 'Test extrusion class',
    unit: 'pcs',
    quantity_required: 400,
    quantity_allocated: 400,
    quantity_consumed: 100,
    shortage_qty: 0,
  }],
);
assert.ok(detailText.includes('Inicio: 27/10/2026'));
assert.ok(detailText.includes('Asignado 400'));
assert.ok(detailText.includes('Consumido 100'));
assert.ok(detailText.includes('Sin faltantes de materiales.'));

const shortageText = format.formatShortages({
  total: 1,
  shown: 1,
  orders: [{
    id: 9,
    production_no: 'PRD-2026-0007',
    status: 'planned',
    due_date: '2026-11-12',
    materials: [{ name: 'Mozzarella', unit: 'kg', shortage_qty: 120 }],
  }],
});
assert.ok(shortageText.includes('Órdenes con faltantes de materiales'));
assert.ok(shortageText.includes('Mozzarella: faltan 120 kg'));

assert.ok(format.helpMessage().includes('/produccion'));
assert.ok(format.helpMessage().includes('/orden PRD-2026-0006'));
assert.ok(format.linkInstructions().includes('/vincular'));

console.log('All Telegram checks passed.');
