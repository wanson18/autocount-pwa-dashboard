# Task 2 fix round 4 report

Date: 2026-08-28
Branch: `codex/delivery-dispatch`
Base: `49c1bae`
Implementation commit: `fd79ae6d6e14bf6ba0a667dd2f5b0c5285193b77`

## Status

Local verification is PASS against the independent in-memory PGlite path. The
real-Postgres provider gate is PARTIAL because `TEST_DATABASE_URL` was not
configured. No production or preview database was connected, migrated, or
modified. Docker and deployment were not attempted.

## TDD evidence

The preserved RED was the new negative-`BIGINT` keyset boundary test. Before
the fix, `iterateLegacyQuantityContamination` started at cursor `0`, so the
negative contaminated row was omitted:

```text
npm run test:repository
tests 27
pass 25
fail 1
skipped 1
actual [1, 2]
expected [-1, 1, 2]
```

The smallest fix uses a `NULL` initial cursor and a parameterized
`($1::bigint IS NULL OR id > $1::bigint)` predicate. Subsequent cursors are
copied directly from the database result; they are not converted through
JavaScript `Number`, so `BIGINT` precision is retained. `ORDER BY id` remains
deterministic because `id` is the primary key.

Fresh GREEN evidence:

```text
node --check scripts/migrate.js
node --check scripts/migrate-preflight.js
node --check scripts/remediate-legacy-quantities.js
node --check test/helpers/postgres.js
node --check api/dispatch-repository.test.js
all five commands exit 0

npm run test:repository
tests 27
pass 26
fail 0
skipped 1

npm test
tests 66
pass 65
fail 0
skipped 1

git diff --check
exit 0
```

The full suite's one skipped test is the conditional
`TEST_DATABASE_URL` provider-schema isolation test. The existing timezone
test emits its intentional invalid-timezone diagnostic while still passing.

## Review findings addressed

### Locking and migration race

`002_delivery_dispatch_hardening.sql` begins with:

```sql
LOCK TABLE delivery_assignments, delivery_assignment_items
  IN SHARE ROW EXCLUSIVE MODE;
```

This mode remains compatible with ordinary reads but conflicts with the
`ROW EXCLUSIVE` locks taken by inserts, updates, and deletes. It is acquired
before the contamination scan and remains held through the hardening DDL, so
legacy writes cannot slip between the scan and constraint/trigger creation.
The assignment-then-item order is explicit and matches the repository and
remediation write order. The migration runner takes the transaction advisory
lock before applying migrations; remediation takes that same advisory lock
before the same table locks. The shared ordering avoids introducing a cycle
between migration and remediation.

### Version-neutral finite classification

Migration, preflight, and remediation classify special numeric values through
`quantity::text` sentinels. They do not cast `NaN`, `Infinity`, or
`-Infinity` as numeric literals, so no undeclared PostgreSQL version floor is
required.

### Bounded preflight and pagination

The library boundary exposes a summary plus an async batch iterator. Batch
size is validated to the range 1..1000, defaults to 100, and the CLI streams
summary, record, and completion lines as NDJSON. Keyset pagination uses the
nullable raw `BIGINT` cursor described above, covers the complete signed ID
range, and does not retain the complete dataset in one result object. The
summary count is accepted only when it is a non-negative safe integer.

### Atomic remediation and audit safety

Remediation begins one transaction, takes the migration advisory lock and the
same assignment-then-item table locks, then performs the complete contaminated
rescan and exact replacement-set comparison inside that transaction. A row
present after outside preflight but before remediation obtains the locks is
therefore included and causes a mismatch/rollback when no replacement was
provided. Audit insertion and active-row replacement are in that same
transaction, so a failure leaves neither partial audit history nor partial
replacement.

The remediation and request audit tables have primary keys, request IDs are
single-use, duplicate audit inserts fail explicitly, and both tables have
row-level `UPDATE`/`DELETE` protection plus statement-level `BEFORE TRUNCATE`
triggers. Replacement values are checked as positive finite `numeric` values
and all data values use query parameters. The scripts emit only structured
findings/results and error messages; they do not log connection URLs,
customer data, or invoice headers. Migration itself never rewrites historical
quantities.

### Test isolation

When `TEST_DATABASE_URL` is set, each fixture creates a unique temporary
schema, opens its `pg` pool with that schema in `search_path`, and closes the
pool before dropping the schema with `CASCADE`. The provider-only test checks
distinct schemas, current-schema routing, migration isolation, and post-close
cleanup. The PGlite path remains a separate in-memory database with no
provider schema behavior. Because no provider URL was available in this run,
the schema-creation, pooled search-path, lock-contention, and cleanup behavior
remain unproven against real PostgreSQL.

## Hashes

Implementation commit:

```text
fd79ae6d6e14bf6ba0a667dd2f5b0c5285193b77
```

SHA-256:

```text
db/migrations/002_delivery_dispatch_hardening.sql  36A7441E27FF2EF159AA216628FFD97981D26533236781A9D611836C6AFF352D
scripts/migrate-preflight.js                       7CDAAFCFD451CA590274F0B25394EA4A5F2835680AC9069DBBBDF1C6BFE3049E
scripts/remediate-legacy-quantities.js             6181128A6A8F17A96AE8BEFCAE67483FC11E0FC8E312673E7B9504286AAECDE7
test/helpers/postgres.js                           5DE6EC353F4684ED9E2833EFB35B4C06FBB93CB04E93094206D3DC306ED6BF5B
api/dispatch-repository.test.js                    4626B391F674938DBF2E8EF1645C622F41E103A311EBCAD300F80D8B11E0139C
```

## Remaining provider limitation

Run the repository and full suites again with a disposable real PostgreSQL
`TEST_DATABASE_URL` before preview acceptance. That run is required to prove
provider-specific DDL/catalog behavior, advisory/table-lock contention,
`pg` startup `search_path` handling, and schema cleanup. The local PGlite
verification does not substitute for that provider gate.
