# AutoCount Sales Dashboard (iPhone PWA)

A lightweight mobile-first sales dashboard that fetches real-time invoice data from AutoCount Cloud API, aggregates by product, and displays clean KPI cards, charts, and tables. Designed as an iPhone PWA (Progressive Web App) for Home Screen access.

## Features

- **Real-time data** — Pulls live invoices from AutoCount Cloud Accounting API
- **Date range selector** — Today, Yesterday, Last 7/30 Days, This Month, or custom range
- **KPI cards** — Total Revenue, Invoices, Units Sold, Top Customer
- **Bar chart** — Top 5 products by revenue
- **Doughnut chart** — Units distribution by product
- **Product breakdown table** — Searchable, sorted by revenue
- **Offline support** — Service Worker caches static assets for offline viewing
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
| `AUTOCOUNT_API_KEY`         | Your AutoCount API key                      |
| `AUTOCOUNT_KEY_ID`          | Your AutoCount Key ID                       |
| `AUTOCOUNT_ACCOUNT_BOOK_ID` | Your account book ID (e.g., `63688`)        |
| `USE_MOCK_DATA`             | `false` for live data, `true` for mock      |
| `DATABASE_URL`              | Pooled PostgreSQL URL for dispatch state    |
| `DISPATCH_USERS_JSON`       | Server-side clerk identities and scrypt hashes |
| `DISPATCH_SESSION_SECRET`   | Base64url for exactly 32 random secret bytes |

### 3. Run Locally

```bash
npx vercel dev
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
padding). PIN hashes use the canonical
`scrypt$N$r$p$salt$derived-key` form with bounded parameters and byte lengths.
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

## Deploy to Vercel

```bash
npx vercel --prod
```

Set environment variables on Vercel:

```bash
npx vercel env add AUTOCOUNT_API_KEY production,preview --value "your-key"
npx vercel env add AUTOCOUNT_KEY_ID production,preview --value "your-key-id"
npx vercel env add AUTOCOUNT_ACCOUNT_BOOK_ID production,preview --value "63688"
npx vercel env add AUTOCOUNT_API_URL production,preview --value "https://accounting-api.autocountcloud.com"
npx vercel env add USE_MOCK_DATA production,preview --value "false"
```

## API Endpoints

| Endpoint                                             | Method | Description               |
| ---------------------------------------------------- | ------ | ------------------------- |
| `/api/sales`                                         | GET    | Sales data for today      |
| `/api/sales?startDate=2026-08-01&endDate=2026-08-03` | GET    | Sales data for date range |

Response:

```json
{
  "success": true,
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
    { "docNo": "SI-00123", "docDate": "2026-08-03", "customerName": "Customer A", "grandTotal": 12000, "outstandingAmount": 0, "paymentStatus": "paid" }
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

This project uses the AutoCount Cloud Accounting API:

- **Base URL**: `https://accounting-api.autocountcloud.com`
- **Auth headers**: `API-Key` and `Key-ID` (not Bearer token)
- **Invoice listing**: `/{accountBookId}/invoice/listing?page={page}&startDate={start}&endDate={end}`
- **Response format**: `{ data: [{ master: {...}, details: [...] }] }`

## License

MIT
