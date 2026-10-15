# AutoCount: one shared layer for Sales, Dispatch and Price Check

Date: 2026-10-15 · Base: `origin/main` at `04af0d1` (PR #20)
Scope: `lib/autocount/`, new `lib/dates.js`, `api/sales.js`, `api/price-check.js`, `lib/price-check/`, the date checks in `lib/dispatch/` and `api/dispatch-invoices.js` / `api/dispatch-assignments.js`, `.env.example`, README, `agents.md`, tests

This is sub-project 1 of the repo refactor. The others (Dispatch API input checks, splitting `lib/dispatch/repository.js`, moving inline page scripts into files, docs tidy-up) get their own specs.

## Problem

Sales reads AutoCount with its own copy of everything that Dispatch and Price Check share in `lib/autocount/`:

- **Company settings, twice, with rules that contradict each other.**
  - `api/sales.js` has its own `COMPANY_DEFINITIONS`, with the book numbers typed in (63750, 63688).
  - `lib/autocount/company-config.js` reads the book numbers from `AUTOCOUNT_ACCOUNT_BOOK_WANSON_*` and fails if they are missing.
  - `api/price-check.js` (`EXPECTED_BOOKS`) and `lib/price-check/source.js` (`COMPANY_REGISTRY`) then type the numbers in again, to check them.
  - Dispatch lets Sdn Bhd fall back to the shared `AUTOCOUNT_API_KEY` pair. Sales refuses that, on purpose (test "getCompanyConfigs never reuses Enterprise credentials for Sdn Bhd").
  - Both accept the `AUTOCOUNT_ENTERPRISE_API_KEY` and `AUTOCOUNT_API_KEY_WANSON_ENTERPRISE` styles, but prefer them in opposite order. Only Sales reads `AUTOCOUNT_ENTERPRISE_API_URL` / `AUTOCOUNT_SDN_BHD_API_URL`. Only Dispatch trims spaces.
- **AutoCount fetching, twice.** `fetchAllInvoices` in `api/sales.js` calls axios directly, with plain `JSON.parse` numbers, its own headers and its own page loop. It runs its own completeness check (`listingProblem`) before falling back to the shared reader's `windowed` mode. Dispatch and Price Check go through `AutoCountClient` (lossless JSON).
- **Date helpers, many times.** The "real calendar date" check is written 7 times on the server: `api/sales.js` (regex only), `api/dispatch-invoices.js`, `api/dispatch-assignments.js`, `lib/dispatch/service.js`, `lib/dispatch/invoice-adapter.js`, `lib/price-check/source.js` and `lib/price-check/compare.js`. "Today in Malaysia" is written twice (`getLocalToday` in Sales, `malaysiaDate` in Price Check).

So any fix to how AutoCount is read, or how its settings are read, has to be made in two places, and the two copies already disagree.

## Goal

One AutoCount layer: one company list and settings loader, one client, one file for checked invoice reads, and one date module. Sales, Dispatch and Price Check all use it. The pages and the API answers for valid requests stay exactly the same. This is checked against live AutoCount before the PR.

## Decisions (agreed while brainstorming)

- **One rule set.** Where Sales, Dispatch and Price Check disagree about settings, all three now follow the same rules, and the stricter rule wins. Every key name that works today keeps working.
- **Approach A: share the AutoCount pieces only.** Sales keeps its sales maths (normalising, MultiPack, totals, payment status) in `api/sales.js`. Dispatch keeps its own paging loop in `lib/dispatch/invoice-adapter.js`.
- **Live check on this PC** before the PR (see Testing).

## Design

### 1. Company list and settings (`lib/autocount/company-config.js`)

**`COMPANIES`.** A frozen list in this order, the only place the books are defined:

| `companyKey` | `salesId` | `accountBookId` | `name` (Dispatch, Price Check) | `dashboardName` (Sales) | `profileName` (Price Check) |
| --- | --- | --- | --- | --- | --- |
| `enterprise` | `enterprise` | `63750` | Wanson Enterprise | Wanson Enterprise | WANSON ENTERPRISE |
| `sdn_bhd` | `sdnBhd` | `63688` | Wanson Enterprise (M) Sdn Bhd | Wanson Sdn Bhd | WANSON ENTERPRISE (M) SDN. BHD |

The two display names stay different because the pages show them differently today.

**Settings rules.** Every value is trimmed, and an empty value counts as unset.

- **Book number.** Fixed by `COMPANIES`. `AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE` / `AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD` are optional. If one is set to anything other than the fixed number, that book is misconfigured. It is never read from a different book.
- **API key and key ID.** Each is resolved on its own, from the book's own names, in this order:
  - Enterprise: `AUTOCOUNT_ENTERPRISE_API_KEY`, then `AUTOCOUNT_API_KEY_WANSON_ENTERPRISE`. For the key ID: `AUTOCOUNT_ENTERPRISE_KEY_ID`, then `AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE`.
  - Sdn Bhd: `AUTOCOUNT_SDN_BHD_API_KEY`, then `AUTOCOUNT_API_KEY_WANSON_SDN_BHD`. For the key ID: `AUTOCOUNT_SDN_BHD_KEY_ID`, then `AUTOCOUNT_KEY_ID_WANSON_SDN_BHD`.

  The two own-name styles may be mixed (a key from one, its ID from the other), as both Sales and Dispatch allow today.
  - Both found: the book is ready.
  - Only one found: the book is misconfigured. The missing half is never borrowed from the shared pair.
  - Neither found:
    - **Enterprise only** may use the old shared pair: `AUTOCOUNT_API_KEY`, with `AUTOCOUNT_KEY_ID` (or, failing that, `AUTOCOUNT_API_KEY_ID`). It must be a complete pair, or the book is misconfigured.
    - **Sdn Bhd** is misconfigured. It never uses the shared pair.
- **AutoCount address.** `AUTOCOUNT_ENTERPRISE_API_URL` / `AUTOCOUNT_SDN_BHD_API_URL`, then `AUTOCOUNT_API_URL`, then `https://accounting-api.autocountcloud.com`. Trailing slashes are removed.

**Interface**

- `readCompanySettings(env = process.env)` returns one frozen entry per company, in `COMPANIES` order. Each entry has the `COMPANIES` fields plus:
  - `apiUrl`, `apiKey`, `keyId`
  - `problem`: `null`, or `{ code, message }`

  The `code` is one of `credentials_missing`, `credentials_incomplete`, `shared_credentials_incomplete` or `account_book_mismatch`. The `message` names settings only, never values. When `problem` is set, `apiKey` and `keyId` are `null`, so half a credential never travels further.
- `loadCompanyConfigs(env = process.env)` keeps its current contract for Dispatch and Price Check:
  - It returns frozen `{ enterprise, sdn_bhd }`, each `{ companyKey, name, accountBookId, apiUrl, keyId, apiKey }`. `apiUrl` is new.
  - It throws `CompanyConfigError` with the first problem's message if either book is misconfigured.
- `publicCompany` and `CompanyConfigError` are unchanged.
- The old `COMPANY_DEFINITIONS` export goes; nothing outside the file uses it.

**How each surface fails (unchanged)**

- **Sales** maps `readCompanySettings` to its existing `getCompanyConfigs` shape: `{ id: salesId, name: dashboardName, accountBookId, apiUrl, apiKey, keyId, credentialsConfigured }`, plus a new `settingsError` field. A book with a problem gets `credentialsConfigured: false` and shows as unavailable on its own, as today. `settingsError` holds the error text to show:
  - "Credentials not configured" for the three credential codes (today's text).
  - "Account book setting does not match" for `account_book_mismatch` (new).

  `loadCompanyInvoices` uses `settingsError`, or "Credentials not configured" when it is absent (as in tests that build a company by hand).
- **Dispatch** (`api/dispatch-invoices.js`, `lib/dispatch/service.js`) and **Price Check** still call `loadCompanyConfigs()` and keep their current 503 answers when it throws.

### 2. AutoCount client (`lib/autocount/client.js`)

- Each request uses `company.apiUrl` when it is a non-empty string, otherwise the client's `baseUrl` (unchanged default: `AUTOCOUNT_API_URL`, then AutoCount's standard address).
- Trailing slashes are removed with `/\/+$/`. Today the client removes only one.
- Nothing else changes: the same headers (`API-Key`, `Key-ID`), 15-second timeout, raw text with lossless JSON parsing, and status checks.

### 3. Checked read for Sales (`lib/autocount/invoice-reader.js`)

New export `readInvoicesChecked({ listPage, accountBookId, startDate, endDate, maxPages = 100 })`. It is Sales' current read, moved here unchanged.

1. **Tolerant pass, page by page from page 1.**
   - A page must be an object whose `data` is an array, or the read throws.
   - Rows are appended. The latest numeric `totalCount` is remembered, so an invoice saved during the read does not break it.
   - Stop on an empty page. Also stop when rows reach the finite `totalCount`. With no `totalCount`, also stop when a page is shorter than the page size. The page size is the first non-zero of `pageSize` / `page_size` / `limit`, using the helper from section 4.
   - Going past `maxPages` throws.
2. **Proof.** If a safe-integer `totalCount` was reported, the rows must equal it, and no readable `docKey` may appear twice. Rows without a readable `docKey` are skipped in the duplicate check, as today. If either check fails, the range is re-read with the existing strict `windowed` mode.
3. **Result.** It returns `{ rows, pageCount, verifiedBy: 'pages' | 'slices', problem }`, where `problem` is `null`, `'row count does not match totalCount'` or `'an invoice is listed twice'`. Any other failure throws.

`readInvoiceRange` (`paged` and `windowed`), `readDocKey` and `sourceError` are unchanged. Price Check keeps its own stricter flow (paged, then windowed on a retryable error). `addDays` moves to `lib/dates.js` (section 5). The "never loosen the checks" rule now has one home.

### 4. Sales (`api/sales.js`)

- **Removed:** its `COMPANY_DEFINITIONS`, `DEFAULT_API_URL`, `getHeaders`, `DATE_RE` / `isValidDate`, `listingProblem`, `readInvoicesInDateSlices`, and the direct `axios` import.
- **`getCompanyConfigs(env)`** maps `readCompanySettings` to the existing shape (section 1).
- **`fetchAllInvoices(startDate, endDate, company, client = new AutoCountClient())`.** The 4th argument is now an AutoCount client, not an axios-like object. It calls `readInvoicesChecked` with `listPage = (params) => client.listInvoicePage(company, params)`. These stay the same:
  - It returns `null` on any failure.
  - It keeps the same "Missing AutoCount credentials" guard.
  - It writes the same log lines, including "cannot be trusted (…); re-reading in date slices" and "Fetched N invoices … (verified in date slices)".
- **`loadCompanyInvoices(startDate, endDate, company, useMock, { client, getProduct })`.** `client` replaces `httpClient`. The default product lookup is `client.getProduct(company, itemCode)` on the same client. Mock mode is unchanged: credentials are not checked, and `mock-sales.json` is used for Enterprise only.
- **Numbers.**
  - **The trap.** The client returns AutoCount numbers as exact text. Today Sales picks values with `a || b || 0` on plain numbers, so a zero falls through to the next field (for example `finalTotal || total || grandTotal`). A text `"0.00"` would not fall through.
  - **The fix.** A small helper, `firstNonZero(...candidates)` in new `lib/autocount/amounts.js`, keeps today's rule: the first candidate that is present and parses to a non-zero number wins, otherwise 0. Sales uses it for grand total, line quantity, unit price and line total. The checked read uses it for page size.
  - **Unchanged.** `parseOutstandingAmount` and the cancelled flag already accept text.
- **Request dates.** The handler checks `startDate` / `endDate` with `isIsoDate`.
- **`getLocalToday`** keeps its export and behaviour (`REPORT_TIMEZONE`, a warning and the UTC date on a bad zone), built on `todayIn`.

### 5. Dates (`lib/dates.js`)

- `isIsoDate(value)`: true only for a string in `YYYY-MM-DD` that is a real calendar date.
- `todayIn(timeZone, now = new Date())`: the `YYYY-MM-DD` date in that time zone. Throws on an invalid zone.
- `addDays(isoDate, delta)`, `diffDays(fromIso, toIso)`: moved from `invoice-reader.js`.

These callers switch to `isIsoDate`, and their own copies are deleted:

- `api/sales.js`
- `api/dispatch-invoices.js` (its unused `isValidDate` export goes)
- `api/dispatch-assignments.js` (`dateField`)
- `lib/dispatch/service.js` (still exports `isValidDate`, now as `isIsoDate`, for `api/dispatch-trips.js` and `api/dispatch-reports.js`)
- `lib/dispatch/invoice-adapter.js`
- `lib/price-check/source.js`
- `lib/price-check/compare.js`

The date-and-time parsing that the adapter and compare do around the check stays as it is. Price Check's `malaysiaDate` becomes `todayIn('Asia/Kuala_Lumpur', …)`.

### 6. Price Check and Dispatch

- `api/price-check.js`: `EXPECTED_BOOKS` is built from `COMPANIES`. The fail-closed check on injected configs stays (test "a configuration that crosses the fixed book ids fails closed").
- `lib/price-check/source.js`: `COMPANY_REGISTRY` is built from `COMPANIES` (same export and shape). `addDays` comes from `lib/dates.js`.
- Dispatch: only the date checks and the settings rules change. The paging loop, row quarantine, duplicate handling and error codes stay as they are.

### 7. Docs

- **`.env.example`:**
  - It describes the one rule set: own names first, aliases next, the shared pair for Enterprise only, and book-number settings optional and double-checked.
  - It adds the per-company `*_API_URL` lines as optional.
  - It drops `AUTOCOUNT_ACCOUNT_BOOK_ID`, which no code reads.
- **README:** the settings table and a short "Company settings" note give the same rules.
- **`agents.md`:**
  - The AutoCount access line now covers Sales too.
  - A rule says company books, key names and the address come only from `lib/autocount/company-config.js`.
  - It notes that `lib/autocount/invoice-reader.js` holds every checked read mode.

## Behaviour changes (complete list)

1. Dispatch and Price Check no longer need `AUTOCOUNT_ACCOUNT_BOOK_WANSON_*`. A value that differs from 63750 / 63688 now marks that book misconfigured; today Dispatch would read that other book. Sales now applies the same check.
2. Sdn Bhd never uses the shared `AUTOCOUNT_API_KEY` pair. Today Dispatch and Price Check allow it.
3. When both own-name styles are set, Dispatch and Price Check now prefer `AUTOCOUNT_ENTERPRISE_*` / `AUTOCOUNT_SDN_BHD_*` (Sales' order). Today they prefer `*_WANSON_*`. For the shared key ID, `AUTOCOUNT_KEY_ID` now comes before `AUTOCOUNT_API_KEY_ID`.
4. Sales no longer combines a book's own key with the shared ID (or the reverse), now trims spaces, and accepts `AUTOCOUNT_API_KEY_ID` as the Enterprise shared key ID.
5. Dispatch and Price Check now honour `AUTOCOUNT_ENTERPRISE_API_URL` / `AUTOCOUNT_SDN_BHD_API_URL`. Today only Sales does.
6. `/api/sales` answers 400 to an impossible date such as `2026-02-31`, as Dispatch already does. Today it passes it on to AutoCount.
7. Sales' AutoCount requests no longer send `Content-Type: application/json` (a GET has no body; Dispatch and Price Check already omit it). Sales now receives numbers as exact text and converts them with the first-non-zero rule.

If the dashboard and Price Check both load both books today, items 1 to 5 change nothing on Vercel. That proves each book's own keys are set, and that any `AUTOCOUNT_ACCOUNT_BOOK_*` value already equals the fixed number. The check after merging (Shipping) confirms it.

## Unchanged

- Every API response shape and value for valid requests:
  - `/api/sales`, including company IDs `enterprise` / `sdnBhd`, names, warnings and `complete`
  - `/api/price-check`
  - `/api/dispatch/*`
- Dispatch's paging loop and Price Check's read flow and error codes.
- Mock mode.
- All pages, `public/sw.js` (no static file changes, so no `CACHE_NAME` bump) and `vercel.json` regions.

## Testing

Tests are written before the code, in this worktree. Baseline on `04af0d1`: `npm test` gives 408 tests, 407 pass, 1 skipped (it needs `TEST_DATABASE_URL`). The Playwright baseline is recorded before the first change.

**New tests**

- Settings, one test per rule in section 1:
  - order of names
  - mixing the two own-name styles
  - half a pair
  - the Enterprise shared pair, complete and incomplete
  - Sdn Bhd refusing the shared pair
  - book-number setting unset, equal, and different
  - trimming and empty values
  - per-company and default address
  - problem messages never contain a key value
  - `apiKey` / `keyId` are `null` when there is a problem
- `readInvoicesChecked`. The Sales reader tests move here and drive it through a fake `listPage`:
  - missing `totalCount`
  - a growing total
  - repeated invoices, which are re-read in slices
  - a list short of its total, which throws
  - slices that do not add up, which throws
  - the page ceiling
- `firstNonZero` (`lib/autocount/amounts.js`): numbers, text, `"0.00"` falling through to the next field, `null` / missing, and all-zero giving 0.
- `lib/dates.js`: real and impossible dates, non-strings, time zones and rollover, an invalid zone, `addDays` / `diffDays`.
- The client's per-company address and trailing slashes.

**Existing tests that change**

- `api/sales.test.js`:
  - The tests that fake axios now build `new AutoCountClient({ http })` with a fake that returns JSON text. The expected results are the same.
  - The `Content-Type` header check goes.
  - Fake rows such as `{ id: 1 }` come back as `{ id: '1' }`, as real lossless parsing does.
  - New tests cover the book-number check and the 400 for impossible dates.
- `api/dispatch-invoices.test.js`:
  - Made-up book numbers become 63750 / 63688.
  - "uses shared credentials only when both shared values exist" now asserts that Enterprise accepts the pair and Sdn Bhd refuses it.
  - The `.env.example` check follows the updated file.
- `api/price-check.test.js` and `test/price-check-source.test.mjs` should pass unchanged.

**Runs**

`npm test` and the Playwright specs must stay green. The specs run one at a time, because they share port 4173.

**Live check (before the PR, nothing committed)**

- A throwaway script in this session's scratch folder, outside the repo, compares an untouched `git archive` copy of `origin/main` (old) with this branch (new).
- Each side runs in its own Node process against live AutoCount, read-only.
- Both load the keys from `.env.local`. Their values are never printed. The old side is also given `AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE=63750` and `AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD=63688`, which it needs and `.env.local` does not set. The new side runs without them.
- Same requests and the same clock for both:
  - The Sales handler for today, the last 30 days and the last 91 days, ignoring `timestamp`.
  - The Price Check handler for `today` and `seven_days`, with `auth` stubbed and `now` fixed.
  - The Dispatch invoices handler for today, with `getSession` stubbed.
- Results are compared in memory. The script prints only "identical", or the JSON paths that differ, never their values. Nothing is written to files. A case that differs is re-run once, to rule out an invoice saved in between. A difference that remains blocks the PR until it is explained.
- The summary goes into the PR description.

## Shipping

- Small commits in plan order: dates, settings, client, reader, Sales, Price Check and Dispatch, docs.
- Push this branch with an explicit refspec and open a draft PR into `main`. The owner merges.
- After the merge, check that `/version.json` shows the merge commit with `"target":"production"`.
- Then the owner opens the dashboard, Price Check and Dispatch once, to confirm both books still load with the Vercel settings, which the live check cannot see.

## Out of scope (possible follow-ups)

- Moving Dispatch's invoice paging onto the shared checked reader (approach C). It changes how Dispatch reacts to a bad AutoCount list, so it needs its own decision.
- Moving the sales maths into `lib/sales/` (approach B).
- Giving the two Sdn Bhd display names a single name.
- The other refactor sub-projects listed at the top.
