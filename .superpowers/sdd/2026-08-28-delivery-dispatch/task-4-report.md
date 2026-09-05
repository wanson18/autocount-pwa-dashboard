# Task 4 delivery-dispatch implementation report

Date: 2026-08-28
Status: GREEN; ready for the focused Task 4 commit

## RED evidence

- Initial auth/resources/UI focused run: 30 tests total, 14 passed, 16 failed. The expected failures covered missing auth modules, missing session/resource endpoints, unprotected invoice reads, and the absent authenticated UI.
- After adding the client transport tests: 17 tests total, 14 passed, 3 failed. The expected failures were the missing login shell and missing session/resource transport exports.
- Deployment configuration test before configuration edits: 10 tests total, 9 passed, 1 failed because the dispatch session secret configuration was absent.
- Service-worker cache-boundary regression before the bypass: 11 tests total, 10 passed, 1 failed because protected dispatch API requests were still handled by the generic API cache path.
- Resource audit regression before repository event writes: 5 tests total, 3 passed, 2 failed because resource create/deactivate audit events were not persisted with the session actor.

## GREEN evidence

- Focused final run:
  `node --test api/dispatch-auth.test.js api/dispatch-resources.test.js api/dispatch-invoices.test.js test/dispatch-state.test.mjs`
  — 51 tests, 51 passed, 0 failed, 0 skipped.
- Full final run: `npm test` — 102 tests, 101 passed, 0 failed, 1 skipped. The skipped test is the existing hosted-provider `TEST_DATABASE_URL` gate; the PGlite-compatible integration tests passed.
- `npm run build` passed; this repository intentionally has a static no-op build step.
- Syntax checks passed for the auth, HTTP, session, resources, invoice, dispatch client, service-worker, and dispatch state files.
- `git diff --check` passed. Git emitted only existing line-ending/config warnings.

## Files

Created:

- `api/dispatch-auth.test.js`
- `api/dispatch-resources.js`
- `api/dispatch-resources.test.js`
- `api/dispatch-session.js`
- `lib/dispatch/auth.js`
- `lib/dispatch/http.js`

Modified:

- `.env.example`
- `api/dispatch-invoices.js`
- `api/dispatch-invoices.test.js`
- `lib/dispatch/repository.js`
- `public/dispatch.css`
- `public/dispatch.html`
- `public/dispatch.js`
- `public/sw.js`
- `test/dispatch-state.test.mjs`
- `vercel.json`

The implementation uses scrypt PIN hashes, timing-safe comparison, strict server-side user parsing, signed eight-hour cookies, session GET/POST/DELETE, generic safe errors, shared request/session guards, protected invoice/resource routes, transactional driver/lorry persistence, reversible active state, append-only resource audit events, and server-derived actors. The Board remains Task 3's fixture-only preview while the Resources tab uses the protected API.

## Leakage and preservation checks

- No dispatch secret, user JSON, scrypt hash, account-book ID, or AutoCount credential reference occurs in `public/dispatch.html`, `public/dispatch.js`, `public/dispatch.css`, `public/sw.js`, or committed test fixtures. Synthetic test-only credentials remain confined to `api/dispatch-auth.test.js`.
- The service worker now sends dispatch API reads directly to the network and never caches or replays them; existing public Sales API caching remains unchanged.
- Before staging, the index was empty for this work. The unrelated untracked `output/playwright/dispatch-1440.png`, `dispatch-390.png`, and `dispatch-768.png` files were preserved and excluded.
- No deployment, hosted provider access, Docker, or external messages were used.

## Focused artifact hash

SHA-256 of the sorted `path=file-hash` manifest for the 16 intended Task 4 source, test, UI, and configuration files (excluding this report and `output/`):

`23b832a9e844f815f28bb79169eac015c859a031cd30e9129eafe382924369ae`

## Concerns and follow-up

- The hosted-provider database test remains gated by `TEST_DATABASE_URL`; no provider connection was attempted. PGlite covered the resource and migration integration paths.
- The authenticated Board intentionally remains fixture-only until the later API-wiring task. The invoice endpoint is nevertheless protected server-side, and dispatch API responses are uncached.
- Resource actors are persisted through the existing append-only `delivery_events` table. Later trip/assignment work still needs its own idempotency and revision checks from the approved plan.
