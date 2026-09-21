# On-Demand PWA Invoice Price Check Design

Date: 2026-09-21

Status: proposed implementation; replaces the static Wanson-dashboard design

## Outcome

Staff open **Price Check** in the AutoCount iPhone PWA and tap **Refresh now** to see price differences on recently approved invoices. Each finding names the invoice, customer, item, UOM, current price, previous price, MYR/% difference, and previous invoice. The checker alerts only; it never blocks issuance, approves, amends, voids, or submits an invoice.

## Why this PWA

The existing static Wanson dashboard updates at 07:00, while this PWA already requests Cloud data on demand. The existing public `/api/sales` response is not suitable for price checking: it drops `debtorCode`, UOM, and approval evidence, and uses floating-point normalized amounts. It also permits cross-origin reads. Price Check therefore gets its own server-side read-only route and mobile page, linked from the PWA home screen.

## Freshness and scope

- Opening Price Check starts a fresh scan; **Refresh now** repeats it. Every successful response shows `scannedAt` from the server and the exact windows. It does not claim push notification or continuous background monitoring.
- Default monitored invoices: **today** in `Asia/Kuala_Lumpur`, with a fixed **last 7 calendar days** option. Price-history baseline: the 90 calendar days preceding the selected monitored window. The resulting source scans are 91 or 97 calendar days, respectively; neither option permits an arbitrary date range.
- The source is AutoCount Cloud invoice listing for Enterprise book `63750` and Sdn Bhd book `63688`. They are independent sources and independent price histories. A failed book is `PARTIAL`; it never inherits the other book's data.
- The source reader pins each request to the configured account-book ID and verifies the Cloud company-profile name, a valid `totalCount`, every page, and exact final row count. The live `companyProfile` response does not contain an account-book ID, so do not invent a body-field check. Missing or changing counts, malformed pages, duplicates, or truncated pagination fail that book rather than yielding false "no differences."
- A complete scan may still take noticeable time because Cloud invoice-history pages must be read. Before production rollout, measure both the 91-day default and 97-day option for both books against the deployed function's timeout and API limits. If either cannot complete reliably, stop and design a persisted incremental history rather than silently shortening the range or claiming the result is current.

## Comparison

- Include only invoices with both `approverID` and `approvedTimeStamp`; exclude cancelled/void invoices. Status text alone is not approval evidence.
- Match by exact `(book ID, debtorCode, productCode, UOM)`; names/descriptions are for display. The latest earlier approved invoice for that customer/item is the reference. Compare whole invoices in order, never two lines from the same invoice against each other.
- If the latest prior occurrence uses another UOM, show `UOM_CHANGED` with the previous UOM and no MYR/% delta. Otherwise show `PRICE_CHANGED` when the quoted unit price differs at MYR 0.01 precision. Prices and deltas use exact decimal-string/BigInt arithmetic, not binary floating point.
- Missing prior history is `NO_HISTORY` and is counted separately, not treated as a matching price. Invalid identity or numeric rows are counted as skipped; they do not become zero-priced comparisons.
- Prior invoice prices show a sales norm, not an approved commercial price. Staff decide whether a difference is intended.

## Amendments and persistence decision

Version 1 recomputes from fresh Cloud data on every check. An amendment to an approved invoice appears on the next scan; a corrected difference disappears. **Version 1 does not retain a first-seen alert history.** This is the trade-off for fast deployment without adding a database migration or durable state to a serverless function. The older static-dashboard plan's persistent `OPEN / RESOLVED_AFTER_AMENDMENT` lifecycle is deliberately not carried over. If staff need a correction audit trail later, add a separate PostgreSQL-backed alert ledger; never write it to the serverless filesystem.

## Access control

- The existing sales homepage is public. Do not embed customer-specific price rows in `/api/sales` or return them through CORS `*`.
- `GET /api/price-check` requires a real signed clerk session cookie. Use `verifySessionCookie`, not `getSessionFromRequest`/`requireDispatchSession`, because `DISPATCH_PUBLIC_ACCESS=true` can grant a synthetic public session. A synthetic public session must **never** authorize Price Check.
- The dedicated PWA page can sign in through the existing `/api/dispatch/session` POST endpoint. If the cookie expires, clear sensitive rendered rows and ask for sign-in again.
- The API is same-origin, `Cache-Control: no-store`, GET-only, and returns no AutoCount credential values or full raw invoices. The service worker must never serve a cached price response or stale fallback. Static page caching is acceptable only because its HTML contains no customer data.

## PWA presentation

Add a **Price Check** link beside the existing Delivery Dispatch link on `public/index.html`. `public/price-check.html` follows the current narrow, dark, iPhone layout. It defaults to Today and offers Last 7 days. It shows source coverage for both books, server scan time, a visible **Refresh now** control, total price/UOM findings, and one compact expandable card per invoice line. Each card shows the company, invoice number/date, customer code/name, item code/description, UOM, current/previous quoted prices, delta, and reference invoice/date. A price alert and UOM alert have distinct text, not color alone. Offline, unauthenticated, partial-source, complete-zero-alert, and source-error states must be visibly distinct.

## Status and trade-offs

- `PASS`: both books verified and scanned completely, even if no alerts were found.
- `PARTIAL`: one book verified and the other failed; show successful-book alerts and name the failed book.
- `FAIL`: neither book produced a complete verified scan. Never show an empty-success state.
- This PWA design improves **freshness** through on-demand scanning. It does not guarantee instant response time; Cloud pagination is likely the main latency. The separate protected route adds sign-in friction but avoids exposing customer price history through the existing public sales API.
- TypeSafe/Jev is not used in version 1. Exact comparison belongs in code; optional semantic labels can be designed later and cannot suppress an alert.

## Out of scope

Approval gates, invoice amendments, price-book updates, push notifications, background polling, a durable alert ledger, a new login system, changes to `/api/sales` output, and deployment before source-performance/security checks pass.
