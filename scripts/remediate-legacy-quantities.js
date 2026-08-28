const fs = require('node:fs/promises');

const { pool } = require('../lib/db/pool');
const { findLegacyQuantityContamination } = require('./migrate-preflight');

const REMEDIATION_TABLE = 'delivery_assignment_item_quantity_remediations';

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
    FOR EACH ROW EXECUTE FUNCTION prevent_delivery_quantity_remediation_mutation()
`;

function remediationError(message) {
  return new Error(`LEGACY_QUANTITY_REMEDIATION_${message}`);
}

async function assertFinitePositive(client, replacement) {
  const result = await client.query(`
    SELECT $1::numeric AS replacement
    WHERE $1::numeric > 0
      AND $1::numeric <> 'NaN'::numeric
      AND $1::numeric <> 'Infinity'::numeric
      AND $1::numeric <> '-Infinity'::numeric
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
} = {}) {
  if (confirm !== true) throw remediationError('CONFIRMATION_REQUIRED');
  if (!databasePool) throw new Error('DATABASE_URL is required for legacy quantity remediation');
  if (!approvedBy || !requestId) throw remediationError('OPERATOR_METADATA_REQUIRED');
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) {
    throw remediationError('REPLACEMENTS_REQUIRED');
  }

  const findings = await findLegacyQuantityContamination({ pool: databasePool });
  const expectedIds = new Set(findings.records.map((record) => String(record.itemId)));
  const providedIds = new Set(Object.keys(replacements));
  if (expectedIds.size !== providedIds.size || [...expectedIds].some((id) => !providedIds.has(id))) {
    throw remediationError('REPLACEMENT_SET_MISMATCH');
  }
  if (findings.count === 0) return { remediatedCount: 0, itemIds: [] };

  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    await client.query(CREATE_REMEDIATION_TABLE);
    await client.query(CREATE_REMEDIATION_TRIGGER);

    const itemIds = [];
    for (const finding of findings.records) {
      const item = await client.query(`
        SELECT id, assignment_id, line_no, item_code, description, uom, quantity::text AS original_quantity
        FROM delivery_assignment_items
        WHERE id = $1
          AND quantity IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        FOR UPDATE
      `, [finding.itemId]);
      if (item.rows.length !== 1) throw remediationError('LEGACY_ROW_CHANGED');
      const original = item.rows[0];
      const replacement = await assertFinitePositive(client, replacements[String(finding.itemId)]);

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

      await client.query('DROP TRIGGER IF EXISTS delivery_assignment_item_snapshot_immutable ON delivery_assignment_items');
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
      await client.query(`
        CREATE TRIGGER delivery_assignment_item_snapshot_immutable
          BEFORE UPDATE OR DELETE ON delivery_assignment_items
          FOR EACH ROW EXECUTE FUNCTION prevent_delivery_assignment_item_snapshot_mutation()
      `);
      itemIds.push(original.id);
    }

    await client.query('COMMIT');
    return { remediatedCount: itemIds.length, itemIds };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original remediation error.
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
  }
  return options;
}

if (require.main === module) {
  parseArguments(process.argv.slice(2)).replacementsFile
    ? fs.readFile(parseArguments(process.argv.slice(2)).replacementsFile, 'utf8')
      .then((contents) => remediateLegacyQuantities({
        pool,
        ...parseArguments(process.argv.slice(2)),
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
  REMEDIATION_TABLE,
  remediateLegacyQuantities,
};
