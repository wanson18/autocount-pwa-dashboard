# Today's Payment Status (Design Spec)

Date: 2026-08-14

## Problem

The dashboard shows sales totals for whatever date range is selected, but
gives no visibility into which of today's invoices have actually been paid.
The business wants a quick, always-current check: of today's invoices, how
much has been collected and how much is still outstanding — regardless of
what date range is currently browsed elsewhere on the dashboard.

## Goal

A new "Today's Payments" panel, always showing the current working day (per
the existing `getLocalToday()` reporting timezone), independent of the Date
Range picker. It shows:

- Paid / Partial / Unpaid counts and RM totals
- A headline "Still unpaid today" RM total
- A list of today's invoices, each tagged with its payment status, sorted by
  outstanding amount descending

## Non-goals

- Not tied to the Date Range picker — always "today," never affected by
  Yesterday/7 Days/30 Days/This Month selections.
- No new AutoCount API endpoint/report — reuses the existing
  `/invoice/listing` fetch already used by `/api/sales`.
- No payment actions (no recording payments, no reminders/notifications) —
  read-only display.
- No changes to existing KPI cards, charts, or the Product Breakdown table.
- No retry/multi-candidate field-name guessing — see "Unverified field"
  below.

## Backend changes — `api/sales.js`

### 1. Capture the outstanding balance per invoice

`normalizeInvoices()` currently reads `master.finalTotal || master.total` for
`grandTotal` but discards everything else on `master`. Add:

```js
outstandingAmount: parseOutstandingAmount(master.outstandingAmount),
```

where:

```js
function parseOutstandingAmount(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const parsed = parseFloat(rawValue);
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}
```

**Unverified field:** `master.outstandingAmount` is a best-guess field
name — nothing in this codebase has read invoice payment data before, and
AutoCount's exact API field name hasn't been confirmed against a live
response (web lookup was unavailable while writing this spec). If the field
is absent (`undefined`/`null`) on a real response, `outstandingAmount`
becomes `null` and the invoice is classified `unknown` (see below) rather
than silently treated as fully paid. Once a live sample confirms the real
field name, only the one field access above needs to change.

### 2. Classify payment status per invoice

```js
function classifyPaymentStatus(grandTotal, outstandingAmount) {
  if (outstandingAmount === null) return 'unknown';
  if (outstandingAmount <= 0) return 'paid';
  if (outstandingAmount >= grandTotal) return 'unpaid';
  return 'partial';
}
```

Add `paymentStatus: classifyPaymentStatus(grandTotal, outstandingAmount)` to
each normalized invoice.

### 3. Compute a payment summary

New function, alongside `computeKPIs`:

```js
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

`unknown` invoices are deliberately excluded from `stillUnpaidTotal` — we
can't claim they're unpaid any more than we can claim they're paid, so
they're surfaced as their own bucket instead of skewing the headline number
either direction.

### 4. Extend the API response

Add two new top-level fields to the response object built in the exported
handler, computed from the same `invoices` array already used for
`aggregateBySKU`/`computeKPIs` — for whatever date range was requested (no
special-casing "today" server-side):

```js
invoices: invoices.map(inv => ({
  docNo: inv.docNo,
  docDate: inv.docDate,
  customerName: inv.customerName,
  grandTotal: inv.grandTotal,
  outstandingAmount: inv.outstandingAmount,
  paymentStatus: inv.paymentStatus
})),
paymentSummary: computePaymentSummary(invoices)
```

(Line items are omitted from this trimmed list — not needed for payment
status, keeps the payload smaller.)

This is purely additive: `kpis`, `topSKUs`, and `skuBreakdown` are
unchanged.

## Frontend changes — `public/index.html`

### 1. Always-today fetch

New function `fetchTodayPayments()`, called once on page load (alongside the
existing `setPreset('today')` call) and once whenever the refresh button is
clicked — independent of `currentStartDate`/`currentEndDate`:

```js
async function fetchTodayPayments() {
  const res = await fetch('/api/sales');
  const data = await res.json();
  if (data.success) renderTodayPayments(data.invoices || [], data.paymentSummary);
}
```

No query params — the backend's own `getLocalToday()` decides "today," so
the frontend never computes its own idea of "today" that could drift from
the backend's reporting timezone.

### 2. New "Today's Payments" panel

Placed above the existing Date Range picker panel (signals independence
from it). Structure:

- Three stat tiles: Paid (count + RM, green), Partial (count + RM
  outstanding, amber), Unpaid (count + RM, red).
- Headline line: "Still unpaid today: RM X" (prominent — this is the number
  the user explicitly asked for).
- If `unknown.count > 0`, a small warning line: "N invoice(s) with
  unrecognized payment data — check manually" (amber/gray, low-key but
  visible).
- A compact invoice list below, one row per invoice: customer name, docNo
  (small/secondary), RM amount, status badge. Sorted by `outstandingAmount`
  descending (paid invoices have `outstandingAmount <= 0`, so they naturally
  sort last; unknown invoices — `outstandingAmount: null` — sort using `0`
  as the sort key so they don't scatter to the top).
- Empty state: if there are zero invoices today, show "No invoices yet
  today" instead of an empty panel.

### 3. Status badge styling

Reuse the existing color conventions already established by the KPI cards /
status dot (`emerald` for positive/paid, `amber` for partial/warning,
`red`-family for unpaid, `slate` for unknown) — consistent with
`status-online`/`status-offline` and `kpi-value` color classes already in
the stylesheet.

### 4. Shared helpers

Reuse the existing `escapeHtml()`, `formatMYR()`, `formatNumber()` helpers
already defined for the Product Breakdown table — no new formatting
utilities needed.

## Testing

Unit tests in `api/sales.test.js`, following the existing pattern:

- `classifyPaymentStatus`: paid (outstanding = 0), paid (outstanding
  negative — defensive), partial (0 < outstanding < total), unpaid
  (outstanding = total), unpaid (outstanding > total — defensive), unknown
  (outstanding = null).
- `computePaymentSummary`: mixed bucket of paid/partial/unpaid/unknown
  invoices produces correct counts, totals, and `stillUnpaidTotal`; empty
  invoice array produces an all-zero summary; confirms `unknown` invoices
  are excluded from `stillUnpaidTotal`.

Manual verification via `npx vercel dev` with `USE_MOCK_DATA=true`:

- `mock-sales.json` gets an `outstandingAmount` field added to each
  invoice — a mix of `0` (paid), a partial value less than `grandTotal`
  (partial), and a value equal to `grandTotal` (unpaid) — so all three
  buckets render.
- Confirm the "Today's Payments" panel renders regardless of which Date
  Range preset is active (e.g., select "7 Days" and confirm the panel still
  shows the same today-only figures).
- Confirm "Still unpaid today" equals partial outstanding + unpaid total by
  hand-checking against the mock data.
