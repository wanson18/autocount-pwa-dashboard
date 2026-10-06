# Dispatch Conditional Loading Plan Implementation Plan (as built)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the delivery loading plan until a trip exists so the unassigned invoices fill the full width as a wrapping grid, then show the plan beside the invoices once a trip is added.

**Architecture:** `renderDispatchBoard` derives `hasTrips = state.trips.length > 0` on every render and toggles three static hooks (`#loadingPlan[hidden]`, `#boardLayout[data-has-trips]`, `#queueHelp` text); CSS keys the two layouts off `data-has-trips`. The `+ New trip` button moves into the always-visible Unassigned panel header. `renderInvoiceCard` gains an `assignable` option so cards drop dead assignment controls while no trip exists.

**Tech Stack:** Vanilla ES modules (`public/dispatch.js`), static HTML/CSS on the shared pastel theme, Node test runner (`node --test`), Playwright e2e (desktop 1280×900 and Pixel 5 projects).

Spec: [2026-10-06-dispatch-conditional-loading-plan-design.md](../specs/2026-10-06-dispatch-conditional-loading-plan-design.md)

## Global Constraints

- Base is `origin/main` (`70346c7`), not `master`: `main` carries the pastel theme and the 960px desktop layout that the Board actually ships with.
- "Has trips" = the Board returned at least one trip for its date; no other rule.
- Hook IDs are exactly `boardLayout`, `loadingPlan`, `queueHelp`; the layout attribute is `data-has-trips="true|false"`.
- Exactly one element matches `getByRole('button', { name: /New trip/ })`; it keeps `id="newTripButton"`.
- Desktop breakpoint: `min-width: 960px` (the theme's). Plan column: `clamp(340px, 30vw, 440px)`. Invoice grid: `repeat(auto-fill, minmax(min(100%, 230px), 1fr))`. Stacked queue cap: `max-height: min(55vh, 520px)`.
- `renderInvoiceCard`'s new option is `assignable`, default `true`.
- Queue help copy, no trips: `Add a trip to open the loading plan, then drag invoices into it. Assignments are saved as dispatch records; accounting invoices stay unchanged.` With trips: the existing text, unchanged.
- Service-worker cache name goes `sales-dashboard-v18` → `sales-dashboard-v19`.
- Run Node tooling from the worktree root. Dependencies resolve from the parent checkout's `node_modules` (the worktree is nested inside it), so do not run `npm install`. Invoke Playwright as `node D:/autocount-pwa-dashboard/node_modules/@playwright/test/cli.js test ...` (plain `npx playwright` would try to download it).
- No `git commit`, `git merge`, or `git push` unless the user asks.

---

### Task 1: Render logic and HTML hooks

**Files:**
- Create: `test/dispatch-board-loading-plan.test.mjs`
- Modify: `public/dispatch.js` (copy constants, `renderInvoiceCard`, `renderDispatchBoard`)
- Modify: `public/dispatch.html` (`.board-layout` block)

**Interfaces:**
- Produces: `renderInvoiceCard(invoice, { ..., assignable = true })`; DOM hooks `#boardLayout[data-has-trips]`, `#loadingPlan[hidden]`, `#queueHelp`, and `#newTripButton` inside the queue header (consumed by Task 2's CSS and the e2e tests).

- [x] **Step 1: Write the failing unit tests** in `test/dispatch-board-loading-plan.test.mjs` (fake-DOM root keyed by `#id`): the Board hides the plan and drops assignment controls with no trip; shows the plan and controls with a trip; hides the plan again when trips disappear; tolerates a shell without the new hooks; the invoice card omits Assign and the drag hint when `assignable` is false and keeps them by default; assigned in-trip cards stay removable regardless of `assignable`.
- [x] **Step 2: Run red.** `node --test test/dispatch-board-loading-plan.test.mjs` → 4 fail, 2 pass (the two pass because they pin behaviour that already exists).
- [x] **Step 3: Implement.** In `public/dispatch.js`: add `QUEUE_HELP_NO_TRIPS` / `QUEUE_HELP_WITH_TRIPS`; in `renderInvoiceCard` add `assignable = true`, `showAssignControls = inTrip || assignable`, `draggable` honouring `assignable` for queue cards, an Assign button only when `assignable`, and `dragHint` only when `showAssignControls`; in `renderDispatchBoard` compute `hasTrips`, then (each guarded) set `#boardLayout.dataset.hasTrips`, `#loadingPlan.hidden = !hasTrips`, `#queueHelp.textContent`, and pass `assignable: hasTrips` to the queue cards.
- [x] **Step 4: Restructure the HTML.** `<div class="board-layout" id="boardLayout" data-has-trips="false">`; queue heading gets `queue-heading` and a `queue-heading-actions` group holding `#queueKey` and `#newTripButton`; the help paragraph gets `id="queueHelp"`; the lorry section gets `id="loadingPlan"` and `hidden`, and loses the `+ New trip` button.
- [x] **Step 5: Run green.** The 6 unit tests pass; `node --test test/*.test.mjs` shows no new failures.

### Task 2: Layout CSS (wrapping grid, beside / stacked)

**Files:**
- Modify: `test/e2e/dispatch-board.spec.js` (fixture options `noTrips`, `extraInvoices`; three new tests)
- Modify: `test/e2e/responsive-layout.spec.js` (the dispatch test)
- Modify: `public/dispatch.css`

- [x] **Step 1: Write the e2e tests** (`dispatch-board.spec.js`): creating the first trip reveals the plan and restores assignment controls (and the invoice can then be assigned); with no trip the queue is a full-width multi-row grid, one column on phones, no sideways overflow; with a trip the plan sits beside the queue on desktop (both in view) and below it on phones, and the queue scrolls inside its own panel.
- [x] **Step 2: Update the existing responsive test** (`responsive-layout.spec.js`, "dispatch: …"): load with no trips and assert the plan is hidden and the queue spans the board; push a trip, press Refresh board, then assert the plan is beside the queue (wide) or below it (phone) and nothing scrolls sideways.
- [x] **Step 3: Run red** against the unmodified code: all new e2e runs fail, and the updated responsive test fails with `Expected: hidden, Received: visible` on a pristine export of `origin/main`.
- [x] **Step 4: Replace the invoice-rail CSS** in `public/dispatch.css`:

```css
.queue-heading {
  flex-wrap: wrap;
}

.queue-heading-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

/* Wrapping grid: the queue fills the panel and grows downward, so more invoices show at once. */
.invoice-rail {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 230px), 1fr));
  align-content: start;
  gap: 10px;
  min-height: 112px;
}

.invoice-rail[data-drop-unassigned] {
  padding: 8px;
  border: 1px dashed var(--border-light);
  border-radius: 10px;
  background: var(--ground);
}

.invoice-rail > .empty-dropzone {
  grid-column: 1 / -1;
}

/* Loading plan visible, stacked: cap the queue so the lanes stay within reach. */
.board-layout[data-has-trips="true"] .invoice-rail {
  max-height: min(55vh, 520px);
  overflow-y: auto;
}
```

Add `.invoice-card--rail .invoice-date { white-space: nowrap; }` after the other rail-card rules. Delete the `.invoice-rail .invoice-card { flex-basis: 200px; }` rule from the `max-width: 860px` block. In the theme's `@media (min-width: 960px)` block, replace the fixed 320–400px queue column and the single-column list rules with:

```css
  /* Loading plan visible: plan beside the queue; the queue sticks while the lanes scroll. */
  .board-layout[data-has-trips="true"] {
    grid-template-columns: minmax(0, 1fr) clamp(340px, 30vw, 440px);
  }

  .board-layout[data-has-trips="true"] .queue-panel {
    position: sticky;
    top: 12px;
    display: flex;
    max-height: calc(100vh - 24px);
    flex-direction: column;
  }

  .board-layout[data-has-trips="true"] .invoice-rail {
    min-height: 0;
    max-height: none;
    flex: 1 1 auto;
  }
```

- [x] **Step 5: Run green.** `dispatch-board.spec.js` and `responsive-layout.spec.js` pass on both projects except the pre-existing "HTTP 401" test.

### Task 3: Service-worker cache bump

**Files:**
- Modify: `test/service-worker.test.mjs` (expected cache name)
- Modify: `test/price-check-ui.test.mjs` (expected cache name)
- Modify: `public/sw.js` (line 1)

- [x] **Step 1: Update both tests** to expect `sales-dashboard-v19`.
- [x] **Step 2: Run red.** `node --test test/service-worker.test.mjs test/price-check-ui.test.mjs` → 2 fail.
- [x] **Step 3: Bump** `CACHE_NAME` to `'sales-dashboard-v19'`.
- [x] **Step 4: Run green.** 34 pass.

### Task 4: Full verification and visual check

- [x] Same suites on an untouched export of `origin/main` versus this branch. `npm test`: 363 tests, 4 fail, 1 skipped versus 369 tests, the same 4 fail, 1 skipped. Playwright: 56 pass, 2 fail versus 62 pass, the same 2 fail.
- [x] Screenshots (scratchpad harness, invented data, 40 unassigned invoices) at 1440×900, 1920×1080 and 393px, both states, plus a scrolled 1440px shot showing the queue pinned; the "before" comes from the untouched export. Fully visible cards in the first screen: 1 before, versus 5 / 12 with no trips (1440 / 1920) and 3 / 4 with trips.

---

## Execution notes (2026-10-06)

- **Base correction:** the worktree was first cut from `master` (`226e512`, Sep 24), which predates the pastel theme and the 960px two-column Board that ship on `origin/main`. The first pass (stacked layout, 1100px breakpoint, cache `v16` → `v17`) was therefore built and screenshotted against the wrong UI. The branch was reset onto `origin/main` and the work redone: the JS, HTML and e2e tests carried over unchanged, the CSS was rewritten against the new layout, and the cache goes to `v19`.
- **Order:** the unit tests and the e2e tests were written and run red before production code on the new base too (4 of 6 unit tests, all 6 new e2e runs, and the updated responsive test against a pristine export).
- **Known failures on untouched `origin/main`:** the stale "HTTP 401 … returns to login" e2e test (two projects) and four Windows-only Node tests (`vercel-regions`, three in `version-stamp`). Both are out of scope here.
