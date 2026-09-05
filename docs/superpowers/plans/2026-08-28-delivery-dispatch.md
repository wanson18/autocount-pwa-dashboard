# Delivery Dispatch Module Implementation Plan

> **Execution rule:** Do not start this plan until the user approves it. After
> approval, Sol remains the lead reviewer and delegates each implementation
> task to a fresh `gpt-5.6-luna` subagent. Independent tasks may run in
> parallel; dependent tasks run in waves. Sol inspects every diff, runs the
> integration gates, and owns the final recommendation.

**Goal:** Add a database-backed delivery dispatch module to the Sales Dashboard
where a clerk can place invoices from both companies on the same driver/lorry
trip, update delivery status, print combined item totals, and export period-end
delivery records.

**Architecture:** The Sales Dashboard owns the dispatch UI, same-origin Vercel
Functions, and Postgres tables. It reads eligible invoices from both AutoCount
account books using server-side company configuration and persists immutable
invoice/item snapshots on assignment. Quick Invoice receives only an **Open
Dispatch** link.

**Tech stack:** Existing Node.js CommonJS Vercel Functions, static HTML/CSS/JS
PWA, Node test runner, Playwright for browser flows, `pg` plus
`@vercel/functions` connection pooling, and a Marketplace Postgres database.

**Spec:**
`outputs/2026-08-28-delivery-dispatch-design-spec.md`

**UI reference:**
`C:\Users\wanso\.codex\visualizations\2026\08\27\01a041e7-4d25-7d11-a329-545293c73331\delivery-dispatch-ui-architecture.html`

## Global constraints

- Primary repository: `D:\autocount-pwa-dashboard` (`master`).
- Integration-only repository: `D:\autocount-mobile-quick-invoice` (`main`).
- Preserve the dashboard's unrelated untracked `.claude/` directory.
- Quick Invoice is currently four commits behind `origin/main` and has user
  edits in `agents.md`, `app/autocount/adapter.py`, `app/main.py`, and two test
  files. Do not reset, stash, overwrite, or fold these changes into dispatch
  work.
- Keep `enterprise` and `sdn_bhd` distinct at every API and database boundary.
  A physical trip may combine them; accounting identity may not.
- Server-side configuration must fail closed if account-book IDs are missing,
  equal, or paired with incomplete credentials.
- Source invoices must be non-cancelled at assignment time. The client cannot
  provide authoritative totals, customer data, or line snapshots.
- Store decimal quantities as Postgres `numeric`; JSON serializes them as
  strings. Do not use binary floating-point for persisted loading totals.
- Aggregate loading totals only by exact normalized `item_code + UOM`. Do not
  invent UOM conversions.
- Dispatch writes are online-only and authenticated. The service worker must
  never queue, cache, or replay writes.
- Every write carries an idempotency request ID and every trip mutation checks
  an expected revision. A stale write returns `409`.
- Use Kuala Lumpur business dates and explicit ISO dates. Do not derive the
  business date from UTC with `toISOString().slice(0, 10)`.
- Each Luna agent receives only its task, the spec, relevant files, current git
  status, and acceptance tests. Agents do not merge or deploy.
- Each task follows red-green-refactor: add a failing regression test, run it
  and confirm the expected failure, implement the minimum, rerun focused tests,
  then run the task's broader gate.

## Orchestration and review waves

| Wave | Owner | Work | Dependency |
| --- | --- | --- | --- |
| 0 | Sol | Worktrees, baselines, contracts, agent briefs | Approval |
| 1A | Luna 1 | AutoCount two-company invoice adapter | Wave 0 |
| 1B | Luna 2 | Postgres schema, migration, repository primitives | Wave 0 |
| 1C | Luna 3 | Dispatch page shell and pure UI state | Wave 0 |
| Review 1 | Sol | Contract/schema/UI consistency review | 1A-1C |
| 2A | Luna 4 | Clerk session and resource APIs | Review 1 |
| 2B | Luna 5 | Trip/assignment transactional service and APIs | 1A, 1B, Review 1 |
| Review 2 | Sol | Security, invariants, concurrency, error contract | 2A-2B |
| 3A | Luna 6 | Board integration, drag/drop, touch/keyboard fallback | Review 2, 1C |
| 3B | Luna 7 | Loading sheet, Print Items, period reports | Review 2 |
| 3C | Luna 8 | Navigation links and PWA behavior | Review 2 |
| Review 3 | Sol | Cross-module and responsive review | 3A-3C |
| 4 | Luna 9 | End-to-end and accessibility regression suite | Review 3 |
| Final | Sol | Full tests, migration rehearsal, live read-only check, deployment checklist | Wave 4 |

## Task 0: Sol prepares isolated execution environments

**Files:** No product files changed.

- [ ] Record `git status --short --branch`, current commit, and remotes for both
  repositories.
- [ ] Run the dashboard baseline:

  ```powershell
  npm test
  ```

  Expected baseline: 21 passing tests, 0 failures.

- [ ] Run Quick Invoice's full baseline from its existing environment without
  editing the dirty checkout:

  ```powershell
  .venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider --basetemp D:\Wanson_Automation\.pytest-temp\dispatch-plan-baseline
  ```

- [ ] Create `codex/delivery-dispatch` in a separate worktree from the current
  dashboard `master`; do not move or delete `.claude/`.
- [ ] Create a second integration worktree from Quick Invoice `origin/main` only
  when Task 8 begins. The link commit must remain isolated from the user's dirty
  `main` checkout.
- [ ] Copy the approved spec and this plan into the dashboard worktree as:
  - `docs/superpowers/specs/2026-08-28-delivery-dispatch-design.md`
  - `docs/superpowers/plans/2026-08-28-delivery-dispatch.md`
- [ ] Commit only those two documents:

  ```powershell
  git add docs/superpowers/specs/2026-08-28-delivery-dispatch-design.md docs/superpowers/plans/2026-08-28-delivery-dispatch.md
  git commit -m "docs: define two-company delivery dispatch"
  ```

## Task 1: Luna 1 builds the two-company AutoCount invoice adapter

**Create:**

- `lib/autocount/company-config.js`
- `lib/autocount/client.js`
- `lib/dispatch/invoice-adapter.js`
- `api/dispatch-invoices.js`
- `api/dispatch-invoices.test.js`
- `test/fixtures/autocount-enterprise-invoices.json`
- `test/fixtures/autocount-sdn-bhd-invoices.json`

**Modify:**

- `.env.example`
- `vercel.json`
- `package.json`

Steps:

- [ ] Add fixture-driven failing tests for company isolation, pagination,
  duplicate `docKey` rejection, cancellation exclusion, date validation, exact
  decimal strings, item description/UOM extraction, and partial-company failure
  reporting.
- [ ] Confirm the focused test fails because the adapter and endpoint do not
  exist:

  ```powershell
  node --test api/dispatch-invoices.test.js
  ```

- [ ] Perform one read-only live contract capture for each company using the
  existing credentials. Sanitize customer names, addresses, IDs, and values in
  the committed fixtures while retaining exact field names and shapes.
- [ ] Encode only observed AutoCount fields for `docKey`, `docNo`, `docDate`,
  cancellation, customer, delivery address, item code, description, quantity,
  and UOM. If UOM is absent from invoice detail, enrich it through the observed
  documented item endpoint; if no authoritative UOM exists, return
  `eligibility: "blocked_missing_uom"` and prohibit assignment.
- [ ] Configure the same company keys and environment names already used by
  Quick Invoice:
  `AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE`,
  `AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD`, company-specific Key-ID/API-Key pairs,
  and shared-key fallback only when both shared values exist.
- [ ] Implement `GET /api/dispatch/invoices?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&company=all|enterprise|sdn_bhd`.
  `all` fetches both companies concurrently and returns company-tagged invoices
  plus `sources.enterprise` and `sources.sdn_bhd` health.
- [ ] Do not use `/api/sales` as the dispatch feed; it currently drops stable
  document identity, line UOM, and cancellation state.
- [ ] Run focused tests, then all dashboard tests.
- [ ] Commit:

  ```powershell
  git add .env.example vercel.json package.json package-lock.json lib/autocount lib/dispatch/invoice-adapter.js api/dispatch-invoices.js api/dispatch-invoices.test.js test/fixtures
  git commit -m "feat: add isolated two-company dispatch invoice feed"
  ```

## Task 2: Luna 2 adds Postgres schema and repository primitives

**Create:**

- `db/migrations/001_delivery_dispatch.sql`
- `scripts/migrate.js`
- `lib/db/pool.js`
- `lib/dispatch/repository.js`
- `api/dispatch-repository.test.js`
- `test/helpers/postgres.js`

**Modify:**

- `package.json`
- `package-lock.json`
- `.env.example`
- `README.md`

Steps:

- [ ] Add failing repository tests for migrations, company checks, unique
  driver/registration records, trip revisions, exact numeric quantities,
  active-assignment uniqueness on `(company_key, invoice_id)`, event history,
  and transactional rollback.
- [ ] Add `pg` and `@vercel/functions`; initialize one module-level pool from a
  pooled `DATABASE_URL` and attach it for Vercel Functions connection reuse.
- [ ] Create the six tables from the spec. Use database checks for company and
  status values, foreign keys, UTC timestamps, `numeric` quantities, and a
  partial unique index that allows reassignment only after a prior assignment
  is `removed`, `failed`, or `returned`; delivered invoices remain protected.
- [ ] `delivery_assignments` stores immutable invoice header JSON and
  `delivery_assignment_items` stores immutable line snapshots. Current status
  and trip reference may change, but snapshots do not.
- [ ] Implement transaction helpers and repository methods; do not place HTTP
  parsing or AutoCount calls in the repository.
- [ ] Make `scripts/migrate.js` idempotent by tracking applied filenames in a
  `schema_migrations` table and taking a Postgres advisory lock.
- [ ] Test against a temporary Postgres database, then run all dashboard tests.
- [ ] Commit:

  ```powershell
  git add db scripts lib/db lib/dispatch/repository.js api/dispatch-repository.test.js test/helpers package.json package-lock.json .env.example README.md
  git commit -m "feat: persist delivery trips and assignment history"
  ```

## Task 3: Luna 3 creates the dispatch UI shell and pure state model

**Create:**

- `public/dispatch.html`
- `public/dispatch.css`
- `public/dispatch-state.mjs`
- `public/dispatch.js`
- `test/dispatch-state.test.mjs`

Steps:

- [ ] Add failing pure-state tests for combined company filters, stable invoice
  identity (`company_key + invoice_id`), selected invoice/trip state, optimistic
  move/rollback, and stale response rejection.
- [ ] Build the responsive shell with Board, Trips, Reports, and Resources tabs.
  Every invoice-card template reserves a visible company badge.
- [ ] Implement no backend mutations yet. Use dependency-injected fetch helpers
  and a temporary in-memory fixture adapter so later API work can wire in without
  rewriting rendering.
- [ ] Add desktop drag affordances and mobile/keyboard controls to the markup,
  but keep assignment disabled until Task 6.
- [ ] Confirm 390px, 768px, and 1440px layouts do not horizontally clip controls.
- [ ] Run focused state tests and all dashboard tests.
- [ ] Commit:

  ```powershell
  git add public/dispatch.html public/dispatch.css public/dispatch-state.mjs public/dispatch.js test/dispatch-state.test.mjs
  git commit -m "feat: add responsive dispatch board shell"
  ```

## Sol Review Gate 1

- [ ] Compare company keys, statuses, decimal serialization, and snapshot fields
  across Tasks 1-3. Reject any mismatch before APIs are built.
- [ ] Confirm no account-book ID appears in browser JSON, fixtures, logs, or
  committed docs.
- [ ] Confirm all three task commits are narrow and contain no unrelated files.
- [ ] Run `npm test` and inspect responsive screenshots.

## Task 4: Luna 4 adds clerk sessions and driver/lorry resources

**Create:**

- `lib/dispatch/auth.js`
- `lib/dispatch/http.js`
- `api/dispatch-session.js`
- `api/dispatch-resources.js`
- `api/dispatch-auth.test.js`
- `api/dispatch-resources.test.js`

**Modify:**

- `.env.example`
- `vercel.json`
- `public/dispatch.html`
- `public/dispatch.js`

Steps:

- [ ] Add failing tests for scrypt PIN verification, timing-safe comparison,
  signed-cookie expiry/tamper rejection, `401` on protected routes, request
  method checks, and safe error envelopes.
- [ ] Read clerk identities and scrypt hashes from `DISPATCH_USERS_JSON`; sign an
  eight-hour Secure/HttpOnly/SameSite=Lax cookie with
  `DISPATCH_SESSION_SECRET`. Never return or log hashes, PINs, secrets, or book
  IDs.
- [ ] Implement session GET/POST/DELETE and protect all dispatch APIs, including
  reads because invoice/customer details are sensitive.
- [ ] Add resource GET/POST/PATCH for drivers and lorries. Deactivation is
  reversible; there is no hard delete.
- [ ] Wire the login view and Resources tab. The authenticated clerk ID becomes
  the audit actor; the client never submits `assigned_by`.
- [ ] Test focused and full suites, then commit.

## Task 5: Luna 5 implements transactional trip and assignment APIs

**Create:**

- `lib/dispatch/service.js`
- `lib/dispatch/status-machine.js`
- `api/dispatch-trips.js`
- `api/dispatch-assignments.js`
- `api/dispatch-trips.test.js`
- `api/dispatch-assignments.test.js`

**Modify:**

- `vercel.json`
- `README.md`

Steps:

- [ ] Add failing tests for trip creation, mixed-company assignments, duplicate
  rejection, source cancellation rejection, missing-UOM rejection, inactive
  driver/lorry rejection, valid and invalid status transitions, move/remove,
  idempotent replay, stale revision `409`, event creation, and full rollback if
  any snapshot line fails.
- [ ] Implement GET/POST/PATCH trip operations. Require expected revision for
  mutations and return the new revision.
- [ ] Implement assignment as one transaction: refetch the invoice from its
  company, verify exact identity and cancellation state, insert immutable
  header/item snapshots, update trip revision, and append the event.
- [ ] Accept only `trip_id`, `company_key`, `invoice_id`, `doc_no`, `doc_date`,
  `expected_trip_revision`, and `request_id` from the client. Ignore no extra
  fields; reject them with `400`.
- [ ] Implement server-owned transitions and dispatch guards. Do not calculate
  lorry weight from unrelated UOM quantities.
- [ ] Return stable error codes:
  `unauthorized`, `invalid_request`, `invoice_cancelled`,
  `invoice_missing_uom`, `invoice_already_assigned`, `invalid_transition`,
  `stale_trip`, `source_unavailable`, and `internal_error`.
- [ ] Run focused API/repository tests, all tests, then commit.

## Sol Review Gate 2

- [ ] Threat-review authentication, cookie flags, SQL parameterization, source
  validation, idempotency, transaction boundaries, and redacted logging.
- [ ] Simulate two clerks assigning the same invoice and updating the same trip;
  prove one succeeds and one receives a conflict without duplicate rows.
- [ ] Simulate one company source failing; prove the other company's feed remains
  usable while the failed source is visibly marked unavailable.
- [ ] Review event history after assign, move, status update, remove, and failed
  transition attempts.

## Task 6: Luna 6 wires the operational board

**Modify:**

- `public/dispatch.html`
- `public/dispatch.css`
- `public/dispatch-state.mjs`
- `public/dispatch.js`
- `test/dispatch-state.test.mjs`

**Create:**

- `test/e2e/dispatch-board.spec.js`
- `playwright.config.js`

**Modify:**

- `package.json`
- `package-lock.json`

Steps:

- [ ] Add failing browser tests for combined feed, visible company badges, trip
  creation, Enterprise and Sdn Bhd invoices on one trip, drag/drop, click/touch
  assignment, keyboard assignment, optimistic rollback, and stale conflict
  refresh.
- [ ] Wire session, resource, invoice, trip, and assignment APIs into the shell.
- [ ] Make click/touch/keyboard assignment the canonical action; drag/drop only
  selects the same invoice/trip and calls that action.
- [ ] Disable writes while offline or during an in-flight request. Announce
  success/errors through an ARIA live region and restore focus after dialogs.
- [ ] Show per-trip invoice count and Enterprise/Sdn Bhd subtotals without
  splitting the trip.
- [ ] Add loading, empty, partial-source, unauthorized, and retry states.
- [ ] Run pure-state tests, Playwright board tests at desktop/mobile widths, and
  all dashboard tests. Commit.

## Task 7: Luna 7 implements Print Items and period-end reports

**Create:**

- `lib/dispatch/loading-sheet.js`
- `lib/dispatch/report.js`
- `api/dispatch-loading-sheet.js`
- `api/dispatch-reports.js`
- `api/dispatch-loading-sheet.test.js`
- `api/dispatch-reports.test.js`
- `public/loading-sheet.html`
- `public/loading-sheet.js`
- `public/loading-sheet.css`
- `test/e2e/dispatch-print-report.spec.js`

**Modify:**

- `public/dispatch.html`
- `public/dispatch.js`
- `vercel.json`

Steps:

- [ ] Add failing tests proving exact `item_code + UOM` grouping, company
  subtotals, combined totals, decimal-string handling, no price exposure,
  removed-assignment exclusion, historical snapshot stability, period boundary
  inclusion, company filters, CSV escaping, and Kuala Lumpur dates.
- [ ] Implement loading-sheet queries exclusively from persisted snapshots.
- [ ] Add **Print Items** on each trip and in trip detail. The printable page
  shows trip metadata, company invoice counts, item table, signatures/check
  fields, and company-tagged invoice checklist.
- [ ] Ensure print CSS removes controls and fits A4 portrait; allow the item table
  to continue across pages with repeated headers.
- [ ] Implement combined JSON/CSV period records with optional company, driver,
  lorry, and status filters. Each CSV row retains company, invoice, trip, driver,
  lorry, assignment/outcome status, and audit timestamps.
- [ ] Run focused tests, Playwright print/report tests, and all tests. Commit.

## Task 8: Luna 8 adds navigation and safe PWA behavior

**Dashboard modify:**

- `public/index.html`
- `public/today-invoices.html`
- `public/sw.js`
- `public/manifest.json`
- `README.md`

**Quick Invoice modify in its isolated worktree:**

- `app/static/index.html`
- `tests/unit/test_api.py`

Steps:

- [ ] Add failing tests that the Dashboard exposes a Dispatch link and Quick
  Invoice exposes an **Open Dispatch** link to
  `https://autocount-pwa-dashboard.vercel.app/dispatch.html`.
- [ ] Add Dispatch navigation without replacing the existing Sales or Today's
  Invoices views.
- [ ] Bump the service-worker cache version and cache new static dispatch assets.
  Keep every `/api/dispatch/*` request network-only and never cache non-GET
  requests.
- [ ] Add an offline banner that disables all dispatch mutations; do not display
  cached board data as current.
- [ ] In the separate Quick Invoice worktree, add only the link and its test.
  Run `pytest tests/` there and commit the two-file change independently.
- [ ] Sol compares the isolated Quick Invoice link commit with the user's dirty
  checkout. If no overlap exists, cherry-pick it only after the user's work is
  safely committed; otherwise deliver the exact commit hash for later adoption.

## Sol Review Gate 3

- [ ] Inspect 390px touch, tablet, and desktop board layouts.
- [ ] Verify both company badges remain visible on cards, trip details, loading
  sheets, and reports.
- [ ] Hand-calculate a mixed trip fixture, including `5KG = 200` and
  `AJINOMOTO = 3 CTN`, and match the print API and rendered page exactly.
- [ ] Confirm Quick Invoice's Company -> Customer -> Items -> Review -> Issue
  Invoice workflow is unchanged.
- [ ] Confirm service-worker fetch behavior cannot replay a write.

## Task 9: Luna 9 completes end-to-end regression coverage

**Create/modify:**

- `test/e2e/dispatch-lifecycle.spec.js`
- `test/e2e/dispatch-accessibility.spec.js`
- `test/fixtures/dispatch-lifecycle.json`
- `package.json`
- `README.md`

Steps:

- [ ] Cover the full fixture-backed lifecycle: sign in, create resources, create
  trip, assign one invoice from each company, print item totals, dispatch,
  record one delivered and one returned outcome, complete trip, export combined
  report, and export each company filter.
- [ ] Cover duplicate assignment, cancelled invoice, source outage, stale
  revision, offline state, browser refresh, and idempotent retry.
- [ ] Run automated accessibility checks for labels, focus order, keyboard
  assignment, dialogs, status announcements, and print button naming.
- [ ] Document the exact local fixture commands and production smoke-test steps.
- [ ] Commit only test/config/documentation changes.

## Final Sol review and release gate

- [ ] Review every commit and combined diff against the approved spec. Reject
  hidden account-book IDs, cross-company joins without `company_key`, untested
  mutation paths, or unrelated changes.
- [ ] Run:

  ```powershell
  npm test
  npm run test:e2e
  npm run format:check
  npm run build
  ```

- [ ] Provision a Marketplace Postgres integration in the same region as the
  Vercel Functions, using a pooled connection URL as recommended by current
  Vercel guidance. Apply migrations first to a preview database.
- [ ] Run migration twice in preview; the second run must report no pending
  migrations and create no duplicate schema objects.
- [ ] Deploy a preview, then run one read-only live invoice-feed check for each
  company. Confirm cancelled invoices are excluded and no source IDs or secrets
  appear in the browser response.
- [ ] Execute a preview-only fixture dispatch lifecycle and compare database
  rows, event history, loading totals, print output, and CSV output.
- [ ] Obtain the user's explicit release approval before production deployment
  or production database migration.
- [ ] After production release, create one reversible test trip with designated
  test invoices only if the user authorizes those exact records; otherwise limit
  production verification to authenticated reads and page loading.
- [ ] Deliver: dashboard commit range, independent Quick Invoice link commit,
  migration filenames, test totals, preview URL, production checklist, and any
  follow-up risks.

## Self-review

- **Spec coverage:** same-trip multi-company assignment, permanent company
  identity, drag/drop plus touch/keyboard fallback, persistent database,
  statuses, Print Items with per-company and combined totals, period reports,
  Quick Invoice link, offline safety, duplicate prevention, cancellation
  exclusion, and audit history are each assigned to concrete tasks and tests.
- **Risk coverage:** the plan isolates Quick Invoice's dirty/behind checkout,
  avoids the unsuitable `/api/sales` feed, validates live field contracts before
  mapping UOM, uses source refetch and immutable snapshots, protects writes,
  and tests concurrent conflicts.
- **Type consistency:** company keys are `enterprise|sdn_bhd`; trip statuses are
  `planned|loading|dispatched|completed|cancelled`; assignment statuses are
  `assigned|loaded|out_for_delivery|delivered|failed|returned|removed`;
  quantities are decimal strings at JSON boundaries and `numeric` in Postgres.
- **Placeholder scan:** no TBD/TODO placeholders. Missing authoritative UOM has
  a defined fail-closed behavior rather than an assumed conversion.

## Approval boundary

Approval authorizes worktree creation, code/tests/docs in the two named
repositories, read-only AutoCount contract checks, preview database setup, and
preview deployment verification. It does **not** authorize production database
migration, production deployment, live invoice edits, or creation of production
dispatch records; Sol will request explicit approval at that release gate.
