# Task 6 evidence report

## Result

Task 6 is implemented on `codex/delivery-dispatch` as implementation commit
`55c5900` (`feat: wire delivery dispatch operational board`). A second
report-only commit will contain this evidence report.

## RED evidence

All production behavior was preceded by a regression test or browser
regression. The first focused RED run was:

```text
node --test test/dispatch-state.test.mjs
tests 24, pass 21, fail 3
```

The three expected failures were:

- persisted assignment snapshots produced no assigned mixed-company cards;
- the board transport made 1 request instead of the required 3 authenticated
  invoices/trips/assignments requests;
- `createTripsTransport` was not defined.

The initial browser RED attempt correctly reached the existing fixture shell
after the local Playwright browser was installed and exposed the missing Task 6
surface: the Sdn Bhd badge count was 2 rather than the new expected queue
contract, and the new-trip/assignment controls were unavailable. No external
service was contacted.

## GREEN and verification evidence

Focused pure-state/client tests:

```text
node --test test/dispatch-state.test.mjs
tests 24, pass 24, fail 0, skipped 0
```

Desktop Board browser tests:

```text
npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --reporter=line
6 passed, 0 failed
```

Mobile Board browser tests:

```text
npx playwright test test/e2e/dispatch-board.spec.js --project=mobile --reporter=line
6 passed, 0 failed
```

The browser tests use a local static HTTP server and Playwright route
interception for every `/api/dispatch/*` response. They do not call AutoCount,
Vercel, a provider database, production, Quick Invoice, or any external
service.

Full repository test suite:

```text
npm test
tests 164, pass 163, fail 0, skipped 1
```

Build:

```text
npm run build
exit code 0
```

Syntax checks:

```text
node --check public/dispatch.js
node --check public/dispatch-state.mjs
node --check test/e2e/dispatch-board.spec.js
node --check playwright.config.js
all exit code 0
```

Diff check:

```text
git diff --check
clean
```

## Changed files

- `public/dispatch.html` — authenticated Board status/source/retry surfaces,
  trip dialog, and accessible controls.
- `public/dispatch.css` — responsive assignment, source, offline, and dialog
  presentation.
- `public/dispatch-state.mjs` — API normalization, persisted assignment
  snapshots, mixed-company counts, resource joins, and optimistic rollback
  state.
- `public/dispatch.js` — same-origin session/resource/invoice/trip/assignment
  transports and one canonical assignment action for click, touch, keyboard,
  and drag/drop.
- `test/dispatch-state.test.mjs` — pure-state and exact transport regressions.
- `test/e2e/dispatch-board.spec.js` — local fixture-backed desktop/mobile Board
  regressions.
- `playwright.config.js` — local Playwright projects and test configuration.
- `package.json` — approved `@playwright/test` dev dependency.
- `package-lock.json` — locked Playwright dependency graph.

## Scope and self-review

- Production Board defaults to authenticated same-origin API transport; it does
  not fall back to `DISPATCH_FIXTURE` after an API error.
- Invoice identity remains `company_key + invoice_id`; Enterprise and Sdn Bhd
  cards retain visible badges in the queue and in one physical trip.
- Assigned cards are reconstructed from persisted assignment headers/items when
  absent from the live invoice feed.
- Trip driver/vehicle IDs are joined to the protected resource response when
  the trip response does not include embedded resources.
- Create-trip and assignment-create request bodies are allowlisted to the
  required fields and receive distinct generated request IDs.
- Assignment click/touch/keyboard/drag paths converge on one action with
  optimistic state, exact rollback, ARIA-live feedback, stale-trip refresh,
  focus restoration, and late-response sequencing.
- Offline and in-flight states disable mutation entry points. No offline queue
  or cached-current presentation was added.
- `401` clears sensitive Board/resource state and returns to the login boundary.
- No account-book IDs, browser secrets, `toISOString()` business-date
  derivation, deployment, database migration, Quick Invoice change, or
  external-service call was introduced.
- Existing untracked `output/` evidence was not staged or changed.

## Known limits

- Task 6 uses the brief’s explicit `2026-08-28` Board date; date-range
  navigation is outside this task.
- Task 6 wires trip creation and assignment only. Trip status transitions,
  moves/removals, loading sheets, reports, and service-worker changes remain in
  their designated later scopes.
- Mobile verification uses Chromium Pixel 5 emulation with touch enabled; no
  WebKit browser download or real-device run was required.
- Browser API responses are deterministic local fixtures; server/provider
  integration remains covered by the existing API test suite rather than this
  local browser run.

## Commits

- Implementation: `55c5900`
- Evidence report: added in the follow-up report-only commit.

## Fix round 1 closeout

### Result and finding mapping

Task 6 fix round 1 closes the one Critical and eight Important findings from
`task-6-fix-1-findings.md` without changing the Task 5 server/API contracts:

1. **Critical — fixture fallback:** production state now starts empty, writes
   remain disabled until an authoritative Board load succeeds, and an applied
   Board error clears invoice/trip/source rows instead of retaining fixture or
   stale rows. Covered by the empty-state pure test and loading/error browser
   tests.
2. **Important — refresh/pending sequencing:** Board refreshes queue behind an
   active mutation, and authoritative reloads cannot erase or suppress a newer
   pending assignment. Covered by the deferred assignment-versus-refresh and
   assignment-versus-filter browser tests plus existing request-sequence tests.
3. **Important — shared in-flight lock:** one mutation lock covers resource
   create/update, trip create, assignment create, and required read-back;
   writes remain disabled through stale-409 refetch. Covered by the deferred
   resource-write and stale-refetch browser tests.
4. **Important — drag validation:** the canonical client assignment action
   accepts only a current, eligible, unassigned invoice key. Forged, blocked,
   assigned, and missing keys are rejected client-side while Task 5 server
   uniqueness remains authoritative. Covered by pure-state and forged/stale
   drag browser tests.
5. **Important — online recovery:** both offline and online events rerender the
   Board, so mutation controls disable offline and recompute on reconnect.
   Covered by the offline/reconnect browser test.
6. **Important — HTTP 401 precedence:** HTTP status 401 is authoritative even
   when the response payload contains an arbitrary error code; sensitive Board
   state is cleared and the login boundary is restored. Covered by transport
   and browser tests.
7. **Important — company filter during load:** every filter change starts or
   queues a replacement load, and only the newest company response applies.
   Covered by deferred old/new filter and pending-mutation filter tests.
8. **Important — missing source health:** health evaluates both required
   company keys, so an absent Enterprise or Sdn Bhd entry is unavailable rather
   than healthy. Covered by pure-state and browser tests.
9. **Important — focus restoration:** assignment focus resolves a current,
   stable invoice/trip control only after mutation settlement, authoritative
   refresh, and final rerender. Covered after both success and rollback.

The two deferred Minor findings were not changed. Mixed-company trip identity
remains `company_key + invoice_id`, and no API request shape or server contract
was expanded.

### RED evidence

Each behavior was proven to fail before its production fix. Exact focused RED
commands and counts:

```text
node --test --test-name-pattern="production state starts empty" test/dispatch-state.test.mjs
tests 1, pass 0, fail 1

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="loading starts|generic Board failure" --reporter=line
2 failed

node --test --test-name-pattern="source health treats" test/dispatch-state.test.mjs
tests 1, pass 0, fail 1

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="missing required source" --reporter=line
1 failed

node --test --test-name-pattern="drag validation accepts" test/dispatch-state.test.mjs
tests 1, pass 0, fail 1

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="forged and stale drag" --reporter=line
1 failed

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="offline state disables" --reporter=line
1 failed

node --test --test-name-pattern="invoice fetch transport preserves" test/dispatch-state.test.mjs
tests 1, pass 0, fail 1

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="HTTP 401 with an arbitrary" --reporter=line
1 failed

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="changing company during" --reporter=line
1 failed

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="stays locked|refresh cannot erase|one shared lock" --reporter=line
3 failed

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="stable replacement|failed assignment rolls" --reporter=line
2 failed

npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --grep="filter change queues" --reporter=line
1 failed (sequencing-guard mutation check)
```

The first combined-project run also exposed a local test-harness race that
individual projects cannot show:

```text
npx playwright test test/e2e/dispatch-board.spec.js --reporter=line
15 passed, 1 failed, 14 did not run
failure: EADDRINUSE 127.0.0.1:4173
```

`playwright.config.js` now uses one worker for the one shared local static
server. No external service was contacted.

### GREEN and final verification evidence

Focused GREEN reruns produced the corresponding counts:

```text
empty production state: 1 passed
loading/error non-writable Board: 2 passed
missing source health: pure 1 passed; browser 1 passed
current-unassigned drag validation: pure 1 passed; browser 1 passed
offline/online recovery: 1 passed
arbitrary-body HTTP 401: pure 1 passed; browser 1 passed
filter replacement during load: 1 passed
shared lock, pending refresh, stale refetch: 3 passed
stable focus after success/rollback: 2 passed
pending assignment/filter sequencing: 1 passed
```

Focused pure-state/client suite:

```text
node --test test/dispatch-state.test.mjs
tests 27, pass 27, fail 0, skipped 0
```

Desktop Board suite:

```text
npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --reporter=line
15 passed, 0 failed
```

Mobile Board suite:

```text
npx playwright test test/e2e/dispatch-board.spec.js --project=mobile --reporter=line
15 passed, 0 failed
```

Combined desktop/mobile Board suite after serializing the shared local server:

```text
npx playwright test test/e2e/dispatch-board.spec.js --reporter=line
30 passed, 0 failed
```

Fresh full repository suite at closeout:

```text
npm test
tests 167, pass 166, fail 0, skipped 1
```

Build:

```text
npm run build
exit code 0
```

Final syntax checks on the exact closeout tree:

```text
node --check public/dispatch.js
node --check public/dispatch-state.mjs
node --check test/e2e/dispatch-board.spec.js
node --check playwright.config.js
all exit code 0
```

Final whitespace/diff check:

```text
git diff --check
exit code 0
```

### Fix-round changed files

- `playwright.config.js` — serializes the shared fixture-backed local HTTP
  server so desktop/mobile combined execution cannot collide on port 4173.
- `public/dispatch-state.mjs` — empty production defaults, required-company
  source health, and current eligible unassigned invoice validation.
- `public/dispatch.js` — authoritative-load write gate, shared mutation lock,
  queued/refetch sequencing, 401 precedence, filter replacement loading,
  online rerender, canonical drag validation, and stable focus restoration.
- `test/dispatch-state.test.mjs` — empty-state, source-health, drag-validation,
  401, and request-sequencing regressions.
- `test/e2e/dispatch-board.spec.js` — local deferred HTTP regressions for all
  Critical/Important browser findings at desktop and mobile widths.
- `.superpowers/sdd/2026-08-28-delivery-dispatch/task-6-report.md` — this fix
  evidence and closeout record.

### Fix-round scope and self-review

- No `api/` file, Task 5 server contract, API request allowlist, `package.json`,
  lockfile, HTML, CSS, service worker, Quick Invoice file, deployment config,
  provider database, or production integration changed.
- Client drag validation supplements existing server-side uniqueness and does
  not duplicate, weaken, or expand that contract.
- All browser behavior uses the local static server and intercepted
  `/api/dispatch/*` fixture responses only.
- Existing untracked `output/` evidence remains untouched and uncommitted.
- Generated `test-results/` output was removed before staging.
- The existing Node typeless-module warning and the two explicitly deferred
  Minor findings remain known limits; no unrelated cleanup was performed.

### Fix-round commits

- Fix implementation and evidence: `8120ae9a9b3cd8f13ee0c873fc3cdafde494f512`
- Fix-hash report update: recorded in the report-only follow-up commit.
