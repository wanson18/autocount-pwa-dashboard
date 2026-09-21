const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../lib/dispatch/auth');
const { createPriceCheckHandler } = require('./price-check');

const NOW = new Date('2026-09-21T04:00:00Z');
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

test('price check is public and reads prices without dispatch credentials', async () => {
  const client = cloudClient();
  const handler = createPriceCheckHandler({
    env: { DISPATCH_PUBLIC_ACCESS: 'false' },
    client,
    configs: CONFIGS,
    now: NOW,
  });

  const res = response();
  await handler({ method: 'GET', headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PASS');
  assert.equal(res.body.cloudWrites, false);
  assert.ok(client.cloudCalls > 0);
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
});

test('a forged dispatch cookie does not affect public price checks', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, now: NOW });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: 'dispatch_session=forged.token' }, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'PASS');
  assert.ok(client.cloudCalls > 0);
});

test('a public request returns PASS with exact window, alerts, and no-store', async () => {
  const client = cloudClient();
  const handler = createPriceCheckHandler({ client, configs: CONFIGS, now: NOW });

  const res = response();
  await handler({ method: 'GET', headers: {}, query: {} }, res);

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
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

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
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

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
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

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
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

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
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

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
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: { range: 'last_month' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(client.cloudCalls, 0);
});

test('an unexpected query key or array range is rejected with 400', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

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
  const handler = createPriceCheckHandler({ env, client, configs: crossed, auth, now: NOW });

  const res = response();
  await handler({ method: 'GET', headers: { cookie: signedCookie() }, query: {} }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(client.cloudCalls, 0);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0, must-revalidate');
});

test('the response never contains credentials, raw invoices, or internal messages', async () => {
  const env = await signedEnv();
  const client = cloudClient();
  const handler = createPriceCheckHandler({ env, client, configs: CONFIGS, auth, now: NOW });

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
