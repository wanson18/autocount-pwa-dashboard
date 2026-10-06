'use strict';

const { addDays, readInvoiceRange, sourceError } = require('../autocount/invoice-reader');

const COMPANY_REGISTRY = Object.freeze({
  enterprise: Object.freeze({
    accountBookId: '63750',
    profileName: 'WANSON ENTERPRISE',
  }),
  sdn_bhd: Object.freeze({
    accountBookId: '63688',
    profileName: 'WANSON ENTERPRISE (M) SDN. BHD',
  }),
});

const RANGE_MONITORED_DAYS = Object.freeze({ today: 1, seven_days: 7 });
const HISTORY_DAYS = 90;
const TIME_ZONE = 'Asia/Kuala_Lumpur';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeName(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function validIsoDate(value) {
  if (!ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(value.slice(0, 4))
    && date.getUTCMonth() + 1 === Number(value.slice(5, 7))
    && date.getUTCDate() === Number(value.slice(8, 10));
}

function assertIsoDate(value, field) {
  if (typeof value !== 'string' || !validIsoDate(value.trim())) {
    throw sourceError(`price-check ${field} is invalid`, 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  return value.trim();
}

function resolveCompany(company) {
  if (!company || typeof company !== 'object' || Array.isArray(company)) {
    throw sourceError('company configuration is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  const definition = COMPANY_REGISTRY[company.companyKey];
  if (!definition) {
    throw sourceError('company key is not in the fixed registry', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  const accountBookId = String(company.accountBookId ?? '').trim();
  if (accountBookId !== definition.accountBookId) {
    throw sourceError('configured account book does not match the fixed registry', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  return { accountBookId, profileName: definition.profileName };
}

function malaysiaDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const lookup = {};
  for (const part of parts) lookup[part.type] = part.value;
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function priceCheckWindow(now = new Date(), range = 'today') {
  if (!Object.prototype.hasOwnProperty.call(RANGE_MONITORED_DAYS, range)) {
    throw sourceError('unsupported price-check range', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) {
    throw sourceError('price-check clock is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  const through = malaysiaDate(instant);
  const monitorFrom = addDays(through, -(RANGE_MONITORED_DAYS[range] - 1));
  const historyFrom = addDays(monitorFrom, -HISTORY_DAYS);
  return { monitorFrom, historyFrom, through };
}

async function loadPriceSource(client, company, { historyFrom, through, strategy = 'paged' } = {}) {
  if (!client || typeof client.getCompanyProfile !== 'function'
    || typeof client.listInvoicePage !== 'function') {
    throw sourceError('price-check client is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  if (strategy !== 'paged' && strategy !== 'windowed') {
    throw sourceError('price-check read strategy is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  const resolved = resolveCompany(company);
  const startDate = assertIsoDate(historyFrom, 'historyFrom');
  const endDate = assertIsoDate(through, 'through');
  if (startDate > endDate) {
    throw sourceError('price-check window is reversed', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }

  const profile = await client.getCompanyProfile(company);
  const profileName = profile && typeof profile === 'object' ? profile.companyName : null;
  if (typeof profileName !== 'string' || !profileName.trim()
    || normalizeName(profileName) !== normalizeName(resolved.profileName)) {
    throw sourceError('Cloud company profile does not match the pinned book', 'PRICE_PROFILE_MISMATCH', 'PriceProfileMismatchError');
  }

  const { rows, pageCount } = await readInvoiceRange({
    listPage: (params) => client.listInvoicePage(company, params),
    accountBookId: resolved.accountBookId,
    startDate,
    endDate,
    strategy,
  });

  return {
    rows,
    profileName,
    pageCount,
    invoiceCount: rows.length,
    strategy,
  };
}

module.exports = {
  COMPANY_REGISTRY,
  loadPriceSource,
  normalizeName,
  priceCheckWindow,
};
