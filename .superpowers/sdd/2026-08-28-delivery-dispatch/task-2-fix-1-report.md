# Task 2 fix round 1 report

Date: 2026-08-28
Branch: `codex/delivery-dispatch`
Base: `5fe2aa9`
Fix commit: `f9a537e fix: harden delivery dispatch persistence invariants`

## Status

Complete. No production or preview database was connected, migrated, or
modified. Docker was not attempted.

## TDD evidence

Regression tests were added before the production changes. The RED run was:

```text
npm run test:repository
tests 14
pass 11
fail 3
```

The failures were the intended regressions: direct `company_key` mutation was
accepted, `NaN` quantity was accepted, and the package engine was still
`>=18.0.0` instead of `>=20.0.0`.

Focused GREEN:

```text
npm run test:repository
tests 14
pass 14
fail 0
```

Full suite GREEN:

```text
npm test
tests 53
pass 53
fail 0
```

`npm install --package-lock-only --ignore-scripts --offline` completed
successfully, and `git diff --check` passed.

## Fixes and files

The fix commit changes only:

- `db/migrations/001_delivery_dispatch.sql` — assignment identity/date/header
  immutability and explicit rejection of `NaN`, `Infinity`, and `-Infinity`.
- `lib/dispatch/repository.js` — removed unused `queryableRepository`.
- `api/dispatch-repository.test.js` — regression coverage for immutable fields,
  snapshot/event deletes, non-finite quantities, assignment rollback after a
  prior item insert, active `loaded`/`out_for_delivery` uniqueness, `returned`
  reuse, and Node 20 metadata.
- `package.json` and `package-lock.json` — project engine set to `>=20.0.0`.

## Remaining real-provider limitations

Tests used the in-memory PGlite PostgreSQL-compatible engine because
`TEST_DATABASE_URL` was not configured. This does not prove provider-specific
behavior for `pg_advisory_xact_lock`, pooled `pg` network/TLS behavior, or
`@vercel/functions` pool attachment. The real-Postgres migration rehearsal and
release gate remain required before preview acceptance.
