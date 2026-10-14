# Dispatch Board Date Picker + Older Invoice Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dispatch clerk open any day's board (today ± 7) and pull a previous-dated, unassigned invoice onto a trip, without cluttering the board.

**Architecture:** The backend gains one read filter (`doc_date` on `GET /api/dispatch/assignments`, active rows only, cap 1000). Pure date/filter helpers live in `public/dispatch-state.mjs`. A new `public/dispatch-invoice-picker.mjs` holds the picker's model (load + assign logic, unit-tested in Node) and its DOM mount. `public/dispatch.js` swaps the hard-coded "today" for a `selectedDate`, adds the date bar, and wires the picker.

**Tech Stack:** Node 20+ (`node --test`), vanilla ES modules in the browser, PGlite for repository tests, Playwright for e2e.

**Spec:** `docs/specs/2026-10-14-dispatch-older-invoices-design.md`

## Global Constraints

- Business timezone: `Asia/Kuala_Lumpur`. All "today" values come from `getDefaultDateRange()` / `KUALA_LUMPUR_DATE_FORMATTER` in `public/dispatch-state.mjs`.
- Board window: **today − 7 to today + 7**, inclusive, enforced in the UI.
- Picker lists **one date at a time**, default = board date − 1 (clamped to the window).
- "Active" (holding) assignment = `status NOT IN ('removed', 'failed', 'returned')`. This matches the unique index `delivery_assignments_active_invoice_idx` in `db/migrations/001_delivery_dispatch.sql`.
- `GET /api/dispatch/assignments`: limit cap stays **100** without `doc_date` and becomes **1000** with `doc_date`.
- No new DB tables or migrations. No changes to `POST /api/dispatch/assignments`, loading sheet, or reports.
- Copy strings (exact):
  - Banner: `Viewing <formatted date> — not today`
  - Tag: `Older · <d Mon>` / `Dated · <d Mon>`
  - Picker, no trips: `Create a trip for this day first.`
  - Picker, load failure: `Couldn't load invoices for <formatted date>. Try again.`
  - Picker, already assigned: `Already on another trip.`
  - Picker, stale trip after one retry: `Trip changed — reopen and try again.`
- Run the full unit suite with `npm test` (baseline: 380 pass, 0 fail). Run `npm ci` first if `node_modules` is missing.
- Commit after every task, ending each message with the session's attribution trailer lines.

## Deviations from the spec (agreed during planning)

1. **No server-side date-window guard.** About 40 existing API tests create trips and list invoices dated `2026-08-28` without injecting a clock, so a server guard tied to the real clock would break them. The window is enforced in the UI (date input `min`/`max`, clamped prev/next). The clerks are authenticated, so bypassing the UI gains nothing.
2. **No `trip_date` filter on assignments.** `GET /api/dispatch/trips` already embeds each trip's `assignments` (`lib/dispatch/repository.js` `listTrips`), so older invoices already on the day's trips render today. Only `doc_date` is needed.
3. The new module is `public/dispatch-invoice-picker.mjs` (`.mjs`, like `dispatch-state.mjs`), not `.js`.

Task 8 records these deviations in the spec.

## File Map

| File | Change | Responsibility |
|---|---|---|
| `lib/dispatch/repository.js` | modify `readLimit`, `listAssignments` | `docDate` filter, active-only, cap 1000 |
| `api/dispatch-assignments.js` | modify query parsing | accept/validate `doc_date`, per-filter limit cap |
| `public/dispatch-state.mjs` | add exports | `shiftDate`, `getDispatchWindow`, `clampToDispatchWindow`, `filterUnassignedForDate`, `filterPickerInvoices`, `getInvoiceDateTag` |
| `public/dispatch.js` | modify | transport `doc_date`, `loadPickerInvoices`; `selectedDate`; date bar; tag render; picker wiring |
| `public/dispatch-invoice-picker.mjs` | **new** | `createInvoicePickerModel`, `mountInvoicePicker` |
| `public/dispatch.html` | modify | date bar, banner, "+ Add older invoice" button, picker dialog |
| `public/dispatch.css` | modify | date bar, banner, tag, picker list styles |
| `public/sw.js` | modify | cache bump v28→v29, add picker module |
| `api/dispatch-assignments.test.js` | add tests | Task 1 |
| `test/dispatch-dates.test.mjs` | **new** | Tasks 2, 3, 5 |
| `test/dispatch-invoice-picker.test.mjs` | **new** | Task 6 |
| `test/dispatch-state.test.mjs` | add test | Task 4 |
| `test/e2e/dispatch-board.spec.js` | add tests | Tasks 4, 7 |
| `docs/specs/2026-10-14-dispatch-older-invoices-design.md` | modify | Task 8 |

---

### Task 1: `doc_date` filter on the assignments read API

**Files:**
- Modify: `lib/dispatch/repository.js:33-41` (`readLimit`), `lib/dispatch/repository.js:647-665` (`listAssignments`)
- Modify: `api/dispatch-assignments.js:27-29`, `:93-103` (`limitField`), `:162-176` (`normalizeQuery`)
- Test: `api/dispatch-assignments.test.js` (append)

**Interfaces:**
- Produces: `GET /api/dispatch/assignments?doc_date=YYYY-MM-DD[&limit=n]` → `{ success: true, assignments: Assignment[] }`. Only active rows are returned, and `limit ≤ 1000` (default 1000).
- Produces: `repository.listAssignments({ tripId = null, docDate = null, limit })`.
- Produces: `normalizeQuery(req)` returns `{ assignmentId, tripId, docDate, limit }`.

- [ ] **Step 1: Write the failing tests** (append to `api/dispatch-assignments.test.js`)

```js
test('assignment GET with doc_date returns only active assignments for that invoice date', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '101');
    const source = createSource({
      enterprise: [
        invoice({ companyKey: 'enterprise', invoiceId: 'DOC-OLD-1', docNo: 'ENT-OLD-1', docDate: '2026-08-27' }),
        invoice({ companyKey: 'enterprise', invoiceId: 'DOC-OLD-2', docNo: 'ENT-OLD-2', docDate: '2026-08-27' }),
        invoice({ companyKey: 'enterprise', invoiceId: 'DOC-NEW-1', docNo: 'ENT-NEW-1', docDate: '2026-08-28' }),
      ],
    });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    let revision = 1;
    const created = [];
    for (const [invoiceId, docNo, docDate] of [
      ['DOC-OLD-1', 'ENT-OLD-1', '2026-08-27'],
      ['DOC-OLD-2', 'ENT-OLD-2', '2026-08-27'],
      ['DOC-NEW-1', 'ENT-NEW-1', '2026-08-28'],
    ]) {
      const response = responseRecorder();
      await handler(jsonRequest('POST', {
        trip_id: trip.id, company_key: 'enterprise', invoice_id: invoiceId, doc_no: docNo,
        doc_date: docDate, expected_trip_revision: revision, request_id: `doc-date-filter-${invoiceId}`,
      }), response);
      assert.equal(response.statusCode, 201);
      revision = response.body.tripRevision;
      created.push(response.body.assignment);
    }
    const remove = responseRecorder();
    await handler(jsonRequest('PATCH', {
      assignment_id: created[1].id, operation: 'remove', expected_trip_revision: revision,
      request_id: 'doc-date-filter-remove-old-2',
    }), remove);
    assert.equal(remove.statusCode, 200);

    const listed = responseRecorder();
    await handler({ method: 'GET', headers: {}, query: { doc_date: '2026-08-27' } }, listed);
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.body.assignments.map((row) => row.invoiceId), ['DOC-OLD-1']);
  } finally {
    await database.close();
  }
});

test('assignment GET validates doc_date and allows a 1000 limit only with doc_date', () => {
  const { normalizeQuery } = requireAssignmentsApi();
  assert.deepEqual(normalizeQuery({ query: { doc_date: '2026-08-27' } }), {
    assignmentId: null, tripId: null, docDate: '2026-08-27', limit: 1000,
  });
  assert.deepEqual(normalizeQuery({ query: { doc_date: '2026-08-27', limit: '1000' } }).limit, 1000);
  assert.equal(normalizeQuery({ query: {} }).limit, 100);
  assert.equal(normalizeQuery({ query: {} }).docDate, null);
  for (const query of [
    { doc_date: '2026-02-30' },
    { doc_date: '27-08-2026' },
    { limit: '1000' },
    { doc_date: '2026-08-27', limit: '1001' },
    { doc_date: '2026-08-27', assignment_id: '1' },
  ]) {
    assert.throws(() => normalizeQuery({ query }), (error) => error.status === 400, JSON.stringify(query));
  }
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test --test-name-pattern="doc_date" api/dispatch-assignments.test.js`
Expected: both FAIL. The first gets a 400 because `doc_date` is not an allowed query key. The second fails because `docDate` is missing from the result.

Check the error shape before relying on `error.status`. Run `grep -n "class DispatchHttpError" -A8 lib/dispatch/http.js`. If the property is named `statusCode` rather than `status`, change the assertion to match.

- [ ] **Step 3: Implement the repository change** (`lib/dispatch/repository.js`)

Replace `readLimit` (lines 36-42):

```js
const DOC_DATE_READ_LIMIT = 1000;

function readLimit(value = DEFAULT_DISPATCH_READ_LIMIT, max = DEFAULT_DISPATCH_READ_LIMIT) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw dispatchMutationError('invalid_request');
  }
  return limit;
}
```

Replace `listAssignments`:

```js
  async listAssignments({ tripId = null, docDate = null, limit = DEFAULT_DISPATCH_READ_LIMIT } = {}) {
    const filters = [];
    const values = [];
    const boundedLimit = readLimit(limit, docDate !== null ? DOC_DATE_READ_LIMIT : DEFAULT_DISPATCH_READ_LIMIT);
    if (tripId !== null) {
      values.push(tripId);
      filters.push(`trip_id = $${values.length}`);
    }
    if (docDate !== null) {
      values.push(docDate);
      filters.push(`doc_date = $${values.length}`);
      filters.push(`status NOT IN ('removed', 'failed', 'returned')`);
    }
    const result = await this.db.query(`
      SELECT id
      FROM delivery_assignments
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY id
      LIMIT $${values.length + 1}
    `, [...values, boundedLimit]);
    const assignments = [];
    for (const row of result.rows) assignments.push(await this._readAssignment(this.db, row.id));
    return assignments;
  }
```

- [ ] **Step 4: Implement the API change** (`api/dispatch-assignments.js`)

```js
const ASSIGNMENT_QUERY_KEYS = ['assignment_id', 'trip_id', 'doc_date', 'limit'];
const OPERATIONS = new Set(['move', 'remove', 'status']);
const MAX_LIMIT = 100;
const DOC_DATE_MAX_LIMIT = 1000;
```

```js
function limitField(value, max = MAX_LIMIT) {
  if (value === undefined) return max;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return limit;
}
```

```js
function normalizeQuery(req) {
  const query = req?.query || {};
  if (Object.keys(query).some((key) => !ASSIGNMENT_QUERY_KEYS.includes(key))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const assignmentId = queryValue(query, 'assignment_id');
  const tripId = queryValue(query, 'trip_id');
  const docDate = queryValue(query, 'doc_date');
  if (assignmentId !== undefined && (tripId !== undefined || docDate !== undefined)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return {
    assignmentId: assignmentId === undefined ? null : idField(assignmentId),
    tripId: tripId === undefined ? null : idField(tripId),
    docDate: docDate === undefined ? null : dateField(docDate),
    limit: limitField(queryValue(query, 'limit'), docDate === undefined ? MAX_LIMIT : DOC_DATE_MAX_LIMIT),
  };
}
```

`service.listAssignments(filters)` already passes the filters object straight to the repository, so `lib/dispatch/service.js` needs no change.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test api/dispatch-assignments.test.js`
Expected: all PASS, including the 2 new tests.

Run: `npm test`
Expected: 382 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add lib/dispatch/repository.js api/dispatch-assignments.js api/dispatch-assignments.test.js
git commit -m "Dispatch: filter assignments by invoice date (active only, up to 1000)"
```

---

### Task 2: Pure date and filter helpers

**Files:**
- Modify: `public/dispatch-state.mjs` (add exports after `getDefaultDateRange`, line ~25, and after `invoiceMatchesSearch`)
- Create: `test/dispatch-dates.test.mjs`

**Interfaces:**
- Produces (all exported from `public/dispatch-state.mjs`):
  - `shiftDate(date: 'YYYY-MM-DD', days: number) → 'YYYY-MM-DD'`
  - `getDispatchWindow(now?: Date) → { today, minDate, maxDate }` (± 7 days)
  - `clampToDispatchWindow(date: string, now?: Date) → string` (invalid input → today)
  - `filterUnassignedForDate(invoices: Invoice[], assignments: Assignment[]) → Invoice[]` (drops invoices with an active assignment and cancelled invoices, keeps `eligibility === 'eligible'` only)
  - `filterPickerInvoices(invoices: Invoice[], search: string) → Invoice[]` (matches doc no. or customer name, case-insensitive)
  - `getInvoiceDateTag(docDate: string, referenceDate: string) → null | { kind: 'older' | 'newer', label: string }`

- [ ] **Step 1: Write the failing tests** (`test/dispatch-dates.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampToDispatchWindow,
  filterPickerInvoices,
  filterUnassignedForDate,
  getDispatchWindow,
  getInvoiceDateTag,
  shiftDate,
} from '../public/dispatch-state.mjs';

const KL_NOON_14_OCT = new Date('2026-10-14T04:00:00Z');
const KL_JUST_AFTER_MIDNIGHT_15_OCT = new Date('2026-10-14T16:05:00Z');

test('shiftDate moves across month and year boundaries', () => {
  assert.equal(shiftDate('2026-10-14', -1), '2026-10-13');
  assert.equal(shiftDate('2026-10-01', -1), '2026-09-30');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
});

test('dispatch window is today ± 7 in Kuala Lumpur time', () => {
  assert.deepEqual(getDispatchWindow(KL_NOON_14_OCT), { today: '2026-10-14', minDate: '2026-10-07', maxDate: '2026-10-21' });
  assert.deepEqual(getDispatchWindow(KL_JUST_AFTER_MIDNIGHT_15_OCT), { today: '2026-10-15', minDate: '2026-10-08', maxDate: '2026-10-22' });
});

test('clampToDispatchWindow keeps dates inside the window and repairs bad input', () => {
  assert.equal(clampToDispatchWindow('2026-10-10', KL_NOON_14_OCT), '2026-10-10');
  assert.equal(clampToDispatchWindow('2026-10-01', KL_NOON_14_OCT), '2026-10-07');
  assert.equal(clampToDispatchWindow('2026-11-30', KL_NOON_14_OCT), '2026-10-21');
  assert.equal(clampToDispatchWindow('not-a-date', KL_NOON_14_OCT), '2026-10-14');
});

const pickerInvoices = [
  { companyKey: 'enterprise', invoiceId: 'E1', docNo: 'IV-1001', docDate: '2026-10-13', customer: { name: 'Kedai Ah Seng' }, cancelled: false, eligibility: 'eligible' },
  { companyKey: 'sdn_bhd', invoiceId: 'S1', docNo: 'IV-2001', docDate: '2026-10-13', customer: { name: 'Mini Market Ipoh' }, cancelled: false, eligibility: 'eligible' },
  { companyKey: 'enterprise', invoiceId: 'E2', docNo: 'IV-1002', docDate: '2026-10-13', customer: { name: 'Cancelled Co' }, cancelled: true, eligibility: 'eligible' },
  { companyKey: 'enterprise', invoiceId: 'E3', docNo: 'IV-1003', docDate: '2026-10-13', customer: { name: 'No UOM Sdn' }, cancelled: false, eligibility: 'blocked_missing_uom' },
];

test('filterUnassignedForDate drops assigned, cancelled, and blocked invoices', () => {
  const assignments = [{ companyKey: 'enterprise', invoiceId: 'E1', status: 'assigned' }];
  assert.deepEqual(filterUnassignedForDate(pickerInvoices, assignments).map((row) => row.invoiceId), ['S1']);
});

test('filterUnassignedForDate keys by company so the same invoice ID in the other book stays available', () => {
  const assignments = [{ companyKey: 'sdn_bhd', invoiceId: 'E1', status: 'assigned' }];
  assert.deepEqual(filterUnassignedForDate(pickerInvoices, assignments).map((row) => row.invoiceId), ['E1', 'S1']);
});

test('filterPickerInvoices matches doc no. or customer name, case-insensitive', () => {
  assert.deepEqual(filterPickerInvoices(pickerInvoices, 'iv-200').map((row) => row.invoiceId), ['S1']);
  assert.deepEqual(filterPickerInvoices(pickerInvoices, 'ah seng').map((row) => row.invoiceId), ['E1']);
  assert.equal(filterPickerInvoices(pickerInvoices, '  ').length, pickerInvoices.length);
});

test('getInvoiceDateTag labels older and later invoice dates against the trip date', () => {
  assert.equal(getInvoiceDateTag('2026-10-14', '2026-10-14'), null);
  assert.equal(getInvoiceDateTag('', '2026-10-14'), null);
  const older = getInvoiceDateTag('2026-10-12', '2026-10-14');
  assert.equal(older.kind, 'older');
  assert.match(older.label, /^Older · 12 Oct$/);
  const newer = getInvoiceDateTag('2026-10-15', '2026-10-14');
  assert.equal(newer.kind, 'newer');
  assert.match(newer.label, /^Dated · 15 Oct$/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/dispatch-dates.test.mjs`
Expected: FAIL with `SyntaxError: The requested module ... does not provide an export named 'clampToDispatchWindow'`.

- [ ] **Step 3: Implement** (in `public/dispatch-state.mjs`, directly after `getDefaultDateRange`)

```js
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const DISPATCH_WINDOW_DAYS = 7;
const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

export function shiftDate(date, days) {
  const parsed = parseIsoDate(date);
  if (!parsed) throw new Error(`invalid date: ${date}`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function getDispatchWindow(now = new Date()) {
  const today = getDefaultDateRange(now).startDate;
  return { today, minDate: shiftDate(today, -DISPATCH_WINDOW_DAYS), maxDate: shiftDate(today, DISPATCH_WINDOW_DAYS) };
}

export function clampToDispatchWindow(date, now = new Date()) {
  const { today, minDate, maxDate } = getDispatchWindow(now);
  if (!parseIsoDate(date)) return today;
  if (date < minDate) return minDate;
  if (date > maxDate) return maxDate;
  return date;
}

export function getInvoiceDateTag(docDate, referenceDate) {
  const doc = parseIsoDate(docDate);
  if (!doc || !parseIsoDate(referenceDate) || docDate === referenceDate) return null;
  const shortDate = SHORT_DATE_FORMATTER.format(doc);
  return docDate < referenceDate
    ? { kind: 'older', label: `Older · ${shortDate}` }
    : { kind: 'newer', label: `Dated · ${shortDate}` };
}
```

Then, directly after `invoiceMatchesSearch`:

```js
const HOLDING_ASSIGNMENT_EXCLUDED_STATUSES = new Set(['removed', 'failed', 'returned']);

export function filterUnassignedForDate(invoices = [], assignments = []) {
  const taken = new Set(assignments
    .filter((assignment) => !HOLDING_ASSIGNMENT_EXCLUDED_STATUSES.has(assignment.status))
    .map((assignment) => getInvoiceKey(companyKeyOf(assignment), invoiceIdOf(assignment))));
  return invoices.filter((invoice) => (
    invoice.cancelled !== true
    && invoice.eligibility === 'eligible'
    && !taken.has(getInvoiceKey(companyKeyOf(invoice), invoiceIdOf(invoice)))
  ));
}

export function filterPickerInvoices(invoices = [], search = '') {
  const text = String(search ?? '').trim().toLowerCase();
  if (!text) return invoices;
  return invoices.filter((invoice) => [invoice.docNo, invoice.doc_no, invoice.customer?.name, invoice.customerName]
    .some((field) => typeof field === 'string' && field.toLowerCase().includes(text)));
}
```

Before writing this, check `getInvoiceKey(companyKey, invoiceId)` at `public/dispatch-state.mjs:107`. It must accept the two-argument form `(companyKey, invoiceId)`; its signature `getInvoiceKey(invoiceOrCompanyKey, maybeInvoiceId)` shows that it does. Also confirm that `companyKeyOf` and `invoiceIdOf` (lines 91 and 95) read both camelCase and snake_case fields.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/dispatch-dates.test.mjs`
Expected: PASS (7 tests).

Run: `npm test`
Expected: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add public/dispatch-state.mjs test/dispatch-dates.test.mjs
git commit -m "Dispatch: add date-window, picker filter, and date-tag helpers"
```

---

### Task 3: Transport reads assignments by date and loads picker invoices

**Files:**
- Modify: `public/dispatch.js:423-444` (`createFetchTransport().loadBoard`) and add `loadPickerInvoices`
- Test: `test/dispatch-dates.test.mjs` (append)

**Interfaces:**
- Consumes: `GET /api/dispatch/assignments?doc_date=` (Task 1)
- Produces: `transport.loadBoard({ startDate, endDate, company })`. Same return shape as today, but the assignments URL is now `/api/dispatch/assignments?doc_date=<startDate>&limit=1000`.
- Produces: `transport.loadPickerInvoices({ date, company }) → Promise<{ invoices, assignments, sources }>`

- [ ] **Step 1: Write the failing test** (append to `test/dispatch-dates.test.mjs`)

```js
import { createFetchTransport } from '../public/dispatch.js';

function recordingFetch(payloadFor) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, async json() { return payloadFor(url); } };
  };
  return { calls, fetchImpl };
}

test('board transport asks for assignments by the board date instead of the latest 100', async () => {
  const { calls, fetchImpl } = recordingFetch((url) => (
    url.includes('/invoices?') ? { success: true, invoices: [], sources: {}, dateRange: { startDate: '2026-10-13', endDate: '2026-10-13' } }
      : url.includes('/trips?') ? { success: true, trips: [] }
        : { success: true, assignments: [] }));
  await createFetchTransport({ fetchImpl }).loadBoard({ startDate: '2026-10-13', endDate: '2026-10-13', company: 'all' });
  const assignmentUrl = calls.find((url) => url.startsWith('/api/dispatch/assignments'));
  assert.equal(assignmentUrl, '/api/dispatch/assignments?doc_date=2026-10-13&limit=1000');
});

test('picker transport reads one date of invoices and that date’s active assignments', async () => {
  const invoices = [{ companyKey: 'enterprise', invoiceId: 'E1', docNo: 'IV-1' }];
  const assignments = [{ companyKey: 'enterprise', invoiceId: 'E9', status: 'assigned' }];
  const { calls, fetchImpl } = recordingFetch((url) => (
    url.includes('/invoices?') ? { success: true, invoices, sources: { enterprise: { status: 'ok' } } } : { success: true, assignments }));
  const result = await createFetchTransport({ fetchImpl }).loadPickerInvoices({ date: '2026-10-12', company: 'enterprise' });
  assert.deepEqual(calls.sort(), [
    '/api/dispatch/assignments?doc_date=2026-10-12&limit=1000',
    '/api/dispatch/invoices?startDate=2026-10-12&endDate=2026-10-12&company=enterprise',
  ]);
  assert.deepEqual(result, { invoices, assignments, sources: { enterprise: { status: 'ok' } } });
});
```

Move the `import { createFetchTransport }` line to the top of the file with the other imports.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/dispatch-dates.test.mjs`
Expected: 2 FAIL. The first gets the URL `.../assignments?limit=100`. The second fails with `loadPickerInvoices is not a function`.

- [ ] **Step 3: Implement** (`public/dispatch.js`, inside `createFetchTransport`)

Replace the assignments `getJson` line in `loadBoard`:

```js
        getJson(fetchImpl, `/api/dispatch/assignments?${new URLSearchParams({ doc_date: startDate, limit: '1000' }).toString()}`, 'The assignments could not be loaded.'),
```

Add after `loadBoard`:

```js
    async loadPickerInvoices({ date, company = 'all' } = {}) {
      if (!COMPANY_FILTERS.includes(company)) throw new Error(`invalid company filter: ${company}`);
      const invoiceQuery = new URLSearchParams({ startDate: date, endDate: date, company });
      const assignmentQuery = new URLSearchParams({ doc_date: date, limit: '1000' });
      const [invoicePayload, assignmentPayload] = await Promise.all([
        getJson(fetchImpl, `/api/dispatch/invoices?${invoiceQuery.toString()}`, 'The invoices could not be loaded.'),
        getJson(fetchImpl, `/api/dispatch/assignments?${assignmentQuery.toString()}`, 'The assignments could not be loaded.'),
      ]);
      return {
        invoices: invoicePayload?.invoices || [],
        assignments: assignmentPayload?.assignments || [],
        sources: invoicePayload?.sources || {},
      };
    },
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/dispatch-dates.test.mjs test/dispatch-state.test.mjs`
Expected: PASS. The existing test `board transport reads authenticated invoices, trips, and persisted assignments together` still passes, because it only checks that the URL contains `/api/dispatch/assignments?`.

Run: `npm test`
Expected: 0 fail.

- [ ] **Step 5: Commit**

```bash
git add public/dispatch.js test/dispatch-dates.test.mjs
git commit -m "Dispatch: load board assignments by invoice date; add picker invoice transport"
```

---

### Task 4: Board date picker

**Files:**
- Modify: `public/dispatch.html:72-76` (toolbar date block)
- Modify: `public/dispatch.css` (append)
- Modify: `public/dispatch.js`: `createDispatchApp` (lines ~640-1118): `selectedDate`, `loadBoard`, `createTrip`, `syncDefaultDateControls` usage, listeners, return value
- Test: `test/dispatch-state.test.mjs` (append), `test/e2e/dispatch-board.spec.js` (append)

**Interfaces:**
- Consumes: `getDispatchWindow`, `clampToDispatchWindow`, `shiftDate` (Task 2)
- Produces: the `createDispatchApp(...)` return object gains `setBoardDate(date: string) → Promise<state>` and `getBoardDate() → string`.
- Produces: DOM ids `boardDate`, `boardPrevDay`, `boardNextDay`, `boardToday`, `boardDateBanner`.

- [ ] **Step 1: Write the failing unit test** (append to `test/dispatch-state.test.mjs`)

```js
test('board date picker reloads the chosen day and creates trips on that day', async () => {
  const fake = createFakeDispatchDocument({ protectedShell: true });
  const boardCalls = [];
  const tripBodies = [];
  const app = createDispatchApp({
    documentRef: fake.documentRef,
    sessionTransport: { getSession: async () => ({ authenticated: true, session: { clerkId: 'clerk-1', role: 'clerk' } }) },
    transport: { loadBoard: async (options) => { boardCalls.push(options); return { invoices: [], trips: [], assignments: [], sources: {} }; } },
    resourcesTransport: { loadResources: async () => ({ drivers: [], lorries: [] }) },
    tripsTransport: { createTrip: async (body) => { tripBodies.push(body); return { trip: { id: 1 } }; } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const { today, minDate } = dispatchState.getDispatchWindow();
  assert.equal(app.getBoardDate(), today);
  assert.equal(boardCalls.at(-1).startDate, today);

  const yesterday = dispatchState.shiftDate(today, -1);
  await app.setBoardDate(yesterday);
  assert.equal(app.getBoardDate(), yesterday);
  assert.deepEqual([boardCalls.at(-1).startDate, boardCalls.at(-1).endDate], [yesterday, yesterday]);

  await app.setBoardDate(dispatchState.shiftDate(today, -30));
  assert.equal(app.getBoardDate(), minDate, 'dates outside the window clamp to the edge');
});
```

This test exercises date selection and loading only. Trip creation on the selected date is checked in the e2e test in Step 7, because the fake document has no trip form.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test --test-name-pattern="board date picker" test/dispatch-state.test.mjs`
Expected: FAIL with `app.getBoardDate is not a function`.

- [ ] **Step 3: Implement the controller** (`public/dispatch.js`)

Add `clampToDispatchWindow`, `getDispatchWindow` and `shiftDate` to the import list from `./dispatch-state.mjs`.

In `createDispatchApp`, replace:

```js
  const initialDateRange = getDefaultDateRange();
  let state = createDispatchState({ dateRange: initialDateRange });
```

with:

```js
  let selectedDate = getDefaultDateRange().startDate;
  const initialDateRange = { startDate: selectedDate, endDate: selectedDate };
  let state = createDispatchState({ dateRange: initialDateRange });
```

In `loadBoard`, replace:

```js
      const dateRange = getDefaultDateRange();
      const board = await transport.loadBoard({ startDate: dateRange.startDate, endDate: dateRange.endDate, company: requestedCompany });
      if (requestSequence !== boardRequestSequence || state.companyFilter !== requestedCompany) return state;
```

with:

```js
      const requestedDate = selectedDate;
      const board = await transport.loadBoard({ startDate: requestedDate, endDate: requestedDate, company: requestedCompany });
      if (requestSequence !== boardRequestSequence || state.companyFilter !== requestedCompany || selectedDate !== requestedDate) return state;
```

Also make sure the state keeps the selected date when the API omits `dateRange`. In the `reloadDispatchState(...)` call that follows, change `{ ...board, resources: boardResources, ... }` to `{ ...board, dateRange: board.dateRange || { startDate: requestedDate, endDate: requestedDate }, resources: boardResources, ... }`.

In `createTrip`, replace `trip_date: getDefaultDateRange().startDate` with `trip_date: selectedDate`.

Add the date-bar functions just above `async function login()`:

```js
  function renderDateBar() {
    const { today, minDate, maxDate } = getDispatchWindow();
    const input = $(root, '#boardDate');
    if (input) { input.min = minDate; input.max = maxDate; input.value = selectedDate; }
    const prev = $(root, '#boardPrevDay'); if (prev) prev.disabled = selectedDate <= minDate;
    const next = $(root, '#boardNextDay'); if (next) next.disabled = selectedDate >= maxDate;
    const todayButton = $(root, '#boardToday'); if (todayButton) todayButton.disabled = selectedDate === today;
    const banner = $(root, '#boardDateBanner');
    if (banner) {
      banner.hidden = selectedDate === today;
      banner.textContent = selectedDate === today ? '' : `Viewing ${formatKualaLumpurDate(selectedDate) || selectedDate} — not today`;
    }
  }
  async function setBoardDate(date) {
    selectedDate = clampToDispatchWindow(date);
    syncDefaultDateControls(root, { startDate: selectedDate, endDate: selectedDate });
    state = { ...state, dateRange: { startDate: selectedDate, endDate: selectedDate } };
    renderDateBar();
    try { return await loadBoard(); } catch { return state; }
  }
```

`syncDefaultDateControls` also rewrites `#reportStartDate` and `#reportEndDate`. That is acceptable: the Reports tab then follows the board day. If you would rather keep the Reports dates fixed, create a `syncBoardDateControls` that only sets `#updatedAt` and `#tripDialogHelp`, and call that instead.

Add listeners next to the other `$(root, ...)?.addEventListener` lines:

```js
  $(root, '#boardDate')?.addEventListener('change', (event) => { if (event.target.value) setBoardDate(event.target.value); });
  $(root, '#boardPrevDay')?.addEventListener('click', () => setBoardDate(shiftDate(selectedDate, -1)));
  $(root, '#boardNextDay')?.addEventListener('click', () => setBoardDate(shiftDate(selectedDate, 1)));
  $(root, '#boardToday')?.addEventListener('click', () => setBoardDate(getDispatchWindow().today));
```

Change the init line to call `renderDateBar()` after `syncDefaultDateControls(root, initialDateRange);`.

Add `setBoardDate, getBoardDate: () => selectedDate` to the returned object.

In `clearSensitiveState`, reset `selectedDate = getDefaultDateRange().startDate;` before `render()`, and call `renderDateBar()`.

- [ ] **Step 4: Implement the markup** (`public/dispatch.html`)

Replace lines 72-75 (the `<div>` containing `Invoice date` / `#boardDateLabel`) with:

```html
            <div class="board-date-block">
              <p class="eyebrow">Delivery date</p>
              <h2 id="boardDateLabel">Today</h2>
              <div class="board-date-controls">
                <button class="secondary-button board-date-step" type="button" id="boardPrevDay" aria-label="Previous day">◀</button>
                <input class="field-control board-date-input" type="date" id="boardDate" aria-label="Board date" />
                <button class="secondary-button board-date-step" type="button" id="boardNextDay" aria-label="Next day">▶</button>
                <button class="secondary-button" type="button" id="boardToday">Today</button>
              </div>
              <p class="board-date-banner" id="boardDateBanner" role="status" aria-live="polite" hidden></p>
            </div>
```

Change the static help text in `#tripDialogHelp` from `today’s dispatch` to `the selected day`. `syncDefaultDateControls` already rewrites it at runtime.

- [ ] **Step 5: Add the CSS** (append to `public/dispatch.css`)

```css
.board-date-block { display: grid; gap: 6px; min-width: 0; }
.board-date-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.board-date-step { min-width: 44px; }
.board-date-input { width: auto; min-width: 150px; }
.board-date-banner {
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--butter-line);
  border-radius: 8px;
  background: var(--butter);
  color: var(--butter-ink);
  font-weight: 600;
}
.board-date-banner[hidden] { display: none; }
```

- [ ] **Step 6: Run the unit tests**

Run: `npm test`
Expected: 0 fail. This includes the new board-date test.

If a test that checks the HTML (e.g. `assert.doesNotMatch(dispatchHtml, /value="2026-08-28"/)`) now fails, fix the markup, not the test. The date input must not have a hard-coded `value`.

- [ ] **Step 7: Write the e2e test** (append to `test/e2e/dispatch-board.spec.js`)

The spec already has `openBoard(page, options)`, which installs the mock, opens `/dispatch.html`, waits for the board and returns the mock `state`. The mock records trip POST bodies in `state.tripBodies`. If the trip dialog needs a non-empty route note or a lorry choice, copy those steps from `'Board shows combined company feed and creates a mixed-company trip'`.

```js
test('board date picker switches day, shows the not-today banner, and creates trips on the chosen day', async ({ page }) => {
  const state = await openBoard(page);
  const banner = page.locator('#boardDateBanner');
  await expect(banner).toBeHidden();
  await page.locator('#boardPrevDay').click();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('not today');
  const chosen = await page.locator('#boardDate').inputValue();
  await page.locator('#newTripButton').click();
  await page.locator('#createTripSubmit').click();
  await expect.poll(() => state.tripBodies.at(-1)?.trip_date).toBe(chosen);
  await page.locator('#boardToday').click();
  await expect(banner).toBeHidden();
});
```

Run: `npx playwright test test/e2e/dispatch-board.spec.js`
Expected: all PASS on both projects (desktop + mobile).

- [ ] **Step 8: Commit**

```bash
git add public/dispatch.html public/dispatch.css public/dispatch.js test/dispatch-state.test.mjs test/e2e/dispatch-board.spec.js
git commit -m "Dispatch: board date picker (today ± 7) with not-today banner"
```

---

### Task 5: "Older" tag on trip invoice cards

**Files:**
- Modify: `public/dispatch.js:146` (`renderInvoiceCard`), `:185-210` (`renderTripCard`)
- Modify: `public/dispatch.css` (append)
- Test: `test/dispatch-dates.test.mjs` (append)

**Interfaces:**
- Consumes: `getInvoiceDateTag` (Task 2)
- Produces: `renderInvoiceCard(invoice, { ..., referenceDate = null })`. When the tag applies, a non-rail card renders `<span class="invoice-date-tag invoice-date-tag-older|newer">Older · 12 Oct</span>` in `.invoice-footer`.

- [ ] **Step 1: Write the failing test** (append to `test/dispatch-dates.test.mjs`)

```js
import { renderInvoiceCard, renderTripCard } from '../public/dispatch.js';
import { createDispatchState } from '../public/dispatch-state.mjs';

const OLD_INVOICE = {
  companyKey: 'enterprise', invoiceId: 'OLD-1', docKey: 'OLD-1', docNo: 'IV-OLD-1', docDate: '2026-10-12',
  customer: { name: 'Kedai Lama' }, deliveryAddress: 'Ipoh', cancelled: false, eligibility: 'eligible',
  items: [{ itemCode: 'OIL', description: 'Oil', quantity: '1', uom: 'CTN' }],
};

test('invoice card shows an Older tag when its date is before the reference date', () => {
  const html = renderInvoiceCard(OLD_INVOICE, { inTrip: true, referenceDate: '2026-10-14' });
  assert.match(html, /class="invoice-date-tag invoice-date-tag-older">Older · 12 Oct</);
  assert.doesNotMatch(renderInvoiceCard(OLD_INVOICE, { inTrip: true, referenceDate: '2026-10-12' }), /invoice-date-tag/);
  assert.doesNotMatch(renderInvoiceCard(OLD_INVOICE, { inTrip: true }), /invoice-date-tag/);
});

test('trip card tags an older invoice against the trip date', () => {
  const state = createDispatchState({
    invoices: [],
    trips: [{ id: 5, tripDate: '2026-10-14', driverId: 1, vehicleId: 2, revision: 2, status: 'planned',
      assignments: [{ id: 9, tripId: 5, companyKey: 'enterprise', invoiceId: 'OLD-1', docNo: 'IV-OLD-1', docDate: '2026-10-12', status: 'assigned',
        header: { customer: { name: 'Kedai Lama' } }, items: OLD_INVOICE.items }] }],
    dateRange: { startDate: '2026-10-14', endDate: '2026-10-14' },
  });
  assert.match(renderTripCard(state, state.trips[0]), /Older · 12 Oct/);
});
```

Move the new imports to the top of the file.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/dispatch-dates.test.mjs`
Expected: 2 FAIL (no `invoice-date-tag` in the output).

- [ ] **Step 3: Implement** (`public/dispatch.js`)

Add `getInvoiceDateTag` to the imports from `./dispatch-state.mjs`.

In `renderInvoiceCard`, add `referenceDate = null` to the destructured options. Then, just before `if (inTrip) {`, add:

```js
  const dateTag = getInvoiceDateTag(invoice.docDate, referenceDate);
  const dateTagHtml = dateTag ? `<span class="invoice-date-tag invoice-date-tag-${dateTag.kind}">${escapeHtml(dateTag.label)}</span>` : '';
```

Invoices inside a trip use the **compact** branch (`if (inTrip) { ... invoice-card--compact ... }`), which returns early. Put the tag there, right after the customer span:

```js
    <article class="invoice-card invoice-card--compact${selectedClass}" data-invoice-key="${escapeHtml(key)}" draggable="${String(draggable)}" title="${escapeHtml(`Invoice ${invoice.docNo}`)}">
      <span class="invoice-customer">${escapeHtml(invoice.customer?.name || invoice.customerName || 'Customer review')}</span>${dateTagHtml}${action}
    </article>`;
```

Leave the rail and full-card branches unchanged. Rail invoices are always board-date invoices, so they never need a tag.

In `renderTripCard` (line ~209), add `referenceDate: trip.tripDate` to the options of `renderInvoiceCard(invoice, { inTrip: true, ... })`. This is the only `inTrip: true` call site: lorry lanes render trips through `renderTripCard` (`renderLorryLane`, line ~255).

- [ ] **Step 4: Add the CSS** (append to `public/dispatch.css`)

```css
.invoice-date-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}
.invoice-date-tag-older { background: var(--butter); color: var(--butter-ink); border: 1px solid var(--butter-line); }
.invoice-date-tag-newer { background: var(--blue-soft); color: var(--blue); }
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test`
Expected: 0 fail.

- [ ] **Step 6: Commit**

```bash
git add public/dispatch.js public/dispatch.css test/dispatch-dates.test.mjs
git commit -m "Dispatch: tag invoices whose date differs from their trip date"
```

---

### Task 6: Invoice picker model (logic, no DOM)

**Files:**
- Create: `public/dispatch-invoice-picker.mjs`
- Create: `test/dispatch-invoice-picker.test.mjs`

**Interfaces:**
- Consumes: `transport.loadPickerInvoices({ date, company })` (Task 3); `assignmentsTransport.assignInvoice({...})`, which resolves `{ assignment, tripRevision }` (existing); `tripsTransport.getTrip?` (not used; see the retry rule below); `filterUnassignedForDate`, `filterPickerInvoices`, `getInvoiceKey` (Task 2 / existing)
- Produces:

```js
createInvoicePickerModel({ transport, assignmentsTransport, reloadTrip, createRequestId })
  → {
    async load({ date, company }) → { status: 'ready', invoices: Invoice[], sources } | { status: 'error', message: string }
    filter(invoices, search) → Invoice[]
    async assign({ invoices: Invoice[], trip: { id, revision } }) → { results: Array<{ key, ok: true } | { key, ok: false, message: string }>, tripRevision: number }
  }
```

`reloadTrip(tripId) → Promise<{ id, revision } | null>` is supplied by `dispatch.js` (Task 7). It is used once per invoice on a `stale_trip` error.

- [ ] **Step 1: Write the failing tests** (`test/dispatch-invoice-picker.test.mjs`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createInvoicePickerModel } from '../public/dispatch-invoice-picker.mjs';

const A = { companyKey: 'enterprise', invoiceId: 'A', docNo: 'IV-A', docDate: '2026-10-12', customer: { name: 'Alpha' }, cancelled: false, eligibility: 'eligible' };
const B = { companyKey: 'enterprise', invoiceId: 'B', docNo: 'IV-B', docDate: '2026-10-12', customer: { name: 'Beta' }, cancelled: false, eligibility: 'eligible' };
const C = { companyKey: 'sdn_bhd', invoiceId: 'C', docNo: 'IV-C', docDate: '2026-10-12', customer: { name: 'Gamma' }, cancelled: false, eligibility: 'eligible' };

function error(code) { const value = new Error(code); value.code = code; return value; }
let requestCounter = 0;
const createRequestId = () => `picker-request-${String(++requestCounter).padStart(4, '0')}`;

test('load returns only invoices not already on a trip', async () => {
  const model = createInvoicePickerModel({
    transport: { loadPickerInvoices: async () => ({ invoices: [A, B, C], assignments: [{ companyKey: 'enterprise', invoiceId: 'B', status: 'assigned' }], sources: {} }) },
    assignmentsTransport: {}, reloadTrip: async () => null, createRequestId,
  });
  const result = await model.load({ date: '2026-10-12', company: 'all' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.invoices.map((row) => row.invoiceId), ['A', 'C']);
});

test('load failure returns a friendly message with the formatted date', async () => {
  const model = createInvoicePickerModel({
    transport: { loadPickerInvoices: async () => { throw error('source_unavailable'); } },
    assignmentsTransport: {}, reloadTrip: async () => null, createRequestId,
  });
  const result = await model.load({ date: '2026-10-12', company: 'all' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /^Couldn't load invoices for .*2026.*\. Try again\.$/);
});

test('load rethrows unauthorized so the app can handle session loss', async () => {
  const model = createInvoicePickerModel({
    transport: { loadPickerInvoices: async () => { throw error('unauthorized'); } },
    assignmentsTransport: {}, reloadTrip: async () => null, createRequestId,
  });
  await assert.rejects(model.load({ date: '2026-10-12', company: 'all' }), (value) => value.code === 'unauthorized');
});

test('assign adds invoices one by one, carrying the trip revision forward', async () => {
  const bodies = [];
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async (body) => { bodies.push(body); return { tripRevision: body.expected_trip_revision + 1 }; } },
    reloadTrip: async () => null, createRequestId,
  });
  const outcome = await model.assign({ invoices: [A, C], trip: { id: 7, revision: 3 } });
  assert.deepEqual(bodies.map((body) => [body.invoice_id, body.company_key, body.doc_date, body.expected_trip_revision, body.trip_id]), [
    ['A', 'enterprise', '2026-10-12', 3, 7],
    ['C', 'sdn_bhd', '2026-10-12', 4, 7],
  ]);
  assert.deepEqual(outcome.results.map((row) => row.ok), [true, true]);
  assert.equal(outcome.tripRevision, 5);
});

test('assign keeps going after an already-assigned invoice and reports it', async () => {
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async (body) => { if (body.invoice_id === 'A') throw error('invoice_already_assigned'); return { tripRevision: body.expected_trip_revision + 1 }; } },
    reloadTrip: async () => null, createRequestId,
  });
  const outcome = await model.assign({ invoices: [A, B], trip: { id: 7, revision: 3 } });
  assert.deepEqual(outcome.results, [
    { key: 'enterprise:A', ok: false, message: 'Already on another trip.' },
    { key: 'enterprise:B', ok: true },
  ]);
});

test('assign retries once after a stale trip using the reloaded revision', async () => {
  const revisions = [];
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async (body) => { revisions.push(body.expected_trip_revision); if (body.expected_trip_revision === 3) throw error('stale_trip'); return { tripRevision: body.expected_trip_revision + 1 }; } },
    reloadTrip: async () => ({ id: 7, revision: 6 }), createRequestId,
  });
  const outcome = await model.assign({ invoices: [A], trip: { id: 7, revision: 3 } });
  assert.deepEqual(revisions, [3, 6]);
  assert.deepEqual(outcome.results, [{ key: 'enterprise:A', ok: true }]);
  assert.equal(outcome.tripRevision, 7);
});

test('assign gives up after a second stale trip', async () => {
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async () => { throw error('stale_trip'); } },
    reloadTrip: async () => ({ id: 7, revision: 6 }), createRequestId,
  });
  const outcome = await model.assign({ invoices: [A], trip: { id: 7, revision: 3 } });
  assert.deepEqual(outcome.results, [{ key: 'enterprise:A', ok: false, message: 'Trip changed — reopen and try again.' }]);
});

test('assign rethrows unauthorized immediately', async () => {
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async () => { throw error('unauthorized'); } },
    reloadTrip: async () => null, createRequestId,
  });
  await assert.rejects(model.assign({ invoices: [A, B], trip: { id: 7, revision: 3 } }), (value) => value.code === 'unauthorized');
});
```

Before writing the expected keys, check the format of `getInvoiceKey`: run `node -e "import('./public/dispatch-state.mjs').then(m=>console.log(m.getInvoiceKey('enterprise','A')))"`. If it prints something other than `enterprise:A`, replace `'enterprise:A'` / `'enterprise:B'` in the tests with the printed format.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/dispatch-invoice-picker.test.mjs`
Expected: FAIL with `Cannot find module '.../public/dispatch-invoice-picker.mjs'`.

- [ ] **Step 3: Implement** (`public/dispatch-invoice-picker.mjs`)

```js
import {
  filterPickerInvoices,
  filterUnassignedForDate,
  getInvoiceKey,
} from './dispatch-state.mjs';

const PICKER_DATE_FORMATTER = new Intl.DateTimeFormat('en-MY', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

export function formatPickerDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? String(date) : PICKER_DATE_FORMATTER.format(parsed);
}

function companyKeyOf(invoice) { return invoice.companyKey ?? invoice.company_key; }
function invoiceIdOf(invoice) { return invoice.invoiceId ?? invoice.invoice_id ?? invoice.docKey; }

export function createInvoicePickerModel({ transport, assignmentsTransport, reloadTrip, createRequestId }) {
  async function load({ date, company = 'all' }) {
    try {
      const { invoices, assignments, sources } = await transport.loadPickerInvoices({ date, company });
      return { status: 'ready', invoices: filterUnassignedForDate(invoices, assignments), sources };
    } catch (error) {
      if (error?.code === 'unauthorized') throw error;
      return { status: 'error', message: `Couldn't load invoices for ${formatPickerDate(date)}. Try again.` };
    }
  }

  async function assignOne(invoice, tripId, revision) {
    return assignmentsTransport.assignInvoice({
      trip_id: Number(tripId),
      company_key: companyKeyOf(invoice),
      invoice_id: invoiceIdOf(invoice),
      doc_no: invoice.docNo,
      doc_date: invoice.docDate,
      expected_trip_revision: revision,
      request_id: createRequestId(),
    });
  }

  async function assign({ invoices, trip }) {
    let revision = Number(trip.revision);
    const results = [];
    for (const invoice of invoices) {
      const key = getInvoiceKey(companyKeyOf(invoice), invoiceIdOf(invoice));
      try {
        let response;
        try {
          response = await assignOne(invoice, trip.id, revision);
        } catch (error) {
          if (error?.code !== 'stale_trip') throw error;
          const fresh = await reloadTrip(trip.id);
          if (!fresh) throw error;
          revision = Number(fresh.revision);
          response = await assignOne(invoice, trip.id, revision);
        }
        revision = Number(response?.tripRevision ?? revision + 1);
        results.push({ key, ok: true });
      } catch (error) {
        if (error?.code === 'unauthorized') throw error;
        const message = error?.code === 'invoice_already_assigned' ? 'Already on another trip.'
          : error?.code === 'stale_trip' ? 'Trip changed — reopen and try again.'
            : 'Could not add this invoice. Try again.';
        results.push({ key, ok: false, message });
      }
    }
    return { results, tripRevision: revision };
  }

  return { load, filter: filterPickerInvoices, assign };
}
```

`mountInvoicePicker` (the DOM part) is added to this same file in Task 7.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test test/dispatch-invoice-picker.test.mjs`
Expected: PASS (8 tests).

Run: `npm test`
Expected: 0 fail. `npm test` runs `test/*.test.mjs`, so the new file is included automatically.

- [ ] **Step 5: Commit**

```bash
git add public/dispatch-invoice-picker.mjs test/dispatch-invoice-picker.test.mjs
git commit -m "Dispatch: invoice picker model (load unassigned, sequential assign with retry)"
```

---

### Task 7: Picker dialog UI and wiring

**Files:**
- Modify: `public/dispatch-invoice-picker.mjs` (add `mountInvoicePicker`)
- Modify: `public/dispatch.html` (button in `.queue-heading-actions`, dialog after `#tripDialogBackdrop`)
- Modify: `public/dispatch.css` (append)
- Modify: `public/dispatch.js` (import + mount in `createDispatchApp`)
- Modify: `public/sw.js:1-14`
- Test: `test/e2e/dispatch-board.spec.js` (append)

**Interfaces:**
- Consumes: `createInvoicePickerModel` (Task 6), `getDispatchWindow`, `clampToDispatchWindow`, `shiftDate`, `getTripNumbers` (existing), `formatKualaLumpurDate` (dispatch.js)
- Produces:

```js
mountInvoicePicker(root, {
  model,                          // from createInvoicePickerModel
  getBoardDate: () => string,
  getTrips: () => Trip[],         // state.trips (non-cancelled already)
  canWrite: () => boolean,
  onAssigned: async () => void,   // reload board
  onSessionLoss: () => void,
}) → { open(invoker?: HTMLElement): Promise<void>, close(): void }
```

- DOM ids: `addOlderInvoiceButton`, `olderInvoiceBackdrop`, `olderInvoiceDialog`, `closeOlderInvoice`, `olderInvoiceDate`, `olderInvoiceCompany`, `olderInvoiceSearch`, `olderInvoiceList`, `olderInvoiceTrip`, `olderInvoiceMessage`, `olderInvoiceSubmit`, `olderInvoiceRetry`. Rows use `data-older-invoice-key`.

- [ ] **Step 1: Write the failing e2e test** (append to `test/e2e/dispatch-board.spec.js`)

The mock's invoices branch (`pathname === '/api/dispatch/invoices'`) always returns `state.invoices`, and its assignment POST finds the invoice in `state.invoices` only. Make two edits to `installFixtureApi`:

1. In the invoices branch, serve older rows when `olderInvoicesByDate` has an entry for the requested date. Remember them so the POST can find them:

```js
      const startDate = url.searchParams.get('startDate');
      const olderRows = state.olderInvoicesByDate ? state.olderInvoicesByDate[startDate] : undefined;
      if (olderRows) {
        state.servedOlderInvoices.push(...olderRows);
        return json(route, { success: true, dateRange: { startDate, endDate: startDate }, company: requestedCompany, invoices: olderRows, sources: { enterprise: { status: 'ok' }, sdn_bhd: { status: 'ok' } } });
      }
```

Put this right after the `requestedCompany` line and before the existing gates. Add `servedOlderInvoices: []` and `olderInvoicesByDate: null` to `createServerState()`.

The board's own request is for today, and the picker's is for today − 1. The Proxy in the test therefore also answers the board's date. Guard against that: answer only dates **before** today:

```js
  state.olderInvoicesByDate = new Proxy({}, { get: (_target, date) => (typeof date === 'string' && date < currentKualaLumpurDate() ? [{ ...OLD, docDate: date }] : undefined) });
```

Use this line in the test below in place of the shorter Proxy.

2. In the assignment POST branch, change the lookup to:

```js
      const invoice = [...state.invoices, ...state.servedOlderInvoices].find((row) => row.companyKey === body.company_key && row.invoiceId === body.invoice_id);
```

```js
test('older invoice picker adds a previous-day invoice to the current trip with an Older tag', async ({ page }) => {
  const state = await openBoard(page);
  const OLD = { ...ENTERPRISE, invoiceId: 'enterprise-old-001', docKey: 'enterprise-old-001', docNo: 'ENT-OLD-001',
    customer: { code: 'OLD', name: 'Kedai Semalam' } };
  state.trips[0].tripDate = currentKualaLumpurDate();
  state.olderInvoicesByDate = new Proxy({}, { get: (_target, date) => (typeof date === 'string' && date < currentKualaLumpurDate() ? [{ ...OLD, docDate: date }] : undefined) });
  await page.locator('#refreshBoard').click();
  await page.locator('#addOlderInvoiceButton').click();
  await expect(page.locator('#olderInvoiceDialog')).toBeVisible();
  await page.locator('#olderInvoiceSearch').fill('semalam');
  await page.locator('[data-older-invoice-key] input[type="checkbox"]').first().check();
  await page.locator('#olderInvoiceSubmit').click();
  await expect(page.locator('#olderInvoiceDialog')).toBeHidden();
  await expect.poll(() => state.assignmentBodies.at(-1)?.invoice_id).toBe('enterprise-old-001');
  await expect(page.locator('.invoice-date-tag-older').first()).toBeVisible();
});

test('older invoice picker tells the clerk to create a trip first when the day has none', async ({ page }) => {
  const state = await openBoard(page);
  state.trips.length = 0;
  await page.locator('#refreshBoard').click();
  await page.locator('#addOlderInvoiceButton').click();
  await expect(page.locator('#olderInvoiceMessage')).toHaveText('Create a trip for this day first.');
  await expect(page.locator('#olderInvoiceSubmit')).toBeDisabled();
});
```

The `Older` tag is rendered because the created assignment's `docDate` (yesterday) differs from fixture trip 101's `tripDate` (`2026-08-28`). The tag says `Dated · …` instead of `Older · …` because yesterday is after 2026-08-28. Assert on `.invoice-date-tag` rather than `.invoice-date-tag-older`. A more realistic alternative: before opening the picker, set `state.trips[0].tripDate = currentKualaLumpurDate()` and refresh the board; then the tag is `Older` and `.invoice-date-tag-older` is correct. Use that alternative.

Run: `npx playwright test test/e2e/dispatch-board.spec.js -g "older invoice picker"`
Expected: FAIL (`#addOlderInvoiceButton` not found).

- [ ] **Step 2: Add the markup** (`public/dispatch.html`)

In `.queue-heading-actions`, before `#newTripButton`:

```html
                  <button class="secondary-button" type="button" id="addOlderInvoiceButton">+ Add older invoice</button>
```

After the closing `</div>` of `#tripDialogBackdrop`:

```html
          <div class="dialog-backdrop" id="olderInvoiceBackdrop" hidden>
            <section class="trip-dialog older-invoice-dialog" id="olderInvoiceDialog" role="dialog" aria-modal="true" aria-labelledby="olderInvoiceTitle">
              <div class="section-heading">
                <div>
                  <p class="eyebrow">Previous-dated invoices</p>
                  <h2 id="olderInvoiceTitle">Add older invoice</h2>
                </div>
                <button class="secondary-button" type="button" id="closeOlderInvoice">Close</button>
              </div>
              <div class="older-invoice-filters">
                <label class="field-group" for="olderInvoiceDate"><span>Invoice date</span><input class="field-control" type="date" id="olderInvoiceDate" /></label>
                <label class="field-group" for="olderInvoiceCompany"><span>Company</span>
                  <select class="field-control" id="olderInvoiceCompany">
                    <option value="all">Both companies</option>
                    <option value="enterprise">Enterprise only</option>
                    <option value="sdn_bhd">Sdn Bhd only</option>
                  </select>
                </label>
                <label class="field-group" for="olderInvoiceSearch"><span>Search</span><input class="field-control" type="search" id="olderInvoiceSearch" placeholder="Invoice no. or customer…" autocomplete="off" /></label>
              </div>
              <div class="older-invoice-list" id="olderInvoiceList" aria-live="polite"></div>
              <label class="field-group" for="olderInvoiceTrip"><span>Add to trip</span><select class="field-control" id="olderInvoiceTrip"></select></label>
              <p class="dialog-message" id="olderInvoiceMessage" role="status" aria-live="polite"></p>
              <div class="older-invoice-actions">
                <button class="secondary-button" type="button" id="olderInvoiceRetry" hidden>Retry</button>
                <button class="primary-button" type="button" id="olderInvoiceSubmit" disabled>Add to trip</button>
              </div>
            </section>
          </div>
```

- [ ] **Step 3: Implement `mountInvoicePicker`** (append to `public/dispatch-invoice-picker.mjs`)

Extend the import at the top of the file:

```js
import {
  clampToDispatchWindow,
  filterPickerInvoices,
  filterUnassignedForDate,
  getDispatchWindow,
  getInvoiceKey,
  getTripNumbers,
  shiftDate,
} from './dispatch-state.mjs';
```

Then append:

```js
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
const COMPANY_LABELS = { enterprise: 'Enterprise', sdn_bhd: 'Sdn Bhd' };

function tripLabel(trip, numbers) {
  const lorry = trip.lorry?.registrationNo || trip.registrationNo || `Lorry ${trip.vehicleId ?? ''}`;
  const driver = trip.driver?.name ? ` · ${trip.driver.name}` : '';
  return `Trip ${numbers.get(String(trip.id)) ?? trip.id} · ${lorry}${driver}`;
}

export function mountInvoicePicker(root, { model, getBoardDate, getTrips, canWrite, onAssigned, onSessionLoss }) {
  const $ = (selector) => root.querySelector(selector);
  const backdrop = $('#olderInvoiceBackdrop');
  if (!backdrop) return { open: async () => {}, close: () => {} };
  const dateInput = $('#olderInvoiceDate'); const companySelect = $('#olderInvoiceCompany');
  const searchInput = $('#olderInvoiceSearch'); const list = $('#olderInvoiceList');
  const tripSelect = $('#olderInvoiceTrip'); const message = $('#olderInvoiceMessage');
  const submit = $('#olderInvoiceSubmit'); const retry = $('#olderInvoiceRetry');
  let invoices = []; let ticked = new Set(); let rowMessages = new Map(); let loadSequence = 0; let invoker = null; let busy = false;

  function trips() { return (getTrips() || []).filter((trip) => trip.status !== 'cancelled'); }
  function updateSubmit() { submit.disabled = busy || !canWrite() || !ticked.size || !tripSelect.value; }

  function renderList() {
    const visible = filterPickerInvoices(invoices, searchInput.value);
    list.innerHTML = visible.length ? visible.map((invoice) => {
      const key = getInvoiceKey(invoice.companyKey, invoice.invoiceId);
      const note = rowMessages.get(key);
      return `<label class="older-invoice-row" data-older-invoice-key="${escapeHtml(key)}">
        <input type="checkbox" value="${escapeHtml(key)}"${ticked.has(key) ? ' checked' : ''} />
        <span class="older-invoice-main"><strong>${escapeHtml(invoice.docNo)}</strong> · ${escapeHtml(COMPANY_LABELS[invoice.companyKey] || invoice.companyKey)}<br />${escapeHtml(invoice.customer?.name || invoice.customerName || '')}</span>
        <span class="older-invoice-date">${escapeHtml(invoice.docDate)}</span>
        ${note ? `<span class="older-invoice-error">${escapeHtml(note)}</span>` : ''}
      </label>`;
    }).join('') : '<p class="section-help">No unassigned invoices for this date.</p>';
    updateSubmit();
  }

  function renderTrips() {
    const dayTrips = trips();
    const numbers = getTripNumbers(dayTrips);
    const previous = tripSelect.value;
    tripSelect.innerHTML = dayTrips.map((trip) => `<option value="${escapeHtml(trip.id)}">${escapeHtml(tripLabel(trip, numbers))}</option>`).join('');
    if (dayTrips.some((trip) => String(trip.id) === previous)) tripSelect.value = previous;
    tripSelect.disabled = !dayTrips.length;
    if (!dayTrips.length) message.textContent = 'Create a trip for this day first.';
  }

  async function load() {
    const sequence = ++loadSequence;
    ticked = new Set(); rowMessages = new Map(); retry.hidden = true;
    list.innerHTML = '<p class="section-help">Loading invoices…</p>';
    if (trips().length) message.textContent = '';
    try {
      const result = await model.load({ date: dateInput.value, company: companySelect.value });
      if (sequence !== loadSequence) return;
      if (result.status === 'error') { invoices = []; list.innerHTML = ''; message.textContent = result.message; retry.hidden = false; updateSubmit(); return; }
      invoices = result.invoices;
      renderList();
    } catch (error) {
      if (error?.code === 'unauthorized') { close(); onSessionLoss(); }
    }
  }

  async function open(button = null) {
    if (!canWrite()) return;
    invoker = button;
    const { minDate, maxDate } = getDispatchWindow();
    dateInput.min = minDate; dateInput.max = maxDate;
    dateInput.value = clampToDispatchWindow(shiftDate(getBoardDate(), -1));
    searchInput.value = '';
    message.textContent = '';
    renderTrips();
    backdrop.hidden = false;
    dateInput.focus?.();
    await load();
  }

  function close() { backdrop.hidden = true; invoker?.focus?.(); invoker = null; }

  async function submitPicked() {
    const trip = trips().find((candidate) => String(candidate.id) === tripSelect.value);
    const picked = invoices.filter((invoice) => ticked.has(getInvoiceKey(invoice.companyKey, invoice.invoiceId)));
    if (!trip || !picked.length || !canWrite()) return;
    busy = true; updateSubmit(); message.textContent = `Adding ${picked.length} invoice(s)…`;
    try {
      const { results } = await model.assign({ invoices: picked, trip });
      const added = new Set(results.filter((row) => row.ok).map((row) => row.key));
      rowMessages = new Map(results.filter((row) => !row.ok).map((row) => [row.key, row.message]));
      invoices = invoices.filter((invoice) => !added.has(getInvoiceKey(invoice.companyKey, invoice.invoiceId)));
      ticked = new Set([...ticked].filter((key) => !added.has(key)));
      if (added.size) await onAssigned();
      if (!rowMessages.size) { close(); return; }
      message.textContent = `${added.size} added. ${rowMessages.size} could not be added.`;
      renderTrips(); renderList();
    } catch (error) {
      if (error?.code === 'unauthorized') { close(); onSessionLoss(); return; }
      message.textContent = 'Could not add invoices. Try again.';
    } finally { busy = false; updateSubmit(); }
  }

  $('#closeOlderInvoice')?.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  dateInput.addEventListener('change', () => { dateInput.value = clampToDispatchWindow(dateInput.value); load(); });
  companySelect.addEventListener('change', load);
  retry.addEventListener('click', load);
  searchInput.addEventListener('input', renderList);
  tripSelect.addEventListener('change', updateSubmit);
  list.addEventListener('change', (event) => {
    const box = event.target.closest?.('input[type="checkbox"]'); if (!box) return;
    if (box.checked) ticked.add(box.value); else ticked.delete(box.value);
    updateSubmit();
  });
  submit.addEventListener('click', () => { submitPicked(); });

  return { open, close };
}
```

- [ ] **Step 4: Wire it into `createDispatchApp`** (`public/dispatch.js`)

Add at the top:

```js
import { createInvoicePickerModel, mountInvoicePicker } from './dispatch-invoice-picker.mjs';
```

Inside `createDispatchApp`, just before the `root.querySelectorAll('[role="tab"]')` listener line:

```js
  const invoicePicker = mountInvoicePicker(root, {
    model: createInvoicePickerModel({
      transport,
      assignmentsTransport,
      createRequestId,
      reloadTrip: async (tripId) => {
        await loadBoard({ preserveMessage: true });
        return state.trips.find((trip) => String(trip.id) === String(tripId)) || null;
      },
    }),
    getBoardDate: () => selectedDate,
    getTrips: () => state.trips,
    canWrite: writesEnabled,
    onAssigned: async () => { state.statusMessage = 'Older invoice added to the trip.'; try { await loadBoard({ preserveMessage: true }); } catch { /* loadBoard renders the failure. */ } },
    onSessionLoss: handleSessionLoss,
  });
  $(root, '#addOlderInvoiceButton')?.addEventListener('click', (event) => { invoicePicker.open(event.currentTarget).catch(() => {}); });
```

`createDispatchApp` tests inject a `transport` without `loadPickerInvoices`. That is fine, because the model only calls it when the picker is opened, and the fake test document has no `#olderInvoiceBackdrop`, so `mountInvoicePicker` returns a no-op.

In `updateWriteControls`, also toggle the button: `const older = $(root, '#addOlderInvoiceButton'); if (older) older.disabled = !writesEnabled();`.

- [ ] **Step 5: Add the CSS** (append to `public/dispatch.css`)

```css
.older-invoice-dialog { max-width: 640px; width: calc(100vw - 32px); }
.older-invoice-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.older-invoice-list { display: grid; gap: 6px; max-height: 45vh; overflow-y: auto; margin: 10px 0; }
.older-invoice-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 4px 10px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  cursor: pointer;
}
.older-invoice-row input { width: 20px; height: 20px; }
.older-invoice-date { color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
.older-invoice-error { grid-column: 2 / -1; color: var(--amber); font-weight: 600; font-size: 0.85rem; }
.older-invoice-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 6: Update the service worker** (`public/sw.js`)

Change `CACHE_NAME` to `'sales-dashboard-v29'`, and add `'/dispatch-invoice-picker.mjs',` after `'/dispatch-state.mjs',`.

Then run `node --test test/service-worker.test.mjs`. If it asserts the exact current cache name or deleted-cache list, update only the expectations that encode the version number (v28 → v29). Do not weaken any other assertion.

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: 0 fail.

Run: `npx playwright test`
Expected: all PASS (desktop + mobile), including both new picker tests and the Task 4 date test.

- [ ] **Step 8: Check by eye on a phone-sized screen**

Start the static server from the e2e spec. Alternatively, run `npx playwright test -g "older invoice picker" --project=mobile --trace on` and open the trace. Check that:
- the dialog fits inside 393px width with no horizontal scroll;
- the rows are tappable;
- the date bar wraps cleanly.

- [ ] **Step 9: Commit**

```bash
git add public/dispatch-invoice-picker.mjs public/dispatch.html public/dispatch.css public/dispatch.js public/sw.js test/service-worker.test.mjs test/e2e/dispatch-board.spec.js
git commit -m "Dispatch: add older invoice picker dialog"
```

---

### Task 8: Record deviations in the spec and verify everything

**Files:**
- Modify: `docs/specs/2026-10-14-dispatch-older-invoices-design.md`

- [ ] **Step 1: Update the spec**
  - Replace section "2. Date window guard" with: "Enforced in the UI only (date input `min`/`max`, clamped prev/next/picker). No server guard: existing API tests use fixed 2026-08-28 dates without an injectable clock, and clerks are authenticated."
  - In section "1. Assignments API": remove `trip_date`. Add a note that `GET /api/dispatch/trips` already embeds each trip's assignments. Define active as `status NOT IN ('removed','failed','returned')`.
  - In "Frontend changes": rename the module to `public/dispatch-invoice-picker.mjs`. Change `loadBoard` to read assignments by `doc_date` only.
  - In "Testing": remove the window-guard API tests.
  - Update "Files touched" to match the File Map above.

- [ ] **Step 2: Final verification**

```bash
npm test
npx playwright test
git diff main --stat
```

Expected: unit tests 0 fail; Playwright all pass; the diff touches only the files in the File Map.

- [ ] **Step 3: Commit and push**

```bash
git add docs/specs/2026-10-14-dispatch-older-invoices-design.md
git commit -m "docs: align dispatch older-invoices spec with the implementation"
git push -u origin claude/zen-curie-5x52uh
```
