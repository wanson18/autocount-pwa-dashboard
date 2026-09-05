const { pool } = require('../lib/db/pool');

const LEGACY_QUANTITY_CONDITION = 'non_finite_delivery_assignment_item_quantities';
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 1000;

const LEGACY_QUANTITY_SUMMARY_QUERY = `
  SELECT count(*)::text AS count
  FROM delivery_assignment_items
  WHERE quantity::text IN ('NaN', 'Infinity', '-Infinity')
`;

const LEGACY_QUANTITY_BATCH_QUERY = `
  SELECT
    id AS "itemId",
    assignment_id AS "assignmentId",
    line_no AS "lineNo",
    CASE quantity::text
      WHEN 'NaN' THEN 'NaN'
      WHEN 'Infinity' THEN 'Infinity'
      WHEN '-Infinity' THEN '-Infinity'
    END AS "quantityClass"
  FROM delivery_assignment_items
  WHERE ($1::bigint IS NULL OR id > $1::bigint)
    AND quantity::text IN ('NaN', 'Infinity', '-Infinity')
  ORDER BY id
  LIMIT $2
`;

function requireQueryable(databasePool, queryable) {
  const database = queryable || databasePool;
  if (!database) throw new Error('DATABASE_URL is required to run migration preflight');
  return database;
}

function normalizeBatchSize(value) {
  const batchSize = value === undefined ? DEFAULT_BATCH_SIZE : Number(value);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`MIGRATION_PREFLIGHT_INVALID_BATCH_SIZE: use an integer from 1 to ${MAX_BATCH_SIZE}`);
  }
  return batchSize;
}

function normalizeCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('MIGRATION_PREFLIGHT_COUNT_UNSAFE');
  }
  return count;
}

async function getLegacyQuantitySummary({ pool: databasePool, queryable } = {}) {
  const database = requireQueryable(databasePool, queryable);
  const result = await database.query(LEGACY_QUANTITY_SUMMARY_QUERY);
  return {
    condition: LEGACY_QUANTITY_CONDITION,
    count: normalizeCount(result.rows[0]?.count),
  };
}

async function* iterateLegacyQuantityContamination({
  pool: databasePool,
  queryable,
  batchSize,
  afterId = null,
} = {}) {
  const database = requireQueryable(databasePool, queryable);
  const limit = normalizeBatchSize(batchSize);
  let cursor = afterId;

  while (true) {
    const result = await database.query(LEGACY_QUANTITY_BATCH_QUERY, [cursor, limit]);
    if (!result.rows.length) return;
    yield result.rows;
    cursor = result.rows[result.rows.length - 1].itemId;
    if (result.rows.length < limit) return;
  }
}

async function writeLegacyQuantityPreflight({
  pool: databasePool,
  batchSize,
  write = (line) => process.stdout.write(line),
} = {}) {
  if (!databasePool) throw new Error('DATABASE_URL is required to run migration preflight');
  const client = await databasePool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transactionStarted = true;
    const summary = await getLegacyQuantitySummary({ pool: databasePool, queryable: client });
    await write(`${JSON.stringify({ type: 'summary', ...summary })}\n`);

    let emittedCount = 0;
    for await (const batch of iterateLegacyQuantityContamination({
      pool: databasePool,
      queryable: client,
      batchSize,
    })) {
      for (const record of batch) {
        await write(`${JSON.stringify({ type: 'record', ...record })}\n`);
        emittedCount += 1;
      }
    }
    if (emittedCount !== summary.count) {
      throw new Error('MIGRATION_PREFLIGHT_RESULT_CHANGED');
    }
    await write(`${JSON.stringify({ type: 'complete', count: emittedCount })}\n`);
    await client.query('COMMIT');
    transactionStarted = false;
    return summary;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original preflight error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  writeLegacyQuantityPreflight({ pool })
    .then(() => pool.end())
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  LEGACY_QUANTITY_BATCH_QUERY,
  LEGACY_QUANTITY_CONDITION,
  LEGACY_QUANTITY_SUMMARY_QUERY,
  getLegacyQuantitySummary,
  iterateLegacyQuantityContamination,
  writeLegacyQuantityPreflight,
};
