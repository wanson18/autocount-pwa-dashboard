# Wanson Companies AutoCount Sales Dashboard (iPhone PWA)

A lightweight mobile-first sales dashboard that fetches real-time invoice data from AutoCount Cloud API, aggregates by product, and displays clean KPI cards, charts, and tables. Designed as an iPhone PWA (Progressive Web App) for Home Screen access.

## Features

- **Real-time data** — Pulls live invoices from AutoCount Cloud Accounting API
- **Date range selector** — Today, Yesterday, Last 7/30 Days, This Month, or custom range
- **KPI cards** — Total Revenue, Invoices, Units Sold, Top Customer
- **Bar chart** — Top 5 products by revenue
- **Doughnut chart** — Units distribution by product
- **Product breakdown table** — Searchable, sorted by revenue
- **Offline support** — Service Worker caches static assets for offline viewing; sales API failures stay visible instead of showing stale data
- **iPhone PWA** — Add to Home Screen for standalone app experience

## Tech Stack

- **Frontend**: HTML5 + Tailwind CSS (CDN) + Chart.js
- **Backend**: Vercel Serverless Function (Node.js)
- **PWA**: Service Worker + `manifest.json` with iOS standalone tags
- **Data Source**: AutoCount Cloud Accounting API

## Project Structure

```
autocount-pwa-dashboard/
├── api/
│   ├── sales.js           # Serverless middleware (AutoCount API fetcher & aggregator)
│   └── mock-sales.json    # Mock data for offline/fallback
├── public/
│   ├── index.html         # iPhone-optimized single-page web app
│   ├── manifest.json      # PWA metadata for iOS Home Screen
│   ├── sw.js              # Service worker for offline caching
│   └── icons/
│       └── icon-192.png   # App launcher icon
├── .env.example           # Template for API credentials
├── vercel.json            # Vercel deployment config
├── package.json           # Dependencies
└── agents.md              # Project blueprint
```

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/wanson18/autocount-pwa-dashboard.git
cd autocount-pwa-dashboard
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env.local` and fill in your AutoCount credentials:

```bash
cp .env.example .env.local
```

Required variables:

| Variable                    | Description                                 |
| --------------------------- | ------------------------------------------- |
| `AUTOCOUNT_API_URL`         | `https://accounting-api.autocountcloud.com` |
| `AUTOCOUNT_ENTERPRISE_API_KEY` | Credential for Enterprise book `63750`   |
| `AUTOCOUNT_ENTERPRISE_KEY_ID`  | Key ID for Enterprise book `63750`       |
| `AUTOCOUNT_SDN_BHD_API_KEY`    | Credential for Sdn Bhd book `63688`      |
| `AUTOCOUNT_SDN_BHD_KEY_ID`     | Key ID for Sdn Bhd book `63688`          |
| `USE_MOCK_DATA`             | `false` for live data, `true` for mock      |
| `DATABASE_URL`              | Pooled PostgreSQL URL for dispatch state    |
| `DISPATCH_USERS_JSON`       | Server-side clerk identities and scrypt hashes |
| `DISPATCH_SESSION_SECRET`   | Base64url for exactly 32 random secret bytes |
| `DISPATCH_PUBLIC_ACCESS`     | `true` deliberately disables dispatch credential checks |

The old single-book `AUTOCOUNT_COMPANY_ID` setting does not select a book in this integration. Both book-scoped credential pairs must be present for a complete live result; otherwise the dashboard reports which book is unavailable.

### 3. Run Locally

```bash
npm run local
```

## Delivery dispatch persistence

Dispatch state is stored only in PostgreSQL. AutoCount remains the invoice
source. Set `DATABASE_URL` to the pooled Postgres connection supplied by the
deployment provider, then apply ordered migrations with:

```powershell
npm run migrate
```

The migration runner records applied filenames in `schema_migrations` and
uses a transaction-scoped Postgres advisory lock. It does not print the
connection string. The runtime pool is module-scoped and attached for Vercel
Functions connection reuse.

Dispatch authentication requires `DISPATCH_SESSION_SECRET` to be the canonical
base64url encoding of exactly 32 random bytes (43 characters without `=`
padding). PIN hashes use the canonical positional
`scrypt$N$r$p$salt$derived-key` form with one approved profile only:
`N=16384`, `r=8`, `p=1`, a 16-byte salt, and a 64-byte derived key. Alternate
profiles, unknown or duplicate parameters, noncanonical encodings, and malformed
or out-of-bound salt/key lengths fail closed. The bounded parser checks remain in
place as a defense-in-depth limit around that exact profile.
Set `DISPATCH_PUBLIC_ACCESS=true` only for a deliberate public deployment: it
removes the login screen and bypasses clerk checks for dispatch reads and writes.
Anyone who can reach the deployment can then view invoice/customer data and use
dispatch mutations, so keep it `false` unless the deployment is protected by a
separate trusted network or access-control layer.
Login throttling is persisted in PostgreSQL, keyed by HMAC digests of the
normalized clerk ID and trusted client address; the service fails closed if that
store is unavailable. Resource POST/PATCH requests require a validated
`request_id`, and the database stores its fingerprint, response, and audit event
in the same transaction so a retry cannot create a second resource or event.

The dispatch browser uses same-origin JSON requests with a Secure, HttpOnly,
`SameSite=Lax` session cookie. The CSRF boundary assumes no permissive CORS is
configured and that cross-site forms cannot submit the required
`application/json` mutation body. This is an explicit deployment assumption,
not a substitute for authentication; if another origin must call dispatch, add
an origin check or CSRF token before enabling it.

Login admission is reserved atomically before PIN verification. The durable
transaction locks `dispatch_login_throttle_meta` and the selected account and
client-address bucket rows, then reserves both slots or denies the request; the
same-process queue only keeps the embedded PGlite test harness from pretending
one connection is multiple PostgreSQL clients. Before preview, the provider
gate must run the concurrent login regression against real pooled PostgreSQL
connections (including separate worker/process or pool instances), verify that
12 simultaneous requests admit exactly the configured threshold and that all
remaining requests receive `429` with `Retry-After`, then verify expiry, success
reset, migration, TLS, and Vercel pool attachment. This provider rehearsal was
not run in the local security-fix pass.

### Authenticated delivery dispatch API

The dispatch API is protected by the same signed session cookie as the resource
API. The server supplies the audit actor from that session; mutation bodies may
not supply an actor or authoritative invoice data.

Trips are persisted with optimistic revisions and the explicit state machine
`planned -> loading -> dispatched -> completed`, with cancellation allowed from
`planned` or `loading`. A trip can be dispatched only with an active driver, an
active lorry, and at least one active assignment. Assignment outcomes are
`assigned -> loaded -> out_for_delivery -> delivered`, with `failed` or
`returned` from `out_for_delivery` and `removed` from `assigned` or `loaded`.

The available routes are:

| Endpoint | Methods | Purpose |
| --- | --- | --- |
| `/api/dispatch/trips` | GET, POST, PATCH | List, create, and revise trips |
| `/api/dispatch/assignments` | GET, POST, PATCH | Read, assign, move, remove, and update assignment outcomes |

Assignment creation accepts only `trip_id`, `company_key`, `invoice_id`,
`doc_no`, `doc_date`, `expected_trip_revision`, and `request_id`. The server
refetches the selected company's invoice, verifies its company and document
identity, cancellation flag, complete lines, exact decimal quantity strings,
and authoritative UOM, then stores immutable header and line snapshots. One
physical trip may contain assignments from both companies; company ownership is
retained on every assignment and snapshot.

Every mutation uses a validated `request_id` and the durable idempotency record.
The assignment snapshot, item rows, trip revision, audit event, and idempotency
result commit together. A stale revision returns `409 stale_trip`; conflicting
request reuse returns `409 idempotency_conflict`. Stable source and workflow
errors include `invoice_cancelled`, `invoice_missing_uom`,
`invoice_already_assigned`, `invalid_transition`, and `source_unavailable`.
No lorry capacity or weight is inferred from arbitrary invoice UOM quantities.

Before preview, run the Task 5 API and repository checks against real pooled
PostgreSQL connections as well as the local suite. That rehearsal must cover
multi-connection same-invoice and same-revision races, transaction rollback,
append-only event history, migration compatibility, TLS/network behavior, and
Vercel pool attachment. The Board remains fixture-only until its later UI task.

### Legacy non-finite quantity gate

The hardening migration refuses to add the finite-quantity constraint when an
existing `001_delivery_dispatch.sql` database contains `NaN`, `Infinity`, or
`-Infinity` item quantities. It aborts before the hardening DDL, leaves `002`
unapplied, and reports only a count plus bounded item and assignment IDs.
The migration first takes `SHARE ROW EXCLUSIVE` locks on
`delivery_assignments` and `delivery_assignment_items` in that order. This
blocks legacy inserts/updates for the scan and subsequent DDL while matching
the repository's assignment-then-item write order.

Finite classification uses `quantity::text` sentinels rather than
version-specific special-value numeric casts, so the migration and preflight
do not require a hidden PostgreSQL version assumption.

Run the read-only structured preflight first:

```powershell
npm run migrate:preflight
```

Preflight output is NDJSON: one summary line, one bounded record line per
affected item, and one completion line. Records are fetched with deterministic
`id` keyset batches (100 by default, at most 1,000), so the output can be
turned into an exact replacement map without loading the affected dataset into
one in-memory result object.

Do not correct these rows by editing or deleting them ad hoc. If a correction
is authorized, prepare a JSON replacement map keyed by the reported item IDs,
then run the separate, explicitly confirmed remediation path:

```powershell
node scripts/remediate-legacy-quantities.js `
  --confirm `
  --approved-by=OPERATOR_ID `
  --request-id=CHANGE_ID `
  --replacements-file=path\to\replacements.json
```

The replacement map must cover exactly the contaminated IDs and contain
operator-supplied positive finite decimal values. The remediation transaction
acquires the migration advisory lock and the same assignment-then-item table
locks, rescans the complete contaminated set, and compares the replacement map
inside that transaction. Every original item quantity and identifying field is
then appended to `delivery_assignment_item_quantity_remediations`, together
with approval and request metadata, and makes that audit table append-only. It
then replaces the active row with the supplied value while retaining its item
ID. A new contamination or replacement-set mismatch rolls the whole operation
back; request IDs are single-use and audit history cannot be overwritten or
truncated. Migration does not invoke this path, and omitting `--confirm` cannot
change data. Review the preflight findings, replacement values, and audit rows
before running `npm run migrate` again.

Repository tests execute the actual migration SQL and transaction behavior
against in-memory WASM PostgreSQL when no test URL is configured. When
`TEST_DATABASE_URL` is configured, each test fixture receives a unique
temporary schema, sets it as its connection `search_path`, and drops it with
`CASCADE` during cleanup:

```powershell
npm run test:repository
```

To run the same file against a temporary real Postgres database, set
`TEST_DATABASE_URL` for that command. The embedded engine cannot prove
provider-specific advisory-lock/table-lock contention, pooled `pg`
network/TLS behavior, or Vercel pool attachment; those require the separate
real-Postgres run.

## On-demand price check

`GET /api/price-check?range=today|seven_days` performs a fresh, read-only scan of both AutoCount Cloud books (`63750` Enterprise and `63688` Sdn Bhd) and highlights quoted unit-price differences between approved invoices. It is a separate protected route; the existing `/api/sales` output is unchanged.

- **Access** — enter a clerk ID and PIN in the Price Check access panel at the top of the dashboard home page. The existing `/api/dispatch/session` endpoint sets the signed `dispatch_session` cookie; the price-check route accepts only a real signed session and never accepts the synthetic public-dispatch session.
- **Windows** — fixed server-side only, in `Asia/Kuala_Lumpur`: `today` scans 90 prior days plus today (91 days), and `seven_days` monitors the last 7 calendar days plus 90 prior days (97 days). Arbitrary or unknown ranges return `400`.
- **Read-only** — `Cache-Control: no-store`, no CORS, GET-only, and no service-worker cache or offline fallback for price data. No invoice is created, approved, amended, voided, or submitted, and Jev/TypeSafe is not involved.
- **No persistent audit** — version 1 recomputes from fresh Cloud data on every check, so a corrected difference disappears on the next scan. A durable first-seen alert ledger is deliberately out of scope.
- **Status** — `PASS` (both books verified and scanned completely, even with no alerts), `PARTIAL` (one book failed; only the successful book's alerts are shown), `FAIL` (neither book scanned, returned with HTTP `502`, never an empty-success state).

The dashboard home page starts with the **Price Check access** panel. After signing in, use the **Check Price Differences** button. The mobile page `public/price-check.html` defaults to Today and offers a Last 7 days selector. It clears customer rows on failed or unauthenticated refreshes instead of showing stale prices, and distinguishes complete-zero, partial, failed, offline, and unauthenticated states by text.

## Deploy to Vercel

```bash
npx vercel --prod
```

Set environment variables on Vercel:

```bash
npx vercel env add AUTOCOUNT_ENTERPRISE_API_KEY production,preview --value "your-enterprise-key"
npx vercel env add AUTOCOUNT_ENTERPRISE_KEY_ID production,preview --value "your-enterprise-key-id"
npx vercel env add AUTOCOUNT_SDN_BHD_API_KEY production,preview --value "your-sdn-bhd-key"
npx vercel env add AUTOCOUNT_SDN_BHD_KEY_ID production,preview --value "your-sdn-bhd-key-id"
npx vercel env add AUTOCOUNT_API_URL production,preview --value "https://accounting-api.autocountcloud.com"
npx vercel env add USE_MOCK_DATA production,preview --value "false"
```

## API Endpoints

| Endpoint                                             | Method | Description               |
| ---------------------------------------------------- | ------ | ------------------------- |
| `/api/sales`                                         | GET    | Sales data for today      |
| `/api/sales?startDate=2026-08-01&endDate=2026-08-03` | GET    | Sales data for date range |

Response:

The response is `complete: true` only when both books load successfully. If one book is unavailable, the API returns the available data with `complete: false`, a per-company error, and a warning so the dashboard cannot mistake one book's count for the combined total.

```json
{
  "success": true,
  "complete": true,
  "company": "Wanson Companies",
  "companies": [
    { "id": "enterprise", "name": "Wanson Enterprise", "accountBookId": "63750", "status": "ok", "invoiceCount": 12 },
    { "id": "sdnBhd", "name": "Wanson Sdn Bhd", "accountBookId": "63688", "status": "ok", "invoiceCount": 45 }
  ],
  "dateRange": { "startDate": "2026-08-03", "endDate": "2026-08-03" },
  "kpis": {
    "totalRevenue": 40773.3,
    "totalInvoices": 29,
    "totalItemsSold": 1234,
    "avgOrderValue": 1405.98,
    "topCustomer": { "name": "Customer A", "revenue": 12000 }
  },
  "topSKUs": [...],
  "skuBreakdown": [...],
  "invoices": [
    { "docNo": "SI-00123", "docDate": "2026-08-03", "customerName": "Customer A", "grandTotal": 12000, "outstandingAmount": 0, "paymentStatus": "paid", "companyId": "enterprise", "companyName": "Wanson Enterprise", "accountBookId": "63750" }
  ],
  "paymentSummary": {
    "paid": { "count": 20, "total": 28000 },
    "partial": { "count": 3, "outstanding": 4200 },
    "unpaid": { "count": 6, "total": 8573.3 },
    "unknown": { "count": 0, "total": 0 },
    "stillUnpaidTotal": 12773.3
  }
}
```

## AutoCount Cloud API Reference

This project uses the AutoCount Cloud Accounting API for both Wanson companies:

- **Base URL**: `https://accounting-api.autocountcloud.com`
- **Auth headers**: `API-Key` and `Key-ID` (not Bearer token)
- **Cloud books**: `63750` (`Wanson Enterprise`) and `63688` (`Wanson Sdn Bhd`)
- **Credentials**: each book uses its own matching API-Key and Key-ID pair
- **Invoice listing**: `/{accountBookId}/invoice/listing?page={page}&startDate={start}&endDate={end}`
- **Response format**: `{ data: [{ master: {...}, details: [...] }] }`

## License

MIT
