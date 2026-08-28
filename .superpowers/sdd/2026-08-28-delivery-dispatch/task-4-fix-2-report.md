# Task 4 security fix round 2 report

Date: 2026-08-28
Base: `3cdcadc`
Status: GREEN locally; real-provider concurrency gate remains pending

## RED evidence

The new regression tests were run before the production changes:

```text
node --test --test-name-pattern='concurrent login requests|login reservation expiry|exact approved|login signs an eight-hour|invoice fetch transport' api/dispatch-auth.test.js api/dispatch-throttle.test.js test/dispatch-state.test.mjs
```

Result: 5 tests failed as intended. The old implementation admitted all 12
concurrent login verifications, accepted an alternate bounded scrypt profile,
accepted a bare duplicate session-cookie name, retained board state after the
real invoice transport returned `401`, and did not provide the new reservation
lifecycle behavior.

## GREEN changes

### Atomic throttle admission

- Replaced the split `check()` then `recordFailure()` path with
  `reserveAttempt()`.
- Admission now runs in one transaction after locking the singleton
  `dispatch_login_throttle_meta` row and selecting both matching bucket rows
  with `FOR UPDATE`.
- The transaction checks both account and client-address blocks before writing;
  an active block denies without changing either row. An admitted request
  increments/reserves both `failure_count` slots before PIN verification, and a
  transaction rollback prevents a partial two-bucket reservation.
- The threshold-th attempt is admitted and starts the block for later attempts;
  `Retry-After`, bounded exponential expiry, HMAC-only keys, cleanup, and row
  bounds remain intact.
- Failed or unexpected PIN verification does not increment again. A successful
  verification transactionally deletes the account bucket and relaxes the
  client-address bucket by one reserved slot. Missing or malformed throttle
  state still fails closed before verification.
- A per-pool in-process transaction queue keeps the embedded single-connection
  PGlite harness from interleaving transactions. PostgreSQL row locks remain
  the cross-worker correctness boundary.

### Canonical scrypt

All configured and dummy verification hashes now use exactly:

```text
N=16384, r=8, p=1, salt=16 bytes, derived key=64 bytes
```

The parser still applies the existing bounds and canonical base64url checks,
then rejects alternate bounded profiles, unknown/duplicate parameter forms,
noncanonical numeric encodings, and malformed lengths. There is no automatic
rehash path: an existing clerk hash using a formerly accepted alternate
profile must be regenerated with the approved profile because the PIN is not
available to the application.

### Invoice transport and cookie parsing

- `createFetchTransport.loadBoard()` now uses the shared API-response parser,
  preserving `error.code = unauthorized` and the safe HTTP status so the app
  invokes session-loss handling. Session loss clears the board, resource lists,
  form state, and actor before returning to login.
- The cookie parser treats a bare or malformed `dispatch_session` segment as a
  real occurrence. Any duplicate occurrence is rejected, and token/signature
  values must remain canonical.

## Verification

- Task 4 security-focused suites: **111 passed, 0 failed, 1 existing provider
  skip**.
- Full `npm test`: **132 passed, 0 failed, 1 existing provider skip**.
- `npm run build`: **PASS** (the repository uses a static no-op build step).
- Node syntax checks: **PASS** for changed auth, throttle, invoice client,
  session, test, HTTP, resource, and service-worker modules.
- `git diff --check`: **PASS**; Git emitted only existing Windows line-ending
  warnings.
- Leakage review: no dispatch secrets, clerk JSON, PINs, scrypt hashes, book
  IDs, or credential references were added to browser assets or logs. The
  existing untracked `output/` screenshots remain excluded.

## Provider limitation and release gate

No provider, deployment, Docker, or external service was used in this pass.
The real PostgreSQL gate is still required before preview: run the concurrent
login regression with independent pooled connections and separate worker or
pool instances, confirm exactly the configured number of admissions from 12
simultaneous same-account/same-address requests, confirm all denials happen
before PIN verification with `429` and `Retry-After`, and verify expiry,
success reset, migration, TLS, and Vercel pool attachment. The local PGlite
gate verifies behavior through the in-process queue; it cannot independently
prove cross-connection PostgreSQL locking.

## Files changed

- `.env.example`
- `README.md`
- `api/dispatch-auth.test.js`
- `api/dispatch-throttle.test.js`
- `lib/dispatch/auth.js`
- `lib/dispatch/throttle.js`
- `public/dispatch.js`
- `test/dispatch-state.test.mjs`
- `.superpowers/sdd/2026-08-28-delivery-dispatch/task-4-fix-2-report.md`
