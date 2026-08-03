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
└── AGENTS.md              # Project blueprint
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

| Variable | Description |
|----------|-------------|
| `AUTOCOUNT_API_URL` | `https://accounting-api.autocountcloud.com` |
| `AUTOCOUNT_API_KEY` | Your AutoCount API key |
| `AUTOCOUNT_KEY_ID` | Your AutoCount Key ID |
| `AUTOCOUNT_ACCOUNT_BOOK_ID` | Your account book ID (e.g., `63688`) |
| `USE_MOCK_DATA` | `false` for live data, `true` for mock |

### 3. Run Locally

```bash
npx vercel dev
```

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

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sales` | GET | Sales data for today |
| `/api/sales?startDate=2026-08-01&endDate=2026-08-03` | GET | Sales data for date range |

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
  "skuBreakdown": [...]
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
