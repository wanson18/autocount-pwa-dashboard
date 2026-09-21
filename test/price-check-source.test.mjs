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
