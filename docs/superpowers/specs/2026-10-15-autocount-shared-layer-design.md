# AutoCount: one shared layer for Sales, Dispatch and Price Check

Date: 2026-10-15, revised the same day after design review · Base: `origin/main` at `04af0d1` (PR #20)
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
- **AutoCount fetching, twice.** `fetchAllInvoices` in `api/sales.js` calls axios directly, with plain `JSON.parse` numbers, its own headers and its own page loop. It runs its own count and duplicate check (`listingProblem`) before falling back to the shared reader's `windowed` mode. Dispatch and Price Check go through `AutoCountClient` (lossless JSON).
- **Date helpers, many times.** The "real calendar date" check is written 7 times on the server: `api/sales.js` (regex only), `api/dispatch-invoices.js`, `api/dispatch-assignments.js`, `lib/dispatch/service.js`, `lib/dispatch/invoice-adapter.js`, `lib/price-check/source.js` and `lib/price-check/compare.js`. "Today in Malaysia" is written twice (`getLocalToday` in Sales, `malaysiaDate` in Price Check).

So any fix to how AutoCount is read, or how its settings are read, has to be made in two places, and the two copies already disagree.

## Goal

One AutoCount layer: one company list and settings loader, one client, one file for checked invoice reads, one module for reading AutoCount numbers, and one date module. Sales, Dispatch and Price Check all use it.

For the values AutoCount actually sends, the pages and the API answers for valid requests stay the same. This is checked before the PR by replaying identical recorded AutoCount responses to the old and the new code. Where the new parsing could differ only for values AutoCount does not send, the rule is spelled out below, not claimed identical.

## Decisions (agreed while brainstorming and in design review)

- **One rule set.** Where Sales, Dispatch and Price Check disagree about settings, all three now follow the same rules, and the stricter rule wins. Every key name that works today keeps working.
- **Approach A: share the AutoCount pieces only.** Sales keeps its sales maths (normalising, MultiPack, totals, payment status) in `api/sales.js`. Dispatch keeps its own paging loop in `lib/dispatch/invoice-adapter.js`.
- **Proof on this PC.** A deterministic old-versus-new comparison runs on pinned commits with recorded AutoCount responses, plus a separate live run of the new code (see Testing).
- **Release gate.** Before merging, the Vercel settings are checked by name, because the precedence and address rules can pick different settings than today (see Shipping).

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

**Changes**

- Each request uses `company.apiUrl` when it is a non-empty string, otherwise the client's `baseUrl` (unchanged default: `AUTOCOUNT_API_URL`, then AutoCount's standard address).
- Trailing slashes are removed with `/\/+$/`. Today the client removes only one.
- Nothing else changes: the same headers (`API-Key`, `Key-ID`), 15-second timeout, status checks and parsing.

**Parsing facts this design relies on** (checked on 2026-10-15 over real HTTP with axios 1.19.0 and lossless-json 4.3.1)

- Every client request passes `transformResponse: [(data) => data]`, so axios hands over the raw response text and never runs its own `JSON.parse`. That parse would already lose precision: in the same check, plain axios turned `12345678901234567890` into `12345678901234567000` and `1e400` into `Infinity`.
- `lossless-json` returns `LosslessNumber` objects, not strings. The client's `materializeResponse` turns each one into its exact source text (for example `"3.000"`, `"-2.50"`, `"1e400"`, `"12345678901234567890"`). The exception is any `totalCount` key, which becomes a JS number. Strings, booleans and `null` pass through unchanged.

An acceptance test pins both facts (see Testing).

### 3. Checked read for Sales (`lib/autocount/invoice-reader.js`)

New export `readInvoicesChecked({ listPage, accountBookId, startDate, endDate, maxPages = 100 })`. It moves Sales' current read here with the same acceptance rules, and reports exactly which check it passed.

1. **Tolerant pass, page by page from page 1.**
   - A page must be an object whose `data` is an array, or the read throws.
   - Rows are appended. A numeric `totalCount` is remembered, and the latest one wins, so an invoice saved during the read does not fail it.
   - Reading stops on an empty page, or when the rows reach a finite `totalCount`. With no `totalCount`, it also stops on a page shorter than the page size. The page size comes from `firstPositiveInteger(pageSize, page_size, limit)` (section 4).
   - Going past `maxPages` throws.
2. **Check level.** The result records which check the rows passed:
   - **`count`:** AutoCount reported a safe-integer total. The rows equal the latest reported total, and no readable `docKey` appears twice. Rows without a readable `docKey` are skipped in the duplicate check, as today.
   - **`slices`:** AutoCount reported a total, but the rows failed the count check. The range was then re-read with the existing strict `windowed` mode, which passed: every date slice fit on one page, the slice totals add up to the overall total, and no document appears twice.
   - **`none`:** AutoCount reported no total. Reading stopped at an empty or short page, and nothing was checked. Sales accepts this, as it does today, but now logs it as unchecked. Live AutoCount always sends a total today; Price Check depends on it.
3. **Result.** It returns `{ rows, pageCount, check: 'count' | 'slices' | 'none', problem }`, where `problem` is `null`, `'row count does not match totalCount'` or `'an invoice is listed twice'`. A failed windowed re-read, a malformed page or the page ceiling throws.

**What the checks guarantee.** They catch the repeated and missing rows that AutoCount's paging produced on long ranges. They do not prove a consistent snapshot. If invoices are added or deleted while the pages are being read, a list can still pass the count check and miss or repeat a row. For example, one invoice deleted from an early page and another added at the end leaves the total unchanged while shifting the rows across a page boundary. Code comments, logs and docs say "checked", with the condition, and do not claim the list is proven complete.

`readInvoiceRange` (`paged` and `windowed`), `readDocKey` and `sourceError` are unchanged. Price Check keeps its own stricter flow (paged, then windowed on a retryable error). `addDays` and `diffDays` move to `lib/dates.js` (section 5).

### 4. Sales (`api/sales.js`) and AutoCount values (`lib/autocount/numbers.js`)

**Removed from `api/sales.js`:** its `COMPANY_DEFINITIONS`, `DEFAULT_API_URL`, `getHeaders`, `DATE_RE` / `isValidDate`, `listingProblem`, `readInvoicesInDateSlices`, and the direct `axios` import.

**Kept, with new insides**

- **`getCompanyConfigs(env)`** maps `readCompanySettings` to the existing shape (section 1).
- **`fetchAllInvoices(startDate, endDate, company, client = new AutoCountClient())`.** The 4th argument is now an AutoCount client, not an axios-like object. It calls `readInvoicesChecked` with `listPage = (params) => client.listInvoicePage(company, params)`. It still returns `null` on any failure and keeps the "Missing AutoCount credentials" guard. Log lines by check level:
  - `count`: "Fetched N invoices for A to B" (today's line).
  - `slices`: today's two lines ("cannot be trusted (…); re-reading in date slices", then "Fetched N invoices … (verified in date slices)").
  - `none`: "Fetched N invoices for A to B (no total count from AutoCount, so the list was not checked)".
- **`loadCompanyInvoices(startDate, endDate, company, useMock, { client, getProduct })`.** `client` replaces `httpClient`. The default product lookup is `client.getProduct(company, itemCode)` on the same client. Mock mode is unchanged: credentials are not checked, and `mock-sales.json` (read with `JSON.parse`) is used for Enterprise only.
- **Request dates.** The handler checks `startDate` / `endDate` with `isIsoDate`.
- **`getLocalToday`** keeps its export and behaviour (`REPORT_TIMEZONE`, a warning and the UTC date on a bad zone), built on `todayIn`.

**Field conversions.** These are all the AutoCount fields Sales reads. "Today" means the value after axios `JSON.parse`; "new" means after the client (section 2).

| Field(s) | Today | New input | Rule from now on |
| --- | --- | --- | --- |
| `totalCount` | number | number (the client converts it) | Unchanged code. The latest numeric value is remembered; the count check needs a safe integer. |
| `pageSize`, `page_size`, `limit` | number, via `Number(a \|\| b \|\| c)` | text | `firstPositiveInteger`. If none qualifies, there is no short-page stop. |
| `docKey` | number or text, then `String()` | exact text | Kept as exact text and compared as text. Never turned into a number. |
| `docNo`, `docDate`, `debtorName` / `customerName`, `productCode` / `sku`, `description`, `unit` | text (a number only if AutoCount sent one) | text (exact digits if AutoCount sent a number) | Kept as text. Only `unit` is trimmed, as today. The type probe (Testing, step 0) confirms AutoCount sends these as JSON strings; if any arrives as a JSON number, stop and decide before implementing. |
| `cancelled ?? isCancelled` | cancelled if `true`, `1` or `'1'` | boolean or text | Cancelled if `true`, or if its numeric value is exactly 1 (number `1`, text `"1"` or `"1.0"`). Anything else is not cancelled. |
| `finalTotal` / `total` / `grandTotal`; `qty` / `quantity`; `unitPrice`; `subTotal` / `total` | `parseFloat(a \|\| b \|\| 0)` | text | `firstNonZero`, in the same candidate order as today. |
| `outstandingAmount` | `parseFloat`; missing or `null` gives `null` | text or `null` | Unchanged `parseOutstandingAmount`: missing or `null` gives `null`, otherwise `parseFloat`, `NaN` gives `null`, rounded to 2 decimals. |
| Product lookup: `product.unit`, `productMultiPacks[].multiPack`, `.multiPackRate` | already read through the client | unchanged | Unchanged. |

**`lib/autocount/numbers.js`**

- **`decimalValue(value)`** gives the number for:
  - a finite JS number
  - text that matches `^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$`, with no surrounding spaces, and whose `Number()` is finite

  It gives `null` for everything else: `null`, `undefined`, booleans, objects, empty text, other text, `NaN` and ±`Infinity`.
- **`firstNonZero(...candidates)`** returns the first candidate whose `decimalValue` is a non-zero number. Negative values count, and are returned as they are. Zero (`0`, `-0`, `"0"`, `"0.00"`, `"-0"`) does not count, so it falls through to the next candidate. If no candidate counts, it returns `0`.
- **`firstPositiveInteger(...candidates)`** returns the first candidate whose `decimalValue` is a safe integer greater than 0 (so `"100"` and `"100.0"` give 100). If none qualifies, it returns `null`.

**How close this is to today.** For finite JSON numbers, missing values and `null`, which is what AutoCount sends for these fields, `firstNonZero` gives exactly today's `parseFloat(a || b || 0)`. The results differ only in these cases:

- A value AutoCount sent as a JSON string: zero text now falls through to the next field, and malformed text is skipped instead of giving `NaN`.
- A number beyond double range: it is skipped instead of becoming `Infinity`.
- A `docKey` beyond 2^53: it is now compared exactly. Today plain `JSON.parse` rounds it, so two different keys could look the same and force a needless slice re-read.

The type probe (Testing, step 0) confirms which token types AutoCount sends.

### 5. Dates (`lib/dates.js`)

No date component goes through a JavaScript `Date` constructor or `Date.UTC`. Those normalise overflowing dates (31 February becomes 3 March) and map years 0–99 to 1900–1999.

- **`isIsoDate(value)`** is true only for a string matching `^\d{4}-\d{2}-\d{2}$` whose month is 1–12 and whose day fits that month. Leap years follow the Gregorian rule: divisible by 4, except centuries not divisible by 400. This is checked with arithmetic, not with `Date`.
- **`todayIn(timeZone, now = new Date())`** gives the `YYYY-MM-DD` date in that time zone, using `Intl.DateTimeFormat('en-CA', …).formatToParts`. It throws on an invalid zone.
- **`addDays(isoDate, delta)`** and **`diffDays(fromIso, toIso)`**:
  - They throw if an input fails `isIsoDate`.
  - They calculate in UTC milliseconds from a `Date` whose fields are set with `setUTCFullYear(year, month - 1, day)`, which keeps years 0–99 as written.
  - `addDays` returns a zero-padded `YYYY-MM-DD`.

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
- Dispatch: only the date checks and the settings rules change. The paging loop, row quarantine, duplicate handling, cancelled-flag rule and error codes stay as they are.

### 7. Docs

- **`.env.example`:**
  - It describes the one rule set: own names first, aliases next, the shared pair for Enterprise only, and book-number settings optional and double-checked.
  - It adds the per-company `*_API_URL` lines as optional.
  - It drops `AUTOCOUNT_ACCOUNT_BOOK_ID`, which no code reads.
- **README:**
  - The settings table and a short "Company settings" note give the same rules.
  - "Verified invoice reads" states the guarantee from section 3 (checked against the count, or in date slices; not a consistent snapshot) and drops "proven".
- **`agents.md`:**
  - The AutoCount access line now covers Sales too.
  - A rule says company books, key names and the address come only from `lib/autocount/company-config.js`, and AutoCount numbers are read only through `lib/autocount/numbers.js`.
  - The invoice-reads rule uses the section 3 wording.

## Behaviour changes (complete list)

1. Dispatch and Price Check no longer need `AUTOCOUNT_ACCOUNT_BOOK_WANSON_*`. A value that differs from 63750 / 63688 now marks that book misconfigured; today Dispatch would read that other book. Sales now applies the same check.
2. Sdn Bhd never uses the shared `AUTOCOUNT_API_KEY` pair. Today Dispatch and Price Check allow it.
3. When both own-name styles are set, Dispatch and Price Check now prefer `AUTOCOUNT_ENTERPRISE_*` / `AUTOCOUNT_SDN_BHD_*` (Sales' order). Today they prefer `*_WANSON_*`. For the shared key ID, `AUTOCOUNT_KEY_ID` now comes before `AUTOCOUNT_API_KEY_ID`.
4. Sales no longer combines a book's own key with the shared ID (or the reverse), now trims spaces, and accepts `AUTOCOUNT_API_KEY_ID` as the Enterprise shared key ID.
5. Dispatch and Price Check now honour `AUTOCOUNT_ENTERPRISE_API_URL` / `AUTOCOUNT_SDN_BHD_API_URL`. Today only Sales does.
6. `/api/sales` answers 400 to an impossible date such as `2026-02-31`, as Dispatch already does. Today it passes it on to AutoCount.
7. Sales' AutoCount requests no longer send `Content-Type: application/json` (a GET has no body; Dispatch and Price Check already omit it).
8. Sales reads AutoCount values by the section 4 table. The results equal today's for the values AutoCount sends, except for the edge cases listed there (JSON-string values, numbers beyond double range, `docKey` beyond 2^53).
9. A list without a total count is still accepted by Sales, but is now logged as unchecked.

Items 1 to 5 depend on the Vercel settings, which this branch cannot see. Both books loading today does not prove the aliases or addresses agree. The release gate in Shipping checks them by name before merging.

## Unchanged

- Every API response shape and value for valid requests, given the values AutoCount sends:
  - `/api/sales`, including company IDs `enterprise` / `sdnBhd`, names, warnings and `complete`
  - `/api/price-check`
  - `/api/dispatch/*`
- Dispatch's paging loop and Price Check's read flow and error codes.
- Mock mode.
- All pages, `public/sw.js` (no static file changes, so no `CACHE_NAME` bump) and `vercel.json` regions.

## Testing

Tests are written before the code, in this worktree. Baseline on `04af0d1`: `npm test` gives 408 tests, 407 pass, 1 skipped (it needs `TEST_DATABASE_URL`). The Playwright baseline is recorded before the first change.

**Step 0: type probe (before writing fixtures)**

- A throwaway script in this session's scratch folder makes read-only calls through the current client: one listing page for today and one product lookup per book.
- It prints each field's JSON token type (number, string, boolean, null, object or array) and nothing else. No values reach the chat or any file.
- It confirms the section 4 assumptions and shapes the raw fixtures below.

**New tests**

- **Settings**, one test per rule in section 1:
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
- **Client parsing acceptance test.** Real axios and the real `AutoCountClient` against a local `node:http` server on `127.0.0.1` that returns raw JSON text. It asserts:
  - axios hands over the raw text
  - `12345678901234567890`, `3.000`, `-2.50` and `1e400` arrive as that exact text
  - `totalCount` arrives as a number
  - strings, booleans and `null` pass through unchanged
- **The client's** per-company address and trailing slashes.
- **`readInvoicesChecked`.** The Sales reader tests move here and drive it through a fake `listPage`. Each case asserts the `check` level:
  - missing `totalCount` gives `none`
  - a growing total gives `count`
  - repeated invoices give `slices`
  - a list short of its total throws
  - slices that do not add up throw
  - the page ceiling throws
  - a page size given as text
- **`numbers.js`:**
  - numbers, numeric text and negative amounts
  - numeric and text zero falling through (`0`, `-0`, `"0"`, `"0.00"`, `"-0"`)
  - empty text and malformed text (`"12abc"`, `" 12"`, `"1,000.00"`)
  - non-finite values (`"1e400"`, `Infinity`, `NaN`)
  - `null`, `undefined` and booleans, and all candidates zero
  - `firstPositiveInteger` with `"100"`, `"100.0"`, `0`, `-5`, `"12.5"` and missing values
- **Raw-JSON fixtures** (new, invented data, read as text and shaped by the step 0 probe): `test/fixtures/autocount-sales-raw-listing.json` and `test/fixtures/autocount-sales-raw-product.json`. They run through the real client parser into `fetchAllInvoices`, `loadCompanyInvoices` and `combineCompanyResults`, against hand-computed totals. They cover:
  - a zero `finalTotal` with a non-zero `total`
  - a negative line
  - numeric and boolean cancelled flags
  - `qty` such as `3.000`
  - `outstandingAmount` both `null` and set
  - a `docKey` beyond 2^53
  - a mixed-unit SKU resolved through the product fixture
- **`lib/dates.js`:**
  - leap days: `2024-02-29` and `2000-02-29` are valid; `2026-02-29` and `2100-02-29` are not
  - impossible days and months: `2026-04-31`, `2026-13-01`, `2026-00-10`, `2026-1-01`, a space before the date, non-strings
  - month and year rollover in `addDays`: `2026-12-31` +1 and `2028-03-01` −1
  - a 90-day step back across a year end
  - `diffDays` across a leap day
  - years 0–99 (`0050-01-01` +1 gives `0050-01-02`)
  - `todayIn('Asia/Kuala_Lumpur')` at `15:59:59.999Z` and `16:00:00.000Z`, including the 31 December and 28 February boundaries
  - an invalid zone throws

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

**Old-versus-new replay check (before the PR, nothing committed)**

- **Pinned commits.**
  - Old is the branch's base commit (`git merge-base HEAD origin/main`; today `04af0d1`).
  - New is the branch's HEAD commit, with a clean working tree.
  - Both are exported with `git archive <sha>` into this session's scratch folder, each with a `node_modules` junction to the main checkout, so no uncommitted edit can leak in.
  - Both SHAs go into the PR description. If `main` moves first, rebase and pin the new base.
- **Identical inputs.**
  - One Node process loads both copies. A recording adapter is installed as `defaults.adapter` on every axios module the copies load (with both junctions pointing at one `node_modules`, that is a single module), so it sees every AutoCount request from both.
  - Keys come from `.env.local` and are never printed. `USE_MOCK_DATA` is forced to `false`.
  - The old side runs first, against live AutoCount, and its raw responses are recorded in memory, keyed by URL and query.
  - The new side then runs only from that recording. Any request the new side makes that is not recorded counts as a difference (reported by count and request kind, never by value). There is no live fallback.
  - Each version parses the same bytes its own way: the old Sales through axios `JSON.parse`, the client through lossless JSON.
- **Environment per side.** The cases run one after another:
  - Before each old case, `AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE=63750` and `AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD=63688` are set, because the old side needs them and `.env.local` does not set them.
  - Before each new case they are removed, which proves they are now optional.
- **Cases:**
  - the Sales handler for today, the last 30 days and the last 91 days, ignoring `timestamp`
  - the Price Check handler for `today` and `seven_days`, with `auth` stubbed and `now` fixed
  - the Dispatch invoices handler for today, with `getSession` stubbed
- **Output.** "Identical", or the JSON paths that differ, never their values. Nothing is written to files. Any difference blocks the PR until it is explained.
- **Live integration run.** Separately, the new side runs the same cases against live AutoCount with no recording. This checks that real requests work without `Content-Type` and with the new address rules. It reports only that each case succeeded and which `check` level each Sales book got. Its output is not compared, because live data can change between runs.
- **PR description.** The summary goes into the PR description.

## Shipping

- Small commits in plan order: dates, numbers, settings, client, reader, Sales, Price Check and Dispatch, docs.
- **Release gate, before merging.** List the AutoCount setting names set in Vercel Production and Preview: names only, never values. The owner can do this in the Vercel dashboard or with `npx vercel env ls`. Claude can do it once the Vercel connector is signed in to the wanson team. Stop and resolve before merging if any of these is true:
  - Both own-name styles are set for the same field of a book, for example `AUTOCOUNT_ENTERPRISE_API_KEY` and `AUTOCOUNT_API_KEY_WANSON_ENTERPRISE`. Dispatch and Price Check would switch to the first style. The owner compares the two values in the Vercel dashboard, or removes one.
  - `AUTOCOUNT_ENTERPRISE_API_URL` or `AUTOCOUNT_SDN_BHD_API_URL` is set. Dispatch and Price Check would start using it.
  - A book's own key or ID is missing while the shared `AUTOCOUNT_API_KEY` pair is set.
  - `AUTOCOUNT_ACCOUNT_BOOK_WANSON_*` is set to anything other than 63750 / 63688. The owner checks the value; book numbers are not secret.
- Push this branch with an explicit refspec and open a draft PR into `main`. The owner merges.
- After the merge, check that `/version.json` shows the merge commit with `"target":"production"`. Then the owner opens the dashboard, Price Check and Dispatch once, to confirm both books still load.

## Out of scope (possible follow-ups)

- Moving Dispatch's invoice paging onto the shared checked reader (approach C). It changes how Dispatch reacts to a bad AutoCount list, so it needs its own decision.
- Moving the sales maths into `lib/sales/` (approach B).
- Giving the two Sdn Bhd display names a single name.
- The other refactor sub-projects listed at the top.
