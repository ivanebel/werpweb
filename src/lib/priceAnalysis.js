'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const config = require('../config');

const execFileAsync = promisify(execFile);

const QUERY_MAX_LENGTH = 80;
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_CURRENCY = 'ARS';

// The scraper currently returns these two keys. Unknown keys are still shown so
// adding another store to the Python side does not require a front-end change.
const COMPANY_LABELS = {
  dia: 'DIA',
  carrefour: 'Carrefour',
};
const COMPANY_ORDER = ['dia', 'carrefour'];

class PriceScraperError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'PriceScraperError';
    this.code = code;
    this.detail = detail;
  }
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function normalizeQuery(value) {
  const original = String(value === undefined || value === null ? '' : value);
  // Whitespace is harmless because the query is passed to Python as a single
  // argument and encoded again by the scraper. Reject hidden control bytes.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(original)) {
    return { query: original.trim().replace(/\s+/g, ' '), error: 'invalid' };
  }
  const query = original.trim().replace(/\s+/g, ' ');
  if (!query) return { query: '', error: 'required' };
  const characters = Array.from(query);
  if (characters.length > QUERY_MAX_LENGTH) {
    return { query: characters.slice(0, QUERY_MAX_LENGTH).join(''), error: 'too_long' };
  }
  return { query, error: null };
}

function toPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? round2(value) : null;
  }
  const cleaned = String(value).trim().replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const normalized = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? round2(number) : null;
}

function safeHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href.slice(0, 2_000);
  } catch {
    return null;
  }
}

function companyLabel(key) {
  const normalized = String(key || '').trim().toLowerCase();
  if (COMPANY_LABELS[normalized]) return COMPANY_LABELS[normalized];
  const label = normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
  return label.slice(0, 80) || 'Store';
}

function normalizeCurrency(value) {
  const raw = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : DEFAULT_CURRENCY;
}

function computeStats(products) {
  const prices = products.map((product) => product.price).filter(Number.isFinite);
  if (!prices.length) {
    return { count: products.length, priced_count: 0, min: null, max: null, average: null };
  }
  const total = prices.reduce((sum, price) => sum + price, 0);
  return {
    count: products.length,
    priced_count: prices.length,
    min: round2(Math.min(...prices)),
    max: round2(Math.max(...prices)),
    average: round2(total / prices.length),
  };
}

function productSort(a, b) {
  const priceA = a.price === null ? Number.POSITIVE_INFINITY : a.price;
  const priceB = b.price === null ? Number.POSITIVE_INFINITY : b.price;
  if (priceA !== priceB) return priceA - priceB;
  return String(a.title || '').localeCompare(String(b.title || ''));
}

function normalizeScraperResult(raw, requestedQuery = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PriceScraperError('INVALID_JSON', 'The price scraper returned an invalid response.');
  }
  if (raw.error) {
    throw new PriceScraperError('RESULT_ERROR', String(raw.error));
  }

  const companies = [];
  for (const [key, value] of Object.entries(raw)) {
    if (['query', 'currency', 'error'].includes(key) || !Array.isArray(value)) continue;
    const products = [];
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const title = String(item.title || '').trim().slice(0, 300);
      const price = toPrice(item.price);
      const link = safeHttpUrl(item.link);
      if (!title && !link && price === null) continue;
      products.push({ title, price, link });
    }
    products.sort(productSort);
    companies.push({
      key,
      label: companyLabel(key),
      products,
      stats: computeStats(products),
    });
  }

  companies.sort((a, b) => {
    const indexA = COMPANY_ORDER.indexOf(a.key);
    const indexB = COMPANY_ORDER.indexOf(b.key);
    if (indexA !== -1 || indexB !== -1) {
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    }
    return a.label.localeCompare(b.label);
  });

  const allProducts = companies.flatMap((company) => company.products.map((product) => ({
    ...product,
    company: company.label,
  })));
  const priced = allProducts.filter((product) => product.price !== null);
  const lowest = priced.length
    ? priced.reduce((best, product) => (product.price < best.price ? product : best), priced[0])
    : null;
  const prices = priced.map((product) => product.price);

  return {
    query: requestedQuery || String(raw.query || '').trim(),
    currency: normalizeCurrency(raw.currency),
    companies,
    totals: {
      companies: companies.length,
      products: allProducts.length,
      priced_products: priced.length,
      min: prices.length ? round2(Math.min(...prices)) : null,
      max: prices.length ? round2(Math.max(...prices)) : null,
      average: prices.length ? round2(prices.reduce((sum, price) => sum + price, 0) / prices.length) : null,
      lowest: lowest
        ? { price: lowest.price, title: lowest.title, company: lowest.company }
        : null,
    },
  };
}

function parseScraperOutput(stdout, requestedQuery = '') {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new PriceScraperError('EMPTY_OUTPUT', 'The price scraper returned no output.');
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // Keep the endpoint usable if a scraper module prints a diagnostic before
    // the JSON document. The Python scripts are expected to use stderr.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        raw = JSON.parse(text.slice(start, end + 1));
      } catch {
        raw = null;
      }
    }
    if (!raw) {
      throw new PriceScraperError(
        'INVALID_JSON',
        'The price scraper returned invalid JSON.',
        text.slice(0, 2_000),
      );
    }
  }

  return normalizeScraperResult(raw, requestedQuery);
}

function scraperSettings() {
  const configuredScript = process.env.PRICE_SCRAPER_SCRIPT;
  const scriptPath = configuredScript
    ? (path.isAbsolute(configuredScript) ? configuredScript : path.join(config.root, configuredScript))
    : path.join(config.root, 'scraper', 'main.py');
  const timeoutValue = Number(process.env.PRICE_SCRAPER_TIMEOUT_MS);
  return {
    scriptPath,
    cwd: path.dirname(scriptPath),
    timeoutMs: Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : DEFAULT_TIMEOUT_MS,
    pythonCandidates: process.env.PYTHON_BIN
      ? [process.env.PYTHON_BIN]
      : process.platform === 'win32'
        ? ['python', 'py']
        : ['python3', 'python'],
  };
}

function processError(error) {
  if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
    return new PriceScraperError('TIMEOUT', 'The price scraper timed out.');
  }
  const detail = String(error.stderr || '').trim().slice(0, 4_000);
  if (/ModuleNotFoundError|No module named ['"]?(requests|urllib3)/i.test(detail)) {
    return new PriceScraperError(
      'DEPENDENCY_MISSING',
      'The price scraper dependencies are missing.',
      detail,
    );
  }
  return new PriceScraperError(
    'SCRAPER_FAILED',
    'The price scraper failed.',
    detail || String(error.message || error),
  );
}

async function executeScraper(query) {
  const { scriptPath, cwd, timeoutMs, pythonCandidates } = scraperSettings();
  if (!fs.existsSync(scriptPath)) {
    throw new PriceScraperError('SCRIPT_NOT_FOUND', 'The price scraper script was not found.');
  }

  const options = {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  };

  let missingBinary = null;
  for (const binary of pythonCandidates) {
    try {
      const output = await execFileAsync(binary, [scriptPath, query], options);
      return output;
    } catch (error) {
      if (error.code === 'ENOENT') {
        missingBinary = error;
        continue;
      }
      throw processError(error);
    }
  }

  throw new PriceScraperError(
    'PYTHON_NOT_FOUND',
    'Python could not be found.',
    missingBinary ? String(missingBinary.message || '') : null,
  );
}

async function runPriceScraper(query) {
  const normalized = normalizeQuery(query);
  if (normalized.error) {
    throw new PriceScraperError('INVALID_QUERY', 'The search text is not valid.');
  }

  const startedAt = Date.now();
  const { stdout, stderr } = await executeScraper(normalized.query);
  const durationMs = Date.now() - startedAt;
  return {
    result: parseScraperOutput(stdout, normalized.query),
    stderr: String(stderr || '').trim().slice(0, 4_000),
    durationMs,
  };
}

module.exports = {
  QUERY_MAX_LENGTH,
  PriceScraperError,
  normalizeQuery,
  normalizeScraperResult,
  parseScraperOutput,
  runPriceScraper,
  companyLabel,
  safeHttpUrl,
  toPrice,
};
