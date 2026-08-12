\# Project Blueprint: AutoCount Sales Dashboard (iPhone PWA)



\## System Overview

Build a lightweight 3-tier mobile dashboard that extracts sales invoice data from AutoCount Cloud API, aggregates line items by SKU in a serverless middleware layer, and displays clean KPI cards, charts, and tables on an iPhone PWA.



\## Tech Stack

\- \*\*Middleware:\*\* Node.js (Vercel Serverless Function / Express route handler).

\- \*\*Frontend:\*\* Single-page HTML5 + Tailwind CSS (via CDN) + Chart.js.

\- \*\*PWA:\*\* `manifest.json` with iOS standalone tags (`apple-mobile-web-app-capable`) and Service Worker.

\- \*\*Data Caching:\*\* In-memory TTL cache (10 minutes) to minimize AutoCount API rate hits.



\---



\## Directory Structure to Generate



autocount-pwa-dashboard/

├── api/

│   ├── sales.js             # Main serverless middleware (AutoCount API fetcher \& aggregator)

│   └── mock-sales.json      # Mock sales invoices for offline development

├── public/

│   ├── index.html           # iPhone-optimized single-page web app

│   ├── manifest.json        # PWA metadata for iOS Home Screen shortcut

│   ├── sw.js                # Service worker for offline asset caching

│   └── icons/

│       └── icon-192.png     # App launcher icon

├── .env.example             # Template for API credentials

├── vercel.json              # Vercel deployment routing config

├── package.json             # Dependencies (express, axios, dotenv)

└── AGENTS.md


## Imported Claude Cowork project instructions
