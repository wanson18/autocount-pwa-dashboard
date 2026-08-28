const fs = require('node:fs/promises');

const { pool } = require('../lib/db/pool');
const { MIGRATION_LOCK_KEY } = require('./migrate');
const {
  DEFAULT_BATCH_SIZE,
  getLegacyQuantitySummary,
  iterateLegacyQuantityContamination,
} = require('./migrate-preflight');

const REMEDIATION_TABLE = 'delivery_assignment_item_quantity_remediations';
const REMEDIATION_REQUEST_TABLE = 'delivery_quantity_remediation_requests';

const CREATE_REMEDIATION_REQUEST_TABLE = `
  CREATE TABLE IF NOT EXISTS ${REMEDIATION_REQUEST_TABLE} (
    request_id TEXT PRIMARY KEY CHECK (request_id <> ''),
    approved_by TEXT NOT NULL CHECK (approved_by <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_REMEDIATION_TABLE = `
  CREATE TABLE IF NOT EXISTS ${REMEDIATION_TABLE} (
    original_item_id BIGINT PRIMARY KEY,
    assignment_id BIGINT NOT NULL,
    line_no INTEGER NOT NULL,
    item_code TEXT NOT NULL,
    description TEXT NOT NULL,
    uom TEXT NOT NULL,
    original_quantity TEXT NOT NULL,
    replacement_quantity NUMERIC NOT NULL,
    approved_by TEXT NOT NULL CHECK (approved_by <> ''),
    request_id TEXT NOT NULL CHECK (request_id <> ''),
    remediated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const CREATE_REMEDIATION_TRIGGER = `
  CREATE OR REPLACE FUNCTION prevent_delivery_quantity_remediation_mutation()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'delivery quantity remediation audit is append-only';
  END;
  $$;

  DROP TRIGGER IF EXISTS delivery_quantity_remediation_append_only
    ON ${REMEDIATION_TABLE};
  CREATE TRIGGER delivery_quantity_remediation_append_only
    BEFORE UPDATE OR DELETE ON ${REMEDIATION_TABLE}
    FOR EACH ROW EXECUTE FUNCTION prevent_delivery_quantity_remediation_mutation();

  DROP TRIGGER IF EXISTS delivery_quantity_remediation_truncate
    ON ${REMEDIATION_TABLE};
  CREATE TRIGGER delivery_quantity_remediation_truncate
    BEFORE TRUNCATE ON ${REMEDIATION_TABLE}
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_delivery_quantity_remediation_mutation();

  DROP TRIGGER IF EXISTS delivery_quantity_remediation_request_append_only
    ON ${REMEDIATION_REQUEST_TABLE};
  CREATE TRIGGER delivery_quantity_remediation_request_append_only
    BEFORE UPDATE OR DELETE ON ${REMEDIATION_REQUEST_TABLE}
    FOR EACH ROW EXECUTE FUNCTION prevent_delivery_quantity_remediation_mutation();

  DROP TRIGGER IF EXISTS delivery_quantity_remediation_request_truncate
    ON ${REMEDIATION_REQUEST_TABLE};
  CREATE TRIGGER delivery_quantity_remediation_request_truncate
    BEFORE TRUNCATE ON ${REMEDIATION_REQUEST_TABLE}
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_delivery_quantity_remediation_mutation();
`;

function remediationError(message) {
  return new Error(`LEGACY_QUANTITY_REMEDIATION_${message}`);
}

async function assertFinitePositive(client, replacement) {
  const result = await client.query(`
    SELECT $1::numeric AS replacement
    WHERE $1::numeric > 0
      AND ($1::numeric)::text NOT IN ('NaN', 'Infinity', '-Infinity')
  `, [replacement]);
  if (result.rows.length !== 1) {
    throw remediationError('INVALID_REPLACEMENT');
  }
  return result.rows[0].replacement;
}

async function remediateLegacyQuantities({
  pool: databasePool,
  replacements,
  approvedBy,
  requestId,
  confirm = false,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  if (confirm !== true) throw remediationError('CONFIRMATION_REQUIRED');
  if (!databasePool) throw new Error('DATABASE_URL is required for legacy quantity remediation');
  if (!approvedBy || !requestId) throw remediationError('OPERATOR_METADATA_REQUIRED');
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
    throw remediationError('REPLACEMENTS_REQUIRED');
  }

  const providedIds = new Set(Object.keys(replacements));
  const client = await databasePool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      'LOCK TABLE delivery_assignments, delivery_assignment_items IN SHARE ROW EXCLUSIVE MODE',
    );

    const summary = await getLegacyQuantitySummary({ pool: databasePool, queryable: client });
    await client.query(CREATE_REMEDIATION_TABLE);
    await client.query(CREATE_REMEDIATION_REQUEST_TABLE);
    await client.query(CREATE_REMEDIATION_TRIGGER);
    await client.query(`
      INSERT INTO ${REMEDIATION_REQUEST_TABLE} (request_id, approved_by)
      SELECT request_id, min(approved_by)
      FROM ${REMEDIATION_TABLE}
      GROUP BY request_id
      ON CONFLICT (request_id) DO NOTHING
    `);
    const existingRequest = await client.query(
      `SELECT 1 FROM ${REMEDIATION_REQUEST_TABLE} WHERE request_id = $1`,
      [requestId],
    );
    if (existingRequest.rows.length !== 0) throw remediationError('REQUEST_ID_ALREADY_USED');

    try {
      await client.query(
        `INSERT INTO ${REMEDIATION_REQUEST_TABLE} (request_id, approved_by) VALUES ($1, $2)`,
        [requestId, approvedBy],
      );
    } catch (error) {
      if (error.code === '23505') throw remediationError('REQUEST_ID_ALREADY_USED');
      throw error;
    }

    if (summary.count === 0) {
      if (providedIds.size !== 0) throw remediationError('REPLACEMENT_SET_MISMATCH');
      await client.query('COMMIT');
      transactionStarted = false;
      return { remediatedCount: 0, itemIds: [] };
    }

    const remainingIds = new Set(providedIds);
    const itemIds = [];
    let snapshotTriggerDropped = false;
    for await (const batch of iterateLegacyQuantityContamination({
      pool: databasePool,
      queryable: client,
      batchSize,
    })) {
      for (const finding of batch) {
        const itemId = String(finding.itemId);
        if (!providedIds.has(itemId)) throw remediationError('REPLACEMENT_SET_MISMATCH');
        remainingIds.delete(itemId);

        const item = await client.query(`
          SELECT id, assignment_id, line_no, item_code, description, uom, quantity::text AS original_quantity
          FROM delivery_assignment_items
          WHERE id = $1
            AND quantity::text IN ('NaN', 'Infinity', '-Infinity')
          FOR UPDATE
        `, [finding.itemId]);
        if (item.rows.length !== 1) throw remediationError('LEGACY_ROW_CHANGED');
        const original = item.rows[0];
        const replacement = await assertFinitePositive(client, replacements[itemId]);

        try {
          await client.query(`
            INSERT INTO ${REMEDIATION_TABLE}
              (original_item_id, assignment_id, line_no, item_code, description, uom,
               original_quantity, replacement_quantity, approved_by, request_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            original.id,
            original.assignment_id,
            original.line_no,
            original.item_code,
            original.description,
            original.uom,
            original.original_quantity,
            replacement,
            approvedBy,
            requestId,
          ]);
        } catch (error) {
          if (error.code === '23505') throw remediationError('AUDIT_ROW_ALREADY_EXISTS');
          throw error;
        }

        if (!snapshotTriggerDropped) {
          await client.query(
            'DROP TRIGGER IF EXISTS delivery_assignment_item_snapshot_immutable ON delivery_assignment_items',
          );
          snapshotTriggerDropped = true;
        }
        await client.query('DELETE FROM delivery_assignment_items WHERE id = $1', [original.id]);
        await client.query(`
          INSERT INTO delivery_assignment_items
            (id, assignment_id, line_no, item_code, description, uom, quantity)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          original.id,
          original.assignment_id,
          original.line_no,
          original.item_code,
          original.description,
          original.uom,
          replacement,
        ]);
        itemIds.push(original.id);
      }
    }

    if (remainingIds.size !== 0 || itemIds.length !== summary.count) {
      throw remediationError('REPLACEMENT_SET_MISMATCH');
    }

    const remainingContamination = await getLegacyQuantitySummary({
      pool: databasePool,
      queryable: client,
    });
    if (remainingContamination.count !== 0) throw remediationError('LEGACY_ROW_CHANGED');

    if (snapshotTriggerDropped) {
      await client.query(`
        CREATE TRIGGER delivery_assignment_item_snapshot_immutable
          BEFORE UPDATE OR DELETE ON delivery_assignment_items
          FOR EACH ROW EXECUTE FUNCTION prevent_delivery_assignment_item_snapshot_mutation()
      `);
    }

    await client.query('COMMIT');
    transactionStarted = false;
    return { remediatedCount: itemIds.length, itemIds };
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original remediation error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function parseArguments(argumentsList) {
  const options = {};
  for (const argument of argumentsList) {
    if (argument === '--confirm') options.confirm = true;
    else if (argument.startsWith('--approved-by=')) options.approvedBy = argument.slice('--approved-by='.length);
    else if (argument.startsWith('--request-id=')) options.requestId = argument.slice('--request-id='.length);
    else if (argument.startsWith('--replacements-file=')) options.replacementsFile = argument.slice('--replacements-file='.length);
    else if (argument.startsWith('--batch-size=')) options.batchSize = argument.slice('--batch-size='.length);
  }
  return options;
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2));
  options.replacementsFile
    ? fs.readFile(options.replacementsFile, 'utf8')
      .then((contents) => remediateLegacyQuantities({
        pool,
        ...options,
        replacements: JSON.parse(contents),
      }))
      .then((result) => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return pool.end();
      })
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      })
    : Promise.reject(remediationError('REPLACEMENTS_FILE_REQUIRED'))
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
}

module.exports = {
  CREATE_REMEDIATION_TABLE,
  CREATE_REMEDIATION_REQUEST_TABLE,
  CREATE_REMEDIATION_TRIGGER,
  REMEDIATION_TABLE,
  REMEDIATION_REQUEST_TABLE,
  remediateLegacyQuantities,
};
