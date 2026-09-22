import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const price = readFileSync(new URL('../public/price-check.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function createElement(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id,
    tagName: 'DIV',
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    className: '',
    dataset: {},
    attributes: {},
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener() {},
    dispatch(type, event) { (listeners[type] || []).forEach((handler) => handler(event)); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    appendChild(child) { return child; },
  };
}

function createDocument() {
  const elements = new Map();
  return {
    elements,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) { const element = createElement(''); element.tagName = tag; return element; },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function loadPage(fetchImpl = async () => { throw new Error('fetch not stubbed'); }) {
  const scripts = [...price.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((source) => source.includes('function loadPrices'));
  assert.ok(script, 'price-check.html must define an inline loadPrices function');

  const document = createDocument();
  const windowListeners = {};
  const sandbox = {
    document,
    window: { addEventListener(type, handler) { windowListeners[type] = handler; } },
    navigator: { onLine: true },
    console,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'public/price-check.html' });
  return { sandbox, document, windowListeners };
}

function alertFixture(customerName) {
  return {
    type: 'PRICE_CHANGED',
    bookId: '63750',
    companyName: 'Wanson Enterprise',
    docNo: 'SI-0001',
    docDate: '2026-09-21',
    customerCode: '700-A001',
    customerName,
    itemCode: 'ITEM-1',
    description: 'Sample item',
    uom: 'CTN',
    previousUom: 'CTN',
    currentPrice: '12.00',
    previousPrice: '10.00',
    differenceMYR: '2.00',
    differencePercent: '20.00',
    previousDocNo: 'SI-0000',
    previousDocDate: '2026-06-01',
  };
}

function resultFixture(overrides = {}) {
  return {
    status: 'PASS',
    scannedAt: '2026-09-21T04:00:00.000Z',
    window: { monitorFrom: '2026-09-21', historyFrom: '2026-06-23', through: '2026-09-21' },
    sources: [
      { companyKey: 'enterprise', companyName: 'Wanson Enterprise', ok: true },
      { companyKey: 'sdn_bhd', companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: true },
    ],
    alerts: [],
    counts: {},
    cloudWrites: false,
    ...overrides,
  };
}

test('mobile PWA exposes a fresh protected price view with dashboard login', () => {
  assert.match(home, /href="\/price-check\.html"/);
  assert.match(home, /id="dashboardLoginView"/);
  assert.match(home, /id="dashboardAppView" hidden/);
  assert.match(home, /id="dashboardLoginForm"/);
  assert.match(home, /id="dashboardClerkId"/);
  assert.match(home, /id="dashboardPin"/);
  assert.match(home, /Check Price Differences/);
  for (const id of ['priceCheckRefresh', 'priceCheckStatus', 'priceCheckList']) {
    assert.match(price, new RegExp(`id="${id}"`));
  }
  assert.match(price, /\/api\/price-check/);
  assert.match(price, /cache:\s*'no-store'/);
  assert.match(price, /credentials:\s*'same-origin'/);
  assert.doesNotMatch(price, /priceCheckSignIn|dashboardLoginForm/);
  assert.match(price, /escapeHtml/);
  assert.match(sw, /'\/price-check\.html'/);
});

test('the service worker bumps the cache namespace and lists the price page', () => {
  assert.match(sw, /const CACHE_NAME = 'sales-dashboard-v14'/);
  assert.match(sw, /'\/price-check\.html'/);
});

test('renders customer data as escaped text and distinguishes state by text', () => {
  const { sandbox, document } = loadPage();

  sandbox.renderResult(resultFixture({ alerts: [alertFixture('<script>alert(1)</script>')], counts: { noHistory: 3, skippedInvalidLine: 1 } }));
  const listHtml = document.getElementById('priceCheckList').innerHTML;
  assert.equal(listHtml.includes('<script>alert(1)</script>'), false);
  assert.match(listHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(listHtml, /SI-0001/);
  assert.match(listHtml, /10\.00/);
  assert.match(listHtml, /12\.00/);
  assert.match(listHtml, /Invoice: SI-0001 · 2026-09-21/);
  assert.match(document.getElementById('priceCheckStatus').textContent, /PASS/);
  assert.match(document.getElementById('priceCheckCounts').innerHTML, /No history/i);
  assert.match(document.getElementById('priceCheckCounts').innerHTML, /Skipped/i);
  assert.match(document.getElementById('priceCheckCoverage').innerHTML, /Wanson Enterprise/);

  sandbox.renderResult(resultFixture({
    status: 'PARTIAL',
    alerts: [],
    sources: [
      { companyName: 'Wanson Enterprise', ok: true },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: false, code: 'PRICE_PAGE_INCOMPLETE' },
    ],
  }));
  assert.match(document.getElementById('priceCheckStatus').textContent, /PARTIAL/);

  sandbox.renderResult(resultFixture({
    status: 'FAIL',
    sources: [
      { companyName: 'Wanson Enterprise', ok: false, code: 'PRICE_PROFILE_MISMATCH' },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: false, code: 'PRICE_PAGE_INCOMPLETE' },
    ],
  }));
  assert.match(document.getElementById('priceCheckStatus').textContent, /FAIL/);

  sandbox.renderResult(resultFixture({ status: 'PASS', alerts: [] }));
  assert.match(document.getElementById('priceCheckStatus').textContent, /No price differences/i);
});

test('a 401 clears customer rows and points back to the dashboard login', () => {
  const { sandbox, document } = loadPage();

  sandbox.renderResult(resultFixture({ alerts: [alertFixture('Private Customer Sdn Bhd')] }));
  assert.match(document.getElementById('priceCheckList').innerHTML, /Private Customer Sdn Bhd/);

  sandbox.renderUnauthorized();

  assert.equal(document.getElementById('priceCheckCounts').innerHTML, '');
  assert.match(document.getElementById('priceCheckStatus').textContent, /UNAUTHORIZED|dashboard/i);
  assert.match(document.getElementById('priceCheckList').innerHTML, /Back to dashboard/);
});

test('a fetch failure while online shows UNAVAILABLE and clears rows', () => {
  const { sandbox, document } = loadPage();

  sandbox.renderResult(resultFixture({ alerts: [alertFixture('Private Customer Sdn Bhd')] }));
  assert.match(document.getElementById('priceCheckList').innerHTML, /Private Customer Sdn Bhd/);

  sandbox.navigator.onLine = true;
  sandbox.renderNetworkError();

  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.match(document.getElementById('priceCheckStatus').textContent, /UNAVAILABLE/i);
  assert.doesNotMatch(document.getElementById('priceCheckStatus').textContent, /OFFLINE/i);
});

test('a fetch failure while offline shows OFFLINE', () => {
  const { sandbox, document } = loadPage();

  sandbox.navigator.onLine = false;
  sandbox.renderNetworkError();

  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.match(document.getElementById('priceCheckStatus').textContent, /OFFLINE/i);
});

test('a 502 FAIL envelope names the failed books instead of showing a generic error', async () => {
  const envelope = resultFixture({
    status: 'FAIL',
    alerts: [],
    sources: [
      { companyName: 'Wanson Enterprise', ok: false, code: 'PRICE_PROFILE_MISMATCH' },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: false, code: 'PRICE_PAGE_INCOMPLETE' },
    ],
  });
  const { sandbox, document } = loadPage(async () => jsonResponse(502, envelope));

  await sandbox.loadPrices('today');

  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.match(document.getElementById('priceCheckCoverage').innerHTML, /Wanson Enterprise/);
  assert.match(document.getElementById('priceCheckCoverage').innerHTML, /PRICE_PROFILE_MISMATCH/);
  assert.match(document.getElementById('priceCheckCoverage').innerHTML, /PRICE_PAGE_INCOMPLETE/);
  assert.match(document.getElementById('priceCheckStatus').textContent, /FAIL/);
});

test('a non-envelope non-OK response still shows a generic error', async () => {
  const { sandbox, document } = loadPage(async () => jsonResponse(500, { success: false }));

  await sandbox.loadPrices('today');

  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.match(document.getElementById('priceCheckStatus').textContent, /HTTP 500/);
});

test('a PASS envelope on HTTP 500 is never rendered green', async () => {
  const { sandbox, document } = loadPage(async () => jsonResponse(500, resultFixture({ status: 'PASS', alerts: [] })));

  await sandbox.loadPrices('today');

  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.match(document.getElementById('priceCheckStatus').textContent, /HTTP 500/);
  assert.doesNotMatch(document.getElementById('priceCheckStatus').textContent, /No price differences/i);
  assert.doesNotMatch(document.getElementById('priceCheckStatus').textContent, /Complete coverage/i);
});

test('a FAIL envelope carrying alerts is rejected', async () => {
  const envelope = resultFixture({
    status: 'FAIL',
    alerts: [alertFixture('SHOULD NOT RENDER')],
    sources: [
      { companyName: 'Wanson Enterprise', ok: false, code: 'PRICE_PROFILE_MISMATCH' },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: false, code: 'PRICE_PAGE_INCOMPLETE' },
    ],
  });
  const { sandbox, document } = loadPage(async () => jsonResponse(502, envelope));

  await sandbox.loadPrices('today');

  const listHtml = document.getElementById('priceCheckList').innerHTML;
  assert.equal(listHtml.includes('SHOULD NOT RENDER'), false);
  assert.match(document.getElementById('priceCheckStatus').textContent, /HTTP 502/);
});

test('a malformed envelope fails closed instead of claiming zero differences', () => {
  const { sandbox, document } = loadPage();

  sandbox.renderResult(resultFixture({ alerts: [alertFixture('STALE CUSTOMER')] }));
  assert.match(document.getElementById('priceCheckList').innerHTML, /STALE CUSTOMER/);

  sandbox.renderResult(resultFixture({ status: 'MYSTERY', alerts: [], sources: [{ companyName: 'A', ok: true }, { companyName: 'B', ok: true }] }));
  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.match(document.getElementById('priceCheckStatus').textContent, /ERROR/i);
  assert.doesNotMatch(document.getElementById('priceCheckStatus').textContent, /No price differences/i);

  sandbox.renderResult(resultFixture({
    status: 'PASS',
    alerts: [],
    sources: [{ companyName: 'A', ok: true }, { companyName: 'B', ok: false, code: 'PRICE_PAGE_INCOMPLETE' }],
  }));
  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.match(document.getElementById('priceCheckStatus').textContent, /ERROR/i);
  assert.doesNotMatch(document.getElementById('priceCheckStatus').textContent, /No price differences/i);
});

test('a pending refresh clears stale rows and marks loading immediately', async () => {
  const pending = [];
  const fetchImpl = (url, options) => new Promise((resolve) => {
    pending.push({ url, options, resolve });
  });
  const { sandbox, document } = loadPage(fetchImpl);

  sandbox.renderResult(resultFixture({ alerts: [alertFixture('STALE CUSTOMER')] }));
  assert.match(document.getElementById('priceCheckList').innerHTML, /STALE CUSTOMER/);

  const inFlight = sandbox.loadPrices('today');
  assert.equal(document.getElementById('priceCheckList').innerHTML, '');
  assert.doesNotMatch(document.getElementById('priceCheckStatus').textContent, /PASS/);
  assert.match(document.getElementById('priceCheckStatus').textContent, /LOADING|Refreshing/i);

  pending[0].resolve(jsonResponse(200, resultFixture({ alerts: [alertFixture('FRESH CUSTOMER')] })));
  await inFlight;
  assert.match(document.getElementById('priceCheckList').innerHTML, /FRESH CUSTOMER/);
});

test('an older response cannot overwrite a newer range or refresh', async () => {
  const pending = [];
  const fetchImpl = (url, options) => new Promise((resolve) => {
    pending.push({ url, options, resolve });
  });
  const { sandbox, document } = loadPage(fetchImpl);

  const first = sandbox.loadPrices('today');
  const second = sandbox.loadPrices('seven_days');
  assert.equal(pending.length, 2);

  pending[1].resolve(jsonResponse(200, resultFixture({ alerts: [alertFixture('NEWER RESPONSE')] })));
  await second;
  pending[0].resolve(jsonResponse(200, resultFixture({ alerts: [alertFixture('OLDER RESPONSE')] })));
  await first;

  const listHtml = document.getElementById('priceCheckList').innerHTML;
  assert.match(listHtml, /NEWER RESPONSE/);
  assert.equal(listHtml.includes('OLDER RESPONSE'), false);
  assert.equal(pending[0].url.includes('range=today'), true);
  assert.equal(pending[1].url.includes('range=seven_days'), true);
});

test('a protected refresh calls the price API with the browser session', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith('/api/price-check')) {
      return jsonResponse(200, resultFixture());
    }
    return jsonResponse(404, {});
  };
  const { sandbox, document } = loadPage(fetchImpl);

  await sandbox.loadPrices('today');

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith('/api/price-check?range=today'));
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.match(document.getElementById('priceCheckStatus').textContent, /PASS/);
});
