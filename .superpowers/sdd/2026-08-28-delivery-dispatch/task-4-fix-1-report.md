# Task 4 security fix round 1 report

Date: 2026-08-28
Status: GREEN locally; real-provider gate remains before any preview

## RED evidence

The regression suites were run against `b588c74` after adding the required
regression tests and before the production fixes:

```text
node --test api/dispatch-auth.test.js api/dispatch-throttle.test.js \
  api/dispatch-routing.test.js api/dispatch-resources.test.js \
  api/dispatch-invoices.test.js api/dispatch-repository.test.js \
  test/dispatch-state.test.mjs test/service-worker.test.mjs
```

Result: 108 tests, 75 passed, 32 failed, 1 existing provider-gated skip. The
failures were the intended RED cases for the absent durable throttle, strict
secret/hash parsing, namespace fallback, cache migration, client session-loss
handling, request IDs, idempotent resource persistence, state-aware events, and
rollback behavior.

## Fixes

### Durable login throttling

- Added ordered migration `003_dispatch_login_throttling.sql` with separate
  account/IP bucket rows and a singleton metadata row.
- Account and address values are never persisted. Bucket keys are HMAC-SHA-256
  digests encoded as 43-character base64url strings.
- All throttle reads, atomic failure increments, success relaxation, expiry
  cleanup, and bounded-row enforcement run inside a PostgreSQL transaction
  holding `dispatch_login_throttle_meta FOR UPDATE`. The transaction boundary
  releases the lock on commit, rollback, or process failure; there is no lease
  that can remain indefinitely after a crashed worker.
- Default policy is a 5-failure/15-minute window with 30-second bounded
  exponential blocks. Cleanup is batched and the table has a configurable row
  bound. The request address uses trusted runtime metadata, or forwarded data
  only when `DISPATCH_TRUSTED_PROXY=vercel` is explicitly configured.
- Scrypt verification is limited to four concurrent operations per process and
  rejects excess work with a generic `429` and `Retry-After`. A missing or
  failing throttle database fails closed with a generic `503` before PIN
  verification. Unknown clerks still execute the same dummy scrypt shape as a
  known wrong PIN.

The singleton lock is intentionally conservative: it makes cleanup and the
two-bucket update easy to reason about on both PGlite and PostgreSQL. It can
reduce login throughput under a very high concurrent-login load, so the real
provider rehearsal should measure it before changing the lock granularity.

### Session secret and authentication parsing

- `DISPATCH_SESSION_SECRET` is now required to be canonical base64url for
  exactly 32 bytes; padding, whitespace, arbitrary text, and noncanonical forms
  fail closed.
- Scrypt hashes accept only the canonical positional format with bounded N/r/p,
  salt, derived-key, and memory parameters. Unknown or duplicate parameter
  forms, leading-zero numeric encodings, malformed base64url, and out-of-range
  lengths are rejected.
- Duplicate session-cookie names and noncanonical token payload/signature
  encodings are rejected. Cookie flags remain `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, with the existing eight-hour expiry.

### Fail-closed routing and service-worker migration

- Added an exact `/api/dispatch` fallback and an ordered `/api/dispatch/(.*)`
  fallback before the generic sales rewrite. Unknown dispatch paths return only
  the safe JSON 404 envelope.
- Bumped the static cache namespace to `sales-dashboard-v5`. Activation removes
  older namespaces, and dispatch API paths remain network-only and are never
  written to the cache.

### Client session loss, logout, and accessibility

- Any protected-resource `401` clears the session actor, board state, resource
  lists, and protected form state before returning the UI to login.
- Logout clears local sensitive state only after a successful server DELETE and
  an explicit `authenticated: false` response. Network/server failure keeps the
  authenticated view and presents a generic retry message.
- Resource toggle buttons now expose labels such as `Deactivate driver Aiman
  Driver` and `Reactivate lorry WXY 1001`.

### Idempotent, state-aware resource mutations

- Added ordered migration `004_dispatch_resource_idempotency.sql` with a
  `(actor, request_id)` primary key, operation/resource-type constraints,
  SHA-256 request fingerprints, replay response, status, resource ID, and
  expiry.
- Resource POST/PATCH bodies require a validated `request_id`. The actor is
  derived from the authenticated session; client actor/audit overrides are
  rejected. The browser generates a request ID when one is not supplied.
- Resource mutation, audit event, and idempotency result are persisted in one
  transaction. PostgreSQL uniqueness/row locking handles cross-worker
  concurrency; a same-process keyed queue only supplements the embedded PGlite
  test harness and is not the correctness boundary.
- Updates lock and inspect the persisted row first. No-op updates replay a
  stable result without an event. Deactivate/reactivate event types are derived
  from persisted before/after state, and event payloads include both states.
  There is still no DELETE or hard-delete path.
- Same-actor retries replay the original successful resource and event exactly;
  conflicting request reuse returns a safe `409`. Failures roll back the
  resource row, event, and idempotency row together.

### JSON-only and CSRF assumption

The existing JSON-only mutation policy and `SameSite=Lax` cookie policy remain
in place. The README now documents the explicit assumption that dispatch is
served same-origin, permissive CORS is not configured, and cross-site forms
cannot submit the required `application/json` mutation body. If another origin
must call dispatch, an origin check or CSRF token must be added first.

## Verification

- Focused fix run: 108 tests, 107 passed, 0 failed, 1 existing
  `TEST_DATABASE_URL` provider-gate skip.
- Full `npm test`: 129 tests, 128 passed, 0 failed, 1 existing provider-gate
  skip.
- `npm run build`: passed; the project uses a static no-op build step.
- Node syntax checks: passed for changed server, client, service-worker, and
  test modules.
- `git diff --check`: passed; only existing Windows line-ending/config warnings
  were emitted.
- Public-asset leakage scan and synthetic-credential scan: passed. No secrets,
  PINs, hashes, account-book IDs, or provider credentials were added to browser
  assets or logs.
- Untracked `output/` screenshots were preserved and excluded from the commit.

## Remaining provider gate

`TEST_DATABASE_URL` was not configured in this run, so the real PostgreSQL
fixture was not contacted. Before preview, run the repository and throttle
suites with a temporary provider database and verify migration/advisory-lock
behavior, pooled `pg` concurrency, TLS/network settings, and Vercel pool
attachment. Preview remains intentionally blocked until that gate passes.
