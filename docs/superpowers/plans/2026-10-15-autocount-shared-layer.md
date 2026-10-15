# AutoCount Shared Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sales, Dispatch and Price Check read AutoCount through one company list and settings loader, one client, one checked-read module, one number reader and one date module, with the same API answers as before.

**Architecture:**
- `lib/autocount/company-config.js` becomes the only place the two books and their setting names live (one rule set).
- `lib/autocount/client.js` stays the only HTTP client, now with a per-company address.
- `lib/autocount/invoice-reader.js` gains Sales' checked read (`readInvoicesChecked`).
- New `lib/autocount/numbers.js` reads AutoCount numbers that arrive as exact text.
- New `lib/dates.js` replaces seven copies of the calendar check and two copies of "today in Malaysia".
- `api/sales.js` keeps its sales maths and drops its own settings, fetching and date code.

**Tech Stack:** Node.js 20+ (CommonJS in `api/` and `lib/`), `axios` 1.19, `lossless-json` 4.3, `node:test`, Playwright 1.62 (existing e2e specs only).

**Spec:** `docs/superpowers/specs/2026-10-15-autocount-shared-layer-design.md` (commit `653abae`).

## Global Constraints

- **Books.** The two books are fixed: `enterprise` = `63750`, `sdn_bhd` = `63688`. After Task 5, no other source file under `api/` or `lib/` may contain those numbers.
- **Display names stay as today.** Sales: "Wanson Enterprise", "Wanson Sdn Bhd". Dispatch and Price Check: "Wanson Enterprise", "Wanson Enterprise (M) Sdn Bhd". Price Check profile names: "WANSON ENTERPRISE", "WANSON ENTERPRISE (M) SDN. BHD".
- **Credentials.** Never print, log, commit or write to a file any credential value, AutoCount row value or customer data. Probes and checks print setting names, field paths, token types, status codes and "identical"/difference paths only.
- **Public repo.** New fixtures use invented data only.
- **Dependencies.** No new ones, and no `npm install`. `node_modules` resolves from `D:\autocount-pwa-dashboard` because the worktree is nested inside it.
- **Where to run.** Run every command in Git Bash from the worktree root: `D:/autocount-pwa-dashboard/.claude/worktrees/autocount-shared-layer`.
- **Scratch folder.** `SCRATCH=C:/Users/wanso/AppData/Local/Temp/claude/D--autocount-pwa-dashboard/93d7b131-4d1e-411c-9bc7-afc94adb37fa/scratchpad`. Scripts here are never committed.
- **Playwright.**
  - Run it as `node D:/autocount-pwa-dashboard/node_modules/@playwright/test/cli.js test <spec> --output "$SCRATCH/pw-out"`.
  - Run one spec at a time, because every spec binds port 4173.
- **Never loosen the invoice-read checks.** Price Check's strict flow and the windowed re-read stay exactly as they are.
- **No `CACHE_NAME` bump.** Nothing under `public/` changes.
- **Tests first.** Every code task starts with a failing test.
- **Commit messages** end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

**Create**

| File | Responsibility |
| --- | --- |
| `lib/dates.js` | `isIsoDate`, `todayIn`, `addDays`, `diffDays`: calendar dates as `YYYY-MM-DD`, arithmetic without `Date` normalisation |
| `lib/autocount/numbers.js` | `decimalValue`, `firstNonZero`, `firstPositiveInteger`: reading AutoCount numbers that arrive as exact text |
| `test/dates.test.mjs` | `lib/dates.js` |
| `test/autocount-numbers.test.mjs` | `lib/autocount/numbers.js` |
| `test/company-config.test.mjs` | the one rule set for settings |
| `test/autocount-client.test.mjs` | client parsing acceptance test (real axios, local HTTP server) and per-company address |
| `test/shared-helpers.test.mjs` | guards: date checks live only in `lib/dates.js`; book numbers live only in `company-config.js` |
| `test/fixtures/autocount-sales-raw-listing.json` | invented raw AutoCount listing text |
| `test/fixtures/autocount-sales-raw-product.json` | invented raw product text |

**Modify**

| File | Change |
| --- | --- |
| `lib/autocount/company-config.js` | rewrite: `COMPANIES`, `readCompanySettings`, `DEFAULT_API_URL`; `loadCompanyConfigs` keeps its contract |
| `lib/autocount/client.js` | per-company address, all trailing slashes removed |
| `lib/autocount/invoice-reader.js` | uses `lib/dates.js`; new `readInvoicesChecked` |
| `api/sales.js` | settings, fetching, numbers and dates through the shared modules |
| `api/price-check.js` | `EXPECTED_BOOKS` from `COMPANIES` |
| `lib/price-check/source.js` | `COMPANY_REGISTRY` from `COMPANIES`; dates from `lib/dates.js` |
| `lib/price-check/compare.js` | dates from `lib/dates.js` |
| `lib/dispatch/invoice-adapter.js`, `lib/dispatch/service.js`, `api/dispatch-invoices.js`, `api/dispatch-assignments.js` | date check from `lib/dates.js` |
| `api/sales.test.js`, `api/dispatch-invoices.test.js`, `test/invoice-reader.test.mjs` | tests |
| `.env.example`, `README.md`, `agents.md` | docs |

**Scratch, not committed:** `$SCRATCH/probe/autocount-type-probe.js`, `$SCRATCH/replay/replay-compare.js`, `$SCRATCH/replay/replay-child.js`, `$SCRATCH/pr-body.md`.

---

### Task 1: Baselines and the AutoCount type probe

Nothing in the repo changes. This task records the baselines and checks the spec's assumptions about the JSON AutoCount sends, before any fixture is written.

**Files:**
- Create: `$SCRATCH/probe/autocount-type-probe.js` (scratch, not committed)

**Interfaces:**
- Consumes: nothing.
- Produces: a baseline note (unit test counts, Playwright result per spec) and the probe's token-type list, which Task 9's fixture follows.

- [ ] **Step 1: Confirm the worktree state**

Run: `git status --short && git log --oneline -1`
Expected: no changed files. The last commit is the one that added this plan.

- [ ] **Step 2: Record the unit-test baseline**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ tests 408`, `ℹ pass 407`, `ℹ fail 0`, `ℹ skipped 1`. The skipped test needs `TEST_DATABASE_URL`.

- [ ] **Step 3: Record the Playwright baseline, one spec at a time**

```bash
SCRATCH=C:/Users/wanso/AppData/Local/Temp/claude/D--autocount-pwa-dashboard/93d7b131-4d1e-411c-9bc7-afc94adb37fa/scratchpad
PW=D:/autocount-pwa-dashboard/node_modules/@playwright/test/cli.js
node "$PW" test test/e2e/dispatch-board.spec.js --output "$SCRATCH/pw-out" 2>&1 | tail -4
node "$PW" test test/e2e/dispatch-print-report.spec.js --output "$SCRATCH/pw-out" 2>&1 | tail -4
node "$PW" test test/e2e/responsive-layout.spec.js --output "$SCRATCH/pw-out" 2>&1 | tail -4
node "$PW" test test/e2e/sales-item-dropdowns.spec.js --output "$SCRATCH/pw-out" 2>&1 | tail -4
```

Expected: each prints `N passed` with no failures. If any spec fails on this untouched base, write down which tests failed. They are pre-existing, and Task 11 compares against this list.

- [ ] **Step 4: Write the probe script**

Create `$SCRATCH/probe/autocount-type-probe.js`:

```js
'use strict';

// Read-only AutoCount type probe. It reads the raw response text and parses it
// with lossless-json WITHOUT the client's conversion, so a number token
// (LosslessNumber) and a string token stay distinguishable. It prints field
// paths and token types only: no values and no counts. It writes nothing.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const MAIN = 'D:/autocount-pwa-dashboard';
const requireFromMain = createRequire(path.join(MAIN, 'package.json'));
const axios = requireFromMain('axios');
const losslessJson = requireFromMain('lossless-json');
const dotenv = requireFromMain('dotenv');

const env = dotenv.parse(fs.readFileSync(path.join(MAIN, '.env.local')));
const pick = (...names) => names.map((name) => (env[name] || '').trim()).find(Boolean) || '';
const API_URL = (pick('AUTOCOUNT_API_URL') || 'https://accounting-api.autocountcloud.com').replace(/\/+$/, '');
const BOOKS = [
  {
    label: 'enterprise',
    accountBookId: '63750',
    apiKey: pick('AUTOCOUNT_ENTERPRISE_API_KEY', 'AUTOCOUNT_API_KEY_WANSON_ENTERPRISE'),
    keyId: pick('AUTOCOUNT_ENTERPRISE_KEY_ID', 'AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE'),
  },
  {
    label: 'sdn_bhd',
    accountBookId: '63688',
    apiKey: pick('AUTOCOUNT_SDN_BHD_API_KEY', 'AUTOCOUNT_API_KEY_WANSON_SDN_BHD'),
    keyId: pick('AUTOCOUNT_SDN_BHD_KEY_ID', 'AUTOCOUNT_KEY_ID_WANSON_SDN_BHD'),
  },
];

function malaysiaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDays(isoDate, delta) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function kindOf(value) {
  if (losslessJson.isLosslessNumber(value)) return 'number';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function collect(value, at, kinds) {
  const kind = kindOf(value);
  if (!kinds.has(at)) kinds.set(at, new Set());
  kinds.get(at).add(kind);
  if (kind === 'array') value.forEach((entry) => collect(entry, `${at}[]`, kinds));
  if (kind === 'object') {
    for (const [key, entry] of Object.entries(value)) collect(entry, at ? `${at}.${key}` : key, kinds);
  }
}

function asText(value) {
  if (losslessJson.isLosslessNumber(value)) return value.toString();
  return typeof value === 'string' ? value.trim() : '';
}

async function getRaw(book, pathname, params) {
  const response = await axios.get(`${API_URL}/${book.accountBookId}${pathname}`, {
    headers: { 'API-Key': book.apiKey, 'Key-ID': book.keyId },
    params,
    timeout: 15000,
    transformResponse: [(data) => data],
    validateStatus: () => true,
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status} from ${pathname}`);
  return losslessJson.parse(response.data);
}

async function probeBook(book, startDate, endDate) {
  if (!book.apiKey || !book.keyId) throw new Error('credentials are not set in .env.local');
  const listing = new Map();
  const unitsBySku = new Map();
  let rowsRead = 0;
  for (let page = 1; page <= 100; page += 1) {
    const payload = await getRaw(book, '/invoice/listing', { page, startDate, endDate });
    collect(payload, '', listing);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    rowsRead += rows.length;
    for (const row of rows) {
      for (const detail of Array.isArray(row?.details) ? row.details : []) {
        const sku = asText(detail?.productCode);
        const unit = asText(detail?.unit).toUpperCase();
        if (!sku || !unit) continue;
        if (!unitsBySku.has(sku)) unitsBySku.set(sku, new Set());
        unitsBySku.get(sku).add(unit);
      }
    }
    const total = losslessJson.isLosslessNumber(payload?.totalCount) ? Number(payload.totalCount.toString()) : NaN;
    if (rows.length === 0 || (Number.isFinite(total) && rowsRead >= total)) break;
  }
  const products = new Map();
  for (const [sku, units] of unitsBySku) {
    if (units.size < 2) continue;
    collect(await getRaw(book, '/product', { code: sku }), '', products);
  }
  return { listing, products };
}

function print(title, kinds) {
  console.log(title);
  if (kinds.size === 0) {
    console.log('  (none needed)');
    return;
  }
  for (const [at, set] of [...kinds].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${at || '(root)'}: ${[...set].sort().join(', ')}`);
  }
}

(async () => {
  const endDate = malaysiaToday();
  const startDate = shiftDays(endDate, -90);
  console.log(`AutoCount type probe, ${startDate} to ${endDate} (token types only)`);
  for (const book of BOOKS) {
    try {
      const { listing, products } = await probeBook(book, startDate, endDate);
      print(`${book.label} invoice listing`, listing);
      print(`${book.label} product lookups for mixed-unit items`, products);
    } catch (error) {
      console.log(`${book.label}: probe failed (${error.message})`);
    }
  }
})();
```

- [ ] **Step 5: Run the probe**

Run: `node "$SCRATCH/probe/autocount-type-probe.js"`
Expected: for each book, a sorted list of field paths with their token types, for example `data[].master.finalTotal: number`. No values appear.

- [ ] **Step 6: Check the probe against the spec, and stop if needed**

Compare the output with these expectations, for both books:

| Path | Expected token types |
| --- | --- |
| `totalCount` | `number` |
| `data[].master.docNo`, `docDate`, `debtorName` (and `customerName` if present) | `string` |
| `data[].details[].productCode` (and `sku`), `description`, `unit` | `string` |
| `data[].master.finalTotal`, `total`, `grandTotal` (whichever are present) | `number` (or `null`) |
| `data[].master.outstandingAmount` | `number` and/or `null` |
| `data[].details[].qty` (and `quantity`), `unitPrice`, `subTotal`, `total` | `number` |
| `data[].master.cancelled` / `isCancelled` | `boolean` and/or `number` |
| `pageSize` / `page_size` / `limit` | `number`, or absent |
| `data[].master.docKey` | `number` and/or `string`: either is fine; record which |
| product: `product.unit`, `productMultiPacks[].multiPack` | `string` |
| product: `productMultiPacks[].multiPackRate` | `number` |

STOP and ask the owner before Task 2 if any of these turns up:
- `string` appears for any amount, quantity, page-size or cancelled field. Today Sales treats a non-empty string, even `"0.00"`, as present, so `firstNonZero` would differ there.
- `number` appears for any identifier in the third and fourth rows.
- `totalCount` is anything but `number`.
- A book reports `probe failed`.

Otherwise, write down the token types of `docKey` and of the cancelled flag. Task 9's fixture follows them.

No commit: nothing in the repo changed.

---

### Task 2: `lib/dates.js`

**Files:**
- Create: `lib/dates.js`
- Test: `test/dates.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, for Tasks 3 and 8:
  - `isIsoDate(value: unknown): boolean`
  - `todayIn(timeZone: string, now?: Date): string`, which throws `RangeError` on an invalid zone
  - `addDays(isoDate: string, delta: safe integer): string`
  - `diffDays(fromIso: string, toIso: string): number`

  `addDays` and `diffDays` throw `RangeError` when an input is not a calendar date.

- [ ] **Step 1: Write the failing test**

Create `test/dates.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import dates from '../lib/dates.js';

const { addDays, diffDays, isIsoDate, todayIn } = dates;

test('isIsoDate accepts real calendar dates, including leap days', () => {
  for (const value of ['2026-10-15', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01', '0050-06-15']) {
    assert.equal(isIsoDate(value), true, value);
  }
});

test('isIsoDate rejects impossible dates instead of rolling them over', () => {
  for (const value of [
    '2026-02-29', '2100-02-29', '2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00',
    '2026-1-01', ' 2026-01-01', '2026-01-01 ', '2026-01-01T00:00:00Z', '',
  ]) {
    assert.equal(isIsoDate(value), false, JSON.stringify(value));
  }
});

test('isIsoDate rejects anything that is not a string', () => {
  for (const value of [undefined, null, 20261015, new Date('2026-10-15T00:00:00Z'), ['2026-10-15'], { date: '2026-10-15' }]) {
    assert.equal(isIsoDate(value), false);
  }
});

test('addDays rolls over months, years and leap days in UTC', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-01-15', -90), '2025-10-17');
  assert.equal(addDays('2026-10-15', 0), '2026-10-15');
});

test('addDays keeps years 0-99 as written and zero-pads them', () => {
  assert.equal(addDays('0050-01-01', 1), '0050-01-02');
  assert.equal(addDays('0099-12-31', 1), '0100-01-01');
});

test('diffDays counts calendar days across a leap day and a year end', () => {
  assert.equal(diffDays('2028-02-28', '2028-03-01'), 2);
  assert.equal(diffDays('2026-02-28', '2026-03-01'), 1);
  assert.equal(diffDays('2025-10-17', '2026-01-15'), 90);
  assert.equal(diffDays('2026-01-15', '2025-10-17'), -90);
});

test('addDays and diffDays refuse input that is not a calendar date', () => {
  assert.throws(() => addDays('2026-02-31', 1), RangeError);
  assert.throws(() => addDays('2026-10-15', 1.5), RangeError);
  assert.throws(() => diffDays('2026-10-15', '2026-13-01'), RangeError);
});

test('todayIn moves to the next Malaysian day at exactly 16:00 UTC', () => {
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-10-15T15:59:59.999Z')), '2026-10-15');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-10-15T16:00:00.000Z')), '2026-10-16');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-12-31T16:00:00.000Z')), '2027-01-01');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2028-02-28T16:00:00.000Z')), '2028-02-29');
  assert.equal(todayIn('Asia/Kuala_Lumpur', new Date('2026-02-28T16:00:00.000Z')), '2026-03-01');
});

test('todayIn throws on a time zone that does not exist', () => {
  assert.throws(() => todayIn('Not/AZone', new Date('2026-10-15T00:00:00Z')), RangeError);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/dates.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/dates.js`.

- [ ] **Step 3: Write the implementation**

Create `lib/dates.js`:

```js
'use strict';

// Calendar dates as YYYY-MM-DD text, shared by Sales, Dispatch and Price Check.
// Validation is plain arithmetic: a JavaScript Date would quietly turn
// 31 February into 3 March, and Date.UTC reads years 0-99 as 1900-1999.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseIsoDate(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function isIsoDate(value) {
  return parseIsoDate(value) !== null;
}

function requireIsoDate(value) {
  const parts = parseIsoDate(value);
  if (!parts) throw new RangeError('expected a YYYY-MM-DD calendar date');
  return parts;
}

// Milliseconds since 1970-01-01 UTC. setUTCFullYear keeps years 0-99 as written.
function utcMillis({ year, month, day }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime();
}

function formatIsoDate(millis) {
  const date = new Date(millis);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(isoDate, delta) {
  if (!Number.isSafeInteger(delta)) throw new RangeError('expected a whole number of days');
  return formatIsoDate(utcMillis(requireIsoDate(isoDate)) + delta * DAY_MS);
}

function diffDays(fromIso, toIso) {
  return Math.round((utcMillis(requireIsoDate(toIso)) - utcMillis(requireIsoDate(fromIso))) / DAY_MS);
}

// Today's date in a time zone. Throws a RangeError for a zone that does not exist.
function todayIn(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = { addDays, diffDays, isIsoDate, todayIn };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/dates.test.mjs`
Expected: PASS, `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/dates.js test/dates.test.mjs
git commit -m "feat: add shared calendar date helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Dispatch, Price Check and the reader use `lib/dates.js`

Six files drop their own calendar check, and the reader and Price Check drop their own day arithmetic. The existing Dispatch and Price Check tests are the behaviour check. A new guard test keeps the copies from coming back.

**Files:**
- Modify:
  - `lib/autocount/invoice-reader.js`: remove its own `addDays` and `diffDays`
  - `lib/price-check/source.js`
  - `lib/price-check/compare.js`
  - `lib/dispatch/invoice-adapter.js`
  - `lib/dispatch/service.js`
  - `api/dispatch-invoices.js`
  - `api/dispatch-assignments.js`
- Test: `test/shared-helpers.test.mjs`

**Interfaces:**
- Consumes: `isIsoDate`, `todayIn`, `addDays`, `diffDays` from Task 2.
- Produces:
  - `lib/autocount/invoice-reader.js` exports `{ readDocKey, readInvoiceRange, readPaged, readWindowed, sourceError }`. `addDays` is no longer exported.
  - `lib/dispatch/service.js` still exports `isValidDate`, which is now `isIsoDate`.

- [ ] **Step 1: Write the failing guard test**

Create `test/shared-helpers.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// Files that check calendar dates or do day arithmetic. Each must use lib/dates.js.
const DATE_CHECK_FILES = [
  'api/dispatch-invoices.js',
  'api/dispatch-assignments.js',
  'lib/dispatch/service.js',
  'lib/dispatch/invoice-adapter.js',
  'lib/price-check/source.js',
  'lib/price-check/compare.js',
  'lib/autocount/invoice-reader.js',
];

test('calendar date checks and day arithmetic live only in lib/dates.js', () => {
  for (const file of DATE_CHECK_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /function (isValidDate|validIsoDate|addDays|diffDays|malaysiaDate)\b/, file);
    assert.doesNotMatch(source, /getUTCDate\(\) [!=]== Number\(/, file);
    assert.match(source, /require\('(\.\.\/)+(lib\/)?dates'\)/, `${file} uses lib/dates.js`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/shared-helpers.test.mjs`
Expected: FAIL on `api/dispatch-invoices.js` (it still has `function isValidDate`).

- [ ] **Step 3: Switch the reader**

In `lib/autocount/invoice-reader.js`:
- After `'use strict';` add `const { addDays, diffDays } = require('../dates');`.
- Delete the whole local `function addDays(isoDate, delta) { … }` and the whole local `function diffDays(fromIso, toIso) { … }`.
- Replace the export block with:

```js
module.exports = {
  readDocKey,
  readInvoiceRange,
  readPaged,
  readWindowed,
  sourceError,
};
```

- [ ] **Step 4: Switch Price Check's source**

In `lib/price-check/source.js`, replace line 3:

```js
const { addDays, readInvoiceRange, sourceError } = require('../autocount/invoice-reader');
```

with:

```js
const { readInvoiceRange, sourceError } = require('../autocount/invoice-reader');
const { addDays, isIsoDate, todayIn } = require('../dates');
```

Delete `const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;`, the whole `validIsoDate` function and the whole `malaysiaDate` function. Replace `assertIsoDate` with:

```js
function assertIsoDate(value, field) {
  if (typeof value !== 'string' || !isIsoDate(value.trim())) {
    throw sourceError(`price-check ${field} is invalid`, 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  return value.trim();
}
```

In `priceCheckWindow`, replace `const through = malaysiaDate(instant);` with `const through = todayIn(TIME_ZONE, instant);`.

- [ ] **Step 5: Switch Price Check's compare**

In `lib/price-check/compare.js`:
- After `'use strict';` add `const { isIsoDate } = require('../dates');`.
- Delete the whole `validIsoDate` function (lines 77-84).
- In `readDocDate`, replace `if (!date || !validIsoDate(date)) return null;` with `if (!date || !isIsoDate(date)) return null;`.

Keep `ISO_DATE_RE` and `ISO_DATE_TIME_RE`: `readDocDate` still uses them to cut the date out of a date-time.

- [ ] **Step 6: Switch Dispatch's adapter and service**

In `lib/dispatch/invoice-adapter.js`:
- Add `const { isIsoDate } = require('../dates');` as the first line.
- Delete the whole `validIsoDate` function.
- In `normalizeDocumentDate`, replace `if (!date || !validIsoDate(date)) throw new InvoiceDataError('docDate is invalid');` with `if (!date || !isIsoDate(date)) throw new InvoiceDataError('docDate is invalid');`.

Keep `ISO_DATE_RE` and `ISO_DATE_TIME_RE` for the same reason as in compare.

In `lib/dispatch/service.js`:
- After line 1 add `const { isIsoDate } = require('../dates');`.
- Delete `const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;` and the whole `isValidDate` function.
- Replace the three calls `isValidDate(tripDate)`, `isValidDate(fields.docDate)` and `isValidDate(docDate)` with `isIsoDate(…)`.
- In `module.exports`, replace `isValidDate,` with `isValidDate: isIsoDate,`.

- [ ] **Step 7: Switch the two Dispatch handlers**

In `api/dispatch-invoices.js`:
- After the `company-config` require add `const { isIsoDate } = require('../lib/dates');`.
- Delete `const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;` and the whole `isValidDate` function.
- Replace `if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {` with `if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {`.
- Delete the last line, `module.exports.isValidDate = isValidDate;`.

In `api/dispatch-assignments.js`:
- After line 1 add `const { isIsoDate } = require('../lib/dates');`.
- Delete `const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;`.
- Replace the whole `dateField` function with:

```js
function dateField(value) {
  if (!isIsoDate(value)) throw new DispatchHttpError(400, 'invalid_request');
  return value;
}
```

- [ ] **Step 8: Run the guard and the full suite**

Run: `node --test test/shared-helpers.test.mjs test/dates.test.mjs`
Expected: PASS.

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`. That includes the Dispatch tests "endpoint validates ISO dates before contacting AutoCount", "endpoint returns invalid_request for an invalid calendar month" and "adapter quarantines an invoice with an invalid calendar date as source data", and all Price Check source tests.

- [ ] **Step 9: Commit**

```bash
git add lib/autocount/invoice-reader.js lib/price-check/source.js lib/price-check/compare.js lib/dispatch/invoice-adapter.js lib/dispatch/service.js api/dispatch-invoices.js api/dispatch-assignments.js test/shared-helpers.test.mjs
git commit -m "refactor: one calendar date check for Dispatch, Price Check and the reader" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `lib/autocount/numbers.js`

**Files:**
- Create: `lib/autocount/numbers.js`
- Test: `test/autocount-numbers.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, for Tasks 7 and 9:
  - `decimalValue(value: unknown): number | null`
  - `firstNonZero(...candidates: unknown[]): number`, which gives 0 when no candidate counts
  - `firstPositiveInteger(...candidates: unknown[]): number | null`

- [ ] **Step 1: Write the failing test**

Create `test/autocount-numbers.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import numbers from '../lib/autocount/numbers.js';

const { decimalValue, firstNonZero, firstPositiveInteger } = numbers;

test('decimalValue reads finite numbers and exact decimal text', () => {
  assert.equal(decimalValue(12.5), 12.5);
  assert.equal(decimalValue('12.50'), 12.5);
  assert.equal(decimalValue('-2.50'), -2.5);
  assert.equal(decimalValue('3.000'), 3);
  assert.equal(decimalValue('.5'), 0.5);
  assert.equal(decimalValue('1e3'), 1000);
  assert.equal(decimalValue('+7'), 7);
});

test('decimalValue refuses everything that is not a finite decimal', () => {
  for (const value of [undefined, null, true, false, '', ' 12', '12 ', '12abc', '1,000.00', 'NaN', 'Infinity', '1e400', Infinity, -Infinity, NaN, {}, [], ['5']]) {
    assert.equal(decimalValue(value), null, String(value));
  }
});

test('firstNonZero gives what parseFloat(a || b || 0) gave for numbers, missing values and null', () => {
  assert.equal(firstNonZero(0, 12.5, 99), 12.5);
  assert.equal(firstNonZero(undefined, null, 7), 7);
  assert.equal(firstNonZero(-6, 10), -6);
  assert.equal(firstNonZero(), 0);
  assert.equal(firstNonZero(0, 0), 0);
});

test('firstNonZero lets every zero fall through, whether number or text', () => {
  for (const zero of [0, -0, '0', '0.00', '-0', '0e5']) {
    assert.equal(firstNonZero(zero, '25.50'), 25.5, JSON.stringify(zero));
  }
});

test('firstNonZero skips empty, malformed and out-of-range values', () => {
  assert.equal(firstNonZero('', '1.5'), 1.5);
  assert.equal(firstNonZero('12abc', '1.5'), 1.5);
  assert.equal(firstNonZero(' 12', '1.5'), 1.5);
  assert.equal(firstNonZero('1,000.00', '1.5'), 1.5);
  assert.equal(firstNonZero('1e400', '1.5'), 1.5);
  assert.equal(firstNonZero(Infinity, NaN, '1.5'), 1.5);
  assert.equal(firstNonZero(true, false, '1.5'), 1.5);
  assert.equal(firstNonZero('12abc'), 0);
});

test('firstPositiveInteger accepts only whole numbers above zero', () => {
  assert.equal(firstPositiveInteger('100'), 100);
  assert.equal(firstPositiveInteger('100.0'), 100);
  assert.equal(firstPositiveInteger(50), 50);
  assert.equal(firstPositiveInteger(0, '-5', '12.5', null, undefined, '25'), 25);
  assert.equal(firstPositiveInteger(0, -5, '12.5'), null);
  assert.equal(firstPositiveInteger(), null);
  assert.equal(firstPositiveInteger('9007199254740993'), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/autocount-numbers.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/autocount/numbers.js`.

- [ ] **Step 3: Write the implementation**

Create `lib/autocount/numbers.js`:

```js
'use strict';

// Reading AutoCount numbers. The AutoCount client hands numeric JSON tokens over
// as their exact text ("3.000", "-2.50"), so code that used to see JS numbers
// must not rely on truthiness: the text "0" is truthy. decimalValue is the one
// parser; everything else builds on it.

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// A finite number, or exact decimal text (no spaces), as a JS number; else null.
function decimalValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// The first candidate that is a non-zero number, else 0. For finite numbers,
// missing values and null this is exactly Sales' former parseFloat(a || b || 0):
// a zero falls through to the next candidate.
function firstNonZero(...candidates) {
  for (const candidate of candidates) {
    const number = decimalValue(candidate);
    if (number !== null && number !== 0) return number;
  }
  return 0;
}

// The first candidate that is a whole number above zero, else null.
function firstPositiveInteger(...candidates) {
  for (const candidate of candidates) {
    const number = decimalValue(candidate);
    if (number !== null && Number.isSafeInteger(number) && number > 0) return number;
  }
  return null;
}

module.exports = { decimalValue, firstNonZero, firstPositiveInteger };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/autocount-numbers.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/autocount/numbers.js test/autocount-numbers.test.mjs
git commit -m "feat: add one reader for AutoCount numbers given as exact text" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Company settings, one rule set

`company-config.js` becomes the only place the books and setting names live. Dispatch and Price Check keep calling `loadCompanyConfigs`. Sales' `getCompanyConfigs` maps `readCompanySettings`. Price Check builds its book checks from `COMPANIES`.

**Files:**
- Modify (rewrite): `lib/autocount/company-config.js`
- Modify: `api/sales.js` (remove `COMPANY_DEFINITIONS`, rewrite `getCompanyConfigs`, one line in `loadCompanyInvoices`)
- Modify: `api/price-check.js:4,14`
- Modify: `lib/price-check/source.js` (registry)
- Test (create): `test/company-config.test.mjs`
- Test (modify): `test/shared-helpers.test.mjs`, `api/sales.test.js`, `api/dispatch-invoices.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `COMPANIES`: a frozen array of frozen `{ companyKey, salesId, accountBookId, name, dashboardName, profileName }`, Enterprise first.
  - `DEFAULT_API_URL = 'https://accounting-api.autocountcloud.com'`.
  - `readCompanySettings(env)`: a frozen array (same order) of `{ ...company, apiUrl, apiKey, keyId, problem }`. `problem` is `null` or `{ code, message }`, with `code` one of `credentials_missing`, `credentials_incomplete`, `shared_credentials_incomplete` or `account_book_mismatch`.
  - `loadCompanyConfigs(env)`: frozen `{ enterprise, sdn_bhd }`, each `{ companyKey, name, accountBookId, apiUrl, keyId, apiKey }`. It throws `CompanyConfigError`.
  - `publicCompany(config)`.
  - Sales' `getCompanyConfigs(env)` returns `[{ id, name, accountBookId, apiUrl, apiKey, keyId, credentialsConfigured, settingsError }]`.

- [ ] **Step 1: Write the failing settings tests**

Create `test/company-config.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../lib/autocount/company-config.js';
import source from '../lib/price-check/source.js';

const { COMPANIES, CompanyConfigError, loadCompanyConfigs, readCompanySettings } = config;

const OWN = {
  AUTOCOUNT_ENTERPRISE_API_KEY: 'ent-key',
  AUTOCOUNT_ENTERPRISE_KEY_ID: 'ent-id',
  AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
  AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
};

const byKey = (settings) => Object.fromEntries(settings.map((entry) => [entry.companyKey, entry]));

test('the two books are fixed in code, with every name each surface shows', () => {
  assert.deepEqual(COMPANIES.map((company) => ({ ...company })), [
    { companyKey: 'enterprise', salesId: 'enterprise', accountBookId: '63750', name: 'Wanson Enterprise', dashboardName: 'Wanson Enterprise', profileName: 'WANSON ENTERPRISE' },
    { companyKey: 'sdn_bhd', salesId: 'sdnBhd', accountBookId: '63688', name: 'Wanson Enterprise (M) Sdn Bhd', dashboardName: 'Wanson Sdn Bhd', profileName: 'WANSON ENTERPRISE (M) SDN. BHD' },
  ]);
  assert.ok(Object.isFrozen(COMPANIES) && COMPANIES.every((company) => Object.isFrozen(company)));
});

test('own names are read first, the WANSON aliases second', () => {
  const settings = byKey(readCompanySettings({
    ...OWN,
    AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: 'alias-ent-key',
    AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE: 'alias-ent-id',
    AUTOCOUNT_API_KEY_WANSON_SDN_BHD: 'alias-sdn-key',
    AUTOCOUNT_KEY_ID_WANSON_SDN_BHD: 'alias-sdn-id',
  }));
  assert.deepEqual([settings.enterprise.apiKey, settings.enterprise.keyId], ['ent-key', 'ent-id']);
  assert.deepEqual([settings.sdn_bhd.apiKey, settings.sdn_bhd.keyId], ['sdn-key', 'sdn-id']);
});

test('the aliases alone are enough, and the two own-name styles may be mixed', () => {
  const settings = byKey(readCompanySettings({
    AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: 'alias-ent-key',
    AUTOCOUNT_ENTERPRISE_KEY_ID: 'ent-id',
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
    AUTOCOUNT_KEY_ID_WANSON_SDN_BHD: 'alias-sdn-id',
  }));
  assert.deepEqual([settings.enterprise.apiKey, settings.enterprise.keyId, settings.enterprise.problem], ['alias-ent-key', 'ent-id', null]);
  assert.deepEqual([settings.sdn_bhd.apiKey, settings.sdn_bhd.keyId, settings.sdn_bhd.problem], ['sdn-key', 'alias-sdn-id', null]);
});

test('half of an own pair makes the book misconfigured and never borrows the shared half', () => {
  const settings = byKey(readCompanySettings({
    AUTOCOUNT_ENTERPRISE_API_KEY: 'ent-key',
    AUTOCOUNT_KEY_ID: 'shared-id',
    AUTOCOUNT_API_KEY: 'shared-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
  }));
  assert.equal(settings.enterprise.problem.code, 'credentials_incomplete');
  assert.equal(settings.sdn_bhd.problem.code, 'credentials_incomplete');
  assert.equal(settings.enterprise.apiKey, null);
  assert.equal(settings.enterprise.keyId, null);
});

test('Enterprise may use the complete shared pair when none of its own names is set', () => {
  const withKeyId = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_KEY_ID: 'shared-id', AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key', AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id' }));
  assert.deepEqual([withKeyId.enterprise.apiKey, withKeyId.enterprise.keyId, withKeyId.enterprise.problem], ['shared-key', 'shared-id', null]);

  const withApiKeyId = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_API_KEY_ID: 'other-id' }));
  assert.equal(withApiKeyId.enterprise.keyId, 'other-id');

  const both = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_KEY_ID: 'shared-id', AUTOCOUNT_API_KEY_ID: 'other-id' }));
  assert.equal(both.enterprise.keyId, 'shared-id', 'AUTOCOUNT_KEY_ID comes before AUTOCOUNT_API_KEY_ID');
});

test('an incomplete shared pair is refused for Enterprise', () => {
  for (const env of [{ AUTOCOUNT_API_KEY: 'shared-key' }, { AUTOCOUNT_KEY_ID: 'shared-id' }, { AUTOCOUNT_API_KEY_ID: 'shared-id' }]) {
    const settings = byKey(readCompanySettings(env));
    assert.equal(settings.enterprise.problem.code, 'shared_credentials_incomplete');
    assert.match(settings.enterprise.problem.message, /shared AutoCount credentials/);
  }
});

test('Sdn Bhd never uses the shared pair', () => {
  const settings = byKey(readCompanySettings({ AUTOCOUNT_API_KEY: 'shared-key', AUTOCOUNT_KEY_ID: 'shared-id' }));
  assert.equal(settings.enterprise.problem, null);
  assert.equal(settings.sdn_bhd.problem.code, 'credentials_missing');
  assert.equal(settings.sdn_bhd.apiKey, null);
  assert.equal(settings.sdn_bhd.keyId, null);
});

test('a book number setting is optional, and must match the fixed book when set', () => {
  assert.equal(byKey(readCompanySettings(OWN)).enterprise.problem, null);

  const equal = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: ' 63750 ', AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63688' }));
  assert.equal(equal.enterprise.problem, null);
  assert.equal(equal.sdn_bhd.problem, null);

  const different = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63750' }));
  assert.equal(different.sdn_bhd.problem.code, 'account_book_mismatch');
  assert.equal(different.sdn_bhd.accountBookId, '63688', 'the fixed book is never replaced');
  assert.equal(different.sdn_bhd.apiKey, null);
  assert.equal(different.enterprise.problem, null);
});

test('values are trimmed and blank values count as unset', () => {
  const settings = byKey(readCompanySettings({
    AUTOCOUNT_ENTERPRISE_API_KEY: '  ',
    AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: ' ent-key\n',
    AUTOCOUNT_ENTERPRISE_KEY_ID: '\tent-id ',
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: '',
  }));
  assert.deepEqual([settings.enterprise.apiKey, settings.enterprise.keyId, settings.enterprise.problem], ['ent-key', 'ent-id', null]);
});

test('the address comes from the per-company setting, then AUTOCOUNT_API_URL, then the default', () => {
  const defaults = byKey(readCompanySettings(OWN));
  assert.equal(defaults.enterprise.apiUrl, 'https://accounting-api.autocountcloud.com');

  const shared = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_API_URL: 'https://cloud.example//' }));
  assert.equal(shared.enterprise.apiUrl, 'https://cloud.example');
  assert.equal(shared.sdn_bhd.apiUrl, 'https://cloud.example');

  const perCompany = byKey(readCompanySettings({ ...OWN, AUTOCOUNT_API_URL: 'https://cloud.example', AUTOCOUNT_SDN_BHD_API_URL: ' https://sdn.example/ ' }));
  assert.equal(perCompany.enterprise.apiUrl, 'https://cloud.example');
  assert.equal(perCompany.sdn_bhd.apiUrl, 'https://sdn.example');
});

test('problem messages name settings but never contain a value', () => {
  const secrets = {
    AUTOCOUNT_ENTERPRISE_API_KEY: 'secret-ent-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'secret-sdn-id',
    AUTOCOUNT_API_KEY: 'secret-shared-key',
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: 'secret-book',
  };
  const messages = readCompanySettings(secrets).map((entry) => entry.problem?.message || '').join(' | ');
  assert.ok(messages.includes('AUTOCOUNT_'), 'messages name the settings');
  for (const secret of Object.values(secrets)) assert.equal(messages.includes(secret), false, secret);
});

test('loadCompanyConfigs keeps its contract for Dispatch and Price Check', () => {
  const configs = loadCompanyConfigs(OWN);
  assert.deepEqual(Object.keys(configs), ['enterprise', 'sdn_bhd']);
  assert.deepEqual({ ...configs.enterprise }, {
    companyKey: 'enterprise',
    name: 'Wanson Enterprise',
    accountBookId: '63750',
    apiUrl: 'https://accounting-api.autocountcloud.com',
    keyId: 'ent-id',
    apiKey: 'ent-key',
  });
  assert.equal(configs.sdn_bhd.name, 'Wanson Enterprise (M) Sdn Bhd');
  assert.ok(Object.isFrozen(configs));
  assert.throws(
    () => loadCompanyConfigs({ AUTOCOUNT_ENTERPRISE_API_KEY: 'ent-key', AUTOCOUNT_ENTERPRISE_KEY_ID: 'ent-id' }),
    (error) => error instanceof CompanyConfigError && /sdn_bhd/.test(error.message),
  );
});

test('Price Check checks the books against the shared list', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(source.COMPANY_REGISTRY)), {
    enterprise: { accountBookId: '63750', profileName: 'WANSON ENTERPRISE' },
    sdn_bhd: { accountBookId: '63688', profileName: 'WANSON ENTERPRISE (M) SDN. BHD' },
  });
});
```

Append to `test/shared-helpers.test.mjs`:

```js
import { readdirSync } from 'node:fs';

function sourceFiles(dir) {
  return readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
    .map((name) => `${dir}/${String(name).replaceAll('\\', '/')}`)
    .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js'));
}

test('the two book numbers are typed in one file only', () => {
  const typed = [...sourceFiles('api'), ...sourceFiles('lib')]
    .filter((file) => /\b(63750|63688)\b/.test(read(file)));
  assert.deepEqual(typed, ['lib/autocount/company-config.js']);
});
```

(Put the new `import` line at the top of the file, next to the existing imports.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/company-config.test.mjs test/shared-helpers.test.mjs`
Expected: FAIL. `COMPANIES` is undefined, so the first test throws. The guard finds the book numbers in `api/price-check.js`, `api/sales.js` and `lib/price-check/source.js`, and not in `lib/autocount/company-config.js`.

- [ ] **Step 3: Rewrite `lib/autocount/company-config.js`**

Replace the whole file with:

```js
'use strict';

// The two AutoCount books and the one set of rules for reading their settings.
// Sales, Dispatch and Price Check all load company settings here, so a book can
// never be read with another book's credentials or a book number chosen
// elsewhere. Problem messages name settings, never their values.

const DEFAULT_API_URL = 'https://accounting-api.autocountcloud.com';

const COMPANIES = Object.freeze([
  Object.freeze({
    companyKey: 'enterprise',
    salesId: 'enterprise',
    accountBookId: '63750',
    name: 'Wanson Enterprise',
    dashboardName: 'Wanson Enterprise',
    profileName: 'WANSON ENTERPRISE',
  }),
  Object.freeze({
    companyKey: 'sdn_bhd',
    salesId: 'sdnBhd',
    accountBookId: '63688',
    name: 'Wanson Enterprise (M) Sdn Bhd',
    dashboardName: 'Wanson Sdn Bhd',
    profileName: 'WANSON ENTERPRISE (M) SDN. BHD',
  }),
]);

// Setting names in the order they are tried. Only Enterprise may fall back to
// the old shared pair, and only when none of its own names is set.
const SETTING_NAMES = Object.freeze({
  enterprise: Object.freeze({
    accountBook: 'AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE',
    apiUrl: 'AUTOCOUNT_ENTERPRISE_API_URL',
    apiKey: Object.freeze(['AUTOCOUNT_ENTERPRISE_API_KEY', 'AUTOCOUNT_API_KEY_WANSON_ENTERPRISE']),
    keyId: Object.freeze(['AUTOCOUNT_ENTERPRISE_KEY_ID', 'AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE']),
    shared: Object.freeze({
      apiKey: Object.freeze(['AUTOCOUNT_API_KEY']),
      keyId: Object.freeze(['AUTOCOUNT_KEY_ID', 'AUTOCOUNT_API_KEY_ID']),
    }),
  }),
  sdn_bhd: Object.freeze({
    accountBook: 'AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD',
    apiUrl: 'AUTOCOUNT_SDN_BHD_API_URL',
    apiKey: Object.freeze(['AUTOCOUNT_SDN_BHD_API_KEY', 'AUTOCOUNT_API_KEY_WANSON_SDN_BHD']),
    keyId: Object.freeze(['AUTOCOUNT_SDN_BHD_KEY_ID', 'AUTOCOUNT_KEY_ID_WANSON_SDN_BHD']),
    shared: null,
  }),
});

class CompanyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompanyConfigError';
  }
}

function value(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function firstSet(env, names) {
  for (const name of names) {
    const found = value(env, name);
    if (found) return found;
  }
  return '';
}

function settingsProblem(code, message) {
  return Object.freeze({ code, message });
}

function resolveCredentials(companyKey, names, env) {
  const apiKey = firstSet(env, names.apiKey);
  const keyId = firstSet(env, names.keyId);
  if (apiKey && keyId) return { apiKey, keyId, problem: null };
  if (apiKey || keyId) {
    return {
      problem: settingsProblem(
        'credentials_incomplete',
        `${names.apiKey.join('/')} and ${names.keyId.join('/')} must be set together for ${companyKey}`,
      ),
    };
  }
  if (!names.shared) {
    return { problem: settingsProblem('credentials_missing', `missing credentials for ${companyKey}`) };
  }
  const sharedApiKey = firstSet(env, names.shared.apiKey);
  const sharedKeyId = firstSet(env, names.shared.keyId);
  if (sharedApiKey && sharedKeyId) return { apiKey: sharedApiKey, keyId: sharedKeyId, problem: null };
  if (sharedApiKey || sharedKeyId) {
    return {
      problem: settingsProblem('shared_credentials_incomplete', 'shared AutoCount credentials require both key ID and API key'),
    };
  }
  return { problem: settingsProblem('credentials_missing', `missing credentials for ${companyKey}`) };
}

// Every book with its address, credentials and any settings problem. A book
// with a problem never carries half a credential further.
function readCompanySettings(env = process.env) {
  return Object.freeze(COMPANIES.map((company) => {
    const names = SETTING_NAMES[company.companyKey];
    const apiUrl = (value(env, names.apiUrl) || value(env, 'AUTOCOUNT_API_URL') || DEFAULT_API_URL).replace(/\/+$/, '');
    const credentials = resolveCredentials(company.companyKey, names, env);
    const configuredBook = value(env, names.accountBook);
    const problem = configuredBook && configuredBook !== company.accountBookId
      ? settingsProblem('account_book_mismatch', `${names.accountBook} does not match the fixed account book for ${company.companyKey}`)
      : credentials.problem;
    return Object.freeze({
      ...company,
      apiUrl,
      apiKey: problem ? null : credentials.apiKey,
      keyId: problem ? null : credentials.keyId,
      problem,
    });
  }));
}

// Dispatch and Price Check need both books; any settings problem refuses both.
function loadCompanyConfigs(env = process.env) {
  const settings = readCompanySettings(env);
  const failed = settings.find((entry) => entry.problem);
  if (failed) throw new CompanyConfigError(failed.problem.message);
  const configs = {};
  for (const entry of settings) {
    configs[entry.companyKey] = {
      companyKey: entry.companyKey,
      name: entry.name,
      accountBookId: entry.accountBookId,
      apiUrl: entry.apiUrl,
      keyId: entry.keyId,
      apiKey: entry.apiKey,
    };
  }
  return Object.freeze(configs);
}

function publicCompany(config) {
  return { companyKey: config.companyKey, name: config.name };
}

module.exports = {
  COMPANIES,
  CompanyConfigError,
  DEFAULT_API_URL,
  loadCompanyConfigs,
  publicCompany,
  readCompanySettings,
};
```

- [ ] **Step 4: Point Price Check at `COMPANIES`**

In `api/price-check.js`, replace line 4:

```js
const { loadCompanyConfigs } = require('../lib/autocount/company-config');
```

with:

```js
const { COMPANIES, loadCompanyConfigs } = require('../lib/autocount/company-config');
```

Then replace line 14:

```js
const EXPECTED_BOOKS = Object.freeze({ enterprise: '63750', sdn_bhd: '63688' });
```

with:

```js
const EXPECTED_BOOKS = Object.freeze(Object.fromEntries(
  COMPANIES.map((company) => [company.companyKey, company.accountBookId]),
));
```

In `lib/price-check/source.js`:
- Add `const { COMPANIES } = require('../autocount/company-config');` after `'use strict';`.
- Replace the whole literal `COMPANY_REGISTRY` declaration with:

```js
// Each book's number and the Cloud profile name it must report, from the shared list.
const COMPANY_REGISTRY = Object.freeze(Object.fromEntries(COMPANIES.map((company) => [
  company.companyKey,
  Object.freeze({ accountBookId: company.accountBookId, profileName: company.profileName }),
])));
```

- [ ] **Step 5: Point Sales at `readCompanySettings`**

In `api/sales.js`:
- Add `const { readCompanySettings } = require('../lib/autocount/company-config');` after the `AutoCountClient` require.
- Delete the whole `COMPANY_DEFINITIONS` declaration (lines 13-36). Keep `DEFAULT_API_URL`: `fetchAllInvoices` still uses it until Task 9.
- Replace the whole `getCompanyConfigs` function with:

```js
// What the dashboard shows for a book whose settings are refused.
function settingsErrorText(problem) {
  if (!problem) return null;
  return problem.code === 'account_book_mismatch' ? 'Account book setting does not match' : 'Credentials not configured';
}

function getCompanyConfigs(env = process.env) {
  return readCompanySettings(env).map((settings) => ({
    id: settings.salesId,
    name: settings.dashboardName,
    accountBookId: settings.accountBookId,
    apiUrl: settings.apiUrl,
    apiKey: settings.apiKey,
    keyId: settings.keyId,
    credentialsConfigured: settings.problem === null,
    settingsError: settingsErrorText(settings.problem),
  }));
}
```

In `loadCompanyInvoices`, replace `error: 'Credentials not configured',` (inside the `!company.credentialsConfigured` branch) with:

```js
      error: company.settingsError || 'Credentials not configured',
```

- [ ] **Step 6: Update the Dispatch config tests**

In `api/dispatch-invoices.test.js`, in `ENV` (lines 24-32), replace:

```js
  AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: 'enterprise-book-fixture',
  AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: 'sdn-bhd-book-fixture',
```

with:

```js
  AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: '63750',
  AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63688',
```

In the test "company config isolates both books and exposes only public company identity", replace:

```js
  assert.equal(configs.enterprise.accountBookId, 'enterprise-book-fixture');
  assert.equal(configs.sdn_bhd.accountBookId, 'sdn-bhd-book-fixture');
```

with:

```js
  assert.equal(configs.enterprise.accountBookId, '63750');
  assert.equal(configs.sdn_bhd.accountBookId, '63688');
```

Replace the whole test "company config uses shared credentials only when both shared values exist" with:

```js
test('company config lets only Enterprise use the shared credentials, and only as a complete pair', () => {
  assert.throws(
    () => loadCompanyConfigs({ AUTOCOUNT_API_KEY_ID: 'shared-key-fixture', AUTOCOUNT_API_KEY: 'shared-api-fixture' }),
    /missing credentials for sdn_bhd/,
  );
  const configs = loadCompanyConfigs({
    AUTOCOUNT_API_KEY_ID: 'shared-key-fixture',
    AUTOCOUNT_API_KEY: 'shared-api-fixture',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-bhd-key-fixture',
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-bhd-api-fixture',
  });
  assert.equal(configs.enterprise.keyId, 'shared-key-fixture');
  assert.equal(configs.enterprise.apiKey, 'shared-api-fixture');
  assert.equal(configs.sdn_bhd.apiKey, 'sdn-bhd-api-fixture');
  assert.throws(
    () => loadCompanyConfigs({ AUTOCOUNT_API_KEY_ID: 'shared-key-fixture' }),
    /shared AutoCount credentials/,
  );
});
```

In the test "company config accepts the existing Sdn Bhd credential variable names", delete the two lines `AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: 'enterprise-book-fixture',` and `AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: 'sdn-bhd-book-fixture',`.

In the test "all endpoint returns mixed company invoices and source health", replace `assert.equal(JSON.stringify(res.body).includes('enterprise-book-fixture'), false);` with `assert.equal(JSON.stringify(res.body).includes('63750'), false);`.

- [ ] **Step 7: Add the Sales book-number tests**

Append to `api/sales.test.js` (after the three existing `getCompanyConfigs` tests):

```js
test('getCompanyConfigs marks a book whose account book setting differs as unavailable', () => {
  const [enterprise, sdnBhd] = getCompanyConfigs({
    AUTOCOUNT_ENTERPRISE_API_KEY: 'enterprise-key',
    AUTOCOUNT_ENTERPRISE_KEY_ID: 'enterprise-id',
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63750',
  });

  assert.equal(enterprise.credentialsConfigured, true);
  assert.equal(enterprise.settingsError, null);
  assert.equal(sdnBhd.accountBookId, '63688');
  assert.equal(sdnBhd.credentialsConfigured, false);
  assert.equal(sdnBhd.settingsError, 'Account book setting does not match');
  assert.equal(sdnBhd.apiKey, null);
});

test('loadCompanyInvoices shows the settings error for that book without calling AutoCount', async () => {
  const [, sdnBhd] = getCompanyConfigs({
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63750',
  });

  const result = await loadCompanyInvoices('2026-09-01', '2026-09-01', sdnBhd, false);

  assert.deepEqual(
    { status: result.status, error: result.error, invoices: result.invoices },
    { status: 'error', error: 'Account book setting does not match', invoices: [] },
  );
});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node --test test/company-config.test.mjs test/shared-helpers.test.mjs api/sales.test.js api/dispatch-invoices.test.js api/price-check.test.js test/price-check-source.test.mjs`
Expected: PASS, `ℹ fail 0`.

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`.

- [ ] **Step 9: Commit**

```bash
git add lib/autocount/company-config.js api/sales.js api/price-check.js lib/price-check/source.js test/company-config.test.mjs test/shared-helpers.test.mjs api/sales.test.js api/dispatch-invoices.test.js
git commit -m "refactor: one rule set for AutoCount company settings" -m "Sales, Dispatch and Price Check read the two fixed books, their keys and addresses through lib/autocount/company-config.js. Sdn Bhd never uses the shared key; book-number settings are optional and double-checked." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The client honours each company's address; parsing acceptance test

**Files:**
- Modify: `lib/autocount/client.js`
- Test: `test/autocount-client.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_API_URL` (Task 5).
- Produces: `AutoCountClient` with the unchanged methods `listInvoicePage(company, { page, startDate, endDate })`, `getCompanyProfile(company)` and `getProduct(company, itemCode)`. Each request now goes to `company.apiUrl` when that is a non-empty string, otherwise to the client's `baseUrl`. All trailing slashes are removed.

- [ ] **Step 1: Write the failing test**

Create `test/autocount-client.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import clientModule from '../lib/autocount/client.js';

const { AutoCountClient } = clientModule;

const RAW = '{"data":[{"master":{"docKey":12345678901234567890,"docNo":"INV-1","cancelled":false,"note":null},"details":[{"qty":3.000,"unitPrice":-2.50,"subTotal":1e400}]}],"totalCount":1,"pageSize":100}';

function serve(body) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test('through real axios, AutoCount numbers arrive as their exact text and totalCount as a number', async () => {
  const { server, requests, base } = await serve(RAW);
  try {
    const client = new AutoCountClient({ baseUrl: base });
    const page = await client.listInvoicePage(
      { accountBookId: '63750', apiKey: 'k', keyId: 'i' },
      { page: 1, startDate: '2026-10-15', endDate: '2026-10-15' },
    );
    const master = page.data[0].master;
    const line = page.data[0].details[0];

    assert.equal(master.docKey, '12345678901234567890');
    assert.equal(line.qty, '3.000');
    assert.equal(line.unitPrice, '-2.50');
    assert.equal(line.subTotal, '1e400');
    assert.equal(page.totalCount, 1);
    assert.equal(typeof page.totalCount, 'number');
    assert.equal(page.pageSize, '100');
    assert.equal(master.docNo, 'INV-1');
    assert.equal(master.cancelled, false);
    assert.equal(master.note, null);
    assert.equal(requests[0].url, '/63750/invoice/listing?page=1&startDate=2026-10-15&endDate=2026-10-15');
    assert.equal(requests[0].headers['api-key'], 'k');
    assert.equal(requests[0].headers['key-id'], 'i');
    assert.equal(requests[0].headers['content-type'], undefined);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('every client request asks axios for the raw text, so axios never runs JSON.parse', async () => {
  const transforms = [];
  const fake = {
    async get(url, options) {
      transforms.push(options.transformResponse);
      return { status: 200, data: '{"data":[],"totalCount":0}' };
    },
  };
  const client = new AutoCountClient({ baseUrl: 'https://cloud.example', http: fake });
  const company = { accountBookId: '63750', apiKey: 'k', keyId: 'i' };

  await client.listInvoicePage(company, { page: 1, startDate: '2026-10-15', endDate: '2026-10-15' });
  await client.getCompanyProfile(company);
  await client.getProduct(company, 'ITEM-A');

  assert.equal(transforms.length, 3);
  for (const transform of transforms) {
    assert.ok(Array.isArray(transform) && transform.length === 1);
    assert.equal(transform[0]('{"a":1.10}'), '{"a":1.10}');
  }
});

test('requests go to the company address when its settings gave one, else to the client address', async () => {
  const urls = [];
  const fake = {
    async get(url) {
      urls.push(url);
      return { status: 200, data: '{"data":[],"totalCount":0}' };
    },
  };
  const client = new AutoCountClient({ baseUrl: 'https://cloud.example///', http: fake });
  const params = { page: 1, startDate: '2026-10-15', endDate: '2026-10-15' };

  await client.listInvoicePage({ accountBookId: '63750', apiKey: 'k', keyId: 'i' }, params);
  await client.listInvoicePage({ accountBookId: '63688', apiKey: 'k', keyId: 'i', apiUrl: ' https://sdn.example// ' }, params);
  await client.getProduct({ accountBookId: '63688', apiKey: 'k', keyId: 'i', apiUrl: 'https://sdn.example' }, 'ITEM-A');
  await client.getCompanyProfile({ accountBookId: '63750', apiKey: 'k', keyId: 'i', apiUrl: '' });

  assert.deepEqual(urls, [
    'https://cloud.example/63750/invoice/listing',
    'https://sdn.example/63688/invoice/listing',
    'https://sdn.example/63688/product',
    'https://cloud.example/63750/companyProfile',
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/autocount-client.test.mjs`
Expected: the first two tests PASS: they pin behaviour the client already has. The address test FAILS. It gets `https://cloud.example///63750/invoice/listing`, because the client removes only one of the three trailing slashes, and the second URL ignores `apiUrl`.

- [ ] **Step 3: Implement the address rule**

In `lib/autocount/client.js`:
- After the `lossless-json` require add `const { DEFAULT_API_URL } = require('./company-config');`.
- Replace the class from `class AutoCountClient {` through the end of `getProduct` with:

```js
function trimSlashes(url) {
  return url.replace(/\/+$/, '');
}

class AutoCountClient {
  constructor({ baseUrl, http = axios } = {}) {
    this.baseUrl = trimSlashes(baseUrl || process.env.AUTOCOUNT_API_URL || DEFAULT_API_URL);
    this.http = http;
  }

  // The company's own address when its settings gave one, else the client's.
  urlFor(company, pathname) {
    const own = typeof company?.apiUrl === 'string' ? company.apiUrl.trim() : '';
    const base = own ? trimSlashes(own) : this.baseUrl;
    return `${base}/${encodeURIComponent(company.accountBookId)}${pathname}`;
  }

  async listInvoicePage(company, { page, startDate, endDate }) {
    const response = await this.http.get(
      this.urlFor(company, '/invoice/listing'),
      {
        headers: {
          'API-Key': company.apiKey,
          'Key-ID': company.keyId,
        },
        params: { page, startDate, endDate },
        timeout: 15000,
        transformResponse: [(data) => data],
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error('AutoCount invoice listing request failed');
    }
    return parseResponseData(response.data);
  }

  async getCompanyProfile(company) {
    const response = await this.http.get(
      this.urlFor(company, '/companyProfile'),
      {
        headers: {
          'API-Key': company.apiKey,
          'Key-ID': company.keyId,
        },
        timeout: 15000,
        transformResponse: [(data) => data],
      },
    );
    if (response.status !== 200) throw new Error('Cloud profile request failed');
    return parseResponseData(response.data);
  }

  async getProduct(company, itemCode) {
    const response = await this.http.get(
      this.urlFor(company, '/product'),
      {
        headers: {
          'API-Key': company.apiKey,
          'Key-ID': company.keyId,
        },
        params: { code: itemCode },
        timeout: 15000,
        transformResponse: [(data) => data],
      },
    );
    return parseResponseData(response.data);
  }
}
```

(The empty line and closing brace that followed `getProduct` in the old class are replaced by this one closing brace.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/autocount-client.test.mjs test/price-check-source.test.mjs api/dispatch-invoices.test.js`
Expected: PASS. The Price Check source test "…companyProfile" still expects `https://cloud.example/63688/companyProfile`.

- [ ] **Step 5: Commit**

```bash
git add lib/autocount/client.js test/autocount-client.test.mjs
git commit -m "feat: AutoCount client uses each company's own address" -m "Also pins the parsing facts the shared layer relies on: axios hands over raw text, and numbers arrive as their exact text." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `readInvoicesChecked`, Sales' checked read

**Files:**
- Modify: `lib/autocount/invoice-reader.js`
- Test: `test/invoice-reader.test.mjs`

**Interfaces:**
- Consumes: `firstPositiveInteger` (Task 4); `addDays` and `diffDays` (Task 3, already imported).
- Produces: `readInvoicesChecked({ listPage, accountBookId, startDate, endDate, maxPages = 100, onRecheck })`.
  - It resolves to `{ rows, pageCount, check: 'count' | 'slices' | 'none', problem: null | 'row count does not match totalCount' | 'an invoice is listed twice' }`.
  - It throws a `sourceError`: `PRICE_SOURCE_INVALID` for a malformed page, `PRICE_PAGE_INCOMPLETE` for the page ceiling, or whatever error a failed windowed re-read raises.
  - `onRecheck(problem)` is called once, just before the slice re-read.

- [ ] **Step 1: Write the failing tests**

In `test/invoice-reader.test.mjs`, replace line 5:

```js
const { readInvoiceRange } = reader;
```

with:

```js
const { readInvoiceRange, readInvoicesChecked } = reader;
```

Append to `test/invoice-reader.test.mjs`:

```js
// --- readInvoicesChecked (Sales) -------------------------------------------

// A listPage that serves prepared pages in order and records each request.
function pagesOf(pages) {
  const calls = [];
  const listPage = async (params) => {
    calls.push(params);
    return pages[calls.length - 1] ?? { data: [] };
  };
  listPage.calls = calls;
  return listPage;
}

const row = (docKey) => ({ master: { docKey }, details: [] });
const sameDay = { accountBookId: '63750', startDate: day(0), endDate: day(0) };
const fullRange = { accountBookId: '63750', startDate: day(0), endDate: day(90) };
const isFullRange = (params) => params.startDate === day(0) && params.endDate === day(90);

test('checked read without any total stops at an empty page and reports check none', async () => {
  const listPage = pagesOf([{ data: [row('A'), row('B')] }, { data: [row('C')], totalCount: null }, { data: [] }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.deepEqual(result.rows.map((r) => r.master.docKey), ['A', 'B', 'C']);
  assert.equal(result.check, 'none');
  assert.equal(result.problem, null);
  assert.equal(listPage.calls.length, 3);
});

test('checked read without a total also stops at a page shorter than a page size given as text', async () => {
  const listPage = pagesOf([{ data: [row('A'), row('B')], pageSize: '2' }, { data: [row('C')], pageSize: '2' }, { data: [row('never')] }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.deepEqual(result.rows.map((r) => r.master.docKey), ['A', 'B', 'C']);
  assert.equal(result.check, 'none');
  assert.equal(listPage.calls.length, 2);
});

test('checked read accepts a total that grows while the pages are read', async () => {
  const first = Array.from({ length: 100 }, (_, i) => row(`K${i}`));
  const second = Array.from({ length: 51 }, (_, i) => row(`K${100 + i}`));
  const listPage = pagesOf([{ data: first, totalCount: 150 }, { data: second, totalCount: 151 }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.equal(result.rows.length, 151);
  assert.equal(result.check, 'count');
  assert.equal(listPage.calls.length, 2);
});

test('rows without a readable document key are not counted as repeats', async () => {
  const listPage = pagesOf([{ data: [{ id: 1 }, { id: 1 }], totalCount: 2 }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.equal(result.check, 'count');
});

test('a count mismatch alone triggers the slice re-read', async () => {
  const rows = rowsOverDays(DAYS);
  const honest = listPageOver(rows);
  const listPage = async (params) => {
    const payload = await honest(params);
    return isFullRange(params) && params.page === 2 ? { ...payload, data: payload.data.slice(0, -3) } : payload;
  };
  const rechecks = [];
  const result = await readInvoicesChecked({ listPage, ...fullRange, onRecheck: (problem) => rechecks.push(problem) });
  assert.deepEqual(keys(result.rows), keys(rows));
  assert.equal(result.check, 'slices');
  assert.equal(result.problem, 'row count does not match totalCount');
  assert.deepEqual(rechecks, ['row count does not match totalCount']);
});

test('a repeated document alone triggers the slice re-read', async () => {
  const rows = rowsOverDays(DAYS);
  const result = await readInvoicesChecked({ listPage: listPageOver(rows, { unstable: true }), ...fullRange });
  assert.deepEqual(keys(result.rows), keys(rows));
  assert.equal(result.check, 'slices');
  assert.equal(result.problem, 'an invoice is listed twice');
});

test('when both checks fail, the re-read happens once and the count mismatch is named', async () => {
  const unstable = listPageOver(rowsOverDays(DAYS), { unstable: true });
  const listPage = async (params) => {
    const payload = await unstable(params);
    return isFullRange(params) && params.page === 2 ? { ...payload, data: payload.data.slice(0, -3) } : payload;
  };
  const rechecks = [];
  const result = await readInvoicesChecked({ listPage, ...fullRange, onRecheck: (problem) => rechecks.push(problem) });
  assert.equal(result.check, 'slices');
  assert.equal(result.problem, 'row count does not match totalCount');
  assert.equal(rechecks.length, 1);
});

test('a list that stays short of its total, even in slices, throws', async () => {
  const honest = listPageOver(rowsOverDays(DAYS));
  const listPage = async (params) => {
    const payload = await honest(params);
    return { ...payload, data: payload.data.slice(0, Math.max(0, payload.data.length - 1)) };
  };
  await assert.rejects(() => readInvoicesChecked({ listPage, ...fullRange }), { code: 'PRICE_PAGE_INCOMPLETE' });
});

test('slices that do not add up to the overall total throw', async () => {
  // Every request silently drops its end date, so the slices cannot add up.
  const rows = rowsOverDays(DAYS);
  const listPage = async ({ page, startDate, endDate }) => {
    const matching = rows
      .filter((r) => r.master.docDate >= startDate && r.master.docDate < endDate)
      .sort((a, b) => `${a.master.docDate}${a.master.docKey}`.localeCompare(`${b.master.docDate}${b.master.docKey}`));
    const total = matching.length;
    const ordered = page > 1 && total > 0
      ? matching.map((_, i) => matching[(i - 13 * (page - 1) + total * 100) % total])
      : matching;
    return { totalCount: total, data: ordered.slice((page - 1) * 100, page * 100) };
  };
  await assert.rejects(() => readInvoicesChecked({ listPage, ...fullRange }), { code: 'PRICE_PAGE_INCOMPLETE' });
});

test('a present totalCount that is not a non-negative safe integer makes the page malformed', async () => {
  // Infinity is what the client makes of a 1e400 token.
  for (const totalCount of [-1, 2.5, Infinity, 2 ** 53, '100', true]) {
    await assert.rejects(
      () => readInvoicesChecked({ listPage: pagesOf([{ data: [row('A')], totalCount }]), ...sameDay }),
      { code: 'PRICE_SOURCE_INVALID' },
      String(totalCount),
    );
  }
});

test('a page without a total keeps the total of an earlier page', async () => {
  const listPage = pagesOf([{ data: [row('A'), row('B')], totalCount: 3 }, { data: [row('C')] }, { data: [] }]);
  const result = await readInvoicesChecked({ listPage, ...sameDay });
  assert.equal(result.check, 'count');
  assert.equal(result.rows.length, 3);
  assert.equal(listPage.calls.length, 3);
});

test('a page without a data array is malformed', async () => {
  for (const payload of [null, [], { data: null }, { rows: [] }]) {
    await assert.rejects(
      () => readInvoicesChecked({ listPage: async () => payload, ...sameDay }),
      { code: 'PRICE_SOURCE_INVALID' },
      JSON.stringify(payload),
    );
  }
});

test('the checked read stops at the page ceiling', async () => {
  const listPage = async ({ page }) => ({ data: [row(`K${page}`)] });
  await assert.rejects(
    () => readInvoicesChecked({ listPage, ...sameDay, maxPages: 5 }),
    { code: 'PRICE_PAGE_INCOMPLETE' },
  );
});

test('the checked read needs a listPage function', async () => {
  await assert.rejects(() => readInvoicesChecked({ ...sameDay }), { code: 'PRICE_SOURCE_INVALID' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/invoice-reader.test.mjs`
Expected: the four existing tests PASS. The new ones FAIL with `TypeError: readInvoicesChecked is not a function`.

- [ ] **Step 3: Implement `readInvoicesChecked`**

In `lib/autocount/invoice-reader.js`:
- Add `const { firstPositiveInteger } = require('./numbers');` after the `../dates` require.
- In the header comment, replace these seven lines:

```js
// endDate })`, which must resolve to the raw `{ data, totalCount }` payload, and
// get back rows that are PROVEN complete or an error. Two strategies:
//   - 'paged': read page by page, failing on any repeated, missing or extra row.
//   - 'windowed': read the range in date slices that each fit on ONE page, so
//     the Cloud never has to order rows across pages; slice totals must add up to
//     the overall total and no document may appear twice.
// Errors keep the original Price Check codes (PRICE_*) so existing callers and
```

with:

```js
// endDate })`, which must resolve to the raw `{ data, totalCount }` payload.
// Price Check uses readInvoiceRange, which returns rows that pass strict checks
// or throws:
//   - 'paged': read page by page, failing on any repeated, missing or extra row.
//   - 'windowed': read the range in date slices that each fit on ONE page, so
//     the Cloud never has to order rows across pages; slice totals must add up to
//     the overall total and no document may appear twice.
// Sales uses readInvoicesChecked: a tolerant page-by-page pass, then the count
// and duplicate checks, and the 'windowed' re-read when either check fails.
// These checks catch the repeated and missing rows seen on long ranges. None of
// them proves a consistent snapshot while invoices are added or deleted mid-read.
// Errors keep the original Price Check codes (PRICE_*) so existing callers and
```

(The two lines after it, about the Price Check page and `retryable` / `detail`, stay as they are.) Also change the comment's first line, `// Verified reading of an AutoCount Cloud invoice listing for one date range.`, to `// Checked reading of an AutoCount Cloud invoice listing for one date range.`

Add, just above `async function readInvoiceRange(`:

```js
// A page's own total: null when AutoCount sent none, else a non-negative safe
// integer. Any other value means the page cannot be read safely.
function pageTotal(payload) {
  const total = payload.totalCount;
  if (total === undefined || total === null) return null;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw sourceError('Cloud invoice totalCount is invalid', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  return total;
}

function hasRepeatedDocKey(rows) {
  const seen = new Set();
  for (const row of rows) {
    const docKey = readDocKey(row);
    if (docKey === null) continue;
    if (seen.has(docKey)) return true;
    seen.add(docKey);
  }
  return false;
}

// Sales' read. A tolerant pass page by page: a total that grows while the pages
// are read (an invoice saved meanwhile) and a listing without any total are
// both accepted. Then, if AutoCount reported a total, a count mismatch or a
// repeated document each triggers one re-read in date slices (readWindowed).
// `check` says which check the rows passed: 'count', 'slices', or 'none' when
// AutoCount gave no total and nothing could be checked.
async function readInvoicesChecked({ listPage, accountBookId, startDate, endDate, maxPages = 100, onRecheck } = {}) {
  if (typeof listPage !== 'function') {
    throw sourceError('invoice reader needs a listPage function', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
  }
  const rows = [];
  let latestTotal = null;
  let pageCount = 0;
  for (let page = 1; ; page += 1) {
    if (page > maxPages) {
      throw sourceError('Cloud invoice listing exceeded the page ceiling', 'PRICE_PAGE_INCOMPLETE', 'PricePageIncompleteError', {
        detail: { page, rowsRead: rows.length },
      });
    }
    const payload = await listPage({ page, startDate, endDate });
    pageCount += 1;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data)) {
      throw sourceError('Cloud invoice page is malformed', 'PRICE_SOURCE_INVALID', 'PriceSourceInvalidError');
    }
    const total = pageTotal(payload);
    rows.push(...payload.data);
    if (total !== null) latestTotal = total;
    if (payload.data.length === 0) break;
    if (total !== null && rows.length >= total) break;
    if (total === null) {
      const pageSize = firstPositiveInteger(payload.pageSize, payload.page_size, payload.limit);
      if (pageSize !== null && payload.data.length < pageSize) break;
    }
  }

  if (latestTotal === null) return { rows, pageCount, check: 'none', problem: null };

  let problem = null;
  if (rows.length !== latestTotal) problem = 'row count does not match totalCount';
  else if (hasRepeatedDocKey(rows)) problem = 'an invoice is listed twice';
  if (!problem) return { rows, pageCount, check: 'count', problem: null };

  if (typeof onRecheck === 'function') onRecheck(problem);
  const sliced = await readWindowed(listPage, accountBookId, startDate, endDate);
  return { rows: sliced.rows, pageCount: pageCount + sliced.pageCount, check: 'slices', problem };
}
```

In `module.exports`, add `readInvoicesChecked,` after `readInvoiceRange,`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/invoice-reader.test.mjs`
Expected: PASS, `ℹ fail 0`.

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/autocount/invoice-reader.js test/invoice-reader.test.mjs
git commit -m "feat: shared checked invoice read for Sales" -m "A count mismatch or a repeated document each triggers the slice re-read; a present but invalid totalCount makes the page malformed; the result names the check the rows passed." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sales dates through `lib/dates.js`

**Files:**
- Modify: `api/sales.js` (date check, `getLocalToday`, handler)
- Test: `api/sales.test.js`, `test/shared-helpers.test.mjs`

**Interfaces:**
- Consumes: `isIsoDate`, `todayIn` (Task 2).
- Produces: unchanged exports. `getLocalToday(timeZone, now)` keeps its behaviour. The handler answers 400 for an impossible date.

- [ ] **Step 1: Write the failing tests**

In `test/shared-helpers.test.mjs`, add `'api/sales.js',` as the first entry of `DATE_CHECK_FILES`.

Append to `api/sales.test.js`:

```js
function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

test('the sales API refuses an impossible calendar date before calling AutoCount', async () => {
  const handler = require('./sales.js');
  for (const query of [
    { startDate: '2026-02-31', endDate: '2026-03-01' },
    { startDate: '2026-02-01', endDate: '2026-02-30' },
  ]) {
    const res = responseRecorder();
    await handler({ method: 'GET', query }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.deepEqual(res.body, { success: false, error: 'startDate and endDate must be in YYYY-MM-DD format' });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test api/sales.test.js test/shared-helpers.test.mjs`
Expected: FAIL. The new Sales test gets status 502 instead of 400, because the regex-only check lets the date through and no credentials are set. The guard test fails on `api/sales.js` (`function isValidDate`; no `lib/dates` require).

- [ ] **Step 3: Implement**

In `api/sales.js`:
- Add `const { isIsoDate, todayIn } = require('../lib/dates');` after the `company-config` require.
- Delete `const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;` and the whole `isValidDate` function.
- Replace the whole `getLocalToday` function (including its doc comment) with:

```js
/**
 * Current date as YYYY-MM-DD in the reporting timezone.
 * Replaces `new Date().toISOString().slice(0, 10)`, which returns the UTC date.
 */
function getLocalToday(timeZone = getReportingTimeZone(), now = new Date()) {
  try {
    return todayIn(timeZone, now);
  } catch (error) {
    console.warn(`Invalid REPORT_TIMEZONE "${timeZone}", falling back to UTC:`, error.message);
  }
  return now.toISOString().slice(0, 10);
}
```

In the handler, replace `if (!isValidDate(startDate) || !isValidDate(endDate)) {` with `if (!isIsoDate(startDate) || !isIsoDate(endDate)) {`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test api/sales.test.js test/shared-helpers.test.mjs`
Expected: PASS, including all six `getLocalToday` tests.

- [ ] **Step 5: Commit**

```bash
git add api/sales.js api/sales.test.js test/shared-helpers.test.mjs
git commit -m "refactor: Sales checks dates with the shared calendar check" -m "The sales API now answers 400 to an impossible date such as 2026-02-31, as Dispatch already does." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Sales reads AutoCount through the shared client, reader and number rules

**Files:**
- Modify: `api/sales.js`
- Create: `test/fixtures/autocount-sales-raw-listing.json`, `test/fixtures/autocount-sales-raw-product.json`
- Test: `api/sales.test.js`

**Interfaces:**
- Consumes:
  - `AutoCountClient` (Task 6)
  - `readInvoicesChecked` (Task 7)
  - `decimalValue` and `firstNonZero` (Task 4)
- Produces:
  - `fetchAllInvoices(startDate, endDate, company, client = new AutoCountClient())`, which returns rows or `null`.
  - `loadCompanyInvoices(startDate, endDate, company, useMock, { client, getProduct })`.
  - All other exports are unchanged.

- [ ] **Step 1: Write the raw fixtures (invented data)**

Create `test/fixtures/autocount-sales-raw-listing.json`:

```json
{
  "data": [
    {
      "master": {
        "docKey": 9007199254740993,
        "docNo": "INV-TEST-0001",
        "docDate": "2026-09-24",
        "debtorCode": "C-TEST-001",
        "debtorName": "Sample Trading One",
        "finalTotal": 0,
        "total": 25.50,
        "outstandingAmount": null,
        "cancelled": false
      },
      "details": [
        { "productCode": "ITEM-A", "description": "Sample cooking oil 5KG", "qty": 3.000, "unit": "BOX", "unitPrice": 10.50, "subTotal": 31.50 },
        { "productCode": "ITEM-B", "description": "Sample discount", "qty": 1, "unit": "UNIT", "unitPrice": -6.00, "subTotal": -6.00 }
      ]
    },
    {
      "master": {
        "docKey": 1001,
        "docNo": "INV-TEST-0002",
        "docDate": "2026-09-24",
        "debtorCode": "C-TEST-002",
        "debtorName": "Sample Trading Two",
        "finalTotal": 999.99,
        "outstandingAmount": 999.99,
        "cancelled": 1
      },
      "details": [
        { "productCode": "ITEM-C", "description": "Sample flour 1KG", "qty": 9, "unit": "KG", "unitPrice": 111.11, "subTotal": 999.99 }
      ]
    },
    {
      "master": {
        "docKey": 9007199254740992,
        "docNo": "INV-TEST-0003",
        "docDate": "2026-09-24",
        "debtorCode": "C-TEST-002",
        "debtorName": "Sample Trading Two",
        "finalTotal": 110.00,
        "total": 110.00,
        "outstandingAmount": 40.00,
        "isCancelled": 0
      },
      "details": [
        { "productCode": "ITEM-A", "description": "Sample cooking oil 5KG", "qty": 4, "unit": "BTL", "unitPrice": 2.50, "subTotal": 10.00 },
        { "productCode": "ITEM-C", "description": "Sample flour 1KG", "qty": 2.5, "unit": "KG", "unitPrice": 40, "subTotal": 100.00 }
      ]
    }
  ],
  "totalCount": 3,
  "pageSize": 100
}
```

Create `test/fixtures/autocount-sales-raw-product.json`:

```json
{
  "product": { "productCode": "ITEM-A", "description": "Sample cooking oil 5KG", "unit": "BTL" },
  "productMultiPacks": [
    { "multiPack": "BOX", "multiPackRate": 4.00000000 }
  ]
}
```

Follow Task 1's probe. If the probe showed `docKey` only as `string`, write the three `docKey` values above as strings (`"9007199254740993"`, `"1001"`, `"9007199254740992"`). If it showed the cancelled flags only as `boolean`, change `"cancelled": 1` to `"cancelled": true` and `"isCancelled": 0` to `"isCancelled": false`. The expected results below stay the same either way.

- [ ] **Step 2: Write the failing tests**

At the top of `api/sales.test.js`, after the existing `require('./sales.js')` block, add:

```js
const fs = require('node:fs');
const path = require('node:path');
const { AutoCountClient } = require('../lib/autocount/client');

// Serves a fake's answers as JSON text through the real AutoCountClient, so the
// lossless parser and the shared reader run exactly as in production.
function clientOver(fake) {
  return new AutoCountClient({
    baseUrl: 'https://accounting-api.autocountcloud.com',
    http: {
      async get(url, options) {
        const response = await fake.get(url, options);
        return { status: response.status, data: JSON.stringify(response.data) };
      },
    },
  });
}
```

Replace the whole test "fetchAllInvoices continues pagination when AutoCount omits totalCount" with:

```js
test('fetchAllInvoices continues pagination when AutoCount omits totalCount', async () => {
  const pages = [
    { status: 200, data: { data: [{ id: 1 }, { id: 2 }] } },
    { status: 200, data: { data: [{ id: 3 }] } },
    { status: 200, data: { data: [] } },
  ];
  const calls = [];
  const company = {
    name: 'Wanson Sdn Bhd',
    accountBookId: '63688',
    apiUrl: 'https://accounting-api.autocountcloud.com/',
    apiKey: 'sdn-key',
    keyId: 'sdn-id',
  };
  const client = clientOver({
    get: async (url, options) => {
      calls.push({ url, options });
      return pages.shift();
    },
  });

  const result = await fetchAllInvoices('2026-09-01', '2026-09-01', company, client);

  // The lossless parser hands numbers over as their exact text.
  assert.deepEqual(result, [{ id: '1' }, { id: '2' }, { id: '3' }]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://accounting-api.autocountcloud.com/63688/invoice/listing');
  assert.deepEqual(calls[0].options.headers, {
    'API-Key': 'sdn-key',
    'Key-ID': 'sdn-id',
  });
  assert.deepEqual(calls.map(({ options }) => options.params.page), [1, 2, 3]);
});
```

In the two tests "loadCompanyInvoices converts multipack quantities using the AutoCount product master" and "loadCompanyInvoices still returns invoices when the product master is unavailable":
- Replace `const httpClient = { get: async () => rawPages.shift() || { status: 200, data: { data: [] } } };` with `const client = clientOver({ get: async () => rawPages.shift() || { status: 200, data: { data: [] } } });`.
- Replace `{ httpClient, getProduct },` with `{ client, getProduct },`.

In the slice tests at the end of the file, replace each use of a fake as the 4th argument with `clientOver(fake)`. Edit them exactly like this:

```js
test('fetchAllInvoices returns every invoice exactly once when AutoCount pages repeat invoices', async () => {
  const invoices = invoicesOverDays(MIXED_DAYS);
  assert.ok(invoices.length > 1000, 'fixture must span many pages');
  const fake = fakeAutoCount(invoices, { unstablePaging: true });

  const result = await fetchAllInvoices(sliceDay(0), sliceDay(90), SLICE_COMPANY, clientOver(fake));

  assert.ok(Array.isArray(result), 'a checked result, not null');
  assert.equal(result.length, invoices.length);
  assert.deepEqual(keysOf(result), keysOf(invoices));
  assert.ok(
    fake.calls.some((call) => call.startDate !== sliceDay(0) || call.endDate !== sliceDay(90)),
    'the range was re-read in narrower date slices',
  );
  assert.ok(fake.maxActive <= 3, `at most 3 requests at once, saw ${fake.maxActive}`);
});

test('fetchAllInvoices reads a stable AutoCount page by page and makes no extra requests', async () => {
  const invoices = invoicesOverDays(MIXED_DAYS);
  const fake = fakeAutoCount(invoices);

  const result = await fetchAllInvoices(sliceDay(0), sliceDay(90), SLICE_COMPANY, clientOver(fake));

  assert.deepEqual(keysOf(result), keysOf(invoices));
  const pages = Math.ceil(invoices.length / 100);
  assert.deepEqual(fake.calls.map((call) => call.page), Array.from({ length: pages }, (_, index) => index + 1));
  assert.ok(fake.calls.every((call) => call.startDate === sliceDay(0) && call.endDate === sliceDay(90)));
});

test('fetchAllInvoices does not accept a list whose rows do not add up to the reported total', async () => {
  const invoices = invoicesOverDays(MIXED_DAYS);
  // AutoCount reports N invoices but silently stops short of the last 5, on every kind of read.
  const fake = fakeAutoCount(invoices, { dropTrailingRows: 5 });

  const result = await fetchAllInvoices(sliceDay(0), sliceDay(90), SLICE_COMPANY, clientOver(fake));

  assert.equal(result, null, 'an unchecked result becomes "unavailable", never a wrong total');
});

test('fetchAllInvoices refuses date slices that do not add up to the overall total', async () => {
  const invoices = invoicesOverDays(MIXED_DAYS);
  const fake = fakeAutoCount(invoices, { unstablePaging: true, endExclusive: true });

  assert.equal(await fetchAllInvoices(sliceDay(0), sliceDay(90), SLICE_COMPANY, clientOver(fake)), null);
});

test('loadCompanyInvoices still reports the book unavailable when no checked list can be read', async () => {
  const invoices = invoicesOverDays(MIXED_DAYS);
  const fake = fakeAutoCount(invoices, { dropTrailingRows: 5 });

  const result = await loadCompanyInvoices(sliceDay(0), sliceDay(90), SLICE_COMPANY, false, {
    client: clientOver(fake),
    getProduct: async () => ({}),
  });

  assert.equal(result.status, 'error');
  assert.equal(result.error, 'AutoCount API unavailable');
  assert.deepEqual(result.invoices, []);
});

test('loadCompanyInvoices returns the full, checked list for a long range with unstable pages', async () => {
  const invoices = invoicesOverDays(MIXED_DAYS);
  const fake = fakeAutoCount(invoices, { unstablePaging: true });

  const result = await loadCompanyInvoices(sliceDay(0), sliceDay(90), SLICE_COMPANY, false, {
    client: clientOver(fake),
    getProduct: async () => ({}),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.invoices.length, invoices.length);
  assert.equal(new Set(result.invoices.map((invoice) => invoice.docNo)).size, invoices.length, 'no invoice counted twice');
});

test('fetchAllInvoices accepts a list when an invoice is saved while the pages are being read', async () => {
  const invoices = invoicesOverDays(MIXED_DAYS);
  const newest = invoices[invoices.length - 1];
  const extra = { ...newest, master: { ...newest.master, docKey: 'KEY-late', docNo: 'INV-late', docDate: sliceDay(90) } };
  const base = fakeAutoCount(invoices);
  let requests = 0;
  const fake = {
    calls: base.calls,
    async get(url, options) {
      requests += 1;
      // From the second request on, AutoCount also lists the newly saved invoice (last in order).
      if (requests === 2) invoices.push(extra);
      return base.get(url, options);
    },
  };

  const result = await fetchAllInvoices(sliceDay(0), sliceDay(90), SLICE_COMPANY, clientOver(fake));

  assert.ok(Array.isArray(result));
  assert.equal(result.length, invoices.length);
  assert.deepEqual(fake.calls.map((call) => call.page), fake.calls.map((_, index) => index + 1), 'no slice re-read was needed');
});
```

Append these new tests to `api/sales.test.js`:

```js
test('normalizeInvoices lets a zero amount given as text fall through to the next field, as a zero number did', () => {
  const [invoice] = normalizeInvoices([{
    master: { docNo: 'INV-T-1', finalTotal: '0', total: '25.50' },
    details: [{ productCode: 'A', qty: '0', quantity: '2', unitPrice: '0.00', subTotal: '0', total: '9.5' }],
  }]);

  assert.equal(invoice.grandTotal, 25.5);
  assert.deepEqual(invoice.lineItems[0], { sku: 'A', description: '', quantity: 2, unitPrice: 0, total: 9.5 });
});

test('normalizeInvoices treats a cancelled flag whose value is 1 as cancelled, in any spelling', () => {
  const kept = normalizeInvoices([
    { master: { docNo: 'A', cancelled: '1.0' }, details: [] },
    { master: { docNo: 'B', isCancelled: 1 }, details: [] },
    { master: { docNo: 'C', cancelled: true }, details: [] },
    { master: { docNo: 'D', cancelled: '0' }, details: [] },
    { master: { docNo: 'E', cancelled: false }, details: [] },
    { master: { docNo: 'F' }, details: [] },
  ]);

  assert.deepEqual(kept.map((invoice) => invoice.docNo), ['D', 'E', 'F']);
});

const RAW_LISTING = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'autocount-sales-raw-listing.json'), 'utf8');
const RAW_PRODUCT = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'autocount-sales-raw-product.json'), 'utf8');

// A client over raw AutoCount JSON text, so the real lossless parser runs.
function rawClient() {
  const calls = [];
  const client = new AutoCountClient({
    baseUrl: 'https://accounting-api.autocountcloud.com',
    http: {
      async get(url, options) {
        calls.push({ url, params: options.params });
        if (url.endsWith('/invoice/listing')) {
          return { status: 200, data: options.params.page === 1 ? RAW_LISTING : '{"data":[],"totalCount":3}' };
        }
        if (url.endsWith('/product')) return { status: 200, data: RAW_PRODUCT };
        return { status: 404, data: '{}' };
      },
    },
  });
  client.calls = calls;
  return client;
}

test('raw AutoCount JSON goes through the real client parser into the expected dashboard totals', async () => {
  const client = rawClient();
  const [enterprise] = getCompanyConfigs({ AUTOCOUNT_ENTERPRISE_API_KEY: 'k', AUTOCOUNT_ENTERPRISE_KEY_ID: 'i' });

  const loaded = await loadCompanyInvoices('2026-09-24', '2026-09-24', enterprise, false, { client });
  const result = combineCompanyResults([loaded], '2026-09-24', '2026-09-24', '2026-09-24T00:00:00.000Z');

  // One listing page: document keys beyond 2^53 stay distinct as exact text, so
  // they are not mistaken for repeats and no slice re-read happens.
  assert.deepEqual(client.calls.map((call) => call.url.split('/').pop()), ['listing', 'product']);
  assert.deepEqual(client.calls[1].params, { code: 'ITEM-A' });

  const company = { companyId: 'enterprise', companyName: 'Wanson Enterprise' };
  assert.equal(result.complete, true);
  assert.equal(result.dataSource, 'live');
  assert.deepEqual(result.kpis, {
    totalRevenue: 135.5,
    totalInvoices: 2,
    totalItemsSold: 19.5,
    avgOrderValue: 67.75,
    topCustomer: { name: 'Sample Trading Two', revenue: 110, ...company },
  });
  assert.deepEqual(result.skuBreakdown, [
    {
      sku: 'ITEM-C', description: 'Sample flour 1KG', totalRevenue: 100, totalUnits: 2.5, orderCount: 1, totalCost: 100,
      ...company, unit: 'KG', avgPricePerUnit: 40,
      customers: [{ name: 'Sample Trading Two', quantity: 2.5, ...company }],
    },
    {
      sku: 'ITEM-A', description: 'Sample cooking oil 5KG', totalRevenue: 41.5, totalUnits: 16, orderCount: 2, totalCost: 41.5,
      ...company, unit: 'BTL', avgPricePerUnit: 2.59,
      customers: [{ name: 'Sample Trading One', quantity: 12, ...company }, { name: 'Sample Trading Two', quantity: 4, ...company }],
    },
    {
      sku: 'ITEM-B', description: 'Sample discount', totalRevenue: -6, totalUnits: 1, orderCount: 1, totalCost: -6,
      ...company, unit: 'UNIT', avgPricePerUnit: -6,
      customers: [{ name: 'Sample Trading One', quantity: 1, ...company }],
    },
  ]);
  assert.deepEqual(result.invoices, [
    {
      docNo: 'INV-TEST-0001', docDate: '2026-09-24', customerName: 'Sample Trading One', grandTotal: 25.5,
      outstandingAmount: null, paymentStatus: 'unknown', ...company, accountBookId: '63750',
      lineItems: [
        { sku: 'ITEM-A', description: 'Sample cooking oil 5KG', quantity: 3, unit: 'BOX', unitPrice: 10.5, total: 31.5 },
        { sku: 'ITEM-B', description: 'Sample discount', quantity: 1, unit: 'UNIT', unitPrice: -6, total: -6 },
      ],
    },
    {
      docNo: 'INV-TEST-0003', docDate: '2026-09-24', customerName: 'Sample Trading Two', grandTotal: 110,
      outstandingAmount: 40, paymentStatus: 'partial', ...company, accountBookId: '63750',
      lineItems: [
        { sku: 'ITEM-A', description: 'Sample cooking oil 5KG', quantity: 4, unit: 'BTL', unitPrice: 2.5, total: 10 },
        { sku: 'ITEM-C', description: 'Sample flour 1KG', quantity: 2.5, unit: 'KG', unitPrice: 40, total: 100 },
      ],
    },
  ]);
  assert.deepEqual(result.paymentSummary, {
    paid: { count: 0, total: 0 },
    partial: { count: 1, outstanding: 40 },
    unpaid: { count: 0, total: 0 },
    unknown: { count: 1, total: 25.5 },
    stillUnpaidTotal: 40,
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test api/sales.test.js`
Expected: FAIL in these tests:
- the rewritten `fetchAllInvoices` / `loadCompanyInvoices` tests: the old code calls `client.get`, which an `AutoCountClient` does not have, so they return `null`
- the "zero amount given as text" test: `grandTotal` is 0
- the "cancelled flag" test: `A` is kept
- the raw-fixture test

- [ ] **Step 4: Implement**

In `api/sales.js`, replace every `require` line above the `// Vercel dev does not consistently inject` comment with the lines below. That includes the old `axios` and `{ readDocKey, readInvoiceRange }` requires, which go.

```js
const fs = require('fs');
const path = require('path');
const { AutoCountClient } = require('../lib/autocount/client');
const { readCompanySettings } = require('../lib/autocount/company-config');
const { readInvoicesChecked } = require('../lib/autocount/invoice-reader');
const { decimalValue, firstNonZero } = require('../lib/autocount/numbers');
const { isIsoDate, todayIn } = require('../lib/dates');
```

(Keep the two `dotenv` lines and their comment right after it.)

Delete these, whole: `const DEFAULT_API_URL = …;`, `getHeaders`, `listingProblem` with its comment block, and `readInvoicesInDateSlices` with its comment.

Replace the whole `fetchAllInvoices` function with:

```js
async function fetchAllInvoices(startDate, endDate, company, client = new AutoCountClient()) {
  if (!company?.accountBookId || !company?.apiKey || !company?.keyId) {
    console.error(`Missing AutoCount credentials for ${company?.name || 'unknown company'}`);
    return null;
  }

  try {
    const { rows, check } = await readInvoicesChecked({
      listPage: (params) => client.listInvoicePage(company, params),
      accountBookId: company.accountBookId,
      startDate,
      endDate,
      onRecheck: (problem) => console.error(
        `AutoCount ${company.name} listing for ${startDate} to ${endDate} cannot be trusted (${problem}); re-reading in date slices`,
      ),
    });
    if (check === 'slices') {
      console.log(`Fetched ${rows.length} invoices for ${startDate} to ${endDate} (checked in date slices)`);
    } else if (check === 'none') {
      console.log(`Fetched ${rows.length} invoices for ${startDate} to ${endDate} (no total count from AutoCount, so the list was not checked)`);
    } else {
      console.log(`Fetched ${rows.length} invoices for ${startDate} to ${endDate}`);
    }
    return rows;
  } catch (error) {
    console.error('AutoCount API error:', error.message);
    return null;
  }
}
```

Replace the whole `isCancelledInvoice` function with:

```js
// Cancelled when AutoCount says true, or a flag whose value is exactly 1 (the
// client hands a numeric 1 over as text such as "1" or "1.0").
function isCancelledInvoice(master) {
  const cancellationState = master.cancelled ?? master.isCancelled;
  return cancellationState === true || decimalValue(cancellationState) === 1;
}
```

In `normalizeInvoices`, replace the `grandTotal:` line with:

```js
      grandTotal: Math.round(firstNonZero(master.finalTotal, master.total, master.grandTotal) * 100) / 100,
```

and replace the returned line object with:

```js
        return {
          sku: d.productCode || d.sku || '',
          description: d.description || '',
          quantity: firstNonZero(d.qty, d.quantity),
          ...(unit ? { unit } : {}),
          unitPrice: firstNonZero(d.unitPrice),
          total: firstNonZero(d.subTotal, d.total),
        };
```

In `loadCompanyInvoices`, replace from `try {` through the `const getProduct = …;` statement with:

```js
  try {
    const client = dependencies.client || new AutoCountClient();
    const rawInvoices = useMock
      ? loadMockData(company)
      : await fetchAllInvoices(startDate, endDate, company, client);
    if (!rawInvoices) {
      return {
        company,
        status: 'error',
        error: 'AutoCount API unavailable',
        invoices: [],
      };
    }

    let invoices = normalizeInvoices(rawInvoices, company);
    if (!useMock) {
      try {
        const getProduct = dependencies.getProduct || ((itemCode) => client.getProduct(company, itemCode));
```

(The rest of `loadCompanyInvoices` is unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test api/sales.test.js`
Expected: PASS, `ℹ fail 0`.

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`.

Run: `grep -n -E "axios|DEFAULT_API_URL|listingProblem|readInvoicesInDateSlices|getHeaders" api/sales.js`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add api/sales.js api/sales.test.js test/fixtures/autocount-sales-raw-listing.json test/fixtures/autocount-sales-raw-product.json
git commit -m "refactor: Sales reads AutoCount through the shared client and checked reader" -m "Numbers arrive as exact text and are read with the first-non-zero rule, so a zero still falls through to the next field; document keys are compared exactly; the log says 'checked in date slices'." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs: `.env.example`, README, `agents.md`

**Files:**
- Modify: `.env.example` (lines 1-24), `README.md`, `agents.md`
- Test: `api/dispatch-invoices.test.js` (the `.env.example` test)

**Interfaces:**
- Consumes: the rules from Tasks 5-9.
- Produces: docs that match the code.

- [ ] **Step 1: Write the failing test**

In `api/dispatch-invoices.test.js`, replace the whole test "env example keeps legacy Sales variables alongside dispatch variables" with:

```js
test('env example documents the one rule set for both books', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');

  for (const name of [
    'AUTOCOUNT_API_URL', 'AUTOCOUNT_ENTERPRISE_API_URL', 'AUTOCOUNT_SDN_BHD_API_URL',
    'AUTOCOUNT_ENTERPRISE_API_KEY', 'AUTOCOUNT_ENTERPRISE_KEY_ID', 'AUTOCOUNT_SDN_BHD_API_KEY', 'AUTOCOUNT_SDN_BHD_KEY_ID',
    'AUTOCOUNT_API_KEY_WANSON_ENTERPRISE', 'AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE',
    'AUTOCOUNT_API_KEY_WANSON_SDN_BHD', 'AUTOCOUNT_KEY_ID_WANSON_SDN_BHD',
    'AUTOCOUNT_API_KEY', 'AUTOCOUNT_KEY_ID', 'AUTOCOUNT_API_KEY_ID',
  ]) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'), name);
  }
  assert.match(envExample, /^AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE=63750$/m);
  assert.match(envExample, /^AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD=63688$/m);
  assert.doesNotMatch(envExample, /^AUTOCOUNT_ACCOUNT_BOOK_ID=/m);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test api/dispatch-invoices.test.js`
Expected: FAIL on `AUTOCOUNT_ENTERPRISE_API_URL`.

- [ ] **Step 3: Rewrite the AutoCount block of `.env.example`**

Replace lines 1-24 (from `# AutoCount Cloud API Credentials (server-side only)` through `AUTOCOUNT_ACCOUNT_BOOK_ID=`) with:

```
# AutoCount Cloud API (server-side only). Sales, Dispatch and Price Check read
# these settings the same way (lib/autocount/company-config.js). The two books
# are fixed in code: Wanson Enterprise 63750 and Wanson Sdn Bhd 63688.
AUTOCOUNT_API_URL=https://accounting-api.autocountcloud.com
# Optional per-book address. Leave blank to use AUTOCOUNT_API_URL.
AUTOCOUNT_ENTERPRISE_API_URL=
AUTOCOUNT_SDN_BHD_API_URL=

# Each book uses its own credential pair; never reuse Enterprise credentials
# for Sdn Bhd. These names are read first...
AUTOCOUNT_ENTERPRISE_API_KEY=your-enterprise-api-key-here
AUTOCOUNT_ENTERPRISE_KEY_ID=your-enterprise-key-id-here
AUTOCOUNT_SDN_BHD_API_KEY=your-sdn-bhd-api-key-here
AUTOCOUNT_SDN_BHD_KEY_ID=your-sdn-bhd-key-id-here

# ...then these aliases. A key and its ID may come from either style, but a book
# with only one half of its pair is refused. Leave blank unless used.
AUTOCOUNT_API_KEY_WANSON_ENTERPRISE=
AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE=
AUTOCOUNT_API_KEY_WANSON_SDN_BHD=
AUTOCOUNT_KEY_ID_WANSON_SDN_BHD=

# Optional double-check. When set, each must equal its fixed book number or that
# book is refused; nothing else can choose a book.
AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE=63750
AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD=63688

# Old shared pair: Enterprise only, and only when none of its own names is set.
# AUTOCOUNT_KEY_ID is read before AUTOCOUNT_API_KEY_ID. Sdn Bhd never uses it.
AUTOCOUNT_API_KEY=
AUTOCOUNT_KEY_ID=
AUTOCOUNT_API_KEY_ID=
```

- [ ] **Step 4: Update the README**

In `README.md`, after the paragraph that starts "The old single-book `AUTOCOUNT_COMPANY_ID` setting does not select a book", add:

```markdown
#### Company settings

Sales, Dispatch and Price Check read the AutoCount settings with one rule set (`lib/autocount/company-config.js`):

- The two books are fixed in code (Enterprise `63750`, Sdn Bhd `63688`). `AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE` / `AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD` are optional; if set, they must equal those numbers or that book is refused.
- Each book's API key and key ID come from its own names first (`AUTOCOUNT_ENTERPRISE_*`, `AUTOCOUNT_SDN_BHD_*`), then the aliases (`AUTOCOUNT_API_KEY_WANSON_*`, `AUTOCOUNT_KEY_ID_WANSON_*`). A book with only half a pair is refused.
- Only Enterprise may fall back to the old shared pair (`AUTOCOUNT_API_KEY` with `AUTOCOUNT_KEY_ID` or `AUTOCOUNT_API_KEY_ID`), and only when none of its own names is set. Sdn Bhd never does.
- The address is `AUTOCOUNT_ENTERPRISE_API_URL` / `AUTOCOUNT_SDN_BHD_API_URL`, then `AUTOCOUNT_API_URL`, then AutoCount's standard address.
- Values are trimmed; a blank value counts as unset. Error messages name settings, never their values.
```

Replace the heading `### Verified invoice reads` and its paragraph with:

```markdown
### Checked invoice reads

AutoCount's invoice listing pages can repeat invoices on large date ranges, which also pushes other invoices out of the list. On a live 91-day range the Sales dashboard once received 9 invoices twice and missed 9 others, so revenue was about 1.3% off with no error. `lib/autocount/invoice-reader.js` holds every checked read: Sales uses `readInvoicesChecked`, Price Check its stricter paged-then-sliced flow. When AutoCount reports a `totalCount`, the rows must equal it with no invoice repeated. A count mismatch or a repeated invoice triggers a re-read in date slices that each fit on one page (at most 3 requests at once, 250 in total). If that re-read fails too, Sales shows that company as unavailable and Price Check fails that book, instead of showing wrong numbers. These checks catch repeated and missing rows; they cannot prove a consistent snapshot while invoices are being added or deleted during the read. A listing without any `totalCount` cannot be checked: Sales still shows it and logs it as unchecked. Ranges up to 30 days were consistent when checked, so normal use reads page by page exactly as before.
```

In the "Unstable Cloud lists" bullet of "On-demand price check", replace `Both reads must prove completeness:` with `Both reads must pass the same checks:`.

- [ ] **Step 5: Update `agents.md`**

Replace line 18:

```markdown
- **AutoCount access:** `axios` + `lossless-json` through `lib/autocount/client.js`.
```

with:

```markdown
- **AutoCount access:** `axios` + `lossless-json` through `lib/autocount/client.js`, for Sales, Dispatch and Price Check alike. Company books, key names and addresses come only from `lib/autocount/company-config.js`. The client hands numeric tokens over as exact text, so read AutoCount numbers only through `lib/autocount/numbers.js` (never rely on truthiness: `"0"` is truthy).
```

Replace the bullet that starts `- Invoice reads are verified` (line 53) with:

```markdown
- Invoice reads are checked (`readInvoicesChecked` in `lib/autocount/invoice-reader.js`, next to Price Check's flow). AutoCount's page-by-page listing can repeat invoices on large ranges (live, 91 days: 9 invoices twice, 9 missing, revenue about 1.3% off, no error). After the normal read, the rows must equal AutoCount's latest `totalCount` with no repeated `docKey`; a count mismatch or a repeated document triggers a re-read in date slices, and if that re-read fails too, `fetchAllInvoices` returns `null` (the book shows as unavailable) rather than wrong totals. A `totalCount` that is present but not a non-negative safe integer fails the book. These checks catch repeated and missing rows; they cannot prove a consistent snapshot while invoices change during the read. Never loosen this check to make a range load.
```

In line 62, replace `Both reads must prove completeness (no document twice, slice totals equal to the overall total).` with `Both reads must pass the completeness checks (no document twice, slice totals equal to the overall total).`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add .env.example README.md agents.md api/dispatch-invoices.test.js
git commit -m "docs: describe the one AutoCount settings rule set and the read checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification and the old-versus-new replay check

**Files:**
- Create: `$SCRATCH/replay/replay-compare.js`, `$SCRATCH/replay/replay-child.js` (scratch, not committed)

**Interfaces:**
- Consumes: the finished branch; Task 1's baselines.
- Produces: the verification summary that goes into the PR description (Task 12).

- [ ] **Step 1: Unit tests**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ fail 0`, `ℹ skipped 1`. `pass` is Task 1's 407 plus the new tests.

- [ ] **Step 2: Playwright, one spec at a time**

Run the four commands from Task 1, Step 3.
Expected: the same results as the Task 1 baseline.

- [ ] **Step 3: Confirm a clean, committed tree**

Run: `git status --short`
Expected: no output. The replay check refuses to run on a dirty tree.

- [ ] **Step 4: Write the parent script**

Create `$SCRATCH/replay/replay-compare.js`:

```js
'use strict';

// Old-versus-new replay check. Old = the branch's base commit, new = its HEAD.
// Each version runs in its own process. AutoCount responses are recorded once,
// live and read-only, from the old run, kept in this process's memory, and
// replayed byte for byte to the new run over IPC. Prints only "identical" or
// differing JSON paths, never values. Writes nothing but the two git exports,
// which are removed at the end.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, fork } = require('node:child_process');
const { createRequire } = require('node:module');

const MAIN = 'D:/autocount-pwa-dashboard';
const WORKTREE = 'D:/autocount-pwa-dashboard/.claude/worktrees/autocount-shared-layer';
const TAR = 'C:\\Windows\\System32\\tar.exe';
const HERE = __dirname;
const requireFromMain = createRequire(path.join(MAIN, 'package.json'));
const axios = requireFromMain('axios');
const dotenv = requireFromMain('dotenv');

const git = (...args) => execFileSync('git', ['-C', WORKTREE, ...args], { encoding: 'utf8' }).trim();
const win = (p) => p.replace(/\//g, '\\');

function malaysiaToday(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shiftDays(isoDate, delta) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

// Remove the node_modules junction first (never recurse through it), then the copy.
function removeExport(target) {
  const link = path.join(target, 'node_modules');
  if (fs.existsSync(link)) execFileSync('cmd', ['/c', 'rmdir', win(link)]);
  fs.rmSync(target, { recursive: true, force: true });
}

function exportCommit(label, sha) {
  const target = path.join(HERE, label);
  const tarFile = path.join(HERE, `${label}.tar`);
  removeExport(target);
  fs.mkdirSync(target, { recursive: true });
  execFileSync('git', ['-C', WORKTREE, 'archive', '--format=tar', '-o', tarFile, sha]);
  execFileSync(TAR, ['-xf', win(tarFile), '-C', win(target)]);
  fs.rmSync(tarFile);
  execFileSync('cmd', ['/c', 'mklink', '/J', win(path.join(target, 'node_modules')), win(path.join(MAIN, 'node_modules'))]);
  return target;
}

function requestKey({ url, params }) {
  const query = new URLSearchParams(
    Object.entries(params || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => [name, String(value)]),
  ).toString();
  return `${url}?${query}`;
}

function requestKind(url) {
  if (url.endsWith('/invoice/listing')) return 'listing';
  if (url.endsWith('/product')) return 'product';
  if (url.endsWith('/companyProfile')) return 'profile';
  return 'other';
}

async function liveRequest({ url, params, headers }) {
  const response = await axios.get(url, {
    params,
    headers,
    timeout: 15000,
    transformResponse: [(data) => data],
    validateStatus: () => true,
  });
  return { status: response.status, contentType: String(response.headers['content-type'] || ''), body: response.data };
}

function diffPaths(left, right, at = '$', out = []) {
  if (Object.is(left, right)) return out;
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (kind(left) !== kind(right)) {
    out.push(`${at} (type ${kind(left)} vs ${kind(right)})`);
    return out;
  }
  if (kind(left) === 'array') {
    if (left.length !== right.length) out.push(`${at} (length)`);
    for (let i = 0; i < Math.min(left.length, right.length); i += 1) diffPaths(left[i], right[i], `${at}[${i}]`, out);
    return out;
  }
  if (kind(left) === 'object') {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (!(key in left) || !(key in right)) out.push(`${at}.${key} (on one side only)`);
      else diffPaths(left[key], right[key], `${at}.${key}`, out);
    }
    return out;
  }
  out.push(at);
  return out;
}

function runChild({ label, dir, env, mode, recording, cases, nowIso }) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(HERE, 'replay-child.js'), [dir, mode], { env, silent: true });
    child.stdout.resume();
    child.stderr.resume();
    const results = {};
    const misses = new Map();
    let finished = false;
    child.on('message', async (message) => {
      if (message.type === 'http') {
        const key = requestKey(message.request);
        let pending;
        if (mode === 'record') {
          if (!recording.has(key)) recording.set(key, liveRequest(message.request));
          pending = recording.get(key);
        } else {
          pending = recording.get(key);
          if (!pending) {
            const kind = requestKind(message.request.url);
            misses.set(kind, (misses.get(kind) || 0) + 1);
            child.send({ type: 'http-error', id: message.id, message: 'not in the recording' });
            return;
          }
        }
        try {
          child.send({ type: 'http-result', id: message.id, ...(await pending) });
        } catch (error) {
          child.send({ type: 'http-error', id: message.id, message: error.code || 'request failed' });
        }
      } else if (message.type === 'result') {
        results[message.name] = message.value;
      } else if (message.type === 'done') {
        finished = true;
        resolve({ results, misses });
      } else if (message.type === 'crash') {
        finished = true;
        reject(new Error(`${label} child crashed (${message.error.name || 'Error'}${message.error.code ? ` ${message.error.code}` : ''})`));
      }
    });
    child.on('exit', (code) => {
      if (!finished) reject(new Error(`${label} child exited with code ${code} before finishing`));
    });
    child.send({ type: 'run', cases, nowIso });
  });
}

(async () => {
  if (git('status', '--porcelain')) throw new Error('the worktree has uncommitted changes; commit them first');
  const newSha = git('rev-parse', 'HEAD');
  const oldSha = git('merge-base', 'HEAD', 'origin/main');

  const local = dotenv.parse(fs.readFileSync(path.join(MAIN, '.env.local')));
  const baseEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^(AUTOCOUNT_|DISPATCH_|DATABASE_URL|TEST_DATABASE_URL|USE_MOCK_DATA|REPORT_TIMEZONE)/.test(name)));
  const autocount = Object.fromEntries(Object.entries(local).filter(([name]) => name.startsWith('AUTOCOUNT_')));
  const newEnv = { ...baseEnv, ...autocount, USE_MOCK_DATA: 'false', REPORT_TIMEZONE: 'Asia/Kuala_Lumpur' };
  const oldEnv = { ...newEnv, AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: '63750', AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: '63688' };

  const nowIso = new Date().toISOString();
  const today = malaysiaToday(new Date(nowIso));
  const cases = [
    { kind: 'sales', name: 'sales today', startDate: today, endDate: today },
    { kind: 'sales', name: 'sales last 30 days', startDate: shiftDays(today, -29), endDate: today },
    { kind: 'sales', name: 'sales last 91 days', startDate: shiftDays(today, -90), endDate: today },
    { kind: 'priceCheck', name: 'price check today', range: 'today' },
    { kind: 'priceCheck', name: 'price check 7 days', range: 'seven_days' },
    { kind: 'dispatch', name: 'dispatch invoices today', startDate: today, endDate: today },
  ];

  console.log(`old ${oldSha.slice(0, 7)}  new ${newSha.slice(0, 7)}  clock ${nowIso}  today ${today}`);
  const oldDir = exportCommit('old', oldSha);
  const newDir = exportCommit('new', newSha);
  const recording = new Map();
  try {
    const before = await runChild({ label: 'old', dir: oldDir, env: oldEnv, mode: 'record', recording, cases, nowIso });
    const after = await runChild({ label: 'new', dir: newDir, env: newEnv, mode: 'replay', recording, cases, nowIso });
    let differences = 0;
    for (const testCase of cases) {
      const paths = diffPaths(before.results[testCase.name], after.results[testCase.name]);
      differences += paths.length;
      console.log(`${testCase.name}: ${paths.length === 0 ? 'identical' : `${paths.length} difference(s)`}`);
      paths.slice(0, 20).forEach((p) => console.log(`  ${p}`));
    }
    const misses = [...after.misses].map(([kind, count]) => `${kind} ${count}`);
    console.log(`requests the new side made that the old side did not: ${misses.length ? misses.join(', ') : 'none'}`);
    console.log(`replay verdict: ${differences === 0 && misses.length === 0 ? 'IDENTICAL for the recorded cases' : 'DIFFERENT, do not open the PR'}`);

    const live = await runChild({ label: 'live', dir: newDir, env: newEnv, mode: 'live', recording: null, cases, nowIso });
    for (const testCase of cases) {
      const outcome = live.results[testCase.name] || {};
      const checks = outcome.checks ? ` (checks: ${outcome.checks.join(', ')})` : '';
      console.log(`live ${testCase.name}: ${outcome.ok ? 'ok' : `failed (status ${outcome.status ?? outcome.threw})`}${checks}`);
    }
  } finally {
    removeExport(oldDir);
    removeExport(newDir);
  }
})().catch((error) => {
  console.error(`replay check failed: ${error.message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Write the child script**

Create `$SCRATCH/replay/replay-child.js`:

```js
'use strict';

// One version of the app, run against recorded (or, in live mode, real)
// AutoCount responses. Talks to the parent over IPC only; prints nothing.

const path = require('node:path');
const { createRequire } = require('node:module');

const [dir, mode] = process.argv.slice(2);
// Resolve modules exactly as the copy's own code does, so the axios instance
// that gets the adapter is the one the copy uses.
const copyRequire = createRequire(path.join(dir, 'api', 'sales.js'));
const axios = copyRequire('axios');

let nextId = 0;
const pending = new Map();

function plainHeaders(headers) {
  const all = typeof headers?.toJSON === 'function' ? headers.toJSON() : { ...headers };
  const picked = {};
  for (const [name, value] of Object.entries(all)) {
    if (/^(api-key|key-id|content-type)$/i.test(name) && value !== undefined && value !== null) picked[name] = String(value);
  }
  return picked;
}

// Every AutoCount request goes to the parent, which answers from the live
// service (record) or the recording (replay). validateStatus is applied here,
// as axios's own adapters do.
function parentAdapter(config) {
  return new Promise((resolve, reject) => {
    nextId += 1;
    const id = nextId;
    pending.set(id, (reply) => {
      if (reply.type === 'http-error') {
        reject(new axios.AxiosError(reply.message, 'ERR_REPLAY', config));
        return;
      }
      const response = {
        data: reply.body,
        status: reply.status,
        statusText: '',
        headers: new axios.AxiosHeaders({ 'content-type': reply.contentType }),
        config,
        request: {},
      };
      const validate = config.validateStatus;
      if (!validate || validate(response.status)) resolve(response);
      else {
        const code = response.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
        reject(new axios.AxiosError(`Request failed with status code ${response.status}`, code, config, response.request, response));
      }
    });
    process.send({ type: 'http', id, request: { url: config.url, params: config.params || {}, headers: plainHeaders(config.headers) } });
  });
}

function recorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

async function run({ cases, nowIso }) {
  if (mode !== 'live') axios.defaults.adapter = parentAdapter;

  // Live mode records which check each Sales book passed. The wrapper must be in
  // place before api/sales.js is loaded, because Sales takes the function at load.
  const checks = [];
  if (mode === 'live') {
    const reader = copyRequire('../lib/autocount/invoice-reader.js');
    const original = reader.readInvoicesChecked;
    if (typeof original === 'function') {
      reader.readInvoicesChecked = async (options) => {
        const result = await original(options);
        checks.push(`${options.accountBookId}:${result.check}`);
        return result;
      };
    }
  }

  const salesHandler = copyRequire('./sales.js');
  const { createPriceCheckHandler } = copyRequire('./price-check.js');
  const { createDispatchInvoicesHandler } = copyRequire('./dispatch-invoices.js');
  const quiet = { error() {}, warn() {}, log() {} };
  const session = { clerkId: 'replay-check', role: 'clerk' };

  for (const testCase of cases) {
    const res = recorder();
    checks.length = 0;
    try {
      if (testCase.kind === 'sales') {
        await salesHandler({ method: 'GET', query: { startDate: testCase.startDate, endDate: testCase.endDate } }, res);
        if (res.body) delete res.body.timestamp;
      } else if (testCase.kind === 'priceCheck') {
        const handler = createPriceCheckHandler({
          auth: { verifySessionCookie: async () => session },
          now: new Date(nowIso),
          logger: quiet,
        });
        await handler({ method: 'GET', headers: { cookie: 'dispatch_session=replay' }, query: { range: testCase.range } }, res);
      } else {
        const handler = createDispatchInvoicesHandler({ getSession: async () => session, logger: quiet });
        await handler({ method: 'GET', query: { startDate: testCase.startDate, endDate: testCase.endDate, company: 'all' } }, res);
      }
      const value = mode === 'live'
        ? { ok: res.statusCode === 200, status: res.statusCode, checks: testCase.kind === 'sales' ? [...checks].sort() : undefined }
        : { status: res.statusCode, body: res.body };
      process.send({ type: 'result', name: testCase.name, value });
    } catch (error) {
      process.send({ type: 'result', name: testCase.name, value: { threw: error?.name || 'Error' } });
    }
  }
}

process.on('message', (message) => {
  if (message.type === 'http-result' || message.type === 'http-error') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (waiter) waiter(message);
  } else if (message.type === 'run') {
    run(message).then(
      () => process.send({ type: 'done' }, () => process.exit(0)),
      (error) => process.send({ type: 'crash', error: { name: error?.name, code: error?.code } }, () => process.exit(1)),
    );
  }
});
```

- [ ] **Step 6: Run the replay check**

Run: `node "$SCRATCH/replay/replay-compare.js"`

Expected, in this order:
- the pinned commits line
- six lines, each `<case>: identical`
- `requests the new side made that the old side did not: none`
- `replay verdict: IDENTICAL for the recorded cases`
- six `live <case>: ok` lines. The Sales ones show checks such as `63688:count, 63750:count`; `slices` is also fine for a long range.

It takes a few minutes, because Price Check reads 91 and 97 days for both books.

- [ ] **Step 7: Act on the result**

- If the verdict is `DIFFERENT`, or any live case failed or shows `none`: stop. Do not open the PR. Investigate with superpowers:systematic-debugging, fix in a new commit with a test, and repeat Steps 1-6.
- If it is identical: copy the printed lines (they contain no values) into `$SCRATCH/pr-body.md` for Task 12.

No commit: nothing in the repo changed.

---

### Task 12: Release gate, push and draft PR

**Files:**
- Create: `$SCRATCH/pr-body.md` (scratch)

**Interfaces:**
- Consumes: Task 11's summary; the owner's list of Vercel setting names.
- Produces: a pushed branch and a draft PR into `main`.

- [ ] **Step 1: Get the Vercel setting names (names only)**

Ask the owner for the names of the `AUTOCOUNT_*` settings in Vercel Production and in Preview. They can copy them from Vercel → Project → Settings → Environment Variables, or run `npx vercel env ls` in their own terminal. Alternatively, ask them to sign the Vercel connector in to the "wanson" team, then list names with `filter_project_envs`, reporting names only and never values. Never ask for values.

- [ ] **Step 2: Apply the release gate**

For Production and Preview separately, check the names against this table. A book's own names are the four in `lib/autocount/company-config.js`: both styles, key and ID.

| What the names show | What changes after merging | Action |
| --- | --- | --- |
| Both own-name styles set for the same field of a book (e.g. `AUTOCOUNT_ENTERPRISE_API_KEY` and `AUTOCOUNT_API_KEY_WANSON_ENTERPRISE`) | Dispatch and Price Check switch to the first style | Owner confirms the two values are equal, or removes one |
| Enterprise has none of its own names, and `AUTOCOUNT_API_KEY` is set with `AUTOCOUNT_KEY_ID` or `AUTOCOUNT_API_KEY_ID` | Nothing; a valid Enterprise fallback | None |
| Enterprise uses the shared pair (row above), and both `AUTOCOUNT_KEY_ID` and `AUTOCOUNT_API_KEY_ID` are set | Dispatch and Price Check switch from `AUTOCOUNT_API_KEY_ID` to `AUTOCOUNT_KEY_ID` | Owner confirms they are equal, or removes one |
| A book has only half of its own pair | That book is misconfigured on every surface | Stop: owner sets the missing half first |
| Sdn Bhd has none of its own names | Sdn Bhd is misconfigured on every surface | Stop: owner sets Sdn Bhd's own pair first |
| Enterprise has none of its own names, and the shared pair is incomplete or missing | Already misconfigured; unchanged | Stop: owner fixes the settings first |
| `AUTOCOUNT_ENTERPRISE_API_URL` or `AUTOCOUNT_SDN_BHD_API_URL` set | Dispatch and Price Check start using it | Owner confirms it is the normal AutoCount address, or removes it |
| `AUTOCOUNT_ACCOUNT_BOOK_WANSON_*` set | A value other than 63750 / 63688 refuses that book | Owner confirms the values |

Do not continue until every flagged row is resolved. Record the outcome by name only, for example "Production: own names only, no aliases, no per-company address".

- [ ] **Step 3: Make sure the branch is on the latest `main`**

Run: `git fetch origin main && git merge-base --is-ancestor origin/main HEAD && echo up-to-date`
Expected: `up-to-date`. If not, rebase onto `origin/main`, then rerun `npm test` and Task 11 Steps 1-7, which re-pins the old commit.

- [ ] **Step 4: Push with an explicit refspec**

Run: `git push -u origin worktree-autocount-shared-layer:worktree-autocount-shared-layer`
Expected: the branch is created on `origin`. If the push fails on a network error, retry up to 4 times, waiting 2, 4, 8 and 16 seconds.

- [ ] **Step 5: Write the PR body**

Write `$SCRATCH/pr-body.md` with these sections:
- **Summary:** the one-paragraph goal from the spec.
- **What changed:** one line per module from this plan's File Structure.
- **Behaviour changes:** the ten items, copied from the spec's "Behaviour changes (complete list)".
- **Verification:**
  - the `npm test` summary line
  - the Playwright result per spec
  - the replay check output from Task 11, which contains commit SHAs, case names, "identical" or field paths, and check levels, but no values
- **Release gate:** the outcome from Step 2, by name only.
- **After merging:** check `/version.json`, then the owner opens the dashboard, Price Check and Dispatch once.

End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 6: Open the draft PR**

Run: `gh pr create --draft --base main --head worktree-autocount-shared-layer --title "Refactor: one shared AutoCount layer for Sales, Dispatch and Price Check" --body-file "$SCRATCH/pr-body.md"`
Expected: the PR URL.

Then call the `ccd_pr` `get_status` tool. If it does not report this PR, call `bind_pr` with the PR number. Do not enable auto-merge.

- [ ] **Step 7: Hand over**

Tell the owner the PR URL and that they merge it, since merges to `main` deploy to Production. After they say it is merged:
- Run `curl -s https://autocount-pwa-dashboard.vercel.app/version.json` and confirm `"target":"production"` and the merge commit.
- Ask the owner to open the dashboard, Price Check and Dispatch once to confirm both books load.
