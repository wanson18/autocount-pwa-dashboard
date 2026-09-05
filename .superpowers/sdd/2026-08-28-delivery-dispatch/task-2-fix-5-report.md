# Task 2 fix round 5 report

Date: 2026-08-28
Branch: `codex/delivery-dispatch`
Base: `e43bb83`
Implementation commit: `5fe53fc8956b2770e1dc44f37731894d328bf315`

## Status

Local verification is PASS against the independent in-memory PGlite path. The
real-Postgres provider gate remains PARTIAL because `TEST_DATABASE_URL` was not
configured. No production or preview database was connected, migrated, or
modified. Docker and deployment were not attempted.

## TDD evidence

The new regressions were run before the implementation change. The RED focused
run reported:

```text
npm run test:repository
tests 30
pass 27
fail 2
skipped 1
```

The no-op regression observed an empty request ledger after a successful
zero-row remediation. The provider cleanup regression failed because the
paired-fixture cleanup helper did not yet exist. The signed `BIGINT` boundary
test passed before the code change because the existing keyset query already
accepted string cursors without number coercion.

The minimal GREEN changes are:

- Insert the parameterized request ledger row inside the existing transaction
  before the zero-row return. A successful no-op now consumes its request ID,
  while the quantity audit table remains empty.
- Wrap paired provider test-fixture creation so a failure creating the second
  fixture closes the first fixture. The fixture's existing close path ends the
  pooled connection before dropping its temporary schema, restoring its
  connection/search-path state.
- Add lower-level min/max signed `BIGINT` cursor coverage using string
  parameters. The test exercises `-9223372036854775808`,
  `9223372036854775807`, and the post-maximum boundary without converting to a
  JavaScript `Number`.

## Request-ledger and transaction recheck

The request ID lookup and insert both remain parameterized (`$1`/`$2`); the
regression also uses a single quote in the request ID. The request table keeps
`request_id TEXT PRIMARY KEY`, and duplicate insertion is mapped to
`REQUEST_ID_ALREADY_USED`. The insert occurs after `BEGIN`, the advisory/table
locks, and remediation-table setup, so mismatch, invalid replacement, and
rescan-growth failures roll it back with the rest of the attempt. Existing
retry coverage plus the new no-op-then-contamination retry prove that a
committed request cannot be reused and that no false quantity-audit rows are
created for a no-op.

## BIGINT provider limitation

PGlite permits the signed boundary rows and accepts string cursor parameters,
but returns an extreme `BIGINT` column as JavaScript `bigint`. Consequently,
`JSON.stringify` raises `TypeError: Do not know how to serialize a BigInt` for
that result. The regression therefore tests the lower-level parameterized
cursor/query boundary and compares IDs via `String(...)`; it does not weaken
the production code with a lossy number conversion. The real `pg` provider
branch asserts its normal string `int8` representation when that gate is run.

## Fresh GREEN verification

```text
node --check scripts/migrate.js
node --check scripts/migrate-preflight.js
node --check scripts/remediate-legacy-quantities.js
node --check test/helpers/postgres.js
node --check api/dispatch-repository.test.js
all five commands exit 0

npm run test:repository
tests 30
pass 29
fail 0
skipped 1

npm test
tests 69
pass 68
fail 0
skipped 1

git diff --check
exit 0
```

The one skipped test is the conditional
`TEST_DATABASE_URL fixtures use unique temporary schemas and clean them up`
provider test. The existing invalid-timezone test emits its intentional
fallback diagnostic while passing.

## Remaining hosted-provider gate

Run the repository and full suites again with a disposable real PostgreSQL
`TEST_DATABASE_URL` before preview acceptance. That run is still required to
prove provider-specific DDL/catalog behavior, advisory/table-lock contention,
pooled `search_path` handling, paired-schema cleanup, and real `int8` cursor
serialization. The local PGlite verification does not substitute for that
provider gate.

## Hashes

Implementation commit:

```text
5fe53fc8956b2770e1dc44f37731894d328bf315
```

Report commit is the subsequent commit containing this file.
