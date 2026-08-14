# Today's Payment Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Today's Payments" panel that always shows the current
working day's invoices (independent of the dashboard's date range picker),
broken into Paid/Partial/Unpaid buckets with counts and RM totals, a "still
unpaid today" headline figure, and a list of today's invoices sorted by
outstanding amount with a status badge each.

**Architecture:** Extend the existing `/api/sales` endpoint (already
parametrized by `startDate`/`endDate`) to read each invoice's outstanding
balance, classify it as paid/partial/unpaid/unknown, and include a trimmed
per-invoice list plus a computed summary in the JSON response — purely
additive, no new endpoint, computed for whatever range was requested. The
frontend adds one more `fetch('/api/sales')` call with no date params (the
backend's own timezone-aware `getLocalToday()` decides "today"), independent
of whatever range is selected in the existing Date Range picker, rendering
into a new fixed panel above it.

**Tech Stack:** Vanilla JS (no framework), Tailwind CSS via CDN, Chart.js
(unaffected), Node.js serverless function (Vercel), Node's built-in
`node:test`/`node:assert` (no new dependencies).

## Global Constraints

- Node >= 18.0.0 (from `package.json` engines) — `node:test` is available.
- No new npm dependencies.
- The `/api/sales` response must stay backward compatible: `kpis`,
  `topSKUs`, `skuBreakdown` are unchanged; `invoices` and `paymentSummary`
  are new, additive fields.
- Frontend stays vanilla JS/HTML in `public/index.html` — no build step, no
  new script includes.
- Customer names and document numbers are external data (from
  AutoCount/customer records) interpolated into `innerHTML` — must be
  HTML-escaped via the existing `escapeHtml()` helper.
- The exact AutoCount field name for an invoice's outstanding balance is
  **unverified** — nothing in this codebase has read invoice payment data
  before, and a web lookup was unavailable while designing this feature.
  Code reads `master.outstandingAmount` as a best guess but must fail safe:
  a missing/unreadable field produces `paymentStatus: 'unknown'`, never a
  silent `'paid'` or a wrong amount. See `docs/specs/2026-08-14-todays-payment-status-design.md`.
- `api/mock-sales.json` currently uses `invoiceNo`/`date` field names that
  don't match what `normalizeInvoices()` produces (`docNo`/`docDate`) —
  nothing previously read those fields by name in mock mode, but this
  plan's invoice list is the first feature that does, so Task 3 corrects
  the mock fixture to match the real contract.

---

### Task 1: Backend — capture outstanding balance in `normalizeInvoices`

**Files:**
- Modify: `api/sales.js:107-126` (`normalizeInvoices`) and `module.exports` at the bottom of the file (`api/sales.js:262-263`)
- Modify: `api/sales.test.js:3` (require line) and end of file (new tests)

**Interfaces:**
- Produces: `parseOutstandingAmount(rawValue)` → `number | null` (rounds to
  2 decimals; `null` if the value is missing/non-numeric). `normalizeInvoices(rawInvoices)`
  now also returns `outstandingAmount: number | null` per invoice, alongside
  the existing `docNo`, `docDate`, `customerName`, `grandTotal`,
  `lineItems`. Both `parseOutstandingAmount` and `normalizeInvoices` become
  importable via `require('./sales.js')` (previously only `aggregateBySKU`
  and `getLocalToday` were exported).

- [ ] **Step 1: Write the failing tests**

Update the require line at the top of `api/sales.test.js` (currently line 3):

```js
const { aggregateBySKU, getLocalToday, normalizeInvoices, parseOutstandingAmount } = require('./sales.js');
```

Then append to the end of `api/sales.test.js`:

```js
test('parseOutstandingAmount parses a numeric string and rounds to 2 decimals', () => {
  assert.equal(parseOutstandingAmount('1234.5678'), 1234.57);
});

test('parseOutstandingAmount returns null when the value is missing', () => {
  assert.equal(parseOutstandingAmount(undefined), null);
  assert.equal(parseOutstandingAmount(null), null);
});

test('parseOutstandingAmount returns null for a non-numeric value', () => {
  assert.equal(parseOutstandingAmount('not-a-number'), null);
});

test('normalizeInvoices reads outstandingAmount from the raw invoice master record', () => {
  const rawInvoices = [
    {
      master: {
        docNo: 'SI-001',
        docDate: '2026-08-14',
        debtorName: 'ABC Trading Sdn Bhd',
        finalTotal: '1000.00',
        outstandingAmount: '250.00'
      },
      details: []
    }
  ];

  const [result] = normalizeInvoices(rawInvoices);

  assert.equal(result.grandTotal, 1000);
  assert.equal(result.outstandingAmount, 250);
});

test('normalizeInvoices sets outstandingAmount to null when AutoCount does not return the field', () => {
  const rawInvoices = [
    {
      master: {
        docNo: 'SI-002',
        docDate: '2026-08-14',
        debtorName: 'XYZ Industries Ltd',
        finalTotal: '500.00'
      },
      details: []
    }
  ];

  const [result] = normalizeInvoices(rawInvoices);

  assert.equal(result.outstandingAmount, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test api/sales.test.js`
Expected: FAIL — `normalizeInvoices` and `parseOutstandingAmount` are `undefined` (not yet exported).

- [ ] **Step 3: Implement `parseOutstandingAmount` and wire it into `normalizeInvoices`**

Immediately above `function normalizeInvoices(rawInvoices) {` (`api/sales.js:107`), add:

```js
function parseOutstandingAmount(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const parsed = parseFloat(rawValue);
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}
```

Replace the body of `normalizeInvoices` (`api/sales.js:107-126`) with:

```js
function normalizeInvoices(rawInvoices) {
  return rawInvoices.map(inv => {
    const master = inv.master || inv;
    const details = inv.details || [];

    return {
      docNo: master.docNo || '',
      docDate: master.docDate || '',
      customerName: master.debtorName || master.customerName || '',
      grandTotal: Math.round(parseFloat(master.finalTotal || master.total || 0) * 100) / 100,
      outstandingAmount: parseOutstandingAmount(master.outstandingAmount),
      lineItems: details.map(d => ({
        sku: d.productCode || d.sku || '',
        description: d.description || '',
        quantity: parseFloat(d.qty || d.quantity || 0),
        unitPrice: parseFloat(d.unitPrice || 0),
        total: parseFloat(d.subTotal || d.total || 0),
      })),
    };
  });
}
```

At the bottom of `api/sales.js`, after the existing export lines
(`api/sales.js:262-263`), add:

```js
module.exports.normalizeInvoices = normalizeInvoices;
module.exports.parseOutstandingAmount = parseOutstandingAmount;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test api/sales.test.js`
Expected: PASS (all tests, including the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add api/sales.js api/sales.test.js
git commit -m "Capture outstanding balance when normalizing AutoCount invoices"
```

---

### Task 2: Backend — payment status classification and summary

**Files:**
- Modify: `api/sales.js` (add two new functions after `computeKPIs`, before `module.exports = async (req, res) => {`, currently around `api/sales.js:191`; extend `module.exports` at the bottom)
- Modify: `api/sales.test.js` (require line and new tests)

**Interfaces:**
- Consumes: nothing new — these are pure functions over plain data.
- Produces: `classifyPaymentStatus(grandTotal, outstandingAmount)` →
  `'paid' | 'partial' | 'unpaid' | 'unknown'`. `computePaymentSummary(invoices)` →
  `{ paid: {count, total}, partial: {count, outstanding}, unpaid: {count, total}, unknown: {count, total}, stillUnpaidTotal }`,
  where each `invoice` in the input array is expected to already carry
  `grandTotal`, `outstandingAmount`, and `paymentStatus` (that last field is
  attached by Task 3's handler change — this task's own tests set it
  directly on fixture objects, since `computePaymentSummary` just reads it).

- [ ] **Step 1: Write the failing tests**

Update the require line at the top of `api/sales.test.js` (modified in
Task 1) to:

```js
const { aggregateBySKU, getLocalToday, normalizeInvoices, parseOutstandingAmount, classifyPaymentStatus, computePaymentSummary } = require('./sales.js');
```

Append to the end of `api/sales.test.js`:

```js
test('classifyPaymentStatus returns paid when outstanding is zero', () => {
  assert.equal(classifyPaymentStatus(1000, 0), 'paid');
});

test('classifyPaymentStatus returns paid when outstanding is negative (defensive)', () => {
  assert.equal(classifyPaymentStatus(1000, -0.01), 'paid');
});

test('classifyPaymentStatus returns partial when outstanding is between 0 and the total', () => {
  assert.equal(classifyPaymentStatus(1000, 400), 'partial');
});

test('classifyPaymentStatus returns unpaid when outstanding equals the total', () => {
  assert.equal(classifyPaymentStatus(1000, 1000), 'unpaid');
});

test('classifyPaymentStatus returns unpaid when outstanding exceeds the total (defensive)', () => {
  assert.equal(classifyPaymentStatus(1000, 1200), 'unpaid');
});

test('classifyPaymentStatus returns unknown when outstanding is null or undefined', () => {
  assert.equal(classifyPaymentStatus(1000, null), 'unknown');
  assert.equal(classifyPaymentStatus(1000, undefined), 'unknown');
});

test('computePaymentSummary tallies counts and totals per bucket', () => {
  const invoices = [
    { grandTotal: 1000, outstandingAmount: 0, paymentStatus: 'paid' },
    { grandTotal: 2000, outstandingAmount: 0, paymentStatus: 'paid' },
    { grandTotal: 500, outstandingAmount: 200, paymentStatus: 'partial' },
    { grandTotal: 800, outstandingAmount: 800, paymentStatus: 'unpaid' },
    { grandTotal: 300, outstandingAmount: null, paymentStatus: 'unknown' }
  ];

  const summary = computePaymentSummary(invoices);

  assert.deepEqual(summary, {
    paid: { count: 2, total: 3000 },
    partial: { count: 1, outstanding: 200 },
    unpaid: { count: 1, total: 800 },
    unknown: { count: 1, total: 300 },
    stillUnpaidTotal: 1000
  });
});

test('computePaymentSummary returns an all-zero summary for an empty invoice list', () => {
  const summary = computePaymentSummary([]);

  assert.deepEqual(summary, {
    paid: { count: 0, total: 0 },
    partial: { count: 0, outstanding: 0 },
    unpaid: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
    stillUnpaidTotal: 0
  });
});

test('computePaymentSummary excludes unknown invoices from stillUnpaidTotal', () => {
  const invoices = [
    { grandTotal: 5000, outstandingAmount: null, paymentStatus: 'unknown' }
  ];

  const summary = computePaymentSummary(invoices);

  assert.equal(summary.stillUnpaidTotal, 0);
  assert.equal(summary.unknown.total, 5000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test api/sales.test.js`
Expected: FAIL — `classifyPaymentStatus` and `computePaymentSummary` are `undefined`.

- [ ] **Step 3: Implement both functions**

Immediately after the `computeKPIs` function and before
`module.exports = async (req, res) => {` (`api/sales.js`, around line 191),
add:

```js
function classifyPaymentStatus(grandTotal, outstandingAmount) {
  if (outstandingAmount === null || outstandingAmount === undefined) return 'unknown';
  if (outstandingAmount <= 0) return 'paid';
  if (outstandingAmount >= grandTotal) return 'unpaid';
  return 'partial';
}

function computePaymentSummary(invoices) {
  const summary = {
    paid: { count: 0, total: 0 },
    partial: { count: 0, outstanding: 0 },
    unpaid: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
    stillUnpaidTotal: 0
  };

  for (const invoice of invoices) {
    const { grandTotal, outstandingAmount, paymentStatus } = invoice;

    if (paymentStatus === 'paid') {
      summary.paid.count += 1;
      summary.paid.total = Math.round((summary.paid.total + grandTotal) * 100) / 100;
    } else if (paymentStatus === 'partial') {
      summary.partial.count += 1;
      summary.partial.outstanding = Math.round((summary.partial.outstanding + outstandingAmount) * 100) / 100;
      summary.stillUnpaidTotal = Math.round((summary.stillUnpaidTotal + outstandingAmount) * 100) / 100;
    } else if (paymentStatus === 'unpaid') {
      summary.unpaid.count += 1;
      summary.unpaid.total = Math.round((summary.unpaid.total + grandTotal) * 100) / 100;
      summary.stillUnpaidTotal = Math.round((summary.stillUnpaidTotal + grandTotal) * 100) / 100;
    } else {
      summary.unknown.count += 1;
      summary.unknown.total = Math.round((summary.unknown.total + grandTotal) * 100) / 100;
    }
  }

  return summary;
}
```

At the bottom of `api/sales.js`, after the exports added in Task 1, add:

```js
module.exports.classifyPaymentStatus = classifyPaymentStatus;
module.exports.computePaymentSummary = computePaymentSummary;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test api/sales.test.js`
Expected: PASS (all tests, including the 9 new ones).

- [ ] **Step 5: Commit**

```bash
git add api/sales.js api/sales.test.js
git commit -m "Add payment status classification and summary aggregation"
```

---

### Task 3: Backend — wire payment status into the API response

**Files:**
- Modify: `api/sales.js:230-248` (the exported handler body, between `if (!invoices) { ... }` and the `result` object)
- Modify: `api/mock-sales.json` (full-file rewrite: field names + new `outstandingAmount`)
- Modify: `README.md` (example response)

**Interfaces:**
- Consumes: `classifyPaymentStatus` and `computePaymentSummary` (Task 2),
  `normalizeInvoices` producing `outstandingAmount` (Task 1).
- Produces: the `/api/sales` JSON response gains `invoices: Array<{docNo, docDate, customerName, grandTotal, outstandingAmount, paymentStatus}>`
  and `paymentSummary` (shape from Task 2), computed for whatever date range
  was requested. This is the last backend task — Task 4 (frontend) consumes
  these two fields.

This task isn't unit-testable at the handler level (the existing codebase
has no HTTP-mocking test infra for the exported handler — it's verified
manually via a running dev server, same as every other change to this
function). Verification is manual, in Step 4 below.

- [ ] **Step 1: Replace the entire contents of `api/mock-sales.json`**

This corrects a pre-existing field-name mismatch: `normalizeInvoices()`
(Task 1) produces `docNo`/`docDate`, but the mock fixture has always used
`invoiceNo`/`date` instead — invisible until now because nothing read those
fields by name in mock mode. The new `invoices` list (Step 2 below) is the
first thing that does, so this fixes the fixture to match the real
contract. It also adds `outstandingAmount` to each invoice — a mix of paid
(`0`), partial (less than `grandTotal`), unpaid (equal to `grandTotal`), and
one invoice with the field omitted entirely, to exercise all four payment
buckets in manual testing:

```json
{
  "invoices": [
    {
      "docNo": "INV-2025-001",
      "docDate": "2025-07-15",
      "customerName": "ABC Trading Sdn Bhd",
      "status": "Posted",
      "lineItems": [
        {
          "sku": "OIL-PKO-20L",
          "description": "Palm Kernel Oil 20L Drum",
          "quantity": 50,
          "unitPrice": 125.00,
          "total": 6250.00
        },
        {
          "sku": "OIL-CPO-19L",
          "description": "Crude Palm Oil 19L Tin",
          "quantity": 30,
          "unitPrice": 98.50,
          "total": 2955.00
        }
      ],
      "subtotal": 9205.00,
      "tax": 552.30,
      "grandTotal": 9757.30,
      "outstandingAmount": 0
    },
    {
      "docNo": "INV-2025-002",
      "docDate": "2025-07-18",
      "customerName": "XYZ Industries Ltd",
      "status": "Posted",
      "lineItems": [
        {
          "sku": "OIL-CPO-19L",
          "description": "Crude Palm Oil 19L Tin",
          "quantity": 100,
          "unitPrice": 98.50,
          "total": 9850.00
        },
        {
          "sku": "OIL-RBD-25L",
          "description": "RBD Palm Oil 25L Jerry Can",
          "quantity": 20,
          "unitPrice": 142.00,
          "total": 2840.00
        },
        {
          "sku": "SOAP-BASE-1KG",
          "description": "Soap Base Granules 1kg",
          "quantity": 200,
          "unitPrice": 8.50,
          "total": 1700.00
        }
      ],
      "subtotal": 14390.00,
      "tax": 863.40,
      "grandTotal": 15253.40,
      "outstandingAmount": 5000
    },
    {
      "docNo": "INV-2025-003",
      "docDate": "2025-07-22",
      "customerName": "ABC Trading Sdn Bhd",
      "status": "Posted",
      "lineItems": [
        {
          "sku": "OIL-PKO-20L",
          "description": "Palm Kernel Oil 20L Drum",
          "quantity": 40,
          "unitPrice": 125.00,
          "total": 5000.00
        },
        {
          "sku": "SOAP-BASE-1KG",
          "description": "Soap Base Granules 1kg",
          "quantity": 150,
          "unitPrice": 8.50,
          "total": 1275.00
        }
      ],
      "subtotal": 6275.00,
      "tax": 376.50,
      "grandTotal": 6651.50,
      "outstandingAmount": 6651.50
    },
    {
      "docNo": "INV-2025-004",
      "docDate": "2025-07-28",
      "customerName": "Maju Jaya Enterprise",
      "status": "Posted",
      "lineItems": [
        {
          "sku": "OIL-RBD-25L",
          "description": "RBD Palm Oil 25L Jerry Can",
          "quantity": 60,
          "unitPrice": 142.00,
          "total": 8520.00
        },
        {
          "sku": "OIL-CPO-19L",
          "description": "Crude Palm Oil 19L Tin",
          "quantity": 25,
          "unitPrice": 98.50,
          "total": 2462.50
        }
      ],
      "subtotal": 10982.50,
      "tax": 658.95,
      "grandTotal": 11641.45,
      "outstandingAmount": 0
    },
    {
      "docNo": "INV-2025-005",
      "docDate": "2025-08-01",
      "customerName": "XYZ Industries Ltd",
      "status": "Posted",
      "lineItems": [
        {
          "sku": "OIL-PKO-20L",
          "description": "Palm Kernel Oil 20L Drum",
          "quantity": 80,
          "unitPrice": 125.00,
          "total": 10000.00
        },
        {
          "sku": "OIL-RBD-25L",
          "description": "RBD Palm Oil 25L Jerry Can",
          "quantity": 45,
          "unitPrice": 142.00,
          "total": 6390.00
        },
        {
          "sku": "SOAP-BASE-1KG",
          "description": "Soap Base Granules 1kg",
          "quantity": 300,
          "unitPrice": 8.50,
          "total": 2550.00
        }
      ],
      "subtotal": 18940.00,
      "tax": 1136.40,
      "grandTotal": 20076.40
    }
  ]
}
```

Note `INV-2025-005` has no `outstandingAmount` key at all (not even
`null`) — this is what exercises the `unknown` bucket, since a live
AutoCount response missing the field would look the same.

- [ ] **Step 2: Modify the handler to attach payment status and extend the response**

Replace the block from `if (!invoices) {` through the end of the `result`
object (`api/sales.js:230-248`) with:

```js
    if (!invoices) {
      const mockData = loadMockData();
      invoices = mockData.invoices || mockData;
      dataSource = 'mock';
    }

    invoices = invoices.map(invoice => ({
      ...invoice,
      paymentStatus: classifyPaymentStatus(invoice.grandTotal, invoice.outstandingAmount)
    }));

    const aggregated = aggregateBySKU(invoices);
    const kpis = computeKPIs(invoices);
    const paymentSummary = computePaymentSummary(invoices);

    const result = {
      success: true,
      cached: false,
      dataSource,
      timestamp: new Date().toISOString(),
      dateRange: { startDate, endDate },
      kpis,
      topSKUs: aggregated.slice(0, 5),
      skuBreakdown: aggregated,
      invoices: invoices.map(invoice => ({
        docNo: invoice.docNo,
        docDate: invoice.docDate,
        customerName: invoice.customerName,
        grandTotal: invoice.grandTotal,
        outstandingAmount: invoice.outstandingAmount,
        paymentStatus: invoice.paymentStatus
      })),
      paymentSummary
    };
```

- [ ] **Step 3: Update the README example response**

In `README.md`, replace the example response block (currently
`README.md:101-115`):

```json
{
  "success": true,
  "dateRange": { "startDate": "2026-08-03", "endDate": "2026-08-03" },
  "kpis": {
    "totalRevenue": 40773.3,
    "totalInvoices": 29,
    "totalItemsSold": 1234,
    "avgOrderValue": 1405.98,
    "topCustomer": { "name": "Customer A", "revenue": 12000 }
  },
  "topSKUs": [...],
  "skuBreakdown": [...]
}
```

with:

```json
{
  "success": true,
  "dateRange": { "startDate": "2026-08-03", "endDate": "2026-08-03" },
  "kpis": {
    "totalRevenue": 40773.3,
    "totalInvoices": 29,
    "totalItemsSold": 1234,
    "avgOrderValue": 1405.98,
    "topCustomer": { "name": "Customer A", "revenue": 12000 }
  },
  "topSKUs": [...],
  "skuBreakdown": [...],
  "invoices": [
    { "docNo": "SI-00123", "docDate": "2026-08-03", "customerName": "Customer A", "grandTotal": 12000, "outstandingAmount": 0, "paymentStatus": "paid" }
  ],
  "paymentSummary": {
    "paid": { "count": 20, "total": 28000 },
    "partial": { "count": 3, "outstanding": 4200 },
    "unpaid": { "count": 6, "total": 8573.3 },
    "unknown": { "count": 0, "total": 0 },
    "stillUnpaidTotal": 12773.3
  }
}
```

- [ ] **Step 4: Start the dev server with mock data and verify the response**

```bash
cp -n .env.example .env.local || true
```

Edit `.env.local` and set `USE_MOCK_DATA=true`.

Run: `npx vercel dev`
Expected: Server starts, prints a local URL (typically `http://localhost:3000`).

In another terminal, run:

```bash
curl -s "http://localhost:3000/api/sales" | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(JSON.stringify(d.paymentSummary, null, 2)); console.log(d.invoices.map(i => `${i.docNo} ${i.paymentStatus} ${i.outstandingAmount}`));"
```

Expected `paymentSummary`:

```json
{
  "paid": { "count": 2, "total": 21398.75 },
  "partial": { "count": 1, "outstanding": 5000 },
  "unpaid": { "count": 1, "total": 6651.5 },
  "unknown": { "count": 1, "total": 20076.4 },
  "stillUnpaidTotal": 11651.5
}
```

Expected `invoices` statuses: `INV-2025-001 paid 0`, `INV-2025-002 partial 5000`,
`INV-2025-003 unpaid 6651.5`, `INV-2025-004 paid 0`, `INV-2025-005 unknown null`.

- [ ] **Step 5: Run the full test suite once more**

Run: `node --test api/sales.test.js`
Expected: PASS (unaffected by this task's changes — this just confirms
Steps 1-2 didn't break anything Tasks 1-2 already covered).

- [ ] **Step 6: Commit**

```bash
git add api/sales.js api/mock-sales.json README.md
git commit -m "Wire payment status into the sales API response"
```

---

### Task 4: Frontend — "Today's Payments" panel

**Files:**
- Modify: `public/index.html` (new panel markup, new rendering functions, init/refresh wiring)

**Interfaces:**
- Consumes: `data.invoices` and `data.paymentSummary` from `/api/sales`
  (Task 3) — `paymentSummary` shape: `{ paid: {count, total}, partial: {count, outstanding}, unpaid: {count, total}, unknown: {count, total}, stillUnpaidTotal }`;
  each item in `invoices` has `{ docNo, docDate, customerName, grandTotal, outstandingAmount, paymentStatus }`.
  Reuses existing helpers `$()`, `escapeHtml()`, `formatMYR()`, `formatNumber()`.
- Produces: `fetchTodayPayments()`, `renderTodayPayments(invoices, summary)`,
  `buildPaymentRow(invoice)`, `sortByOutstandingDesc(invoices)`.

- [ ] **Step 1: Add the panel markup**

In `public/index.html`, insert immediately after the `lastUpdated` div and
before the `<!-- ===== Date range picker ===== -->` comment (currently
`public/index.html:144-146`):

```html
      <!-- ===== Today's Payments ===== -->
      <section class="panel mt-4 p-3">
        <div class="flex items-center gap-2 mb-3">
          <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 7h6m-6 4h6m-6 4h4M5 3h14a2 2 0 012 2v14l-3-2-3 2-3-2-3 2-3-2-3 2V5a2 2 0 012-2z"
            />
          </svg>
          <span class="text-xs font-semibold text-slate-300">Today's Payments</span>
        </div>

        <div id="paymentSkeleton" class="space-y-2">
          <div class="skeleton h-4 rounded w-full"></div>
          <div class="skeleton h-4 rounded w-3/4"></div>
        </div>

        <div id="paymentContent" class="hidden">
          <div class="grid grid-cols-3 gap-2 mb-3">
            <div class="bg-slate-900 rounded-lg p-2 text-center">
              <div class="text-[10px] text-slate-400">Paid</div>
              <div id="paymentPaidCount" class="text-sm font-bold text-emerald-400">--</div>
              <div id="paymentPaidTotal" class="text-[10px] text-slate-400">--</div>
            </div>
            <div class="bg-slate-900 rounded-lg p-2 text-center">
              <div class="text-[10px] text-slate-400">Partial</div>
              <div id="paymentPartialCount" class="text-sm font-bold text-amber-400">--</div>
              <div id="paymentPartialTotal" class="text-[10px] text-slate-400">--</div>
            </div>
            <div class="bg-slate-900 rounded-lg p-2 text-center">
              <div class="text-[10px] text-slate-400">Unpaid</div>
              <div id="paymentUnpaidCount" class="text-sm font-bold text-red-400">--</div>
              <div id="paymentUnpaidTotal" class="text-[10px] text-slate-400">--</div>
            </div>
          </div>

          <div class="flex items-center justify-between px-1 py-2 border-t border-slate-700">
            <span class="text-xs text-slate-300">Still unpaid today</span>
            <span id="stillUnpaidTotal" class="text-base font-bold text-red-400">--</span>
          </div>

          <div id="paymentUnknownWarning" class="hidden text-[10px] text-amber-400 px-1 pb-2"></div>

          <div id="paymentInvoiceList" class="divide-y divide-slate-700"></div>
        </div>
      </section>
```

- [ ] **Step 2: Add the rendering functions**

Insert immediately after the `filterTable` function and before the
`/* ------------------------------- Init ---------------------------------- */`
comment (currently `public/index.html:562-564`):

```js
      /* ------------------------- Today's Payments ----------------------------- */

      const PAYMENT_STATUS_META = {
        paid: { label: 'Paid', badgeClass: 'bg-emerald-500/20 text-emerald-400' },
        partial: { label: 'Partial', badgeClass: 'bg-amber-500/20 text-amber-400' },
        unpaid: { label: 'Unpaid', badgeClass: 'bg-red-500/20 text-red-400' },
        unknown: { label: 'Unknown', badgeClass: 'bg-slate-500/20 text-slate-400' },
      };

      const EMPTY_PAYMENT_SUMMARY = {
        paid: { count: 0, total: 0 },
        partial: { count: 0, outstanding: 0 },
        unpaid: { count: 0, total: 0 },
        unknown: { count: 0, total: 0 },
        stillUnpaidTotal: 0,
      };

      async function fetchTodayPayments() {
        try {
          const res = await fetch('/api/sales');
          if (!res.ok) throw new Error(`Request failed with status ${res.status}`);

          const data = await res.json();
          if (!data.success) throw new Error(data.error || 'Request was not successful');

          renderTodayPayments(data.invoices || [], data.paymentSummary);
        } catch (error) {
          console.error('Today payments fetch error:', error);
        }
      }

      function sortByOutstandingDesc(invoices) {
        return [...invoices].sort((a, b) => (b.outstandingAmount || 0) - (a.outstandingAmount || 0));
      }

      function buildPaymentRow(invoice) {
        const meta = PAYMENT_STATUS_META[invoice.paymentStatus] || PAYMENT_STATUS_META.unknown;
        return `
        <div class="flex items-center justify-between px-1 py-1.5 text-xs">
          <div class="min-w-0">
            <div class="text-white truncate">${escapeHtml(invoice.customerName || 'Unknown customer')}</div>
            <div class="text-slate-500 text-[10px]">${escapeHtml(invoice.docNo)}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="text-slate-300">${formatMYR(invoice.grandTotal)}</span>
            <span class="${meta.badgeClass} px-1.5 py-0.5 rounded text-[10px] font-medium">${meta.label}</span>
          </div>
        </div>`;
      }

      function renderTodayPayments(invoices, summary) {
        $('paymentSkeleton').classList.add('hidden');
        $('paymentContent').classList.remove('hidden');

        const safeSummary = summary || EMPTY_PAYMENT_SUMMARY;

        $('paymentPaidCount').textContent = formatNumber(safeSummary.paid.count);
        $('paymentPaidTotal').textContent = formatMYR(safeSummary.paid.total);
        $('paymentPartialCount').textContent = formatNumber(safeSummary.partial.count);
        $('paymentPartialTotal').textContent = formatMYR(safeSummary.partial.outstanding);
        $('paymentUnpaidCount').textContent = formatNumber(safeSummary.unpaid.count);
        $('paymentUnpaidTotal').textContent = formatMYR(safeSummary.unpaid.total);
        $('stillUnpaidTotal').textContent = formatMYR(safeSummary.stillUnpaidTotal);

        const warningEl = $('paymentUnknownWarning');
        if (safeSummary.unknown.count > 0) {
          warningEl.textContent = `${safeSummary.unknown.count} invoice(s) with unrecognized payment data — check manually`;
          warningEl.classList.remove('hidden');
        } else {
          warningEl.classList.add('hidden');
        }

        const listEl = $('paymentInvoiceList');
        if (invoices.length === 0) {
          listEl.innerHTML = '<div class="text-slate-500 text-xs px-1 py-2">No invoices yet today</div>';
          return;
        }
        listEl.innerHTML = sortByOutstandingDesc(invoices).map(buildPaymentRow).join('');
      }
```

- [ ] **Step 3: Wire `fetchTodayPayments()` into page load and the refresh button**

Replace the refresh button listener inside `bindEvents()` (currently
`public/index.html:577`):

```js
        $('refreshBtn').addEventListener('click', () => fetchData(currentStartDate, currentEndDate));
```

with:

```js
        $('refreshBtn').addEventListener('click', () => {
          fetchData(currentStartDate, currentEndDate);
          fetchTodayPayments();
        });
```

Replace the `window.addEventListener('load', ...)` block (currently
`public/index.html:595-600`):

```js
      window.addEventListener('load', () => {
        registerServiceWorker();
        bindEvents();
        updateOnlineStatus();
        setPreset('today');
      });
```

with:

```js
      window.addEventListener('load', () => {
        registerServiceWorker();
        bindEvents();
        updateOnlineStatus();
        setPreset('today');
        fetchTodayPayments();
      });
```

- [ ] **Step 4: Manually verify in the browser**

`npx vercel dev` should still be running from Task 3 with `USE_MOCK_DATA=true`
(if not, start it again). Open `http://localhost:3000` in a browser.

Confirm the "Today's Payments" panel (above "Date Range") shows:
- **Paid**: `2` / `RM 21,398.75`
- **Partial**: `1` / `RM 5,000.00`
- **Unpaid**: `1` / `RM 6,651.50`
- **Still unpaid today**: `RM 11,651.50`
- A warning line: `1 invoice(s) with unrecognized payment data — check manually`
- An invoice list with 5 rows in this order (sorted by outstanding amount
  descending): `INV-2025-003` (red "Unpaid" badge), `INV-2025-002` (amber
  "Partial" badge), `INV-2025-001` (green "Paid" badge), `INV-2025-004`
  (green "Paid" badge), `INV-2025-005` (gray "Unknown" badge).

Click the "7 Days" preset button. Confirm the KPI cards and Product
Breakdown table below update, but the "Today's Payments" panel numbers
stay exactly the same — proving it's independent of the date range picker.

Click the refresh button (circular arrow, top right). Confirm the "Today's
Payments" panel briefly shows its skeleton loader, then repopulates with
the same numbers.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Add Today's Payments panel to the dashboard"
```

---

## Self-Review Notes

- **Spec coverage:** Outstanding balance captured in `normalizeInvoices`
  (Task 1) ✓; paid/partial/unpaid/unknown classification (Task 2) ✓;
  payment summary with `stillUnpaidTotal` excluding unknown (Task 2) ✓;
  API response gains `invoices`/`paymentSummary`, additive only (Task 3) ✓;
  fail-safe "unverified field" behavior (Tasks 1-2, called out in Global
  Constraints) ✓; always-today fetch independent of the date picker (Task 4
  Step 3, verified in Step 4) ✓; totals + invoice list UI, sorted by
  outstanding descending, status badges, empty/unknown states (Task 4) ✓;
  unit tests for the new pure functions + manual verification for the
  handler and UI (Tasks 1-4) ✓.
- **Placeholder scan:** No TBD/TODO. The one open item flagged in Global
  Constraints (unverified AutoCount field name) is a documented, concrete
  design decision with real fallback code — not an unfinished step.
- **Type consistency:** `paymentSummary` shape (`paid`/`partial`/`unpaid`/`unknown`
  with `count` + `total`/`outstanding`, plus `stillUnpaidTotal`) is
  identical across Task 2's implementation, Task 2's tests, Task 3's README
  example, and Task 4's `renderTodayPayments`/`EMPTY_PAYMENT_SUMMARY`.
  `paymentStatus` string values (`'paid'`, `'partial'`, `'unpaid'`,
  `'unknown'`) are consistent between `classifyPaymentStatus` (Task 2),
  `computePaymentSummary`'s branches (Task 2), and `PAYMENT_STATUS_META`'s
  keys (Task 4). Invoice field names (`docNo`, `docDate`, `customerName`,
  `grandTotal`, `outstandingAmount`, `paymentStatus`) match between Task 1's
  `normalizeInvoices`, Task 3's trimmed `invoices` response mapping, and
  Task 4's `buildPaymentRow`/`sortByOutstandingDesc`.
