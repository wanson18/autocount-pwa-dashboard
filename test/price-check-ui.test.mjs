import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const price = readFileSync(new URL('../public/price-check.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../public/theme.css', import.meta.url), 'utf8');

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
  assert.match(home, /loginView\.classList\.toggle\('hidden', authenticated\)/);
  assert.match(home, /loginView\.classList\.toggle\('flex', !authenticated\)/);
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
  assert.match(sw, /const CACHE_NAME = 'sales-dashboard-v27'/);
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
  assert.match(document.getElementById('priceCheckCounts').innerHTML, /Not approved yet/i);
  assert.match(document.getElementById('priceCheckCounts').innerHTML, /Unreadable rows: 1/);
  assert.doesNotMatch(document.getElementById('priceCheckCounts').innerHTML, /Skipped rows/i);
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

test('every status state has its own banner colour and icon, not just text', () => {
  const { sandbox, document } = loadPage();
  const states = {
    ok: resultFixture(),
    alert: resultFixture({ alerts: [alertFixture('Customer')] }),
    partial: resultFixture({
      status: 'PARTIAL',
      sources: [{ companyName: 'A', ok: true }, { companyName: 'B', ok: false, code: 'PRICE_PAGE_INCOMPLETE' }],
    }),
  };
  for (const [state, envelope] of Object.entries(states)) {
    sandbox.renderResult(envelope);
    assert.equal(document.getElementById('priceCheckStatus').dataset.state, state);
  }
  sandbox.renderUnauthorized();
  assert.equal(document.getElementById('priceCheckStatus').dataset.state, 'unauthorized');
  sandbox.renderFailure(500);
  assert.equal(document.getElementById('priceCheckStatus').dataset.state, 'fail');

  assert.match(price, /id="priceCheckStatus"[^>]*class="status-banner/);
  for (const state of ['ok', 'alert', 'partial', 'unauthorized', 'offline', 'fail', 'error', 'unavailable']) {
    assert.match(theme, new RegExp(`\\.status-banner\\[data-state='${state}'\\]::before`), `${state} needs an icon`);
  }
});

test('a PARTIAL banner names the book that could not be checked', () => {
  const { sandbox, document } = loadPage();
  sandbox.renderResult(resultFixture({
    status: 'PARTIAL',
    sources: [
      { companyName: 'Wanson Enterprise', ok: true },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: false, code: 'PRICE_PAGE_INCOMPLETE' },
    ],
  }));
  const status = document.getElementById('priceCheckStatus').textContent;
  assert.match(status, /PARTIAL/);
  assert.match(status, /Wanson Enterprise \(M\) Sdn Bhd could not be checked/);
  assert.match(status, /must not be read as zero differences/);
});

test('failed sources show a plain-language reason and keep the technical code', () => {
  const { sandbox, document } = loadPage();
  sandbox.renderResult(resultFixture({
    status: 'PARTIAL',
    sources: [
      { companyName: 'Wanson Enterprise', ok: true },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: false, code: 'PRICE_PAGE_INCOMPLETE' },
    ],
  }));
  const coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.match(coverage, /The invoice list was incomplete/);
  assert.match(coverage, /PRICE_PAGE_INCOMPLETE/);

  sandbox.renderResult(resultFixture({
    status: 'PARTIAL',
    sources: [
      { companyName: 'A', ok: true },
      { companyName: 'B', ok: false, code: '<img src=x onerror=alert(1)>' },
    ],
  }));
  const unknown = document.getElementById('priceCheckCoverage').innerHTML;
  assert.match(unknown, /The scan could not be completed/);
  assert.equal(unknown.includes('<img'), false);
});

test('collapsed cards show the price movement without tapping', () => {
  const { sandbox, document } = loadPage();
  const down = { ...alertFixture('Down Customer'), docNo: 'SI-DOWN', currentPrice: '9.50', previousPrice: '10.00', differenceMYR: '-0.50', differencePercent: '-5.00' };
  const uom = { ...alertFixture('Uom Customer'), docNo: 'SI-UOM', type: 'UOM_CHANGED', uom: 'PKT', previousUom: 'CTN', differenceMYR: null, differencePercent: null };
  sandbox.renderResult(resultFixture({ alerts: [alertFixture('Up Customer'), down, uom] }));
  const html = document.getElementById('priceCheckList').innerHTML;

  assert.match(html, /RM 10\.00 → RM 12\.00 · ▲<span class="sr-only"> increase <\/span> \+2\.00 \(\+20\.00%\)/);
  assert.match(html, /RM 10\.00 → RM 9\.50 · ▼<span class="sr-only"> decrease <\/span> -0\.50 \(-5\.00%\)/);
  assert.match(html, /UOM CTN → PKT/);
  assert.match(html, /Enterprise · 2026-09-21/);
  // Detail view labels each price with its own UOM.
  assert.match(html, /Current: RM 12\.00 \/ PKT|Current: RM 12\.00 \/ CTN/);
  assert.match(html, /Previous: RM 10\.00 \/ CTN/);
});

test('a missing percentage is omitted instead of rendering "—%"', () => {
  const { sandbox, document } = loadPage();
  sandbox.renderResult(resultFixture({ alerts: [{ ...alertFixture('Zero Base'), differencePercent: null }] }));
  const html = document.getElementById('priceCheckList').innerHTML;
  assert.equal(html.includes('—%'), false);
  assert.match(html, /\+2\.00/);
});

test('alerts are listed newest invoice first, then biggest move first', () => {
  const { sandbox, document } = loadPage();
  const mk = (docNo, docDate, extra = {}) => ({ ...alertFixture(`Customer ${docNo}`), docNo, docDate, ...extra });
  sandbox.renderResult(resultFixture({
    alerts: [
      mk('OLD', '2026-09-15'),
      mk('NEW-SMALL', '2026-09-21', { differencePercent: '1.00' }),
      mk('NEW-UOM', '2026-09-21', { type: 'UOM_CHANGED', differenceMYR: null, differencePercent: null }),
      mk('MID', '2026-09-18'),
      mk('NEW-BIG', '2026-09-21', { differencePercent: '-30.00', differenceMYR: '-3.00' }),
    ],
  }));
  const html = document.getElementById('priceCheckList').innerHTML;
  const order = ['NEW-BIG', 'NEW-SMALL', 'NEW-UOM', 'MID', 'OLD'].map((docNo) => html.indexOf(`· ${docNo}</span>`));
  assert.ok(order.every((position) => position > -1), 'every alert renders');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'cards appear in newest-first order');
});

test('timeouts and rate limits get an actionable message with the HTTP code kept', async () => {
  for (const [status, expected] of [[504, /took too long/], [408, /took too long/], [429, /Wait a minute/], [503, /temporarily unavailable/], [500, /try again/i]]) {
    const { sandbox, document } = loadPage(async () => jsonResponse(status, null));
    await sandbox.loadPrices('seven_days');
    const text = document.getElementById('priceCheckStatus').textContent;
    assert.match(text, new RegExp(`HTTP ${status}`));
    assert.match(text, expected);
    assert.match(text, /^FAIL/);
  }
});

test('controls meet the 44px touch target and the select avoids iOS focus zoom', () => {
  for (const id of ['priceCheckRefresh', 'priceCheckRange']) {
    const tag = price.match(new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>`, 'i'))?.[0] ?? '';
    assert.match(tag, /min-h-\[44px\]/, `${id} must be at least 44px tall`);
  }
  assert.match(price.match(/<select[^>]*id="priceCheckRange"[^>]*>/i)[0], /text-base/);
  assert.match(price, /aria-label="Back to Sales Dashboard"/);
  assert.match(price.match(/<a[^>]*aria-label="Back to Sales Dashboard"/i)[0], /min-h-\[44px\] min-w-\[44px\]/);
  assert.doesNotMatch(price, /text-\[10px\]/, 'no 10px text');
  assert.doesNotMatch(price, /text-slate-500/, 'no low-contrast slate-500 text');
});

test('a duplicate-invoice failure explains itself in plain words with the diagnostic numbers', () => {
  const { sandbox, document } = loadPage();
  const failedSource = (detail, attempts = 2) => ({
    companyName: 'Wanson Enterprise (M) Sdn Bhd',
    ok: false,
    code: 'PRICE_DUPLICATE_DOC',
    attempts,
    detail,
  });
  const envelope = (source) => resultFixture({
    status: 'PARTIAL',
    sources: [{ companyName: 'Wanson Enterprise', ok: true, attempts: 1 }, source],
  });

  sandbox.renderResult(envelope(failedSource({
    page: 2, rowOnPage: 1, pageSize: 100, totalCount: 2380, rowsRead: 100, firstSeenOnPage: 1, pageRepeated: false, sameContent: true,
  })));
  let coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.match(coverage, /AutoCount listed the same invoice twice/);
  assert.match(coverage, /PRICE_DUPLICATE_DOC/);
  assert.match(coverage, /Details: tried 2 times · problem on page 2, row 1 · first seen on page 1 · the same invoice appeared twice · 100 of 2380 invoices read/);

  sandbox.renderResult(envelope(failedSource({ page: 2, rowOnPage: 1, firstSeenOnPage: 1, pageRepeated: true, sameContent: true })));
  coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.match(coverage, /page 2 repeated the previous page/);

  sandbox.renderResult(envelope(failedSource({ page: 1, rowOnPage: 2, firstSeenOnPage: 1, sameContent: false })));
  coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.match(coverage, /two different invoices share one ID/);

  sandbox.renderResult(envelope(failedSource({ page: 2, totalCount: 3, receivedTotal: 4 }, 1)));
  coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.match(coverage, /total changed from 3 to 4/);
  assert.doesNotMatch(coverage, /tried/);
});

test('diagnostic details are rendered as numbers only, never as markup', () => {
  const { sandbox, document } = loadPage();
  sandbox.renderResult(resultFixture({
    status: 'PARTIAL',
    sources: [
      { companyName: 'A', ok: true },
      {
        companyName: 'B',
        ok: false,
        code: 'PRICE_DUPLICATE_DOC',
        attempts: '<img src=x onerror=alert(1)>',
        detail: { page: '<b>2</b>', rowOnPage: '<i>1</i>', sameContent: '<u>yes</u>', rowsRead: 'x', totalCount: 'y' },
      },
    ],
  }));
  const coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.equal(coverage.includes('<img'), false);
  assert.equal(coverage.includes('<b>'), false);
  assert.equal(coverage.includes('<i>'), false);
  assert.equal(coverage.includes('<u>'), false);
  assert.doesNotMatch(coverage, /Details:/);
});

test('a book that needed a retry says so, and a clean book does not', () => {
  const { sandbox, document } = loadPage();
  sandbox.renderResult(resultFixture({
    sources: [
      { companyName: 'Wanson Enterprise', ok: true, attempts: 1 },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: true, attempts: 2 },
    ],
  }));
  const coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.equal((coverage.match(/repeated once/g) || []).length, 1);
  assert.match(document.getElementById('priceCheckStatus').textContent, /^PASS/);
});

test('a FAIL banner tells staff what to do next', () => {
  const { sandbox, document } = loadPage();
  sandbox.renderResult(resultFixture({
    status: 'FAIL',
    sources: [
      { companyName: 'A', ok: false, code: 'PRICE_DUPLICATE_DOC', attempts: 2 },
      { companyName: 'B', ok: false, code: 'PRICE_DUPLICATE_DOC', attempts: 2 },
    ],
  }));
  const status = document.getElementById('priceCheckStatus').textContent;
  assert.match(status, /^FAIL/);
  assert.match(status, /tap Refresh now/);
  assert.match(status, /tell the admin/);
});

test('a book that was re-read in date ranges says so in plain words', () => {
  const { sandbox, document } = loadPage();
  sandbox.renderResult(resultFixture({
    sources: [
      { companyName: 'Wanson Enterprise', ok: true, attempts: 1, strategy: 'paged' },
      { companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: true, attempts: 2, strategy: 'windowed' },
    ],
  }));
  const coverage = document.getElementById('priceCheckCoverage').innerHTML;
  assert.equal((coverage.match(/smaller date ranges/g) || []).length, 1);
  assert.doesNotMatch(coverage, /repeated once/);
  assert.match(document.getElementById('priceCheckStatus').textContent, /^PASS/);
});

test('diagnostics from a date-range read and from an unreachable AutoCount are described', () => {
  const { sandbox, document } = loadPage();
  const render = (source) => {
    sandbox.renderResult(resultFixture({
      status: 'PARTIAL',
      sources: [{ companyName: 'Wanson Enterprise', ok: true, attempts: 1, strategy: 'paged' }, source],
    }));
    return document.getElementById('priceCheckCoverage').innerHTML;
  };
  const failed = (code, detail, extra = {}) => ({ companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: false, code, detail, ...extra });

  let html = render(failed('PRICE_PAGE_INCOMPLETE', { windowed: true, totalCount: 2346, rowsRead: 2340, windowCount: 40 }, { attempts: 2, strategy: 'windowed' }));
  assert.match(html, /tried 2 times · the last try read smaller date ranges · 2340 of 2346 invoices read in 40 date ranges/);

  html = render(failed('PRICE_DUPLICATE_DOC', { windowed: true, windowIndex: 3, windowCount: 31, rowOnPage: 7, firstSeenInWindow: 2, sameContent: true }, { attempts: 2, strategy: 'windowed' }));
  assert.match(html, /problem in date range 3 of 31, row 7 · first seen in date range 2 · the same invoice appeared twice/);

  html = render(failed('PRICE_PAGE_INCOMPLETE', { windowed: true, requestCount: 250 }, { attempts: 1 }));
  assert.match(html, /stopped after 250 requests/);

  html = render(failed('PRICE_SOURCE_UNAVAILABLE', { httpStatus: 429 }, { attempts: 1 }));
  assert.match(html, /AutoCount did not answer in time, or returned an error/);
  assert.match(html, /AutoCount replied HTTP 429/);

  html = render(failed('PRICE_SOURCE_UNAVAILABLE', { timedOut: true }, { attempts: 1 }));
  assert.match(html, /AutoCount took too long to answer/);
});
