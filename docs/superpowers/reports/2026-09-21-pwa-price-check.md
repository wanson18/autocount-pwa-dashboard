# PWA Price Check — Read-Only Acceptance Report

Date: 2026-09-21
Branch: `codex/pwa-price-check`
Scope: read-only acceptance of the on-demand price check (Tasks 1–4). No deployment.

## Status

- **Local acceptance: PASS** — both fixed books verified and scanned completely for both ranges through the protected local handler, with no Cloud writes.
- **Rollout: PARTIAL / NOT DEPLOYED** — no preview or production deployment is authorized by the plan. Deployed-runtime function timeout has **not** been measured, and no real production login was attempted.

## Method

- Ran the protected handler `createPriceCheckHandler` locally against the live AutoCount Cloud books via the existing `AutoCountClient` (read-only `GET` only: `getCompanyProfile` and `listInvoicePage`/`invoice/listing`).
- Authentication used the real `verifySessionCookie` with an ephemeral, in-memory signed cookie. The session secret and PIN hash were generated in memory for this run and were never printed.
- Company configs were sourced from the existing sales `getCompanyConfigs()` after dotenv load, mapped to `{ enterprise: {…, companyKey: 'enterprise' }, sdn_bhd: {…, companyKey: 'sdn_bhd'} }`.
- Only aggregate counts, dates, HTTP/cache metadata, and wall-clock timings were captured. No customer names, item codes, invoice numbers, prices, raw rows, credentials, cookie, PIN, hash, or secret were printed or stored.
- `cloudWrites: false` in every response; the client only exposed the two read methods, so no mutation API was reachable.

## Results — range `today` (91-day source scan)

- Window (`Asia/Kuala_Lumpur`): monitor `2026-09-21`, history from `2026-06-23`, through `2026-09-21`.
- HTTP `200`, status `PASS`, `Cache-Control: no-store, max-age=0, must-revalidate`, no CORS header, `cloudWrites: false`.
- Wall-clock: **5051 ms** (single local run).
- Aggregate counts: alerts 3 (price 3, UOM 0), compared 77, unchanged 74, no-history 3, monitored invoices 42, eligible invoices 2757, eligible lines 5638, skipped unapproved 47, skipped void 66, skipped invalid line 1, skipped invalid invoice 0.

| Book ID | Company | Profile | Pages | Invoices | Approved invoices | Approved lines | Total lines | First docDate | Last docDate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 63750 | Wanson Enterprise | verified | 5 | 490 | 441 | 441 | 490 | 2026-06-23 | 2026-09-21 |
| 63688 | Wanson Enterprise (M) Sdn Bhd | verified | 24 | 2380 | 2316 | 5197 | 5371 | 2026-06-23 | 2026-09-21 |

## Results — range `seven_days` (97-day source scan)

- Window (`Asia/Kuala_Lumpur`): monitor `2026-09-15`, history from `2026-06-17`, through `2026-09-21`.
- HTTP `200`, status `PASS`, `Cache-Control: no-store, max-age=0, must-revalidate`, no CORS header, `cloudWrites: false`.
- Wall-clock: **4545 ms** (single local run).
- Aggregate counts: alerts 14 (price 14, UOM 0), compared 419, unchanged 405, no-history 13, monitored invoices 199, eligible invoices 2944, eligible lines 6019, skipped unapproved 48, skipped void 66, skipped invalid line 1, skipped invalid invoice 0.

| Book ID | Company | Profile | Pages | Invoices | Approved invoices | Approved lines | Total lines | First docDate | Last docDate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 63750 | Wanson Enterprise | verified | 6 | 520 | 470 | 470 | 521 | 2026-06-17 | 2026-09-21 |
| 63688 | Wanson Enterprise (M) Sdn Bhd | verified | 26 | 2538 | 2474 | 5549 | 5723 | 2026-06-17 | 2026-09-21 |

The two ranges are separate point-in-time snapshots; the `today` counts are not forced to be a subset of the `seven_days` counts.

## Security and contract checks

- `401` without a real cookie fails before any Cloud read (fixture tests: `public dispatch mode without a real cookie never reads prices`, `an invalid signed cookie is rejected with 401 and no Cloud reads` in `api/price-check.test.js`). No real production login was attempted.
- No CORS header is set on any response; `Cache-Control: no-store, max-age=0, must-revalidate` on all responses.
- A `GET`-only route; non-GET returns `405`. One failed book yields `PARTIAL` with only the successful book's alerts; both failed yield `FAIL`/`502`, never an empty-success state.

## UI evidence

- Automated UI/service-worker tests pass (`test/price-check-ui.test.mjs`, `test/service-worker.test.mjs`), including escaped rendering, 401 clearing, in-flight/race handling, 502 FAIL envelope rendering, malformed-envelope fail-closed behavior, and price-API network-only behavior.
- Fixture browser inspection (local Chromium via Playwright, fixture server, no live data) was captured at 390×844 and 320×568 for `pass`, `unauthorized`, `partial`, `fail`, `zero`, `offline`, `seven_days`, and the home link, with zero horizontal overflow. Screenshots remain under `C:/Users/wanso/AppData/Local/Temp/price-check-inspect` (outside the repository).

## Remaining gates

1. **Deploy** to a Vercel preview/production environment (requires explicit user approval; not performed).
2. **Measure both ranges on the deployed runtime.** Confirm the 91-day (`today`) and 97-day (`seven_days`) scans for both books complete within the function timeout and Cloud rate limits. Local timings above do not prove deployed-runtime performance.
3. **Real clerk login** against the deployed route (not attempted here).
4. **Production env confirmation.** Vercel Production contains the required variable *names* (`DISPATCH_USERS_JSON`, `DISPATCH_SESSION_SECRET`, both account-book IDs, both credential pairs); their values were not inspected.
5. **Deployed contract check.** Re-verify `no-store`, no-CORS, `401` zero-Cloud-read, and network-only service-worker behavior on the deployed runtime.

No customer-level payload is included in this report.
