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

### 1. Assignments API — `doc_date` filter

`api/dispatch-assignments.js` + `lib/dispatch/repository.js`
(`listAssignments`):

- Add `doc_date` and `trip_date` to `ASSIGNMENT_QUERY_KEYS`; validate both
  with the existing `dateField` (YYYY-MM-DD).
- Repository adds `assignments.doc_date = $n` / `trips.trip_date = $n` when
  provided (join to `delivery_trips` already available).
- Only active assignments count as "on a trip": rows with status `removed`
  and rows whose trip is `cancelled` are excluded when `doc_date` is given
  (same rule the board uses today for "unassigned").
- When `doc_date` or `trip_date` is set, the limit cap rises from 100 to
  **1000** (a single day never approaches this); the unfiltered call keeps
  the current cap of 100.

### 2. Date window guard (today ± 7, Asia/Kuala_Lumpur)

A shared helper `lib/dispatch/date-window.js`:

- `getDispatchWindow(now) → { minDate, maxDate, today }`
- `isWithinDispatchWindow(date, now) → boolean`

Applied to:

- `GET /api/dispatch/invoices` — both `startDate` and `endDate` must be
  inside the window, else `400 invalid_request`.
- `POST /api/dispatch/trips` — `trip_date` must be inside the window,
  else `400 invalid_request`.
- `GET /api/dispatch/trips` and `GET /api/dispatch/assignments` are **not**
  restricted (reports and loading sheets read older trips).

### 3. No change

- `POST /api/dispatch/assignments` — already accepts any `doc_date`.
- Loading sheet and reports — already keyed by trip.

## Frontend changes

### `public/dispatch-state.mjs`

- `getDispatchWindow(now)` mirroring the server helper (min/max/today).
- `shiftDate(date, days)` pure helper (YYYY-MM-DD in, YYYY-MM-DD out).
- `filterUnassignedForDate(invoices, assignments)` — returns invoices whose
  `(companyKey, invoiceId)` is not in the active assignments list.
- `filterPickerInvoices(invoices, search)` — doc no. / customer substring
  filter.
- `isOlderInvoice(invoice, referenceDate)` — returns
  `'older' | 'newer' | null` for the tag.

### `public/dispatch.js`

- New `selectedDate` held in the controller (initial = today).
- `loadBoard` uses `selectedDate` and fetches assignments twice in
  parallel: `doc_date=selectedDate` (which of this day's invoices are taken)
  and `trip_date=selectedDate` (what is on this day's trips, including older
  invoices). Results are merged by assignment id. The `limit=100` call is
  removed.
- `createTrip` body uses `selectedDate`.
- Date bar wiring, banner, tag rendering.

### `public/dispatch-invoice-picker.js` (new module)

- Owns the dialog: open/close, load (`/api/dispatch/invoices?startDate=D&endDate=D&company=C`
  + `/api/dispatch/assignments?doc_date=D&limit=1000`), search filter, render,
  submit.
- Submit calls the existing `assignmentsTransport.assignInvoice` once per
  ticked invoice **sequentially** (each needs the trip's latest revision; on
  success the revision is incremented locally from the response).
- Per-row results: success rows are removed from the list; failures stay
  ticked with an inline message.
- Exposes `openInvoicePicker({ boardDate, trips, onAssigned })` to
  `dispatch.js`.

### `public/dispatch.html`

- Date bar markup in the board header.
- `<dialog id="olderInvoiceDialog">` markup.
- Yellow banner element.
- `public/sw.js` cache list updated with the new module.

## Error handling

| Situation | Behaviour |
|---|---|
| AutoCount unavailable for the picker date | Dialog shows `Couldn't load invoices for <date>. Try again.` with a Retry button; board unaffected. |
| One source company unavailable | List shows the other company's invoices plus the existing source warning text (`getSourceMessage`). |
| Invoice assigned by someone else meanwhile (`invoice_already_assigned`) | That row shows `Already on another trip`; other rows continue. |
| Trip revision conflict | Re-fetch trip, retry that invoice once; if it still fails, show `Trip changed — reopen and try again`. |
| Session expired (`unauthorized`) | Existing `handleSessionLoss()` path; dialog closes. |
| Date outside window (server 400) | Should not happen via UI; dialog shows `Date not allowed`. |

## Testing

- **Unit (`api/`)**
  - `dispatch-assignments.test.js`: `doc_date` and `trip_date` filters
    accepted/validated; removed and cancelled-trip rows excluded; 1000 cap
    only with a date filter.
  - `dispatch-invoices.test.js` / `dispatch-trips.test.js`: window guard
    accepts today − 7 and today + 7, rejects − 8 and + 8.
  - New `lib/dispatch/date-window` tests across the KL midnight boundary.
- **State (`test/` for `dispatch-state.mjs`)**
  - `shiftDate`, `getDispatchWindow`, `filterUnassignedForDate`,
    `filterPickerInvoices`, `isOlderInvoice`.
- **E2E (Playwright)**
  - Switch board to yesterday and back to today; banner appears/disappears.
  - Open picker, pick yesterday, search by doc no., add to today's trip;
    the trip card shows the invoice with the `Older` tag; reopening the
    picker no longer lists it.

## Files touched

- `api/dispatch-assignments.js`, `api/dispatch-invoices.js`, `api/dispatch-trips.js`
- `lib/dispatch/repository.js`, `lib/dispatch/date-window.js` (new)
- `public/dispatch.html`, `public/dispatch.js`, `public/dispatch-state.mjs`,
  `public/dispatch-invoice-picker.js` (new), `public/sw.js`
- Tests listed above
