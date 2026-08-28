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

### Legacy non-finite quantity gate

The hardening migration refuses to add the finite-quantity constraint when an
existing `001_delivery_dispatch.sql` database contains `NaN`, `Infinity`, or
`-Infinity` item quantities. It aborts before the hardening DDL, leaves `002`
unapplied, and reports only a count plus bounded item and assignment IDs.

Run the read-only structured preflight first:

```powershell
npm run migrate:preflight
```

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
first appends every original item quantity and identifying field to
`delivery_assignment_item_quantity_remediations`, together with approval and
request metadata, and makes that audit table append-only. It then replaces the
active row with the supplied value while retaining its item ID. Migration does
not invoke this path, and omitting `--confirm` cannot change data. Review the
preflight findings, replacement values, and audit rows before running
`npm run migrate` again.

Repository tests execute the actual migration SQL and transaction behavior
against in-memory WASM PostgreSQL when no test URL is configured:

```powershell
npm run test:repository
```

To run the same file against a temporary real Postgres database, set
`TEST_DATABASE_URL` for that command. The embedded engine cannot prove
Postgres advisory-lock behavior or Vercel pool attachment; those require the
real preview gate.

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
