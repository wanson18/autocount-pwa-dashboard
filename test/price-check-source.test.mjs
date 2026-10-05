import test from 'node:test';
import assert from 'node:assert/strict';
import source from '../lib/price-check/source.js';
import clientModule from '../lib/autocount/client.js';

const { loadPriceSource, priceCheckWindow } = source;
const { AutoCountClient } = clientModule;

const WINDOW = { historyFrom: '2026-06-01', through: '2026-09-21' };

const ENTERPRISE = {
  companyKey: 'enterprise',
  accountBookId: '63750',
  name: 'Wanson Enterprise',
  apiKey: 'fake-enterprise-api-key',
  keyId: 'fake-enterprise-key-id',
};

const SDN_BHD = {
  companyKey: 'sdn_bhd',
  accountBookId: '63688',
  name: 'Wanson Enterprise (M) Sdn Bhd',
  apiKey: 'fake-sdn-api-key',
  keyId: 'fake-sdn-key-id',
};

function row(docKey, extra = {}) {
  return { master: { docKey, docNo: docKey, ...extra }, details: [] };
}

function profileClient(companyName) {
  return {
    profileCalls: 0,
    async getCompanyProfile() {
      this.profileCalls += 1;
      return { companyName };
    },
    async listInvoicePage() {
      throw new Error('listing must not be reached');
    },
  };
}

function pagedClient(companyName, pages) {
  return {
    calls: [],
    async getCompanyProfile() {
      return { companyName };
    },
    async listInvoicePage(company, params) {
      this.calls.push({ company, params });
      return pages[params.page - 1];
    },
  };
}

function fakeHttp(response) {
  const calls = [];
  return {
    calls,
    async get(url, options) {
      calls.push({ url, options });
      return response;
    },
  };
}

test('reads both complete pages after profile-name verification', async () => {
  const pages = [{ totalCount: 2, data: [row('A')] }, { totalCount: 2, data: [row('B')] }];
  const client = pagedClient('WANSON ENTERPRISE', pages);

  const result = await loadPriceSource(client, ENTERPRISE, WINDOW);

  assert.equal(result.rows.length, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.invoiceCount, 2);
  assert.equal(result.profileName, 'WANSON ENTERPRISE');
});

test('rejects incomplete pagination instead of an empty-success result', async () => {
  const pages = [
    { totalCount: 2, data: [row('A')] },
    { totalCount: 2, data: [] },
  ];
  const client = pagedClient('WANSON ENTERPRISE', pages);

  await assert.rejects(
    () => loadPriceSource(client, ENTERPRISE, WINDOW),
    { code: 'PRICE_PAGE_INCOMPLETE' },
  );
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].params.page, 2);
});

test('accepts a verified complete zero as a valid empty snapshot', async () => {
  const client = pagedClient('WANSON ENTERPRISE', [{ totalCount: 0, data: [] }]);

  const result = await loadPriceSource(client, ENTERPRISE, WINDOW);

  assert.deepEqual(result.rows, []);
  assert.equal(result.invoiceCount, 0);
  assert.equal(result.pageCount, 1);
});

test('rejects a configured book id outside the fixed registry before any request', async () => {
  const client = profileClient('WANSON ENTERPRISE');
  client.listInvoicePage = async () => {
    throw new Error('listing must not be reached');
  };

  await assert.rejects(
    () => loadPriceSource(client, { ...ENTERPRISE, accountBookId: '99999' }, WINDOW),
    { code: 'PRICE_SOURCE_INVALID' },
  );
  assert.equal(client.profileCalls, 0);
});

test('rejects a book id that belongs to the other configured company', async () => {
  const client = profileClient('WANSON ENTERPRISE (M) SDN. BHD');

  await assert.rejects(
    () => loadPriceSource(client, { ...SDN_BHD, accountBookId: '63750' }, WINDOW),
    { code: 'PRICE_SOURCE_INVALID' },
  );
  assert.equal(client.profileCalls, 0);
});

test('rejects an unknown company key before any request', async () => {
  const client = profileClient('WANSON ENTERPRISE');

  await assert.rejects(
    () => loadPriceSource(client, { ...ENTERPRISE, companyKey: 'other' }, WINDOW),
    { code: 'PRICE_SOURCE_INVALID' },
  );
  assert.equal(client.profileCalls, 0);
});

test('rejects a profile name that does not match the pinned book', async () => {
  const client = profileClient('WANSON ENTERPRISE');

  await assert.rejects(
    () => loadPriceSource(client, SDN_BHD, WINDOW),
    { code: 'PRICE_PROFILE_MISMATCH' },
  );
});

test('rejects a profile response that omits the company name', async () => {
  const client = {
    async getCompanyProfile() { return {}; },
    async listInvoicePage() { throw new Error('listing must not be reached'); },
  };

  await assert.rejects(
    () => loadPriceSource(client, ENTERPRISE, WINDOW),
    { code: 'PRICE_PROFILE_MISMATCH' },
  );
});

test('matches the live profile name across punctuation and whitespace differences', async () => {
  const client = pagedClient('  wanson   enterprise (m) sdn. bhd.  ', [{ totalCount: 0, data: [] }]);

  const result = await loadPriceSource(client, SDN_BHD, WINDOW);

  assert.equal(result.profileName, '  wanson   enterprise (m) sdn. bhd.  ');
  assert.deepEqual(result.rows, []);
});

test('rejects a page without a stable integer totalCount', async () => {
  const missing = { async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; }, async listInvoicePage() { return { data: [row('A')] }; } };
  await assert.rejects(() => loadPriceSource(missing, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });

  const fractional = { async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; }, async listInvoicePage() { return { totalCount: 1.5, data: [row('A')] }; } };
  await assert.rejects(() => loadPriceSource(fractional, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });

  const textual = { async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; }, async listInvoicePage() { return { totalCount: '1', data: [row('A')] }; } };
  await assert.rejects(() => loadPriceSource(textual, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });
});

test('rejects a totalCount beyond the exact integer range', async () => {
  const client = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage() { return { totalCount: 9007199254740992, data: [row('A')] }; },
  };

  await assert.rejects(() => loadPriceSource(client, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });
});

test('rejects a totalCount that changes between pages', async () => {
  let call = 0;
  const client = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage() {
      call += 1;
      return call === 1
        ? { totalCount: 2, data: [row('A')] }
        : { totalCount: 3, data: [row('B')] };
    },
  };

  await assert.rejects(() => loadPriceSource(client, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });
});

test('rejects a malformed page payload', async () => {
  const client = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage() { return { totalCount: 1, data: 'not-an-array' }; },
  };

  await assert.rejects(() => loadPriceSource(client, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });
});

test('rejects a malformed invoice row shape', async () => {
  const noDocKey = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage() { return { totalCount: 1, data: [{ master: {}, details: [] }] }; },
  };
  await assert.rejects(() => loadPriceSource(noDocKey, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });

  const noDetails = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage() { return { totalCount: 1, data: [{ master: { docKey: 'A' } }] }; },
  };
  await assert.rejects(() => loadPriceSource(noDetails, ENTERPRISE, WINDOW), { code: 'PRICE_SOURCE_INVALID' });
});

test('rejects a duplicate document identity across pages', async () => {
  const client = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage() {
      return { totalCount: 2, data: [row('A')] };
    },
  };

  await assert.rejects(() => loadPriceSource(client, ENTERPRISE, WINDOW), { code: 'PRICE_DUPLICATE_DOC' });
});

test('stops at the maximum page ceiling instead of looping forever', async () => {
  const client = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage(_company, { page }) {
      return { totalCount: 5000, data: [row(`D-${page}`)] };
    },
  };

  await assert.rejects(() => loadPriceSource(client, ENTERPRISE, WINDOW), { code: 'PRICE_PAGE_INCOMPLETE' });
});

test('scans the requested window and preserves raw invoice rows', async () => {
  const raw = row('A');
  raw.details = [{ productCode: 'ITEM-1', unit: 'CTN', unitPrice: '12.345', description: 'Sample' }];
  const client = pagedClient('WANSON ENTERPRISE', [{ totalCount: 1, data: [raw] }]);

  const result = await loadPriceSource(client, ENTERPRISE, WINDOW);

  assert.equal(result.rows[0], raw);
  assert.equal(result.rows[0].details[0].unitPrice, '12.345');
  assert.deepEqual(client.calls[0].params, { page: 1, startDate: '2026-06-01', endDate: '2026-09-21' });
});

test('today defaults to a 91-day scan ending on the Malaysia calendar day', () => {
  const window = priceCheckWindow('2026-09-21T00:00:00Z');
  assert.deepEqual(window, {
    monitorFrom: '2026-09-21',
    historyFrom: '2026-06-23',
    through: '2026-09-21',
  });
});

test('seven_days monitors the last 7 calendar days with a 97-day scan', () => {
  const window = priceCheckWindow('2026-09-21T16:00:00Z', 'seven_days');
  assert.deepEqual(window, {
    monitorFrom: '2026-09-16',
    historyFrom: '2026-06-18',
    through: '2026-09-22',
  });
});

test('rolls the calendar day at Malaysia midnight, not at UTC midnight', () => {
  assert.equal(priceCheckWindow('2026-09-21T15:59:59Z').through, '2026-09-21');
  assert.equal(priceCheckWindow('2026-09-21T16:00:00Z').through, '2026-09-22');
});

test('rejects any range outside today and seven_days', () => {
  assert.throws(
    () => priceCheckWindow('2026-09-21T00:00:00Z', 'last_month'),
    { code: 'PRICE_SOURCE_INVALID' },
  );
  assert.throws(
    () => priceCheckWindow('2026-09-21T00:00:00Z', 'today_plus'),
    { code: 'PRICE_SOURCE_INVALID' },
  );
});

test('getCompanyProfile pins the book URL and sends read-only credential headers', async () => {
  const http = fakeHttp({
    status: 200,
    data: JSON.stringify({ companyName: 'WANSON ENTERPRISE (M) SDN. BHD' }),
  });
  const client = new AutoCountClient({ baseUrl: 'https://cloud.example/', http });

  const profile = await client.getCompanyProfile(SDN_BHD);

  assert.equal(profile.companyName, 'WANSON ENTERPRISE (M) SDN. BHD');
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'https://cloud.example/63688/companyProfile');
  assert.equal(http.calls[0].options.headers['API-Key'], SDN_BHD.apiKey);
  assert.equal(http.calls[0].options.headers['Key-ID'], SDN_BHD.keyId);
  assert.equal(http.calls[0].options.timeout, 15000);
  assert.equal(http.calls[0].options.transformResponse.length, 1);
});

test('getCompanyProfile rejects a non-200 profile response', async () => {
  const http = fakeHttp({ status: 500, data: '{}' });
  const client = new AutoCountClient({ baseUrl: 'https://cloud.example', http });

  await assert.rejects(() => client.getCompanyProfile(ENTERPRISE));
});

async function failureOf(client, { strategy, window = WINDOW } = {}) {
  try {
    await loadPriceSource(client, ENTERPRISE, strategy ? { ...window, strategy } : window);
  } catch (error) {
    return error;
  }
  assert.fail('expected the scan to fail');
}

test('a duplicate carries numeric diagnostics and is marked retryable', async () => {
  // Page 2 re-lists the last row of page 1, as happens when a row is inserted mid-scan.
  const client = pagedClient('WANSON ENTERPRISE', [
    { totalCount: 4, data: [row('A'), row('B')] },
    { totalCount: 4, data: [row('B'), row('C')] },
  ]);
  const error = await failureOf(client);

  assert.equal(error.code, 'PRICE_DUPLICATE_DOC');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.detail, {
    page: 2,
    rowOnPage: 1,
    pageSize: 2,
    totalCount: 4,
    rowsRead: 2,
    firstSeenOnPage: 1,
    pageRepeated: false,
    sameContent: true,
  });
});

test('a page that repeats the previous page is reported as ignored paging', async () => {
  const client = pagedClient('WANSON ENTERPRISE', [
    { totalCount: 4, data: [row('A'), row('B')] },
    { totalCount: 4, data: [row('A'), row('B')] },
  ]);
  const error = await failureOf(client);

  assert.equal(error.code, 'PRICE_DUPLICATE_DOC');
  assert.equal(error.detail.pageRepeated, true);
  assert.equal(error.detail.page, 2);
  assert.equal(error.detail.rowOnPage, 1);
});

test('two different invoices sharing one document key are reported as such', async () => {
  const client = pagedClient('WANSON ENTERPRISE', [
    { totalCount: 2, data: [row('A', { docNo: 'INV-1' }), row('A', { docNo: 'INV-2' })] },
  ]);
  const error = await failureOf(client);

  assert.equal(error.code, 'PRICE_DUPLICATE_DOC');
  assert.equal(error.detail.page, 1);
  assert.equal(error.detail.rowOnPage, 2);
  assert.equal(error.detail.firstSeenOnPage, 1);
  assert.equal(error.detail.sameContent, false);
  assert.equal(JSON.stringify(error.detail).includes('INV-'), false);
});

test('a total that changes between pages is retryable and reports both totals', async () => {
  const client = pagedClient('WANSON ENTERPRISE', [
    { totalCount: 3, data: [row('A')] },
    { totalCount: 4, data: [row('B')] },
  ]);
  const error = await failureOf(client);

  assert.equal(error.code, 'PRICE_SOURCE_INVALID');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.detail, { page: 2, totalCount: 3, receivedTotal: 4, rowsRead: 1 });
});

test('ending early is retryable, but a malformed row or the page ceiling is not', async () => {
  const early = await failureOf(pagedClient('WANSON ENTERPRISE', [
    { totalCount: 3, data: [row('A')] },
    { totalCount: 3, data: [] },
  ]));
  assert.equal(early.code, 'PRICE_PAGE_INCOMPLETE');
  assert.equal(early.retryable, true);
  assert.equal(early.detail.rowsRead, 1);
  assert.equal(early.detail.totalCount, 3);

  const malformed = await failureOf(pagedClient('WANSON ENTERPRISE', [
    { totalCount: 1, data: [{ master: {}, details: [] }] },
  ]));
  assert.equal(malformed.retryable, undefined);

  const ceiling = await failureOf({
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage(_company, { page }) { return { totalCount: 5000, data: [row(`D-${page}`)] }; },
  });
  assert.equal(ceiling.code, 'PRICE_PAGE_INCOMPLETE');
  assert.equal(ceiling.retryable, undefined);
});

// ---------------------------------------------------------------------------
// Windowed (date-slice) reads
// ---------------------------------------------------------------------------

const LONG_WINDOW = { historyFrom: '2026-07-07', through: '2026-10-05' };
const isoDay = (offset) => new Date(Date.UTC(2026, 6, 7 + offset)).toISOString().slice(0, 10);

function invoicesPerDay(counts) {
  const invoices = [];
  counts.forEach((count, day) => {
    for (let index = 0; index < count; index += 1) {
      invoices.push(row(`K-${day}-${index}`, { docDate: isoDay(day), docNo: `INV-${day}-${index}` }));
    }
  });
  return invoices;
}

// A fake Cloud over a fixed set of invoices. `unstablePaging` orders every page
// after the first differently from page 1, so pages overlap (the behaviour seen
// on the live books); `endExclusive` and `ignoreDates` model a misread filter.
function fakeCloud(invoices, { unstablePaging = false, endExclusive = false, ignoreDates = false } = {}) {
  let active = 0;
  const cloud = {
    calls: [],
    maxActive: 0,
    async getCompanyProfile() {
      return { companyName: 'WANSON ENTERPRISE' };
    },
    async listInvoicePage(_company, { page, startDate, endDate }) {
      cloud.calls.push({ page, startDate, endDate });
      active += 1;
      cloud.maxActive = Math.max(cloud.maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const matching = invoices
        .filter((entry) => ignoreDates
          || (entry.master.docDate >= startDate
            && (endExclusive ? entry.master.docDate < endDate : entry.master.docDate <= endDate)))
        .sort((left, right) => `${left.master.docDate}${left.master.docKey}`.localeCompare(`${right.master.docDate}${right.master.docKey}`));
      const total = matching.length;
      const ordered = unstablePaging && page > 1 && total > 0
        ? matching.map((_, index) => matching[(index - 13 * (page - 1) + total * 100) % total])
        : matching;
      return { totalCount: total, data: ordered.slice((page - 1) * 100, page * 100) };
    },
  };
  return cloud;
}

const MIXED_DAYS = Array.from({ length: 91 }, (_, day) => (day === 40 ? 60 : 5 + ((day * 7) % 23)));

test('a Cloud that cannot order pages fails the paged read but the windowed read gets every invoice once', async () => {
  const invoices = invoicesPerDay(MIXED_DAYS);
  assert.ok(invoices.length > 1000, 'fixture must span many pages');

  const paged = await failureOf(fakeCloud(invoices, { unstablePaging: true }));
  assert.equal(paged.code, 'PRICE_DUPLICATE_DOC');

  const cloud = fakeCloud(invoices, { unstablePaging: true });
  const result = await loadPriceSource(cloud, ENTERPRISE, { ...LONG_WINDOW, strategy: 'windowed' });

  assert.equal(result.strategy, 'windowed');
  assert.equal(result.rows.length, invoices.length);
  assert.deepEqual(
    result.rows.map((entry) => entry.master.docKey).sort(),
    invoices.map((entry) => entry.master.docKey).sort(),
  );
  assert.equal(result.invoiceCount, invoices.length);
  assert.equal(result.pageCount, cloud.calls.length);
  assert.equal(cloud.calls.every((call) => call.page === 1), true, 'every slice fits on one page');
  assert.ok(cloud.calls.length < 120, `used ${cloud.calls.length} requests`);
  assert.ok(cloud.maxActive >= 2 && cloud.maxActive <= 3, `concurrency was ${cloud.maxActive}`);
});

test('the default strategy is still the page-by-page read', async () => {
  const invoices = invoicesPerDay(MIXED_DAYS);
  const cloud = fakeCloud(invoices);
  const result = await loadPriceSource(cloud, ENTERPRISE, LONG_WINDOW);

  assert.equal(result.strategy, 'paged');
  assert.equal(result.rows.length, invoices.length);
  assert.deepEqual(cloud.calls.map((call) => call.page), cloud.calls.map((_, index) => index + 1));
});

test('a windowed read of a range that fits one page is a single request', async () => {
  const cloud = fakeCloud(invoicesPerDay(Array.from({ length: 91 }, (_, day) => (day % 5 === 0 ? 2 : 0))));
  const result = await loadPriceSource(cloud, ENTERPRISE, { ...LONG_WINDOW, strategy: 'windowed' });

  assert.equal(cloud.calls.length, 1);
  assert.equal(result.rows.length, 38);
});

test('windowed slices that do not add up to the overall total fail closed and are retryable', async () => {
  const cloud = fakeCloud(invoicesPerDay(MIXED_DAYS), { endExclusive: true });
  const error = await failureOf(Object.assign(cloud, {}), { strategy: 'windowed', window: LONG_WINDOW });

  assert.equal(error.code, 'PRICE_PAGE_INCOMPLETE');
  assert.equal(error.retryable, true);
  assert.equal(error.detail.windowed, true);
  assert.ok(error.detail.rowsRead < error.detail.totalCount);
  assert.ok(error.detail.windowCount > 1);
});

test('one day bigger than a page is paged on its own, and the strict checks still apply', async () => {
  const counts = Array.from({ length: 91 }, (_, day) => (day === 10 ? 130 : 3));
  const invoices = invoicesPerDay(counts);

  const stable = fakeCloud(invoices);
  const result = await loadPriceSource(stable, ENTERPRISE, { ...LONG_WINDOW, strategy: 'windowed' });
  assert.equal(result.rows.length, invoices.length);
  const busyDay = isoDay(10);
  assert.ok(stable.calls.some((call) => call.page === 2 && call.startDate === busyDay && call.endDate === busyDay));

  const unstable = fakeCloud(invoices, { unstablePaging: true });
  const error = await failureOf(unstable, { strategy: 'windowed', window: LONG_WINDOW });
  assert.equal(error.code, 'PRICE_DUPLICATE_DOC');
  assert.equal(error.detail.windowed, true);
});

test('a duplicate across the slices is reported with its slice numbers and no invoice text', async () => {
  const client = {
    async getCompanyProfile() { return { companyName: 'WANSON ENTERPRISE' }; },
    async listInvoicePage() { return { totalCount: 3, data: [row('A'), row('B'), row('B')] }; },
  };
  const error = await failureOf(client, { strategy: 'windowed', window: WINDOW });

  assert.equal(error.code, 'PRICE_DUPLICATE_DOC');
  assert.deepEqual(error.detail, {
    windowed: true,
    windowIndex: 1,
    windowCount: 1,
    rowOnPage: 3,
    totalCount: 3,
    rowsRead: 2,
    firstSeenInWindow: 1,
    sameContent: true,
  });
});

test('a date filter that does not narrow results hits the request ceiling instead of looping', async () => {
  const cloud = fakeCloud(invoicesPerDay(Array.from({ length: 91 }, (_, day) => (day < 10 ? 50 : 0))), { ignoreDates: true });
  const error = await failureOf(cloud, { strategy: 'windowed', window: LONG_WINDOW });

  assert.equal(error.code, 'PRICE_PAGE_INCOMPLETE');
  assert.equal(error.retryable, undefined, 'a broken filter is not retried');
  assert.equal(error.detail.windowed, true);
  assert.ok(cloud.calls.length <= 250, `made ${cloud.calls.length} requests`);
});

test('a failing request stops the remaining slices from being requested', async () => {
  let calls = 0;
  const invoices = invoicesPerDay(MIXED_DAYS);
  const inner = fakeCloud(invoices);
  const client = {
    getCompanyProfile: inner.getCompanyProfile,
    async listInvoicePage(company, params) {
      calls += 1;
      if (calls === 4) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return inner.listInvoicePage(company, params);
    },
  };
  const error = await failureOf(client, { strategy: 'windowed', window: LONG_WINDOW });

  assert.equal(error.code, 'ECONNRESET');
  assert.ok(calls < 12, `kept requesting after the failure: ${calls}`);
});

test('an unknown read strategy is rejected', async () => {
  const error = await failureOf(fakeCloud([]), { strategy: 'sideways', window: LONG_WINDOW });
  assert.equal(error.code, 'PRICE_SOURCE_INVALID');
});
