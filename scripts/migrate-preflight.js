const { pool } = require('../lib/db/pool');

const LEGACY_QUANTITY_QUERY = `
  SELECT
    id AS "itemId",
    assignment_id AS "assignmentId",
    line_no AS "lineNo",
    CASE
      WHEN quantity = 'NaN'::numeric THEN 'NaN'
      WHEN quantity = 'Infinity'::numeric THEN 'Infinity'
      WHEN quantity = '-Infinity'::numeric THEN '-Infinity'
    END AS "quantityClass"
  FROM delivery_assignment_items
  WHERE quantity IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
  ORDER BY id
`;

async function findLegacyQuantityContamination({ pool: databasePool } = {}) {
  if (!databasePool) throw new Error('DATABASE_URL is required to run migration preflight');
  const result = await databasePool.query(LEGACY_QUANTITY_QUERY);
  return {
    condition: 'non_finite_delivery_assignment_item_quantities',
    count: result.rows.length,
    records: result.rows,
  };
}

if (require.main === module) {
  findLegacyQuantityContamination({ pool })
    .then((findings) => {
      process.stdout.write(`${JSON.stringify(findings)}\n`);
      return pool.end();
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { LEGACY_QUANTITY_QUERY, findLegacyQuantityContamination };
