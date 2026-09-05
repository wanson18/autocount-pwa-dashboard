# Task 5 fix round 1 report

Date: 2026-08-29
Status: GREEN locally; hosted PostgreSQL/provider verification remains gated

## Scope

- Assignment moves are now limited to `assigned` and `loaded` states.
  `out_for_delivery`, `delivered`, `failed`, `returned`, and `removed`
  assignments return `409 invalid_transition` without mutation.
- Moves are rejected when either the source or destination trip is
  `dispatched`, `completed`, or `cancelled`. The guard runs while both trips
  and the assignment are locked in the existing mutation transaction.
- Missing or incomplete selected-company source configuration returns
  `503 source_unavailable` before the invoice adapter is invoked. A complete
  selected config requires matching `companyKey` plus non-empty
  `accountBookId`, `keyId`, and `apiKey`; no partial fallback config or
  other-company request is attempted.
- Existing mixed-company invoices in one physical trip remain supported and
  green in the focused API suite.

## RED evidence

Before production changes, `node --test api/dispatch-assignments.test.js` ran
18 tests: **12 passed, 6 failed, 0 skipped**. The six expected failures proved:

- `out_for_delivery` was classified as movable;
- missing and incomplete selected-company configs still invoked the source and
  persisted an assignment; and
- moves out of or into a dispatched trip returned success.

## GREEN and verification evidence

- Assignment regression file: **18 passed, 0 failed, 0 skipped**.
- Focused Task 5 API/routing suite: **30 passed, 0 failed, 0 skipped**.
- Relevant repository/source suite: **50 passed, 0 failed, 1 skipped**
  (**51 total**). The skip is the hosted `TEST_DATABASE_URL` gate.
- Full `npm.cmd test`: **160 passed, 0 failed, 1 skipped** (**161 total**).
- `npm.cmd run build`: exit 0; this repository has a static no-op build step.
- Node syntax checks: all 4 changed JavaScript files passed.
- `git diff --check`: passed; only existing Windows line-ending/global-ignore
  warnings were emitted.
- Changed-addition leakage scan: clean.

The rejection regressions assert stable client errors and prove no changes to
the assignment row, source/destination trip revisions, event history, or
durable idempotency rows. The source-config regressions also prove zero source
calls, assignments, trip revision changes, events, and idempotency rows.

## Fix commit

`0a795f624b40a8312102012af11dda40f5947636`

The commit contains only the four Task 5 fix/test files. The pre-existing
untracked `output/` directory remains untouched.

## Known limits

No provider, Docker, deployment, production data, or external service was
used. The provider-backed schema-isolation test remains skipped without
`TEST_DATABASE_URL`; local PGlite evidence does not prove cross-process pooled
PostgreSQL lock contention, network/TLS behavior, or provider connectivity.
The full suite still emits the two pre-existing non-failing diagnostics for an
invalid timezone fallback fixture and the fixture-only browser module type.
