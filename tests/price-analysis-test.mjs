/**
 * Unit checks for the price-analysis helpers.
 *
 * These do not touch the database or the network. Run with:
 *   npm run test:prices
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prices = require('../src/lib/priceAnalysis.js');

assert.deepEqual(prices.normalizeQuery('  queso   tybo  '), { query: 'queso tybo', error: null });
assert.deepEqual(prices.normalizeQuery('leche\ndescremada'), { query: 'leche descremada', error: null });
assert.equal(prices.normalizeQuery('   ').error, 'required');
assert.equal(prices.normalizeQuery('a'.repeat(81)).error, 'too_long');
assert.equal(Array.from(prices.normalizeQuery('a'.repeat(81)).query).length, 80);
assert.equal(prices.normalizeQuery('a\u0000b').error, 'invalid');

assert.equal(prices.toPrice(4490), 4490);
assert.equal(prices.toPrice('$ 4.490,50'), 4490.5);
assert.equal(prices.toPrice('1,234.50'), 1234.5);
assert.equal(prices.toPrice('bad'), null);
assert.equal(prices.toPrice(-1), null);
assert.equal(prices.toPrice(0), null);

assert.equal(prices.safeHttpUrl('https://example.com/p'), 'https://example.com/p');
assert.equal(prices.safeHttpUrl('http://example.com/p?x=1'), 'http://example.com/p?x=1');
assert.equal(prices.safeHttpUrl('javascript:alert(1)'), null);
assert.equal(prices.safeHttpUrl('not a url'), null);

assert.equal(prices.companyLabel('dia'), 'DIA');
assert.equal(prices.companyLabel('carrefour'), 'Carrefour');
assert.equal(prices.companyLabel('super_store'), 'Super Store');

const stdout = JSON.stringify({
  query: 'tybo',
  dia: [
    { title: 'B product', price: 20, link: 'https://dia.example/b' },
    { title: 'A product', price: 10, link: 'https://dia.example/a' },
    { title: 'No price', price: null, link: 'https://dia.example/c' },
    { title: 'Bad link', price: 5, link: 'javascript:alert(1)' },
  ],
  carrefour: [
    { title: 'C product', price: 15, link: 'https://carrefour.example/c' },
    { title: 'D product', price: 12, link: 'https://carrefour.example/d' },
  ],
});

const result = prices.parseScraperOutput(stdout, 'tybo');
assert.equal(result.query, 'tybo');
assert.equal(result.currency, 'ARS');
assert.equal(result.companies.length, 2);
assert.deepEqual(result.companies.map((company) => company.label), ['DIA', 'Carrefour']);
assert.deepEqual(
  result.companies[0].products.map((product) => product.title),
  ['Bad link', 'A product', 'B product', 'No price'],
);
assert.equal(result.companies[0].products[0].link, null);
assert.equal(result.companies[0].stats.count, 4);
assert.equal(result.companies[0].stats.priced_count, 3);
assert.equal(result.companies[0].stats.min, 5);
assert.equal(result.companies[0].stats.max, 20);
assert.equal(result.companies[0].stats.average, 11.67);
assert.equal(result.totals.products, 6);
assert.equal(result.totals.priced_products, 5);
assert.equal(result.totals.min, 5);
assert.equal(result.totals.max, 20);
assert.equal(result.totals.average, 12.4);
assert.equal(result.totals.lowest.title, 'Bad link');
assert.equal(result.totals.lowest.company, 'DIA');

const noisy = `Warning: a scraper diagnostic\n${stdout}\n`;
assert.equal(prices.parseScraperOutput(noisy, 'tybo').totals.products, 6);

const custom = prices.normalizeScraperResult(
  {
    query: 'custom',
    currency: 'usd',
    super_store: [{ title: 'Custom product', price: '10', link: 'https://example.com/custom' }],
  },
  'custom',
);
assert.equal(custom.currency, 'USD');
assert.equal(custom.companies[0].label, 'Super Store');
assert.equal(custom.companies[0].products[0].price, 10);

assert.throws(() => prices.parseScraperOutput('not json'), /invalid JSON/i);
assert.throws(() => prices.parseScraperOutput(''), /no output/i);
assert.throws(() => prices.normalizeScraperResult({ error: 'boom' }), /boom/);

console.log('All price-analysis checks passed.');
