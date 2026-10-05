'use strict';

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
const MAX_PAGES = 1000;
// Windowed reads: at most this many Cloud requests at once, slices planned to
// be about 60% full, and a hard ceiling so a misbehaving date filter cannot
// turn one scan into an unbounded request storm.
const WINDOW_CONCURRENCY = 3;
const WINDOW_FILL = 0.6;
const MAX_WINDOW_REQUESTS = 250;
const TIME_ZONE = 'Asia/Kuala_Lumpur';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// `retryable` marks failures a fresh scan can plausibly clear, i.e. the Cloud
// listing shifted while it was being read. `detail` carries counts and flags
// only, never invoice content, so the API can pass it on to the page.
function sourceError(message, code, name, { retryable = false, detail } = {}) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  if (retryable) error.retryable = true;
  if (detail) error.detail = detail;
  return error;
}

function sameContent(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (error) {
    return false;
  }
}

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

function addDays(isoDate, delta) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
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

function readDocKey(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const master = row.master;
  if (!master || typeof master !== 'object' || Array.isArray(master)) return null;
  if (!Array.isArray(row.details)) return null;
  const raw = master.docKey;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const docKey = String(raw).trim();
  return docKey || null;
}

function diffDays(fromIso, toIso) {
  const [fromYear, fromMonth, fromDay] = fromIso.split('-').map(Number);
  const [toYear, toMonth, toDay] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay)) / 86400000);
}

function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    next();
  });
}

function readPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data)) {
    throw sourceError('Cloud invoice page is malformed', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  if (!Number.isSafeInteger(payload.totalCount) || payload.totalCount < 0) {
    throw sourceError('Cloud invoice totalCount is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  return payload;
}

// Reads one date range page by page. The Cloud list is only trustworthy when
// every page is consistent, so any repeated, missing, or extra row fails it.
async function readPaged(client, company, accountBookId, startDate, endDate, { onRequest, detailBase = {} } = {}) {
  const withBase = (detail) => ({ ...detailBase, ...detail });
  const rows = [];
  const rowPages = [];
  const seen = new Map();
  let page = 1;
  let pageCount = 0;
  let totalCount = null;
  let pageSize = null;
  let previousFirstKey = null;

  while (totalCount === null || rows.length < totalCount) {
    if (page > MAX_PAGES) {
      throw sourceError('Cloud invoice listing exceeded the page ceiling', 'PRICE_PAGE_INCOMPLETE', 'PricePageIncompleteError', {
        detail: withBase({ page, totalCount, rowsRead: rows.length }),
      });
    }
    if (onRequest) onRequest();
    const payload = readPayload(await client.listInvoicePage(company, { page, startDate, endDate }));
    pageCount += 1;
    if (totalCount === null) {
      totalCount = payload.totalCount;
    } else if (payload.totalCount !== totalCount) {
      throw sourceError('Cloud invoice totalCount changed between pages', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError', {
        retryable: true,
        detail: withBase({ page, totalCount, receivedTotal: payload.totalCount, rowsRead: rows.length }),
      });
    }
    if (pageSize === null) pageSize = payload.data.length;

    if (payload.data.length === 0) {
      if (rows.length < totalCount) {
        throw sourceError('Cloud invoice pagination ended before the total count', 'PRICE_PAGE_INCOMPLETE', 'PricePageIncompleteError', {
          retryable: true,
          detail: withBase({ page, pageSize, totalCount, rowsRead: rows.length }),
        });
      }
      break;
    }

    // A page that starts with the same document as the previous page means the
    // Cloud ignored the page number rather than shifting its rows.
    const firstKey = readDocKey(payload.data[0]);
    const pageRepeated = firstKey !== null && firstKey === previousFirstKey;
    previousFirstKey = firstKey;

    for (let index = 0; index < payload.data.length; index += 1) {
      const entry = payload.data[index];
      if (rows.length >= totalCount) {
        throw sourceError('Cloud invoice pagination exceeded the total count', 'PRICE_PAGE_INCOMPLETE', 'PricePageIncompleteError', {
          retryable: true,
          detail: withBase({ page, rowOnPage: index + 1, pageSize, totalCount, rowsRead: rows.length }),
        });
      }
      const docKey = readDocKey(entry);
      if (docKey === null) {
        throw sourceError('Cloud invoice row shape is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
      }
      const identity = `${accountBookId}\u0000${docKey}`;
      if (seen.has(identity)) {
        const firstIndex = seen.get(identity);
        throw sourceError('Cloud invoice listing contains a duplicate document', 'PRICE_DUPLICATE_DOC', 'PriceDuplicateDocError', {
          retryable: true,
          detail: withBase({
            page,
            rowOnPage: index + 1,
            pageSize,
            totalCount,
            rowsRead: rows.length,
            firstSeenOnPage: rowPages[firstIndex],
            pageRepeated,
            sameContent: sameContent(entry, rows[firstIndex]),
          }),
        });
      }
      seen.set(identity, rows.length);
      rowPages.push(page);
      rows.push(entry);
    }
    page += 1;
  }

  if (totalCount === null || rows.length !== totalCount) {
    throw sourceError('Cloud invoice pagination did not match the total count', 'PRICE_PAGE_INCOMPLETE', 'PricePageIncompleteError', {
      retryable: true,
      detail: withBase({ page, pageSize, totalCount, rowsRead: rows.length }),
    });
  }

  return { rows, pageCount };
}

// Reads the range as date slices that each fit on ONE page, so the Cloud never
// has to order rows across pages. Nothing is trusted without proof: every slice
// must be complete, the slice totals must add up to the overall total, and no
// document may appear twice.
async function readWindowed(client, company, accountBookId, startDate, endDate) {
  const limit = createLimiter(WINDOW_CONCURRENCY);
  let requests = 0;
  let failure = null;

  const guarded = async (task) => {
    if (failure) throw failure;
    try {
      return await task();
    } catch (error) {
      failure = failure || error;
      throw error;
    }
  };
  const countRequest = () => {
    if (failure) throw failure;
    requests += 1;
    if (requests > MAX_WINDOW_REQUESTS) {
      throw sourceError('Cloud invoice window scan exceeded the request ceiling', 'PRICE_PAGE_INCOMPLETE', 'PricePageIncompleteError', {
        detail: { windowed: true, requestCount: requests - 1 },
      });
    }
  };
  const firstPage = (start, end) => limit(() => guarded(async () => {
    countRequest();
    return readPayload(await client.listInvoicePage(company, { page: 1, startDate: start, endDate: end }));
  }));
  const inconsistentPage = (payload) => sourceError(
    'Cloud invoice window page did not match its total',
    'PRICE_PAGE_INCOMPLETE',
    'PricePageIncompleteError',
    { retryable: true, detail: { windowed: true, totalCount: payload.totalCount, rowsRead: payload.data.length } },
  );

  const scanSlice = async (start, end) => {
    const payload = await firstPage(start, end);
    if (payload.data.length === payload.totalCount) {
      return [{ total: payload.totalCount, rows: payload.data }];
    }
    if (payload.data.length === 0 || payload.data.length > payload.totalCount) throw inconsistentPage(payload);
    if (start === end) {
      // One day alone is bigger than a page: nothing left to split, so page it.
      const paged = await guarded(() => readPaged(client, company, accountBookId, start, end, {
        onRequest: countRequest,
        detailBase: { windowed: true },
      }));
      return [{ total: paged.rows.length, rows: paged.rows }];
    }
    const half = Math.floor(diffDays(start, end) / 2);
    const middle = addDays(start, half);
    const [left, right] = await Promise.all([
      scanSlice(start, middle),
      scanSlice(addDays(middle, 1), end),
    ]);
    return left.concat(right);
  };

  const root = await firstPage(startDate, endDate);
  const overallTotal = root.totalCount;
  let leaves;
  if (root.data.length === overallTotal) {
    leaves = [{ total: overallTotal, rows: root.data }];
  } else {
    if (root.data.length === 0 || root.data.length > overallTotal) throw inconsistentPage(root);
    // Plan slices so each is expected to be about 60% full, then split any
    // slice that turns out busier than one page.
    const pageSize = root.data.length;
    const days = diffDays(startDate, endDate) + 1;
    const wanted = Math.min(days, Math.max(2, Math.ceil(overallTotal / Math.max(1, Math.floor(pageSize * WINDOW_FILL)))));
    const chunk = Math.ceil(days / wanted);
    const slices = [];
    for (let offset = 0; offset < days; offset += chunk) {
      slices.push([addDays(startDate, offset), addDays(startDate, Math.min(days, offset + chunk) - 1)]);
    }
    leaves = (await Promise.all(slices.map(([start, end]) => scanSlice(start, end)))).flat();
  }

  const slicedTotal = leaves.reduce((sum, leaf) => sum + leaf.total, 0);
  if (slicedTotal !== overallTotal) {
    throw sourceError('Cloud invoice date slices did not add up to the overall total', 'PRICE_PAGE_INCOMPLETE', 'PricePageIncompleteError', {
      retryable: true,
      detail: { windowed: true, totalCount: overallTotal, rowsRead: slicedTotal, windowCount: leaves.length },
    });
  }

  const rows = [];
  const rowSlices = [];
  const seen = new Map();
  for (let sliceIndex = 0; sliceIndex < leaves.length; sliceIndex += 1) {
    const sliceRows = leaves[sliceIndex].rows;
    for (let index = 0; index < sliceRows.length; index += 1) {
      const entry = sliceRows[index];
      const docKey = readDocKey(entry);
      if (docKey === null) {
        throw sourceError('Cloud invoice row shape is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
      }
      const identity = `${accountBookId}\u0000${docKey}`;
      if (seen.has(identity)) {
        const firstIndex = seen.get(identity);
        throw sourceError('Cloud invoice listing contains a duplicate document', 'PRICE_DUPLICATE_DOC', 'PriceDuplicateDocError', {
          retryable: true,
          detail: {
            windowed: true,
            windowIndex: sliceIndex + 1,
            windowCount: leaves.length,
            rowOnPage: index + 1,
            totalCount: overallTotal,
            rowsRead: rows.length,
            firstSeenInWindow: rowSlices[firstIndex] + 1,
            sameContent: sameContent(entry, rows[firstIndex]),
          },
        });
      }
      seen.set(identity, rows.length);
      rowSlices.push(sliceIndex);
      rows.push(entry);
    }
  }

  return { rows, pageCount: requests };
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

  const { rows, pageCount } = strategy === 'windowed'
    ? await readWindowed(client, company, resolved.accountBookId, startDate, endDate)
    : await readPaged(client, company, resolved.accountBookId, startDate, endDate);

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
