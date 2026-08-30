# Task 7 evidence report

## Result

Task 7 is implemented on branch `codex/delivery-dispatch` in the linked
worktree `D:\autocount-pwa-dashboard\.claude\worktrees\delivery-dispatch`.
The saved-project checkout was not edited. Implementation and tests are in
commit `8e43643` (`feat: add dispatch loading sheets and reports`).

Final handoff status: `DONE_WITH_CONCERNS`.

## RED evidence

Production behavior was preceded by failing domain/API, repository, and
browser tests. The initial loading/report domain and API run was:

```text
node --test api/dispatch-loading-sheet.test.js api/dispatch-reports.test.js
tests 10, pass 0, fail 10
```

The failures were the expected missing loading-sheet/report modules and API
handlers. Before the repository read was implemented, the persisted report
integration regression was also run:

```text
node --test --test-name-pattern="report reads keep inclusive" api/dispatch-repository.test.js
tests 1, pass 0, fail 1
failure: repository.listReportRecords is not a function
```

The first local desktop browser run exposed the missing Task 7 surface:

```text
npx playwright test test/e2e/dispatch-print-report.spec.js --project=desktop --reporter=line
4 failed
```

The expected failures covered the absent Print Items link, loading page/state,
Reports table, and print stylesheet behavior. No external service was
contacted.

## GREEN and verification evidence

Focused protected API/auth tests:

```text
node --test api/dispatch-loading-sheet.test.js api/dispatch-reports.test.js api/dispatch-auth.test.js
tests 26, pass 26, fail 0, skipped 0
```

The repository integration regression passed against the local embedded test
database:

```text
node --test --test-name-pattern="report reads keep inclusive" api/dispatch-repository.test.js
tests 1, pass 1, fail 0
```

New loading/report browser tests use a local static server and intercepted
fixture responses only:

```text
npx playwright test test/e2e/dispatch-print-report.spec.js --project=desktop --reporter=line
4 passed, 0 failed

npx playwright test test/e2e/dispatch-print-report.spec.js --project=mobile --reporter=line
4 passed, 0 failed
```

The existing Board browser regression also passed on both configured sizes:

```text
npx playwright test test/e2e/dispatch-board.spec.js --project=desktop --reporter=line
16 passed, 0 failed

npx playwright test test/e2e/dispatch-board.spec.js --project=mobile --reporter=line
16 passed, 0 failed
```

Full local suite:

```text
npm test
tests 181, pass 180, fail 0, skipped 1
```

Additional checks:

```text
npm run build
exit code 0

node --check api/dispatch-loading-sheet.js
node --check api/dispatch-reports.js
node --check lib/dispatch/loading-sheet.js
node --check lib/dispatch/report.js
node --check lib/dispatch/repository.js
node --check public/dispatch.js
node --check public/loading-sheet.js
node --check test/e2e/dispatch-print-report.spec.js
8/8 passed

git diff --check
clean
```

The first full-suite run failed only because the pre-Task-7 rewrite assertion
did not list the two new routes. The expectation was updated and the final
full suite passed as recorded above.

## Implemented boundaries

- Loading sheets read `getTripDetails`/persisted assignment snapshots only;
  they do not call AutoCount, the live invoice feed, or any source adapter.
- Exact `itemCode + UOM` pairs are aggregated with BigInt-backed decimal-string
  arithmetic. Different item codes and UOMs remain separate, and no price,
  value, weight, capacity, or conversion field is emitted.
- Loading output excludes only persisted `removed` assignments. Reports retain
  removed assignments unless the persisted trip/assignment status filter
  selects another status.
- Enterprise and Sdn Bhd identities remain attached to every checklist/report
  row, including equal invoice IDs on a mixed-company trip.
- Report reads are inclusive by validated ISO business date, accept company,
  driver, lorry, and trip/assignment status filters, use parameterized SQL, and
  are bounded to 1,000 rows.
- JSON is the default report format. Explicit CSV uses deterministic columns
  and order, RFC 4180 quoting, CRLF records, and spreadsheet-formula
  neutralization. Report output contains no prices or credentials.
- Both APIs allow only GET/OPTIONS, require the existing signed dispatch
  session before repository access, reject unknown/repeated/invalid query
  fields, and set `Cache-Control: no-store`.
- Print Items is a same-origin link on each Board trip card and each Trips-tab
  trip detail. The loading page has authoritative loading, error, retry, and
  print states; Print is unavailable until the protected snapshot response is
  loaded successfully.
- Browser rendering escapes untrusted snapshot/report fields. Report and
  loading controls remain keyboard accessible without nested interactive
  controls.
- Loading print CSS sets A4 portrait, hides controls/navigation/status chrome,
  keeps badges/checklist legible, repeats table headers, and avoids splitting
  rows across page breaks.
- All browser/API verification used local intercepted fixtures. No AutoCount,
  Vercel, provider database, production, Quick Invoice, deployment, or other
  external service was used.
- Existing untracked `output/` evidence was preserved and not staged.

## Changed files

- `api/dispatch-auth.test.js` — include the two protected Task 7 rewrites in
  the deployment assertion.
- `api/dispatch-loading-sheet.js` and `api/dispatch-loading-sheet.test.js` —
  protected persisted loading-sheet endpoint and boundary tests.
- `api/dispatch-reports.js` and `api/dispatch-reports.test.js` — protected
  JSON/CSV report endpoint and validation tests.
- `api/dispatch-repository.test.js` — embedded repository read/filter/history
  integration regression.
- `lib/dispatch/loading-sheet.js` — snapshot projection and exact aggregation.
- `lib/dispatch/report.js` — safe report projection, filters, dates, and CSV.
- `lib/dispatch/repository.js` — bounded parameterized persisted report read.
- `public/loading-sheet.html`, `public/loading-sheet.js`, and
  `public/loading-sheet.css` — authenticated loading-sheet page and A4 print
  presentation.
- `public/dispatch.html`, `public/dispatch.js`, and `public/dispatch.css` —
  functional Trips/Reports views, same-origin Print Items links, report
  transport, rendering, and responsive controls.
- `test/e2e/dispatch-print-report.spec.js` — local desktop/mobile loading,
  report, export, retry, mixed-company, and print regressions.
- `vercel.json` — protected loading-sheet and report rewrites.

## Known concerns

- `npm run format:check` remains non-executable because the existing package
  script invokes `prettier`, but Prettier is not installed in this worktree:
  `'prettier' is not recognized as an internal or external command`.
- The hosted `TEST_DATABASE_URL` integration test remains skipped when that
  environment variable is absent. Local embedded migration/repository tests
  passed; real provider migration, pooled connection/TLS, and deployment
  attachment rehearsal remain a pre-preview gate.
- Browser verification uses the repository's local Chromium desktop/mobile
  projects and intercepted fixtures; it is not a live provider or real-device
  validation.

## Commits

- Implementation/tests: `8e43643`
- Evidence report: this file is committed separately after the implementation
  commit; the exact report-only commit hash is returned in the final handoff.
