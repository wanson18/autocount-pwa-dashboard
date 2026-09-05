# Task 2 fix round 3 report

Date: 2026-08-28
Branch: `codex/delivery-dispatch`
Base: `bbcb2b9`
Implementation commit: `0c7cbb9 fix: gate contaminated delivery dispatch upgrades`

## Status

Complete. No production or preview database was connected, migrated, or
modified. Docker was not attempted. The report commit follows this
implementation commit.

## TDD evidence

The RED regression first built the exact historical `001_delivery_dispatch.sql`
fixture, inserted `NaN` and `Infinity` into two items in a valid assignment,
and ran the current migration flow. Before the fix it failed with only the
generic provider error:

```text
error: check constraint "delivery_assignment_items_positive_finite_quantity_check" of relation "delivery_assignment_items" is violated by some row
```

The RED preflight/remediation tests also failed because the two standalone
operator interfaces did not exist:

```text
Error: Cannot find module '../scripts/migrate-preflight'
Error: Cannot find module '../scripts/remediate-legacy-quantities'
```

After implementation, the focused repository suite passed:

```text
npm run test:repository
tests 18
pass 18
fail 0
```

The full suite passed:

```text
npm test
tests 57
pass 57
fail 0
```

Additional syntax checks passed for both new scripts, and `git diff --check`
passed.

## Design and tradeoff

The first statement in `002_delivery_dispatch_hardening.sql` now performs a
read-only contamination check. If non-finite quantities exist, it raises the
stable `DELIVERY_DISPATCH_HARDENING_BLOCKED` error before any hardening DDL,
including the count and bounded item/assignment ID lists, plus the preflight
next step. The migration runner transaction rolls back, so `002` remains
unapplied and no constraint or trigger change is left behind.

The separate `npm run migrate:preflight` command returns structured JSON with
the condition, count, item ID, assignment ID, line number, and quantity class.
It intentionally excludes invoice headers and customer data. The separate
`remediate-legacy-quantities.js` path requires `--confirm`, operator identity,
request ID, and an exact replacement map. It archives each original quantity
verbatim with the original item fields and approval metadata in an append-only
audit table before replacing the active row with the operator-supplied finite
value. Migration never invokes it.

Keeping the gate in the migration protects both the normal runner and direct
SQL execution, while the bounded error avoids dumping business data; the
tradeoff is that only the first 20 IDs appear in the migration error, so the
full affected set comes from the read-only preflight. Keeping remediation
separate preserves the migration’s no-write safety and requires deliberate
operator values; the tradeoff is that an authorized correction must use the
controlled archive-and-replace workflow and cannot be inferred automatically.

The tests prove contaminated upgrade blocking and no partial hardening,
safe preflight findings, explicit confirmation, verbatim audit preservation,
successful post-remediation application of `002`, rejection of new non-finite
values, and clean fresh/idempotent convergence.

## Hashes

- Historical fixture `test/fixtures/migration-upgrade-5fe2aa9/001_delivery_dispatch.sql`
  - SHA-256: `310420201001dc5b118281b29a96deb57ff6c254c5a7e55d3d491a6ada225d40`
  - Git blob: `9df075eefabe7534abe1f252b1babfac78135f86`
- `db/migrations/002_delivery_dispatch_hardening.sql`
  - SHA-256: `f68223c96c2e1233513c610bb29203f7b2eef5e53e264ee095ecacc02fd7918e`
- Implementation commit: `0c7cbb9491fe2e6a1420c94eec3ec4fa6df29d88`

## Changed files

- `api/dispatch-repository.test.js`
- `db/migrations/002_delivery_dispatch_hardening.sql`
- `scripts/migrate-preflight.js`
- `scripts/remediate-legacy-quantities.js`
- `package.json`
- `README.md`

## Remaining provider limitation

The verification run used the in-memory PGlite PostgreSQL-compatible engine
because `TEST_DATABASE_URL` was not configured. This does not prove
provider-specific real-PostgreSQL behavior for DDL/catalog compatibility,
advisory locking, pooled `pg` network/TLS behavior, or the exact provider
error surface. A real-Postgres migration rehearsal remains required before
preview acceptance.
