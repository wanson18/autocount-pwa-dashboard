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
