# Delivery dispatch: show the loading plan only once a trip exists

Date: 2026-10-06 · Base: `origin/main` at `70346c7` (pastel theme and desktop layout, PR #9)
Scope: `public/dispatch.html`, `public/dispatch.css`, `public/dispatch.js`, `public/sw.js`, tests

## Problem

From 960px up the Board is two columns (`public/dispatch.css`, `@media (min-width: 960px)`): a 320–400px "Unassigned invoices" column on the left and the "Lorry lanes / Physical loading plan" panel filling the rest. The queue is a single-column list, so on a day with about 40 unassigned invoices only one card is fully visible at a time (measured at 1440×900 and at 1920×1080). The loading plan also takes most of the screen before any trip exists, showing an empty lane per lorry with "Start trip for this lorry". Below 960px the queue is a one-row strip that scrolls sideways above the plan.

## Goal

See more unassigned invoices at once. Show the loading plan only after a trip has been added, so invoices can be dragged into it.

## Behaviour

"Has trips" means the Board returned at least one trip for its date (today, Asia/Kuala_Lumpur). Trips are persisted, so a refresh keeps the plan visible.

### No trips

- The loading plan (`#loadingPlan`, the whole "Physical loading plan / Lorry lanes" panel) is hidden. No lanes, no empty lanes, no "Start trip for this lorry".
- The Unassigned panel spans the full Board width. `#unassignedList` is a wrapping grid (`repeat(auto-fill, minmax(min(100%, 230px), 1fr))`, the width of the old rail cards) whose rows flow downward: 5 columns at 1440px, 6 at 1920px, 1 on a phone. No sideways scroll, no height cap.
- Invoice cards drop the "Assign to selected trip" button and the "Drag / select" hint and are not draggable, because there is nothing to assign to. "Select invoice" stays.
- The queue help text says to add a trip first, instead of pointing at lorries that are not on screen.

### Trips exist

- `#loadingPlan` is visible with unchanged contents (lanes, driver pickers, drag and tap assignment, Remove, Print Items).
- 960px and up: two columns, the queue `minmax(0, 1fr)` as a multi-column grid and the plan `clamp(340px, 30vw, 440px)`. The queue panel is sticky (`top: 12px`, `max-height: calc(100vh - 24px)`) and its grid scrolls inside it, so the lanes can be scrolled while the invoices stay pinned and drag works across both without moving the page.
- Below 960px: stacked, queue first. The grid is capped at `min(55vh, 520px)` with its own scroll so the lanes stay within reach (keeps the phone "select an invoice, then tap a lane" flow short).
- Cards show the assign button and drag hint as before. The date stays on one line (`white-space: nowrap`) now that cards are narrower than the old single column.

### `+ New trip`

Moves from the plan header into the Unassigned panel header so it exists in both states. It stays a single element with `id="newTripButton"`; existing handlers, disabled-state wiring and e2e lookups (`getByRole('button', { name: /New trip/ })`) keep working.

## Measured (40 invented invoices, Playwright, fully visible cards in the first screen)

| Viewport | Before | No trips | With trips (page top / queue pinned) |
| --- | --- | --- | --- |
| 1440×900 | 1 | 5 | 3 / 6 |
| 1920×1080 | 1 | 12 | 4 |

## Unchanged

Lane rendering (including a lane per active lorry once the plan is visible), trip dialog and creation flow, assignment and removal flows, drop on `[data-drop-unassigned]` returning an invoice to the queue, `dispatch-state.mjs`, the API and persistence, and the Trips / Reports / Resources tabs.

## Edge cases

- Before the first board load, or after a load error, no trips are known, so the plan is hidden. The Board already shows its loading or error line and a disabled `+ New trip`.
- A refresh keeps `state.trips`, so the plan does not flicker.
- Creating the first trip: dialog, create, board reload, plan appears. `+ New trip` is a static element that `renderDispatchBoard` only enables or disables, so its handler and the trip-dialog flow are unchanged.
- Staging an invoice for a lorry (`stageInvoiceForLorry`) is only reachable from lanes, so it is unaffected.

## Implementation notes

- Hooks are IDs (`#boardLayout`, `#loadingPlan`, `#queueHelp`) so the repo's fake-DOM unit tests, which only resolve `#id` selectors, can assert them. `renderDispatchBoard` guards each lookup, so existing fakes that omit them keep working.
- `renderInvoiceCard` gains an `assignable` option defaulting to `true`, so existing callers and tests are unaffected.
- The theme's existing `@media (min-width: 960px)` board rules (fixed 320–400px queue column, single-column list) are replaced by rules scoped to `[data-has-trips="true"]`; the 960px breakpoint is reused so the Board switches layout at the same width as the rest of the desktop UI.
- `public/sw.js` pre-caches the dispatch assets, so `CACHE_NAME` goes `sales-dashboard-v18` → `v19` (main is already at `v18`) and the two tests that pin it are updated.
- `test/e2e/responsive-layout.spec.js` asserted the plan beside the queue with no trips; it now asserts the plan hidden with no trips, then appearing beside (wide) or below (phone) once a trip exists.

## Testing

- Unit (`node --test`): `renderInvoiceCard` with `assignable: false`; `renderDispatchBoard` sets `#loadingPlan.hidden`, `#boardLayout.dataset.hasTrips` and the `#queueHelp` text from the trip count.
- E2E (Playwright, desktop 1280px and Pixel 5): no trips gives a hidden plan and a multi-column full-width grid (single column on phones); `+ New trip` creates a trip, the plan appears and the invoice can be assigned; with a trip the plan sits beside the queue on desktop (both in view) and below it on phones.
- Visual check: screenshots of both states at 1440, 1920 and phone widths, against an untouched export of `origin/main` for the "before".

## Known failures on untouched `origin/main` (not part of this change)

- `test/e2e/dispatch-board.spec.js` "HTTP 401 … returns to login": expects `#loginView`, which `dispatch.html` has not had since `528d579`.
- `test/vercel-regions.test.mjs` and three `test/version-stamp.test.mjs` tests: Windows-only path bug (`new URL(import.meta.url).pathname` becomes `D:\D:\…`).
