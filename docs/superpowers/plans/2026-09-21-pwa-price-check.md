# On-Demand PWA Invoice Price Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a protected, read-only, on-demand price-difference check for approved AutoCount Cloud invoices inside the existing iPhone PWA.

**Architecture:** A new pure comparison module reads exact source prices, while a separate protected GET route fetches and verifies both Cloud books on each request. A dedicated mobile page linked from the existing PWA renders alert cards and makes a fresh request when opened or when the user taps Refresh now. The existing public sales API and invoice workflow remain unchanged.

**Tech Stack:** Node.js >=20, CommonJS Vercel Functions, existing AutoCount Axios/lossless-json client, built-in `node:test`, static HTML/Tailwind, existing signed dispatch-session cookie.

**Spec:** `docs/superpowers/specs/2026-09-21-pwa-price-check-design.md`

## Global Constraints

- Read-only Cloud access; no invoice create/update/approve/void/post/submit calls.
- Enterprise is book `63750`; Sdn Bhd is book `63688`. Both book identity and customer/item/UOM identity are hard comparison keys.
- Only `approverID` plus `approvedTimeStamp` proves approval; exclude cancelled/void rows.
- Source coverage is strict; missing, changing, duplicate, or truncated pagination is a per-book failure.
- Fixed server-side windows: today by default or last 7 calendar days on selection, plus 90 earlier days for history, in `Asia/Kuala_Lumpur`. Only these two values are accepted.
- The price route requires a real signed cookie even if `DISPATCH_PUBLIC_ACCESS=true`; do not return price data through the public `/api/sales` endpoint.
- `Cache-Control: no-store`; no stale response or offline fallback for price data.
- Version 1 has no persistent alert lifecycle. Corrections disappear from the next fresh result; a durable audit is separate future work.
- Jev is not used for arithmetic or alert suppression.

## Review Focus

- A book-63750 price must never become history for book 63688. Task 1 tests same customer/item/invoice values across books.
- A draft or void invoice must never be the reference or the alert target. Task 1 tests approval evidence and cancellation forms.
- Latest prior item in another UOM must produce `UOM_CHANGED`, not a misleading money delta. Task 1 tests mixed UOM history.
- A malformed numeric price or incomplete Cloud page must not look like zero difference. Tasks 1 and 2 test these failures.
- A synthetic public-dispatch session must not authorize customer price data. Task 3 tests the public-access override explicitly.

---

## File Structure

- `lib/price-check/compare.js`: pure invoice normalization, exact cents arithmetic, reference selection, and alerts.
- `lib/price-check/source.js`: per-book profile-name validation, strict listing pagination, and 91/97-day date-window generation.
- `lib/autocount/client.js`: add one read-only `getCompanyProfile(company)` method; keep the existing lossless parser.
- `api/price-check.js`: signed-session gate, independent book loads, status envelope, no-store headers, no mutation.
- `vercel.json`: explicit `/api/price-check` rewrite before generic `/api/(.*)`.
- `public/price-check.html`: dedicated protected mobile price-check view and same-origin fetch UI.
- `public/index.html`: one navigation link to Price Check.
- `public/sw.js`: add static page to the versioned asset list; preserve network-only API behavior.
- `api/price-check.test.js`, `test/price-check-compare.test.mjs`, `test/price-check-source.test.mjs`, `test/price-check-ui.test.mjs`: fixture-only and UI-contract tests.
- `test/service-worker.test.mjs`: update the expected cache namespace and assert Price Check API responses stay network-only.
- `README.md`: operator action, coverage/freshness/security limitations.

### Task 1: Pure exact comparison of approved invoice lines

**Files:** Create `lib/price-check/compare.js`; create `test/price-check-compare.test.mjs`.

**Interfaces:** `compareApprovedInvoices(rows, {bookId, companyName, monitorFrom}) -> {alerts, counts}`. Each alert contains `bookId`, `companyName`, `docNo`, `docDate`, `customerCode`, `customerName`, `itemCode`, `description`, `uom`, `previousUom`, `currentPrice`, `previousPrice`, `differenceMYR`, `differencePercent`, `previousDocNo`, `previousDocDate`, and `type` (`PRICE_CHANGED` or `UOM_CHANGED`). Money values are decimal strings.

- [ ] **Step 1: Write failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import comparison from '../lib/price-check/compare.js';

const { compareApprovedInvoices } = comparison;
function inv(docNo, docDate, price, unit = 'CTN', extra = {}) {
  return { master: { docNo, docDate, debtorCode: '700-A001', debtorName: 'Sample',
    approverID: 5, approvedTimeStamp: `${docDate}T09:00:00`, cancelled: false, ...extra },
    details: [{ productCode: 'ITEM-1', description: 'Sample item', unit,
      qty: '2', unitPrice: price, subTotal: '20.00' }] };
}

test('exact prior price and company boundary', () => {
  const rows = [inv('I-1', '2026-09-01', '10.00'), inv('I-2', '2026-09-20', '12.00')];
  const ent = compareApprovedInvoices(rows, { bookId: '63750', companyName: 'Enterprise', monitorFrom: '2026-09-15' });
  const sdn = compareApprovedInvoices([rows[1]], { bookId: '63688', companyName: 'Sdn Bhd', monitorFrom: '2026-09-15' });
  assert.equal(ent.alerts[0].differenceMYR, '2.00');
  assert.equal(ent.alerts[0].previousDocNo, 'I-1');
  assert.equal(sdn.alerts.length, 0);
  assert.equal(sdn.counts.noHistory, 1);
});

test('draft and cancelled references are excluded', () => {
  const rows = [inv('D-1', '2026-09-01', '8.00', 'CTN', { approverID: null }),
    inv('V-1', '2026-09-02', '9.00', 'CTN', { cancelled: true }),
    inv('I-2', '2026-09-20', '12.00')];
  const out = compareApprovedInvoices(rows, { bookId: '63750', companyName: 'Enterprise', monitorFrom: '2026-09-15' });
  assert.equal(out.alerts.length, 0);
  assert.equal(out.counts.noHistory, 1);
  assert.equal(out.counts.skippedUnapproved, 1);
  assert.equal(out.counts.skippedVoid, 1);
});

test('UOM change and invalid price are not numeric price alerts', () => {
  const rows = [inv('I-1', '2026-09-01', '10.00', 'TINS'),
    inv('I-2', '2026-09-20', '12.00', 'CTN'),
    inv('I-3', '2026-09-21', 'NaN', 'CTN')];
  const out = compareApprovedInvoices(rows, { bookId: '63750', companyName: 'Enterprise', monitorFrom: '2026-09-15' });
  assert.equal(out.alerts[0].type, 'UOM_CHANGED');
  assert.equal(out.alerts[0].differenceMYR, null);
  assert.equal(out.counts.skippedInvalidLine, 1);
});
```

- [ ] **Step 2: Verify RED** — `node --test test/price-check-compare.test.mjs`; expect missing module.
- [ ] **Step 3: Implement minimal comparison** using `BigInt` cents parsed from AutoCount's lossless decimal strings:

```js
function toCents(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new TypeError('invalid unit price');
  const fraction = (match[2] || '').padEnd(3, '0');
  return BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2))
    + (fraction[2] >= '5' ? 1n : 0n);
}
```

Sort invoices by `docDate`, `approvedTimeStamp`, `docNo`; compare all lines of an invoice before updating its `(customerCode,itemCode)` prior-item map. Require nonempty codes/UOM and a finite nonnegative numeric price; report invalid rows in counters. For identical UOM, format signed cents and percentage to two decimal places; for different UOM set both deltas to `null`. Do not compare two lines on the same invoice.
- [ ] **Step 4: Verify GREEN** — `node --test test/price-check-compare.test.mjs`; expect all three tests to pass. Add one fixture test for repeated same-item lines and one for a prior zero price (percentage `null`).
- [ ] **Step 5: Commit** — `git add lib/price-check/compare.js test/price-check-compare.test.mjs` then `git commit -m "feat: compare approved invoice line prices"`.

### Task 2: Strict, independent Cloud source snapshots

**Files:** Create `lib/price-check/source.js`; modify `lib/autocount/client.js`; create `test/price-check-source.test.mjs`.

**Interfaces:** `loadPriceSource(client, company, {historyFrom, through}) -> {rows, profileName, pageCount, invoiceCount}`; `priceCheckWindow(now, range='today') -> {monitorFrom, historyFrom, through}`. Allowed `range` values are `today` and `seven_days`. `client` is an `AutoCountClient` with `getCompanyProfile(company)` and `listInvoicePage(company, {page,startDate,endDate})`.

- [ ] **Step 1: Write failing source tests** with these exact fixtures, then add table-driven variants for wrong profile name/book, missing or changed `totalCount`, early empty page, and duplicate `docKey`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import source from '../lib/price-check/source.js';

const { loadPriceSource } = source;
const company = { companyKey: 'enterprise', accountBookId: '63750', name: 'Wanson Enterprise' };
const row = (docKey) => ({ master: { docKey, docNo: docKey }, details: [] });
const pages = [
  { totalCount: 2, data: [row('A')] },
  { totalCount: 2, data: [row('B')] },
];
const client = {
  async getCompanyProfile() { return { accountBookId: '63750', companyName: 'WANSON ENTERPRISE' }; },
  async listInvoicePage(_company, { page }) { return pages[page - 1]; },
};

test('reads both complete pages after profile-name verification', async () => {
  const result = await loadPriceSource(client, company,
    { historyFrom: '2026-06-01', through: '2026-09-21' });
  assert.equal(result.rows.length, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.profileName, 'WANSON ENTERPRISE');
});

test('rejects incomplete pagination instead of an empty-success result', async () => {
  const broken = { ...client, async listInvoicePage(_company, { page }) {
    return page === 1 ? pages[0] : { totalCount: 2, data: [] };
  } };
  await assert.rejects(() => loadPriceSource(broken, company,
    { historyFrom: '2026-06-01', through: '2026-09-21' }),
    { code: 'PRICE_PAGE_INCOMPLETE' });
});
```

Use `PRICE_PROFILE_MISMATCH`, `PRICE_PAGE_INCOMPLETE`, `PRICE_DUPLICATE_DOC`, and `PRICE_SOURCE_INVALID` as the stable rejection codes. Verify the fixed `63750`/`63688` company registry and a Malaysia-midnight date boundary in the same test file.
- [ ] **Step 2: Verify RED** — `node --test test/price-check-source.test.mjs`; expect missing `source.js`.
- [ ] **Step 3: Add the read-only client call**:

```js
async getCompanyProfile(company) {
  const response = await this.http.get(
    `${this.baseUrl}/${encodeURIComponent(company.accountBookId)}/companyProfile`,
    { headers: { 'API-Key': company.apiKey, 'Key-ID': company.keyId },
      timeout: 15000, transformResponse: [(data) => data] },
  );
  if (response.status !== 200) throw new Error('Cloud profile request failed');
  return parseResponseData(response.data);
}
```

Implement `loadPriceSource` to validate configured IDs (`enterprise=63750`, `sdn_bhd=63688`), Cloud profile company name after whitespace/punctuation normalization, exact integer `totalCount` on every page, exact final count, unique `(bookId,docKey)` identity, and a 1,000-page ceiling. The live `companyProfile` body has `companyName` but no `accountBookId`; pin the URL to the validated configured ID and do not require a nonexistent body field. `priceCheckWindow` uses `Intl.DateTimeFormat` with `Asia/Kuala_Lumpur`; monitor starts today by default or 6 days before today for `seven_days`, and history starts 90 days before monitor. Preserve raw invoice objects; do not call public `normalizeInvoices()` because it loses required fields.
- [ ] **Step 4: Verify GREEN** — `node --test test/price-check-source.test.mjs`; expect all source tests to pass, including exact window boundaries across UTC/Malaysia midnight.
- [ ] **Step 5: Commit** — `git add lib/autocount/client.js lib/price-check/source.js test/price-check-source.test.mjs` then `git commit -m "feat: read complete Cloud price-check history"`.

### Task 3: Protected on-demand API

**Files:** Create `api/price-check.js`; modify `vercel.json`; create `api/price-check.test.js`.

**Interfaces:** `createPriceCheckHandler({client, configs, auth, now})` returns a Vercel request handler. `GET /api/price-check?range=today|seven_days` (default `today`) returns `{status, scannedAt, window, sources, alerts, counts, cloudWrites:false}` with `status` `PASS|PARTIAL|FAIL`. Reject other ranges. A failed book never contributes rows or a green status.

- [ ] **Step 1: Write failing handler tests** using an injected fake client and cookie verifier. Start with the hard security boundary:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPriceCheckHandler } = require('./price-check');

function response() {
  return { headers: {}, statusCode: 0, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; } };
}

test('public dispatch mode without a real cookie never reads prices', async () => {
  let cloudCalls = 0;
  const handler = createPriceCheckHandler({
    env: { DISPATCH_PUBLIC_ACCESS: 'true' },
    auth: { verifySessionCookie: () => null,
      getSessionFromRequest: () => ({ clerkId: 'public-dispatch', role: 'admin' }) },
    client: { getCompanyProfile: async () => { cloudCalls += 1; } },
  });
  const res = response();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(cloudCalls, 0);
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
});
```

Add fixtures for a valid cookie returning `PASS` with `Cache-Control:no-store`, one-book `PARTIAL` preserving the successful alerts, two-book 502 `FAIL`, POST 405, default-today and selected-seven-day windows, invalid range 400, and no raw invoice/credential fields in response JSON.
- [ ] **Step 2: Verify RED** — `node --test api/price-check.test.js`; expect missing `api/price-check.js`.
- [ ] **Step 3: Implement the route**. Verify the real cookie directly with `auth.verifySessionCookie(req.headers.cookie, {env,now})`; never call `getSessionFromRequest` because its public-access mode synthesizes an admin session. Instantiate `AutoCountClient` and `loadCompanyConfigs`, assert fixed book IDs, call Task 2's reader for each book in `Promise.allSettled`, then Task 1's comparator per successful book. Set `Cache-Control:no-store, max-age=0, must-revalidate`; do not add CORS headers. Add exact `/api/price-check` rewrite before generic `/api/(.*)` in `vercel.json`.
- [ ] **Step 4: Verify GREEN** — `node --test api/price-check.test.js test/price-check-compare.test.mjs test/price-check-source.test.mjs`; expect all tests to pass.
- [ ] **Step 5: Commit** — `git add api/price-check.js api/price-check.test.js vercel.json` then `git commit -m "feat: expose protected on-demand price check"`.

### Task 4: Mobile view, navigation, offline contract, and operator guide

**Files:** Create `public/price-check.html`; modify `public/index.html`, `public/sw.js`, `README.md`, `test/service-worker.test.mjs`; create `test/price-check-ui.test.mjs`.

**Interfaces:** The page loads `/api/price-check?range=today` with `cache:'no-store'` and `credentials:'same-origin'` on open and on Refresh now. A Today/Last 7 days selector changes the fixed `range` value and triggers a fresh load. A 401 shows a clerk-ID/PIN form that posts to the existing `/api/dispatch/session`. Only authenticated responses render customer/price rows.

- [ ] **Step 1: Write failing UI-contract tests** for the link, expected nodes, network-only fetch, and escaped rendering:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const home = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const price = readFileSync(new URL('../public/price-check.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('mobile PWA exposes a fresh protected price view', () => {
  assert.match(home, /href="\/price-check\.html"/);
  for (const id of ['priceCheckRefresh', 'priceCheckStatus', 'priceCheckList']) {
    assert.match(price, new RegExp(`id="${id}"`));
  }
  assert.match(price, /\/api\/price-check/);
  assert.match(price, /cache:\s*'no-store'/);
  assert.match(price, /credentials:\s*'same-origin'/);
  assert.match(price, /escapeHtml/);
  assert.match(sw, /'\/price-check\.html'/);
});
```

Add a browser fixture test that renders a customer name containing `<script>` as text, clears old alerts after a 401, and distinguishes `PARTIAL`, `FAIL`, complete-zero, and offline states. Keep the API branch network-only in `test/service-worker.test.mjs`.
- [ ] **Step 2: Verify RED** — `node --test test/price-check-ui.test.mjs`; expect missing page/link.
- [ ] **Step 3: Build the narrow dark PWA page** matching `public/index.html`: header/back link, Today/Last 7 days selector (Today default), source coverage and `scannedAt`, Refresh now, price/UOM count, compact expandable alert cards, and a no-history count. Use `textContent` for plain values or `escapeHtml` before HTML templates; no raw AutoCount string enters `innerHTML`. Use request sequence IDs so an older response cannot replace a newer refresh. On network/401 failure clear prior results rather than displaying stale data as current. Add the one homepage link, bump the service-worker cache version from `sales-dashboard-v9` to `sales-dashboard-v10`, update the cache-name expectation and old-name list in `test/service-worker.test.mjs`, and document the 91/97-day windows and no-persistent-audit trade-off in `README.md`.
- [ ] **Step 4: Verify GREEN and visually inspect** — `node --test test/price-check-ui.test.mjs`, then `npm test`; run a local fixture-based mobile browser check at 390px and 320px for sign-in, price alert, UOM alert, partial book, zero-alert complete, offline/error, and Refresh now. Do not invoke a live mutation or deploy.
- [ ] **Step 5: Commit** — `git add public/price-check.html public/index.html public/sw.js README.md test/price-check-ui.test.mjs test/service-worker.test.mjs` then `git commit -m "feat: show price differences in mobile PWA"`.

### Task 5: Read-only acceptance and performance gate

**Files:** Create `docs/superpowers/reports/2026-09-21-pwa-price-check.md` with non-sensitive counts/timings only.

**Interfaces:** The report records per-book identity, complete pages/invoices/approved lines, skipped/no-history counts, alert count, scan duration, HTTP/cache behavior, and `PASS|PARTIAL|FAIL`. No customer-level payload is committed.

- [ ] **Step 1: Run all local tests and diff checks** — `npm test`; `git diff --check`; verify no unexpected files were staged.
- [ ] **Step 2: Run a bounded live GET-only check** against both configured Cloud books through the protected local/preview handler. Measure both complete 91-day default and 97-day option scans; verify each book profile name, exact pagination, first/last dates, counts, and no credentials in logs or response. If the function times out or API limits intervene, report `PARTIAL/FAIL` and stop the rollout rather than narrowing history silently.
- [ ] **Step 3: Inspect page behavior and write evidence**. Confirm the mobile page shows `scannedAt` changing after Refresh now, never shows a green zero on a book failure, and does not serve old customer prices offline. Record only aggregate counts and sanitized sample identifiers in the report.
- [ ] **Step 4: Commit report** — `git add docs/superpowers/reports/2026-09-21-pwa-price-check.md` then `git commit -m "docs: record price-check acceptance evidence"`. Production deployment is a separate user-approved step; do not deploy from this plan automatically.

## Execution note

Tasks 1–4 produce testable code without live writes. Task 5 may establish that full on-demand history is too slow for the deployed function. In that case, do not claim the feature ready; propose a separate, durable incremental-history design and obtain a fresh decision before implementing it.
