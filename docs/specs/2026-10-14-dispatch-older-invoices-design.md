# Dispatch: Board Date Picker + Older Invoice Picker (Design Spec)

Date: 2026-10-14

## Problem

The clerk cannot put a previous-dated invoice onto a delivery trip. The
Dispatch board is locked to today (Asia/Kuala_Lumpur): it loads only
today's invoices and today's trips (`getDefaultDateRange()` in
`public/dispatch-state.mjs`, used by `loadBoard` and `createTrip` in
`public/dispatch.js`). There is no way to:

- **A.** Add an older, undelivered invoice (e.g. yesterday's) to today's trip.
- **B.** Open another day's board (past or upcoming) and add invoices to
  that day's trips.

The backend already accepts any `doc_date` on an assignment and any
`trip_date` on a trip, so the gap is mainly in the UI.

Secondary bug: the board decides whether an invoice is "already on a trip"
from `/api/dispatch/assignments?limit=100` (the latest 100 assignments
only). For older dates this can miss assignments and show an already-assigned
invoice as unassigned. The database unique constraint still blocks a double
assignment (`invoice_already_assigned`), so this is a display bug, not a data
bug.

## Goal

1. A **board date picker** so the clerk can view and edit any day from
   **today − 7 to today + 7** (Malaysia time).
2. An **"+ Add older invoice" picker** that lists unassigned invoices for
   **one chosen date** and adds the ticked ones to a trip on the board's
   current day.
3. "Already on a trip" is decided by an assignment lookup **filtered by
   invoice date**, not by "latest 100".

## Non-goals

- No date-range (multi-day) invoice listing in the picker — one date at a time.
- No search-by-invoice-number across many days.
- No new database tables or migrations.
- No change to the loading sheet or reports beyond working with whatever
  trip date is selected.
- Past days are not read-only — every day in the window is editable.

## UI

### Board date picker

- Replaces the fixed "Today" heading (`#boardDateLabel`) with:
  `◀ Prev day | <date input> | Next day ▶ | Today`.
- Bounds: `min = today − 7`, `max = today + 7` (Asia/Kuala_Lumpur).
  Prev/Next buttons disable at the bounds; the date input uses `min`/`max`.
- Changing the date reloads the board (invoices + trips + assignments) for
  that date.
- **New trip** uses the selected board date as `trip_date`
  (currently `getDefaultDateRange().startDate`).
- Trip dialog help text names the selected date.
- When the selected date ≠ today, a yellow banner shows:
  `Viewing <formatted date> — not today`.
- The selected date is **not** persisted; reloading the page returns to today.

### "+ Add older invoice" picker

- Button placed in the Unassigned panel header. Opens a dialog with:
  - **Date** input — default = selected board date − 1 day; bounds same as
    the board (today ± 7).
  - **Company** filter — All / Enterprise / Sdn Bhd (reuses `COMPANY_FILTERS`).
  - **Search** box — client-side filter on doc no. and customer name
    (case-insensitive substring), applied as the clerk types.
  - **List** of invoices for that date that are **not on any trip**:
    checkbox, doc no., customer, doc date, item summary.
  - **Trip** select — trips on the selected board date (non-cancelled),
    labelled with trip number, lorry and driver as on the board.
  - **Add to trip** button — disabled until ≥ 1 invoice ticked and a trip
    chosen.
- If the board date has no trips, the dialog shows
  `Create a trip for this day first` and the Add button is disabled.
- On success, the dialog closes and the board reloads. Added invoices
  appear on the trip card.

### "Older" tag

- On trip cards and invoice cards, when an invoice's `docDate` ≠ the
  trip's `tripDate` (or, for unassigned cards, ≠ the board date), show a
  small tag: `Older · 12 Oct` (formatted with `formatKualaLumpurDate`).
  For an invoice dated after the trip date, the tag reads `Dated · 15 Oct`.

## Backend changes

> **As built (2026-10-14).** This section records what was implemented. It
> differs from the first draft in three agreed ways: there is no server-side
> date-window guard, no `trip_date` filter, and the new module is `.mjs`.
> See "Changes from the first draft" at the end.

### 1. Assignments API — `doc_date` filter

`api/dispatch-assignments.js` + `lib/dispatch/repository.js`
(`listAssignments`):

- `doc_date` is added to `ASSIGNMENT_QUERY_KEYS` and validated with the
  existing `dateField` (YYYY-MM-DD). It cannot be combined with
  `assignment_id`.
- With `doc_date`, the repository adds `doc_date = $n` and returns only
  **holding** assignments: `status NOT IN ('removed', 'failed', 'returned')`.
  This is the same rule as the unique index
  `delivery_assignments_active_invoice_idx`, so a failed or returned invoice
  shows as available again. Cancelled trips cannot hold active assignments,
  because the trip cancel guard requires the trip to be empty first.
- With `doc_date`, the limit cap is **1000** (default 1000). Without it, the
  cap stays at 100.
- No `trip_date` filter is needed: `GET /api/dispatch/trips` already embeds
  each trip's `assignments`. That is how older invoices already on the day's
  trips render.

### 2. Date window (today ± 7, Asia/Kuala_Lumpur)

The UI enforces the window: the date input's `min`/`max`, Prev/Next buttons
that disable at the edges, and every chosen date clamped through
`clampToDispatchWindow`. There is **no server-side guard**, for two reasons:
- Existing API tests use fixed 2026-08-28 dates without an injectable clock,
  so a guard tied to the real clock would break them.
- Clerks are authenticated, so bypassing the UI gains nothing.

### 3. No change

- `POST /api/dispatch/assignments` already accepts any `doc_date`.
- The loading sheet and reports are already keyed by trip.

## Frontend changes

### `public/dispatch-state.mjs`

- `shiftDate(date, days)`, `getDispatchWindow(now)` (returns
  `{ today, minDate, maxDate }`) and `clampToDispatchWindow(date, now)`.
- `filterUnassignedForDate(invoices, assignments)` keeps eligible,
  non-cancelled invoices that have no holding assignment, keyed by company.
- `filterPickerInvoices(invoices, search)` filters by doc no. or customer
  (substring, case-insensitive).
- `getInvoiceDateTag(docDate, referenceDate)` returns
  `{ kind: 'older' | 'newer', label }` or `null`.

### `public/dispatch.js`

- The controller holds `selectedDate` (initially today). `loadBoard`,
  `createTrip`, the date bar, the banner and the trip-dialog help text all
  use it. Results for a date that is no longer selected are ignored.
- The Reports tab dates are **not** changed by the board date.
- The board transport reads assignments with
  `?doc_date=<board date>&limit=1000`. This replaces `?limit=100`, which
  returned the oldest 100 rows.
- `transport.loadPickerInvoices({ date, company })` fetches the invoices and
  the holding assignments for one date.
- Compact trip invoice cards show `Older · 12 Oct` / `Dated · 15 Oct` when
  the invoice date differs from the trip date.
- The app object exposes `setBoardDate(date)` and `getBoardDate()`.

### `public/dispatch-invoice-picker.mjs` (new module)

- `createInvoicePickerModel({ transport, assignmentsTransport, reloadTrip, createRequestId })`
  has no DOM and is unit-tested:
  - `load({ date, company })` returns
    `{ status: 'ready', invoices, sources, warning }` or
    `{ status: 'error', message }`. `unauthorized` is rethrown.
  - `assign({ invoices, trip })` adds invoices sequentially, carrying the trip
    revision forward. On `stale_trip` it reloads the trip and retries that
    invoice once. It returns per-invoice results.
- `mountInvoicePicker(root, {...})` handles the dialog DOM: open/close, date
  (default board date − 1, clamped), company filter, live search,
  checkboxes, trip select, and submit. Rows that were added successfully
  leave the list. Failed rows stay ticked with their message.

### `public/dispatch.html` / `dispatch.css` / `sw.js`

- Date bar (`#boardDate`, `#boardPrevDay`, `#boardNextDay`, `#boardToday`)
  and the yellow `#boardDateBanner`.
- The "+ Add older invoice" button and the `#olderInvoiceBackdrop` dialog.
- Service worker cache bumped to v29, with the picker module cached.

## Error handling

| Situation | Behaviour |
|---|---|
| AutoCount unavailable for the picker date | Dialog shows `Couldn't load invoices for <date>. Try again.` with a Retry button. The board is unaffected. |
| One company book unavailable | The list shows the other company's invoices, plus `<Company> invoices couldn't be loaded, so this list may be incomplete.` and a Retry button. |
| Invoice assigned by someone else meanwhile (`invoice_already_assigned`) | That row shows `Already on another trip.` Other rows continue. |
| Trip revision conflict | The board reloads and that invoice is retried once. If it still fails, the row shows `Trip changed — reopen and try again.` |
| Session expired (`unauthorized`) | Existing `handleSessionLoss()` path. The dialog closes. |
| No trips on the board day | `Create a trip for this day first.` The Add button stays disabled. |

## Testing

- **API** (`api/dispatch-assignments.test.js`): the `doc_date` filter returns
  only holding rows for that date. Validation covers bad dates,
  `assignment_id` combined with `doc_date`, and the 1000 cap applying only
  with `doc_date`.
- **State** (`test/dispatch-dates.test.mjs`): date helpers across month,
  year and leap boundaries and the KL midnight boundary; picker filters;
  the date tag; transport URLs; tag rendering on trip cards.
- **Picker model** (`test/dispatch-invoice-picker.test.mjs`): load,
  load failure, unauthorized, sequential assign, already-assigned, stale
  retry (one retry, then give up), and the source warning.
- **App** (`test/dispatch-state.test.mjs`): the board date reloads the chosen
  day and clamps to the window.
- **E2E** (`test/e2e/dispatch-board.spec.js`):
  - The date picker switches day, shows the banner, and creates trips on the
    chosen day.
  - The picker adds a previous-day invoice to today's trip with the `Older`
    tag.
  - The picker shows the no-trips message.
- 12 older tests in this e2e spec already failed on `main` before this work,
  because their selectors no longer match the screen. They are tracked
  separately.

## Changes from the first draft

1. No server-side date-window guard (see Backend §2).
2. No `trip_date` assignment filter (see Backend §1).
3. The module is `public/dispatch-invoice-picker.mjs`, not `.js`.
4. "On a trip" excludes `failed` and `returned` as well as `removed`,
   matching the database's unique index.

## Files touched

- `api/dispatch-assignments.js`, `lib/dispatch/repository.js`
- `public/dispatch.html`, `public/dispatch.css`, `public/dispatch.js`,
  `public/dispatch-state.mjs`, `public/dispatch-invoice-picker.mjs` (new),
  `public/sw.js`
- Tests: `api/dispatch-assignments.test.js`, `test/dispatch-dates.test.mjs`
  (new), `test/dispatch-invoice-picker.test.mjs` (new),
  `test/dispatch-state.test.mjs`, `test/service-worker.test.mjs`,
  `test/price-check-ui.test.mjs` (cache version only),
  `test/e2e/dispatch-board.spec.js`
