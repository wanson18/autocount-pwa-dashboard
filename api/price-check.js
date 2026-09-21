'use strict';

const { AutoCountClient } = require('../lib/autocount/client');
const { loadCompanyConfigs } = require('../lib/autocount/company-config');
const { loadPriceSource, priceCheckWindow } = require('../lib/price-check/source');
const { compareApprovedInvoices } = require('../lib/price-check/compare');
const defaultAuth = require('../lib/dispatch/auth');

const STORE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
});
const ALLOWED_QUERY_KEYS = new Set(['range']);
const ALLOWED_RANGES = new Set(['today', 'seven_days']);
const EXPECTED_BOOKS = Object.freeze({ enterprise: '63750', sdn_bhd: '63688' });
const SAFE_SOURCE_CODES = new Set([
  'PRICE_SOURCE_INVALID',
  'PRICE_PROFILE_MISMATCH',
  'PRICE_PAGE_INCOMPLETE',
  'PRICE_DUPLICATE_DOC',
  'PRICE_BOOK_MISMATCH',
]);
const COUNT_KEYS = Object.freeze([
  'invoices',
  'approvedInvoices',
  'monitoredInvoices',
  'lines',
  'compared',
  'priceChanges',
  'uomChanges',
  'unchanged',
  'noHistory',
  'skippedInvalidInvoice',
  'skippedUnapproved',
  'skippedVoid',
  'skippedInvalidLine',
]);

const BAD_REQUEST = Symbol('bad_request');

function sendJson(res, status, body) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    for (const [name, value] of Object.entries(STORE_HEADERS)) res.setHeader(name, value);
  }
  return res.status(status).json(body);
}

function sendFailure(res, status, code) {
  return sendJson(res, status, { success: false, error: { code } });
}

function readCookieHeader(req) {
  const headers = req?.headers || {};
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'cookie')
    .map(([, value]) => value)
    .filter((value) => typeof value === 'string');
  return values.length ? values.join(';') : undefined;
}

function normalizeRange(req) {
  const query = req?.query;
  if (query === undefined || query === null) return 'today';
  if (typeof query !== 'object' || Array.isArray(query)) throw BAD_REQUEST;
  for (const key of Object.keys(query)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw BAD_REQUEST;
  }
  const raw = query.range;
  if (raw === undefined) return 'today';
  if (typeof raw !== 'string' || !ALLOWED_RANGES.has(raw)) throw BAD_REQUEST;
  return raw;
}

function resolveNow(now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value;
  if (value === undefined || value === null) return new Date();
  return new Date(value);
}

function assertExpectedBooks(configs) {
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
    throw new Error('company configuration is invalid');
  }
  for (const [key, accountBookId] of Object.entries(EXPECTED_BOOKS)) {
    const config = configs[key];
    if (!config || typeof config !== 'object' || String(config.accountBookId) !== accountBookId) {
      throw new Error('company configuration does not match the fixed registry');
    }
  }
}

function safeSourceCode(reason) {
  const code = reason && typeof reason.code === 'string' ? reason.code : '';
  return SAFE_SOURCE_CODES.has(code) ? code : 'PRICE_SOURCE_UNAVAILABLE';
}

function zeroCounts() {
  const counts = {};
  for (const key of COUNT_KEYS) counts[key] = 0;
  counts.alerts = 0;
  counts.booksScanned = 0;
  counts.booksFailed = 0;
  return counts;
}

function mergeCounts(target, source) {
  for (const key of COUNT_KEYS) {
    const value = source?.[key];
    if (Number.isSafeInteger(value) && value >= 0) target[key] += value;
  }
}

function createPriceCheckHandler(options = {}) {
  const {
    env = process.env,
    client,
    configs,
    auth = defaultAuth,
    now,
  } = options;

  return async function priceCheck(req, res) {
    const method = typeof req?.method === 'string' ? req.method.toUpperCase() : 'GET';
    if (method !== 'GET') {
      if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET');
      return sendFailure(res, 405, 'method_not_allowed');
    }

    const instant = resolveNow(now);

    let session = null;
    try {
      session = await auth.verifySessionCookie(readCookieHeader(req), { env, now: instant });
    } catch {
      session = null;
    }
    if (!session) return sendFailure(res, 401, 'unauthorized');

    let range;
    try {
      range = normalizeRange(req);
    } catch {
      return sendFailure(res, 400, 'invalid_request');
    }

    let window;
    try {
      window = priceCheckWindow(instant, range);
    } catch {
      return sendFailure(res, 400, 'invalid_request');
    }

    let resolvedConfigs;
    let resolvedClient;
    try {
      resolvedConfigs = configs || loadCompanyConfigs(env);
      resolvedClient = client || new AutoCountClient();
      assertExpectedBooks(resolvedConfigs);
    } catch {
      return sendFailure(res, 503, 'configuration_error');
    }

    const books = Object.keys(EXPECTED_BOOKS).map((key) => resolvedConfigs[key]);
    const settled = await Promise.allSettled(books.map(async (company) => {
      const result = await loadPriceSource(resolvedClient, company, {
        historyFrom: window.historyFrom,
        through: window.through,
      });
      const comparison = compareApprovedInvoices(result.rows, {
        bookId: company.accountBookId,
        companyName: company.name,
        monitorFrom: window.monitorFrom,
      });
      return { result, comparison };
    }));

    const sources = [];
    const alerts = [];
    const counts = zeroCounts();

    settled.forEach((outcome, index) => {
      const company = books[index];
      if (outcome.status === 'fulfilled') {
        const { result, comparison } = outcome.value;
        alerts.push(...comparison.alerts);
        mergeCounts(counts, comparison.counts);
        sources.push({
          companyKey: company.companyKey,
          accountBookId: company.accountBookId,
          companyName: company.name,
          ok: true,
          pageCount: result.pageCount,
          invoiceCount: result.invoiceCount,
          profileName: result.profileName,
        });
      } else {
        sources.push({
          companyKey: company.companyKey,
          accountBookId: company.accountBookId,
          companyName: company.name,
          ok: false,
          code: safeSourceCode(outcome.reason),
        });
      }
    });

    const booksScanned = sources.filter((source) => source.ok).length;
    const booksFailed = sources.length - booksScanned;
    const status = booksFailed === 0 ? 'PASS' : (booksScanned === 0 ? 'FAIL' : 'PARTIAL');

    counts.alerts = alerts.length;
    counts.booksScanned = booksScanned;
    counts.booksFailed = booksFailed;

    return sendJson(res, status === 'FAIL' ? 502 : 200, {
      status,
      scannedAt: instant.toISOString(),
      window,
      sources,
      alerts,
      counts,
      cloudWrites: false,
    });
  };
}

module.exports = createPriceCheckHandler();
module.exports.createPriceCheckHandler = createPriceCheckHandler;
