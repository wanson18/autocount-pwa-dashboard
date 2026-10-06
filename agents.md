# Project Blueprint: AutoCount Sales Dashboard (iPhone PWA)

## System Overview

Mobile-first operations PWA for Wanson Companies. A Vercel serverless middleware reads sales invoices from the AutoCount Cloud Accounting API for both fixed company books (Wanson Enterprise `63750`, Wanson Sdn Bhd `63688`), aggregates line items by SKU, and serves KPI cards, charts, payment status, and per-item/customer breakdowns to a static iPhone-optimized frontend.

Beyond the dashboard home page the app ships Delivery Dispatch, Price Check, Today's Invoices, and a Loading Sheet.

## Tech Stack

- **Middleware:** Node.js serverless functions in `api/` (Vercel, no Express).
- **AutoCount access:** `axios` + `lossless-json` through `lib/autocount/client.js`.
- **Dispatch persistence:** PostgreSQL via `pg`; schema in `db/migrations/`.
- **Frontend:** static HTML5 + Tailwind CSS (CDN, spacing and layout helpers) + `public/theme.css` (all colours and components); no build step. Charts are plain HTML/CSS (no Chart.js).
- **PWA:** `public/manifest.json` plus a versioned service worker cache.
- **Auth:** clerk ID + PIN session cookie. The home page shows a sign-in screen (browser-side only) and `/api/price-check` enforces a real clerk session on the server. `/api/sales` (home page and Today's Invoices) has no server-side login check, and dispatch honours `DISPATCH_PUBLIC_ACCESS`. The owner accepts this (one sign-in on the home page, not a login on every page), so do not add logins elsewhere without asking.

## Repository Layout

```
autocount-pwa-dashboard/
├── api/                 # sales.js, price-check.js, dispatch-*.js, mock-sales.json
├── lib/
│   ├── autocount/       # AutoCount API client and company config
│   ├── db/              # Postgres pool
│   ├── dispatch/        # auth, invoice adapter, loading sheet, repository, service
│   └── price-check/     # invoice source and price comparison
├── public/              # index.html, dispatch.*, loading-sheet.*, price-check.html,
│                        # today-invoices.html, theme.css, fonts/, sw.js, manifest.json, icons/
├── db/migrations/       # delivery dispatch schema (001-005)
├── scripts/             # migrate.js, migrate-preflight.js, remediate-legacy-quantities.js
├── test/                # node:test suites, fixtures, Playwright e2e
├── vercel.json          # API rewrites and no-store headers
└── package.json         # dependencies and npm scripts
```

## Sales Aggregation Rules (`api/sales.js`)

- Every request loads both books; company identity is never mixed (SKUs and customers are keyed per book).
- AutoCount returns each line's `qty` in that line's own `unit`. The raw `quantity` + `unit` stay on `invoices[].lineItems` as the invoice truth.
- **UOM MultiPack rule:** when one SKU appears in more than one unit in the same range (for example BTL and BOX), resolve the product's MultiPack rate from `GET /product` (`productMultiPacks`) and convert to the item's base unit before summing `totalUnits`, customer quantities, `avgPricePerUnit`, and the Units Sold KPI. Observed rates: `1110100002` 5KG = 1 BOX per 4 BTL, `1110100003` 2KG = 1 BOX per 6 BTL.
  - Never hardcode or infer conversion rates.
  - Single-UOM SKUs skip the product lookup.
  - If the product lookup fails, or a unit has no MultiPack that explains it, leave that SKU's quantities raw rather than guessing.
  - `totalCost` stays priced per raw invoice unit.
- Cancelled invoices are excluded. `USE_MOCK_DATA=true` serves `api/mock-sales.json` for Enterprise only.
- Invoice reads are verified (`lib/autocount/invoice-reader.js`, shared with Price Check). AutoCount's page-by-page listing can repeat invoices on large ranges (live, 91 days: 9 invoices twice, 9 missing, revenue about 1.3% off, no error). After the normal read, `fetchAllInvoices` checks that the rows equal `totalCount` with no repeated `docKey`; if not, it re-reads in date slices, and if completeness still cannot be proven it returns `null` (the book shows as unavailable) rather than wrong totals. Never loosen this check to make a range load.

## Delivery Dispatch UOM Rule (contrast)

`lib/dispatch/loading-sheet.js` groups loading totals by exact item code + UOM and must **never** convert or merge units. Do not reuse the sales MultiPack conversion for dispatch quantities.

## Price Check Rules (`api/price-check.js`, `lib/price-check/`)

- Read-only and protected: it needs a real signed clerk session (`verifySessionCookie`), never the synthetic public-dispatch session, and every response is `no-store`.
- Each book is read page by page first (shared reader: `lib/autocount/invoice-reader.js`). AutoCount's paging returned repeated invoices on large date ranges, so a duplicate document, a changing total, or a short or long list triggers one re-read in date slices that each fit on one page. Both reads must prove completeness (no document twice, slice totals equal to the overall total). Never relax these checks to make a failing book pass; fail the book instead.
- `counts.skipped*` describe the monitored window only, not the 90-day history baseline.
- A failed book is `PARTIAL`, never an empty success. Failure details are integers and booleans only (no invoice or customer data).

## Conventions

- UI: colours and components come from `public/theme.css` (tokens in `:root`); `dispatch.css` and `loading-sheet.css` alias the same tokens. Do not add colour utility classes (`text-slate-*`, `bg-*`) or hard-coded hex values to pages. Keep text at least 12px, tap targets at least 44px, text contrast at least 4.5:1 (see README "Look and feel"), and carry status in text, not colour alone.
- Layout: phone layout below 960px, desktop from 960px (`.desktop-only` / `.mobile-only`, app bar from `.app-bar`). Every page must work at 390px and 1440px with no sideways scroll; `test/e2e/responsive-layout.spec.js` checks both.
- The pages must stay usable when the Tailwind CDN script cannot load (offline first visit): keep `.hidden`, box sizing and key layout in `theme.css`, not only in Tailwind classes.
- Tests first: `node:test` suites live in `api/*.test.js` and `test/*.test.mjs`; Playwright specs in `test/e2e/`.
- Changing any cached static asset (including `theme.css` and the font) requires bumping `CACHE_NAME` in `public/sw.js` and the expectations in `test/service-worker.test.mjs` and `test/price-check-ui.test.mjs`.
- Money and quantity values round to 2 decimals at output; keep AutoCount decimal strings exact inside adapters.
- Never commit `.env`, `.env.local`, or credentials; `.env.example` is the contract.
- Merging to `main` deploys to Production by itself: the Vercel Production Branch is `main` (it was `master` before, which is why merges once did nothing). PRs and other branches only get protected previews. Open PRs against `main`; GitHub's default-branch setting may still say `master`, which is stale. Confirm a deploy with `/version.json` (`target` is `production`, `commit` is the merge commit).
- `npx vercel --prod` is now only a backup. Run it from a clean, up-to-date `main` (`git status` empty, `git pull --ff-only`): the CLI uploads the working folder, uncommitted edits included, so deploying anything else lets the live site drift from GitHub (its `/version.json` shows `null` Git fields).
- Function regions are set per function in `vercel.json`. Functions that only call AutoCount Cloud (`price-check`, `sales`, `dispatch-invoices`) run in `sin1`; every function that uses the Postgres (`DATABASE_URL`) runs in `iad1`, next to the database. Moving them all to Singapore made Dispatch slower. Never add a project-wide `regions`; `test/vercel-regions.test.mjs` enforces this (update its `DATABASE_REGION` if the database moves).

## Commands

- `npm test` — unit and integration suites (`node --test api/*.test.js test/*.test.mjs`).
- `npm run local` — run the app locally with `vercel dev`.
- `npm run migrate` / `npm run migrate:preflight` — dispatch database schema.
- `npx playwright test` — end-to-end specs.
- `curl https://autocount-pwa-dashboard.vercel.app/version.json` — which commit is live (`commit`, `branch`, `target`, `builtAt`); merges to `main` deploy to Production automatically (see Conventions).
- `npx vercel --prod` — manual production deploy, a backup only (see Conventions); alias https://autocount-pwa-dashboard.vercel.app. A CLI login unused for 10 days expires, so run `npx vercel login` again if it says "Not authorized".
