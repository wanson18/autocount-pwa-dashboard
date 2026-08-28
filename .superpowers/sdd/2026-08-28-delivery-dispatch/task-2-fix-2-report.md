# Task 2 fix round 2 report

Date: 2026-08-28
Branch: `codex/delivery-dispatch`
Base: `3be238b`
Code/test commit: `3918663 fix: add delivery dispatch hardening upgrade migration`

## Status

Complete. No production or preview database was connected, migrated, or
modified. Docker was not attempted.

## TDD evidence

The upgrade regression was added first and run against the exact
`5fe2aa9:db/migrations/001_delivery_dispatch.sql` content. The fixture hash
matched the historical Git blob. The RED run was:

```text
node --test --test-name-pattern="exact 5fe2aa9" api/dispatch-repository.test.js
tests 1
pass 0
fail 1

AssertionError: an existing 001 database must receive the additive hardening migration
actual:   ['001_delivery_dispatch.sql']
expected: ['001_delivery_dispatch.sql', '002_delivery_dispatch_hardening.sql']
```

The intended missing-upgrade defect was therefore reproduced: the runner
skipped the already-recorded `001` and had no additive migration to apply.

After implementation, the focused repository suite passed:

```text
npm run test:repository
tests 15
pass 15
fail 0
```

The full suite passed:

```text
npm test
tests 54
pass 54
fail 0
```

`git diff --check` passed.

## Migration decision and coverage

`001_delivery_dispatch.sql` is restored as the original baseline. All
hardening lives in ordered `002_delivery_dispatch_hardening.sql`, which:

- adds a named positive-finite quantity constraint through an idempotent
  catalog-guarded `DO` block;
- replaces the assignment snapshot trigger with identity, company, invoice,
  document date, assigned timestamp, and header immutability checks; and
- safely re-creates the trigger on both legacy and fresh schemas.

The regression applies the historical `001` through the migration runner,
records it exactly as the runner does, applies current migrations, runs the
runner again, and proves that `002` is recorded exactly once. It also verifies
all required immutable fields, `NaN`/`Infinity`/`-Infinity` rejection, and an
ordinary high-precision positive decimal.

## Changed files

- `api/dispatch-repository.test.js` — fresh-install and exact historical
  upgrade-path regression coverage.
- `db/migrations/001_delivery_dispatch.sql` — retained as the original
  baseline migration.
- `db/migrations/002_delivery_dispatch_hardening.sql` — additive, ordered,
  idempotent hardening migration.
- `test/fixtures/migration-upgrade-5fe2aa9/001_delivery_dispatch.sql` — exact
  historical migration fixture.

## Remaining real-provider limitation

Tests used the in-memory PGlite PostgreSQL-compatible engine because
`TEST_DATABASE_URL` was not configured. This does not prove provider-specific
behavior for real PostgreSQL DDL/catalog compatibility, advisory locking, or
pooled `pg` network/TLS behavior. A real-Postgres migration rehearsal remains
required before preview acceptance.
