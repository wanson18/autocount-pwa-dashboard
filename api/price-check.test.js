const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../lib/dispatch/auth');
const { createPriceCheckHandler } = require('./price-check');

const NOW = new Date('2026-09-21T04:00:00Z');
const QUIET = { error() {} };
const SECRET = Buffer.alloc(32, 9).toString('base64url');
const pinHashPromise = auth.hashDispatchPin('2468');
let cachedPinHash = null;

const ENTERPRISE_PROFILE = 'WANSON ENTERPRISE';
const SDN_PROFILE = 'WANSON ENTERPRISE (M) SDN. BHD';

const CONFIGS = {
  enterprise: {
    companyKey: 'enterprise',
    name: 'Wanson Enterprise',
    accountBookId: '63750',
    keyId: 'fake-enterprise-key-id',
    apiKey: 'fake-enterprise-api-key',
  },
  sdn_bhd: {
    companyKey: 'sdn_bhd',
    name: 'Wanson Enterprise (M) Sdn Bhd',
    accountBookId: '63688',
    keyId: 'fake-sdn-key-id',
    apiKey: 'fake-sdn-api-key',
  },
};

const ENTERPRISE_PAGES = [{
  totalCount: 2,
  data: [
    invoice('I-1', '2026-06-01', '10.00'),
    invoice('I-2', '2026-09-21', '12.00'),
  ],
}];
const SDN_PAGES = [{ totalCount: 0, data: [] }];

function response() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

function invoice(docNo, docDate, price, unit = 'CTN', extra = {}) {
  return {
    master: {
      docKey: docNo,
      docNo,
      docDate,
      debtorCode: '700-A001',
      debtorName: 'Sample',
      approverID: 5,
      approvedTimeStamp: `${docDate}T09:00:00`,
      cancelled: false,
      ...extra,
    },
    details: [{
      productCode: 'ITEM-1',
      description: 'Sample item',
      unit,
      qty: '2',
      unitPrice: price,
      subTotal: '20.00',
    }],
  };
}

function cloudClient({ enterprisePages = ENTERPRISE_PAGES, sdnPages = SDN_PAGES, profile = {} } = {}) {
  const names = { '63750': ENTERPRISE_PROFILE, '63688': SDN_PROFILE, ...profile };
  return {
    cloudCalls: 0,
    async getCompanyProfile(company) {
      this.cloudCalls += 1;
      const name = names[company.accountBookId];
      if (name === 'REJECT') {
        const error = new Error('internal profile detail');
        error.code = 'PRICE_PROFILE_MISMATCH';
        throw error;
      }
      return { companyName: name };
    },
    async listInvoicePage(company, params) {
      this.cloudCalls += 1;
      const pages = company.accountBookId === '63750' ? enterprisePages : sdnPages;
      const page = pages[params.page - 1];
      if (page === 'REJECT') {
        const error = new Error('internal listing detail');
        error.code = 'PRICE_PAGE_INCOMPLETE';
        throw error;
      }
      return page;
    },
  };
}

async function signedEnv() {
  if (!cachedPinHash) cachedPinHash = await pinHashPromise;
  return {
    DISPATCH_SESSION_SECRET: SECRET,
    DISPATCH_USERS_JSON: JSON.stringify([
      { clerkId: 'clerk-1', role: 'admin', active: true, pinHash: cachedPinHash },
    ]),
  };
}

function signedCookie() {
  return auth.createSessionCookie(
    { clerkId: 'clerk-1', role: 'admin' },
    { secret: SECRET, now: NOW },
  ).cookie;
}

test('public dispatch mode without a real cookie never reads prices', async () => {
  let cloudCalls = 0;
  let syntheticCalls = 0;
  const handler = createPriceCheckHandler({
    env: { DISPATCH_PUBLIC_ACCESS: 'true' },
    auth: {
      verifySessionCookie: () => null,
      getSessionFromRequest: () => {
        syntheticCalls += 1;
        return { clerkId: 'public-dispatch', role: 'admin' };
      },
    },
    client: { getCompanyProfile: async () => { cloudCalls += 1; } },
    now: NOW,
  });

  const res = response();
  await handler({ method: 'GET', headers: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(cloudCalls, 0);
  assert.equal(syntheticCalls, 0);
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
});

test('an invalid signed cookie is rejected with 401 and no Cloud reads', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: 'dispatch_session=forged.token' }, query: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(client.cloudCalls, 0);
});

test('a real signed cookie returns PASS with exact window, alerts, and no-store', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const spyAuth = {
    verifySessionCookie: (cookie, options) => auth.verifySessionCookie(cookie, options),
    getSessionFromRequest: () => {
      throw new Error('getSessionFromRequest must never be used');
    },
  };
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth: spyAuth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PASS');
  assert.equal(res.body.cloudWrites, false);
  assert.equal(res.body.scannedAt, NOW.toISOString());
  assert.deepEqual(res.body.window, {
    monitorFrom: '2026-09-21',
    historyFrom: '2026-06-23',
    through: '2026-09-21',
  });
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].type, 'PRICE_CHANGED');
  assert.equal(res.body.alerts[0].differenceMYR, '2.00');
  assert.equal(res.body.alerts[0].bookId, '63750');
  assert.equal(res.body.counts.alerts, 1);
  assert.equal(res.body.counts.booksScanned, 2);
  assert.equal(res.body.counts.booksFailed, 0);
  assert.equal(res.body.sources.length, 2);
  assert.equal(res.body.sources.every((source) => source.ok === true), true);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  assert.deepEqual(
    Object.keys(res.body).sort(),
    ['alerts', 'cloudWrites', 'counts', 'scannedAt', 'sources', 'status', 'window'],
  );
});

test('selecting seven_days scans the 97-day window', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: { range: 'seven_days' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.window, {
    monitorFrom: '2026-09-15',
    historyFrom: '2026-06-17',
    through: '2026-09-21',
  });
});

test('one failed book yields PARTIAL, keeps the other alerts, and leaks no message', async () => {
  const env = await signedEnv();
  const client = cloudClient({ sdnPages: ['REJECT'] });
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PARTIAL');
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].bookId, '63750');
  assert.equal(res.body.counts.booksScanned, 1);
  assert.equal(res.body.counts.booksFailed, 1);

  const failed = res.body.sources.find((source) => source.ok === false);
  assert.ok(failed);
  assert.equal(failed.companyKey, 'sdn_bhd');
  assert.equal(failed.code, 'PRICE_PAGE_INCOMPLETE');
  assert.equal(JSON.stringify(res.body).includes('internal listing detail'), false);
});

test('a comparison-level cross-book failure marks only that book failed', async () => {
  const env = await signedEnv();
  const sdnAlertPages = [{
    totalCount: 2,
    data: [
      invoice('S-1', '2026-06-01', '10.00'),
      invoice('S-2', '2026-09-21', '12.00'),
    ],
  }];
  const enterpriseCrossBook = [{
    totalCount: 2,
    data: [
      invoice('I-1', '2026-06-01', '10.00', 'CTN', { accountBookId: '63688' }),
      invoice('I-2', '2026-09-21', '12.00', 'CTN', { accountBookId: '63688' }),
    ],
  }];
  const client = cloudClient({ enterprisePages: enterpriseCrossBook, sdnPages: sdnAlertPages });
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PARTIAL');
  assert.equal(res.body.alerts.length, 1);
  assert.equal(res.body.alerts[0].bookId, '63688');
  assert.equal(res.body.counts.alerts, 1);
  assert.equal(res.body.counts.booksScanned, 1);
  assert.equal(res.body.counts.booksFailed, 1);

  const failed = res.body.sources.find((source) => source.ok === false);
  assert.ok(failed);
  assert.equal(failed.companyKey, 'enterprise');
  assert.equal(failed.code, 'PRICE_BOOK_MISMATCH');
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
  assert.equal(JSON.stringify(res.body).includes('fake-enterprise-api-key'), false);
});

test('both comparison failures yield FAIL/502 with no alerts', async () => {
  const env = await signedEnv();
  const enterpriseCrossBook = [{
    totalCount: 2,
    data: [
      invoice('I-1', '2026-06-01', '10.00', 'CTN', { accountBookId: '63688' }),
      invoice('I-2', '2026-09-21', '12.00', 'CTN', { accountBookId: '63688' }),
    ],
  }];
  const sdnCrossBook = [{
    totalCount: 2,
    data: [
      invoice('S-1', '2026-06-01', '10.00', 'CTN', { accountBookId: '63750' }),
      invoice('S-2', '2026-09-21', '12.00', 'CTN', { accountBookId: '63750' }),
    ],
  }];
  const client = cloudClient({ enterprisePages: enterpriseCrossBook, sdnPages: sdnCrossBook });
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.status, 'FAIL');
  assert.deepEqual(res.body.alerts, []);
  assert.equal(res.body.counts.booksScanned, 0);
  assert.equal(res.body.sources.every((source) => source.ok === false), true);
  assert.equal(res.body.sources.every((source) => source.code === 'PRICE_BOOK_MISMATCH'), true);
});

test('both failed books yield FAIL/502 with no alerts', async () => {
  const env = await signedEnv();
  const client = cloudClient({ sdnPages: ['REJECT'], profile: { '63750': 'REJECT' } });
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.body.status, 'FAIL');
  assert.deepEqual(res.body.alerts, []);
  assert.equal(res.body.cloudWrites, false);
  assert.equal(res.body.counts.booksScanned, 0);
  assert.equal(res.body.counts.alerts, 0);
  assert.equal(res.body.sources.every((source) => source.ok === false), true);
});

test('POST is rejected with 405 and never verifies or reads Cloud', async () => {
  let verifyCalls = 0;
  const handler = createPriceCheckHandler({
    auth: { verifySessionCookie: () => { verifyCalls += 1; return null; } },
    client: { getCompanyProfile: async () => { throw new Error('no reads'); } },
    now: NOW,
  });

  const res = response();
  await handler({ method: 'POST', headers: {} }, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET');
  assert.equal(verifyCalls, 0);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
});

test('an invalid range is rejected with 400 before any Cloud read', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: { range: 'last_month' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(client.cloudCalls, 0);
});

test('an unexpected query key or array range is rejected with 400', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const extraKey = response();
  await handler(
    { method: 'GET', headers: { cookie: signedCookie() }, query: { range: 'today', startDate: '2020-01-01' } },
    extraKey,
  );
  assert.equal(extraKey.statusCode, 400);

  const arrayRange = response();
  await handler(
    { method: 'GET', headers: { cookie: signedCookie() }, query: { range: ['today', 'seven_days'] } },
    arrayRange,
  );
  assert.equal(arrayRange.statusCode, 400);
  assert.equal(client.cloudCalls, 0);
});

test('a configuration that crosses the fixed book ids fails closed without Cloud reads', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const crossed = {
    ...CONFIGS,
    enterprise: { ...CONFIGS.enterprise, accountBookId: '63688' },
  };
  const handler = createPriceCheckHandler({ env, client, configs: crossed, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(client.cloudCalls, 0);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
});

test('the response never contains credentials, raw invoices, or internal messages', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger: QUIET });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  const serialized = JSON.stringify(res.body);
  for (const token of [
    'fake-enterprise-api-key',
    'fake-enterprise-key-id',
    'fake-sdn-api-key',
    'fake-sdn-key-id',
    'apiKey',
    'keyId',
    'pinHash',
    'master',
    'unitPrice',
    'internal profile detail',
    'internal listing detail',
  ]) {
    assert.equal(serialized.includes(token), false, `response leaked ${token}`);
  }
});

function scriptedClient({ enterprise, sdn }) {
  const scans = { '63750': 0, '63688': 0 };
  const listCalls = { '63750': 0, '63688': 0 };
  return {
    scans,
    listCalls,
    async getCompanyProfile(company) {
      return { companyName: company.accountBookId === '63750' ? ENTERPRISE_PROFILE : SDN_PROFILE };
    },
    async listInvoicePage(company, { page }) {
      const id = company.accountBookId;
      if (page === 1) scans[id] += 1;
      listCalls[id] += 1;
      return (id === '63750' ? enterprise : sdn)(scans[id], page);
    },
  };
}

const enterpriseOk = (_scan, page) => ENTERPRISE_PAGES[page - 1];

async function runScripted(client, logger = QUIET) {
  const env = await signedEnv();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW, logger });
  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);
  return res;
}

// ---- a Cloud that answers by date range, optionally misordering later pages ----

const addDay = (offset) => new Date(Date.UTC(2026, 5, 23 + offset)).toISOString().slice(0, 10);

function sdnInvoices() {
  const invoices = [];
  for (let index = 0; index < 150; index += 1) {
    invoices.push(invoice(`SDN-INV-${index}`, addDay(index % 80), '10.00', 'CTN', {
      debtorCode: `700-B${index % 7}`,
    }));
  }
  return invoices;
}

const ENTERPRISE_BY_DATE = [
  invoice('E-1', '2026-09-01', '10.00'),
  invoice('E-2', '2026-09-21', '12.00'),
];

function dateAwareCloud({ sdn = sdnInvoices(), unstableSdn = false, endExclusiveSdn = false } = {}) {
  const calls = { '63750': [], '63688': [] };
  return {
    calls,
    async getCompanyProfile(company) {
      return { companyName: company.accountBookId === '63750' ? ENTERPRISE_PROFILE : SDN_PROFILE };
    },
    async listInvoicePage(company, { page, startDate, endDate }) {
      const id = company.accountBookId;
      calls[id].push({ page, startDate, endDate });
      const isSdn = id === '63688';
      const matching = (isSdn ? sdn : ENTERPRISE_BY_DATE)
        .filter((entry) => entry.master.docDate >= startDate
          && (isSdn && endExclusiveSdn ? entry.master.docDate < endDate : entry.master.docDate <= endDate))
        .sort((left, right) => `${left.master.docDate}${left.master.docKey}`.localeCompare(`${right.master.docDate}${right.master.docKey}`));
      const total = matching.length;
      // Pages after the first are ordered differently, so they overlap page 1.
      const ordered = isSdn && unstableSdn && page > 1 && total > 0
        ? matching.map((_, index) => matching[(index - 13 * (page - 1) + total * 100) % total])
        : matching;
      return { totalCount: total, data: ordered.slice((page - 1) * 100, page * 100) };
    },
  };
}

test('a list that cannot be paged reliably is re-read in date slices and can still PASS', async () => {
  const logs = [];
  const cloud = dateAwareCloud({ unstableSdn: true });
  const res = await runScripted(cloud, { error: (...args) => logs.push(args) });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PASS');
  const sdn = res.body.sources.find((source) => source.companyKey === 'sdn_bhd');
  const enterprise = res.body.sources.find((source) => source.companyKey === 'enterprise');
  assert.deepEqual([sdn.ok, sdn.attempts, sdn.strategy], [true, 2, 'windowed']);
  assert.deepEqual([enterprise.ok, enterprise.attempts, enterprise.strategy], [true, 1, 'paged']);
  assert.equal(sdn.invoiceCount, 150, 'every invoice is read exactly once');
  assert.equal(cloud.calls['63750'].length, 1, 'the stable book is read once, page by page');
  assert.ok(cloud.calls['63688'].some((call) => call.page === 2), 'the first attempt paged');
  assert.ok(cloud.calls['63688'].some((call) => call.startDate !== '2026-06-23' || call.endDate !== '2026-09-21'),
    'the second attempt asked for narrower date ranges');
  assert.equal(res.body.counts.booksFailed, 0);
  assert.deepEqual(logs.map((entry) => entry[1]), ['retrying']);
  assert.equal(logs[0][2].strategy, 'paged');
  assert.equal(logs[0][2].code, 'PRICE_DUPLICATE_DOC');
});

test('a book that fails both reads is reported with numeric diagnostics only', async () => {
  const logs = [];
  const cloud = dateAwareCloud({ unstableSdn: true, endExclusiveSdn: true });
  const res = await runScripted(cloud, { error: (...args) => logs.push(args) });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PARTIAL');
  const failed = res.body.sources.find((source) => source.ok === false);
  assert.equal(failed.companyKey, 'sdn_bhd');
  assert.equal(failed.code, 'PRICE_PAGE_INCOMPLETE');
  assert.equal(failed.attempts, 2);
  assert.equal(failed.strategy, 'windowed');
  assert.equal(failed.detail.windowed, true);
  assert.ok(Number.isSafeInteger(failed.detail.totalCount) && failed.detail.totalCount > 0);
  assert.ok(failed.detail.rowsRead < failed.detail.totalCount);
  assert.ok(failed.detail.windowCount > 1);

  assert.deepEqual(logs.map((entry) => entry[1]), ['retrying', 'failed']);
  assert.deepEqual(logs.map((entry) => entry[2].strategy), ['paged', 'windowed']);
  const logged = JSON.stringify(logs);
  const serialized = JSON.stringify(res.body);
  for (const token of ['SDN-INV-', 'Sample', 'fake-sdn-api-key', 'fake-sdn-key-id', 'apiKey']) {
    assert.equal(logged.includes(token), false, `log leaked ${token}`);
  }
  // The healthy book's alert legitimately names its customer ("Sample"); the failed book's rows must not appear.
  for (const token of ['SDN-INV-', 'fake-sdn-api-key', 'fake-sdn-key-id', 'apiKey']) {
    assert.equal(serialized.includes(token), false, `response leaked ${token}`);
  }
});

test('failures that are not list instability are never retried', async () => {
  const client = scriptedClient({
    enterprise: enterpriseOk,
    sdn: () => {
      const error = new Error('internal listing detail');
      error.code = 'PRICE_PAGE_INCOMPLETE';
      throw error;
    },
  });
  const res = await runScripted(client);

  assert.equal(client.scans['63688'], 1);
  const failed = res.body.sources.find((source) => source.ok === false);
  assert.equal(failed.attempts, 1);
  assert.equal(failed.detail, undefined);
});

test('only whitelisted integers and booleans from an error detail reach the response', async () => {
  const client = scriptedClient({
    enterprise: enterpriseOk,
    sdn: () => {
      const error = new Error('internal listing detail');
      error.code = 'PRICE_PAGE_INCOMPLETE';
      error.detail = {
        page: 3,
        totalCount: 7,
        sameContent: false,
        rowsRead: -1,
        pageSize: 100.5,
        rowOnPage: '4',
        docNo: 'SI-SECRET',
        customerName: 'Secret Customer',
        nested: { page: 1 },
      };
      throw error;
    },
  });
  const res = await runScripted(client);

  const failed = res.body.sources.find((source) => source.ok === false);
  assert.deepEqual(failed.detail, { page: 3, totalCount: 7, sameContent: false });
  const serialized = JSON.stringify(res.body);
  for (const token of ['SI-SECRET', 'Secret Customer', 'internal listing detail']) {
    assert.equal(serialized.includes(token), false, `response leaked ${token}`);
  }
});

test('an HTTP status or timeout explains an unreachable book without leaking the message', async () => {
  const failing = (make) => scriptedClient({
    enterprise: enterpriseOk,
    sdn: () => { throw make(); },
  });

  let res = await runScripted(failing(() => Object.assign(new Error('Request failed with status code 429 for https://secret.example/x'), { response: { status: 429 } })));
  let failed = res.body.sources.find((source) => source.ok === false);
  assert.equal(failed.code, 'PRICE_SOURCE_UNAVAILABLE');
  assert.deepEqual(failed.detail, { httpStatus: 429 });
  assert.equal(failed.attempts, 1, 'a rate limit or outage is not retried');
  assert.equal(JSON.stringify(res.body).includes('secret.example'), false);

  res = await runScripted(failing(() => Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' })));
  failed = res.body.sources.find((source) => source.ok === false);
  assert.deepEqual(failed.detail, { timedOut: true });
  assert.equal(JSON.stringify(res.body).includes('15000ms'), false);

  res = await runScripted(failing(() => Object.assign(new Error('x'), { response: { status: 99999 } })));
  failed = res.body.sources.find((source) => source.ok === false);
  assert.equal(failed.detail, undefined, 'a nonsense status is ignored');
});
