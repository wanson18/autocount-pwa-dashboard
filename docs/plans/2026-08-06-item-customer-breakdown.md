# Item → Customer Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user click an item row in the Product Breakdown table and see, in an expandable detail row, the list of customers who bought that item and the quantity each one bought, sorted by quantity descending.

**Architecture:** Extend the existing `aggregateBySKU()` function in `api/sales.js` to tally quantity per customer per SKU and attach it as a `customers` array on each SKU object (purely additive to the existing response shape). Extend the existing Product Breakdown table in `public/index.html` with a shared row-builder function that renders each item as two `<tr>`s: the existing summary row (now with a chevron) plus an initially-hidden detail row listing customers; a click on the row toggles the detail row.

**Tech Stack:** Vanilla JS (no framework), Tailwind CSS via CDN, Chart.js (unaffected), Node.js serverless function (Vercel), Node's built-in `node:test`/`node:assert` for the one unit-testable piece of logic (no new dependencies).

## Global Constraints

- Node >= 18.0.0 (from `package.json` engines) — `node:test` is available.
- No new npm dependencies — this feature is achievable with what's already installed (`axios`, `dotenv`) plus Node's built-in test runner.
- The `/api/sales` response must stay backward compatible: existing fields (`totalRevenue`, `totalUnits`, `orderCount`, `totalCost`, `avgPricePerUnit`, `sku`, `description`) are unchanged; `customers` is a new, additive field.
- Frontend stays vanilla JS/HTML in `public/index.html` — no build step, no new script includes (matches `"build": "echo 'No build step required...'"` in `package.json`).
- Customer names and item descriptions are external data (from AutoCount/customer records) interpolated into `innerHTML` — must be HTML-escaped.

---

### Task 1: Backend — per-customer quantity breakdown in `aggregateBySKU`

**Files:**
- Modify: `api/sales.js:94-121` (the `aggregateBySKU` function) and the `module.exports` at the bottom of the file (`api/sales.js:147`)
- Create: `api/sales.test.js`

**Interfaces:**
- Produces: `aggregateBySKU(invoices)` now returns objects that additionally include `customers: Array<{ name: string, quantity: number }>`, sorted by `quantity` descending. `aggregateBySKU` becomes importable via `require('./sales.js').aggregateBySKU` for testing (the module's default export — the Vercel request handler — is unchanged and still directly callable).

- [ ] **Step 1: Write the failing test**

Create `api/sales.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateBySKU } = require('./sales.js');

test('aggregateBySKU groups quantity sold per customer, sorted descending', () => {
  const invoices = [
    {
      customerName: 'ABC Trading Sdn Bhd',
      grandTotal: 6250,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 50, unitPrice: 125, total: 6250 }
      ]
    },
    {
      customerName: 'XYZ Industries Ltd',
      grandTotal: 3750,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 30, unitPrice: 125, total: 3750 }
      ]
    },
    {
      customerName: 'ABC Trading Sdn Bhd',
      grandTotal: 1250,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 10, unitPrice: 125, total: 1250 }
      ]
    }
  ];

  const [result] = aggregateBySKU(invoices);

  assert.equal(result.sku, 'OIL-PKO-20L');
  assert.deepEqual(result.customers, [
    { name: 'ABC Trading Sdn Bhd', quantity: 60 },
    { name: 'XYZ Industries Ltd', quantity: 30 }
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/sales.test.js`
Expected: FAIL — either `aggregateBySKU` is `undefined` (not yet exported) or `result.customers` is `undefined` (not yet computed).

- [ ] **Step 3: Implement the customer breakdown**

Replace the body of `aggregateBySKU` (`api/sales.js:94-121`) with:

```js
function aggregateBySKU(invoices) {
  const skuMap = {};

  for (const invoice of invoices) {
    for (const item of (invoice.lineItems || [])) {
      if (!skuMap[item.sku]) {
        skuMap[item.sku] = {
          sku: item.sku,
          description: item.description,
          totalRevenue: 0,
          totalUnits: 0,
          orderCount: 0,
          totalCost: 0,
          customerQuantities: {}
        };
      }
      skuMap[item.sku].totalRevenue = Math.round((skuMap[item.sku].totalRevenue + item.total) * 100) / 100;
      skuMap[item.sku].totalUnits = Math.round((skuMap[item.sku].totalUnits + item.quantity) * 100) / 100;
      skuMap[item.sku].orderCount += 1;
      skuMap[item.sku].totalCost = Math.round((skuMap[item.sku].totalCost + item.unitPrice * item.quantity) * 100) / 100;
      skuMap[item.sku].customerQuantities[invoice.customerName] =
        (skuMap[item.sku].customerQuantities[invoice.customerName] || 0) + item.quantity;
    }
  }

  return Object.values(skuMap).map(({ customerQuantities, ...sku }) => ({
    ...sku,
    totalRevenue: Math.round(sku.totalRevenue * 100) / 100,
    avgPricePerUnit: sku.totalUnits ? Math.round((sku.totalRevenue / sku.totalUnits) * 100) / 100 : 0,
    customers: Object.entries(customerQuantities)
      .map(([name, quantity]) => ({ name, quantity: Math.round(quantity * 100) / 100 }))
      .sort((a, b) => b.quantity - a.quantity)
  })).sort((a, b) => b.totalRevenue - a.totalRevenue);
}
```

Then, immediately after the existing `module.exports = async (req, res) => { ... };` block at the bottom of `api/sales.js` (currently ending at `api/sales.js:204`), add:

```js
module.exports.aggregateBySKU = aggregateBySKU;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/sales.test.js`
Expected: PASS (1 test passed).

- [ ] **Step 5: Commit**

```bash
git add api/sales.js api/sales.test.js
git commit -m "Add per-customer quantity breakdown to SKU aggregation"
```

---

### Task 2: Frontend — expandable customer detail rows in Product Breakdown table

**Files:**
- Modify: `public/index.html:308-339` (`renderTable` and `filterTable` functions)

**Interfaces:**
- Consumes: `skus` arrays where each item is a `skuBreakdown`/`topSKUs` entry from `/api/sales`, now including `customers: Array<{ name: string, quantity: number }>` (produced by Task 1).
- Produces: `buildTableRows(skus)`, `buildCustomerList(customers)`, `escapeHtml(str)`, `toggleRow(i)` — new helper functions used by `renderTable` and `filterTable`.

- [ ] **Step 1: Replace `renderTable`/`filterTable` with a shared row builder**

Replace the entire block from `function renderTable(skus) {` through the end of `function filterTable() { ... }` (`public/index.html:308-339`) with:

```js
    function escapeHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function buildCustomerList(customers) {
      if (!customers || customers.length === 0) {
        return '<div class="text-slate-500 text-xs px-2 py-1">No customer data</div>';
      }
      return customers.map(c => `
        <div class="flex justify-between px-2 py-1 text-xs">
          <span class="text-slate-300">${escapeHtml(c.name)}</span>
          <span class="text-slate-400">${c.quantity.toLocaleString()}</span>
        </div>
      `).join('');
    }

    function buildTableRows(skus) {
      return skus.map((s, i) => `
        <tr class="hover:bg-slate-750 cursor-pointer" onclick="toggleRow(${i})">
          <td class="px-3 py-2 text-xs">
            <div class="flex items-center gap-1.5">
              <svg id="chevron-${i}" class="w-3 h-3 text-slate-500 transition-transform duration-150 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
              <div>
                <div class="text-white font-medium">${escapeHtml(s.description || s.sku)}</div>
                <div class="text-slate-500 text-[10px] mt-0.5">${escapeHtml(s.sku)}</div>
              </div>
            </div>
          </td>
          <td class="px-3 py-2 text-right">${s.totalUnits.toLocaleString()}</td>
          <td class="px-3 py-2 text-right text-emerald-400">RM ${s.totalRevenue.toLocaleString('en-MY', {minimumFractionDigits: 2})}</td>
        </tr>
        <tr id="detail-${i}" class="hidden bg-slate-900/50">
          <td colspan="3" class="px-3 pb-2 pt-1">
            ${buildCustomerList(s.customers)}
          </td>
        </tr>
      `).join('');
    }

    function toggleRow(i) {
      document.getElementById(`detail-${i}`).classList.toggle('hidden');
      document.getElementById(`chevron-${i}`).classList.toggle('rotate-90');
    }

    function renderTable(skus) {
      allSKUData = skus;
      document.getElementById('skuTableBody').innerHTML = buildTableRows(skus);
      document.getElementById('tableSkeleton').classList.add('hidden');
      document.getElementById('skuTable').classList.remove('hidden');
    }

    function filterTable() {
      const query = document.getElementById('searchInput').value.toLowerCase();
      const filtered = allSKUData.filter(s => (s.description || '').toLowerCase().includes(query) || s.sku.toLowerCase().includes(query));
      document.getElementById('skuTableBody').innerHTML = buildTableRows(filtered);
    }
```

- [ ] **Step 2: Start the dev server with mock data**

```bash
cp -n .env.example .env.local || true
```

Edit `.env.local` and set `USE_MOCK_DATA=true` (if `AUTOCOUNT_*` credentials aren't set, `api/sales.js` already falls back to mock data automatically, but setting this explicitly makes the test deterministic).

Run: `npx vercel dev`
Expected: Server starts, prints a local URL (typically `http://localhost:3000`).

- [ ] **Step 3: Manually verify the expand/collapse behavior**

Open the local URL in a browser. In the "Date Range" card, set the custom start date to `2025-07-01` and end date to `2025-08-31`, then click "Go" (the mock data in `api/mock-sales.json` is dated July–August 2025; this range guarantees the fallback data renders regardless of caching — note the mock fallback in `api/sales.js` ignores the date range entirely, so "Today" would also show it, but setting real dates avoids ambiguity from cached responses).

In the "Product Breakdown" table:
- Confirm every row shows a small chevron (▸) to the left of the product name.
- Click the "Palm Kernel Oil 20L Drum" row. Confirm a detail panel expands beneath it showing:
  - `ABC Trading Sdn Bhd` with quantity `60`
  - `XYZ Industries Ltd` with quantity `80`

  Wait — recompute from `api/mock-sales.json`: INV-2025-001 (ABC, qty 50) + INV-2025-003 (ABC, qty 40) = ABC 90; INV-2025-005 (XYZ, qty 80) = XYZ 80. Confirm the row shows `ABC Trading Sdn Bhd — 90` listed above `XYZ Industries Ltd — 80` (sorted highest quantity first).
- Confirm the chevron rotates 90° while expanded.
- Click the row again and confirm it collapses and the chevron rotates back.
- Expand two different rows at once and confirm both stay expanded independently.
- Type into the search box (e.g. "soap") and confirm the table filters correctly and previously-expanded rows reset to collapsed.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Add expandable customer breakdown to Product Breakdown table rows"
```

---

## Self-Review Notes

- **Spec coverage:** Backend `customers` field (Task 1) ✓; in-place accordion UI, chevron, quantity-only, sorted descending, "No customer data" fallback, shared row builder, `escapeHtml` (Task 2) ✓; manual verification per spec's Testing section (Task 2 Step 3) ✓.
- **Placeholder scan:** No TBD/TODO; all steps contain literal code or exact manual actions with expected values.
- **Type consistency:** `customers: Array<{ name, quantity }>` is identical in the Task 1 backend output and the Task 2 `buildCustomerList`/`escapeHtml` consumers. Function names (`buildTableRows`, `buildCustomerList`, `escapeHtml`, `toggleRow`) are used consistently within Task 2 since both are implemented in one task.
