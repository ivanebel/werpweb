'use strict';

const express = require('express');
const config = require('../config');
const { formatMoney } = require('../lib/helpers');
const priceAnalysis = require('../lib/priceAnalysis');

const router = express.Router();

function renderPage(req, res, options = {}) {
  const {
    status = 200,
    query = '',
    error = null,
    errorHint = null,
    errorDetail = null,
    result = null,
    durationMs = null,
    warnings = [],
    warningDetail = null,
  } = options;
  const currency = result ? result.currency : 'ARS';
  return res.status(status).render('finance/prices/index', {
    title: req.t('Price analysis'),
    active: 'finance-prices',
    breadcrumbs: [{ label: req.t('Price analysis') }],
    query,
    error,
    errorHint,
    errorDetail,
    result,
    durationMs,
    warnings,
    warningDetail,
    currency,
    price: (value) => formatMoney(value, currency, req.locale),
    exampleQueries: ['tybo', 'queso', 'leche'],
  });
}

function validationMessage(code, req) {
  if (code === 'too_long') {
    return req.t('Use {max} characters or fewer.', { max: priceAnalysis.QUERY_MAX_LENGTH });
  }
  if (code === 'invalid') return req.t('The search text contains unsupported characters.');
  return req.t('Enter a product name or brand to search.');
}

function scraperError(error, req) {
  switch (error.code) {
    case 'PYTHON_NOT_FOUND':
      return {
        status: 503,
        message: req.t('Python is not available on this server.'),
        hint: req.t('Install Python 3 and the scraper dependencies on the server, then try again.'),
      };
    case 'SCRIPT_NOT_FOUND':
      return {
        status: 503,
        message: req.t('The price scraper script was not found on this server.'),
        hint: req.t('Check that the scraper folder is deployed with the application.'),
      };
    case 'TIMEOUT':
      return {
        status: 504,
        message: req.t('The price search timed out. Please try again.'),
        hint: req.t('The external stores may be responding slowly. Try again in a moment.'),
      };
    case 'INVALID_JSON':
      return {
        status: 502,
        message: req.t('The price scraper returned an invalid response.'),
        hint: req.t('Check the scraper output and the server logs.'),
      };
    case 'EMPTY_OUTPUT':
      return {
        status: 502,
        message: req.t('The price scraper returned no data.'),
        hint: req.t('Check the scraper output and the server logs.'),
      };
    case 'DEPENDENCY_MISSING':
      return {
        status: 503,
        message: req.t('The price scraper dependencies are not installed on this server.'),
        hint: req.t('Run python -m pip install -r scraper/requirements.txt on the server, then try again.'),
      };
    case 'SCRAPER_FAILED':
      return {
        status: 502,
        message: req.t('The price scraper failed. Please try again.'),
        hint: req.t('Check the server logs for more information.'),
      };
    case 'RESULT_ERROR':
      return {
        status: 502,
        message: req.t('The price scraper reported an error: {message}', { message: error.message }),
        hint: req.t('Try a different search or check the scraper configuration.'),
      };
    case 'INVALID_QUERY':
      return {
        status: 422,
        message: req.t('Enter a product name or brand to search.'),
      };
    default:
      return {
        status: 502,
        message: req.t('The price search could not be completed. Please try again.'),
        hint: req.t('Check the server logs for more information.'),
      };
  }
}

router.get('/', (req, res) => {
  const normalized = priceAnalysis.normalizeQuery(req.query.q);
  return renderPage(req, res, { query: normalized.query });
});

router.post('/', async (req, res) => {
  const normalized = priceAnalysis.normalizeQuery(req.body.query);
  if (normalized.error) {
    return renderPage(req, res, {
      status: 422,
      query: normalized.query,
      error: validationMessage(normalized.error, req),
    });
  }

  try {
    const { result, stderr, durationMs } = await priceAnalysis.runPriceScraper(normalized.query);
    if (stderr) console.warn(`[price-analysis] ${stderr}`);
    const warnings = stderr
      ? stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5)
      : [];
    return renderPage(req, res, {
      query: normalized.query,
      result,
      durationMs,
      warnings,
      warningDetail: config.isProduction ? null : (warnings.join('\n') || null),
    });
  } catch (error) {
    console.error(`[price-analysis] ${error.code || 'ERROR'} ${error.detail || error.message}`);
    const mapped = scraperError(error, req);
    return renderPage(req, res, {
      status: mapped.status,
      query: normalized.query,
      error: mapped.message,
      errorHint: mapped.hint || null,
      errorDetail: config.isProduction ? null : error.detail || null,
    });
  }
});

module.exports = router;
