# Task 5 delivery-dispatch implementation report

Date: 2026-08-29
Status: GREEN locally; the real PostgreSQL/provider gate remains pending

## RED evidence

- Initial Task 5 API/status slice: 16 tests, 0 passed, 16 failed. The failures
  were the expected missing trip/assignment APIs and service/status modules.
- Resume focused run after the adapter/status slice: 17 tests, 2 passed, 15
  failed. The adapter refetch regression and status-machine test were green;
  the protected endpoint surface was still absent.
- Routing rewrite regression before the rewrite: 1 passed, 1 failed because
  trips and assignments were not routed before the dispatch catch-all.
- Durable idempotency operation/type regression before migration 005: 0 passed,
  1 failed because Task 5 rows were stored as resource operations instead of
  their actual trip operation/type.

## GREEN evidence

- Focused Task 5 final run:
  `node --test api/dispatch-trips.test.js api/dispatch-assignments.test.js api/dispatch-routing.test.js`
  — **23 passed, 0 failed, 0 skipped**.
- Focused API/repository/source run:
  `node --test api/dispatch-trips.test.js api/dispatch-assignments.test.js api/dispatch-routing.test.js api/dispatch-repository.test.js api/dispatch-invoices.test.js`
  — **71 passed, 0 failed, 1 existing provider skip**.
- Full final run: `npm.cmd test` — **154 passed, 0 failed, 1 existing provider
  skip**. The skip is the hosted `TEST_DATABASE_URL` schema-isolation gate.
- `npm.cmd run build` passed; the repository uses a static no-op build step.
- Node syntax checks passed for all 12 changed JavaScript files.
- `git diff --check` passed. Git emitted only existing Windows line-ending and
  global-ignore permission warnings.
- Leakage scan passed for changed additions: no account-book IDs, credential
  values, private-key material, or provider payloads. The source-failure
  string used to prove redaction is confined to the test.

## Implementation and evidence

- Added the explicit trip and assignment status machines with only the approved
  transitions. Delivered assignments cannot be removed or moved.
- Added protected GET/POST/PATCH trip and assignment handlers. Request bodies
  use exact allowlists; actors come only from the verified Task 4 session.
- Added authoritative selected-company invoice refetch and fail-closed checks
  for company/invoice identity, document number/date, boolean cancellation,
  complete lines, item identity, exact positive decimal strings, and UOM.
- Assignment creation persists the header snapshot, every item, trip revision,
  durable idempotency result, and append-only event in one transaction. The
  injected later-line failure test proves zero assignment rows, item rows,
  revision changes, events, and idempotency rows after rollback.
- Same-trip mixed-company assignment is covered. The same-company active
  invoice uniqueness index and concurrent race test prove one durable success
  and one safe conflict without duplicate rows. Same-trip revision races prove
  one success and one `stale_trip` response.
- Event history is asserted for assignment, move, status changes, remove, and
  trip creation/status changes; every mutation event uses the session actor.
- Added additive migration `005_dispatch_mutation_idempotency.sql` so the
  existing durable idempotency table records real `trip` and `assignment`
  operation/resource types. Applied migrations 001–004 were not rewritten.
- Added the source adapter's cancelled-document refetch path. No lorry weight
  or capacity is inferred from arbitrary UOM quantities.
- Added trip/assignment rewrites before the dispatch catch-all. The Board and
  its fixture transport remain unchanged and fixture-only until Task 6.

## Focused implementation commit

`1073374f4d6b8508296f6d4057e311eb886d0df3`

The implementation commit contains only the intended Task 5 code, tests,
additive migration, routing/documentation updates, and compatibility assertions
for the migration/routing contracts. The pre-existing untracked `output/`
directory remains untouched and uncommitted.

## Provider gate and follow-up

No provider, deployment, production system, Docker, or external service was
used. Before preview, run the migrations and focused API/repository suite
against real pooled PostgreSQL connections, including independent
multi-connection same-invoice and same-trip-revision races, durable idempotency
locking, rollback, append-only event checks, TLS/network behavior, and Vercel
pool attachment. Local PGlite verifies the transaction behavior but cannot
prove cross-process PostgreSQL lock contention or provider connectivity.

The full run retains two pre-existing non-failing diagnostics: the invalid
`REPORT_TIMEZONE` fixture fallback and Node's module-type warning for the
fixture-only browser script.
