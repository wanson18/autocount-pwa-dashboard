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

The old single-book `AUTOCOUNT_COMPANY_ID` setting does not select a book in this integration. Both book-scoped credential pairs must be present for a complete live result; otherwise the dashboard reports which book is unavailable.

### 3. Run Locally

```bash
npm run local
```

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
