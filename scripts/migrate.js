const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const MIGRATION_LOCK_KEY = 88174231;

async function migrate({ pool, migrationsDir = DEFAULT_MIGRATIONS_DIR, skipAdvisoryLock = false } = {}) {
  if (!pool) throw new Error('DATABASE_URL is required to run migrations');

  const filenames = (await fs.readdir(migrationsDir))
    .filter((filename) => filename.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!skipAdvisoryLock) {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);

    const applied = await client.query('SELECT filename FROM schema_migrations');
    const appliedNames = new Set(applied.rows.map((row) => row.filename));
    for (const filename of filenames) {
      if (appliedNames.has(filename)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, CURRENT_TIMESTAMP)',
        [filename],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original migration error.
    }
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const { pool } = require('../lib/db/pool');
  migrate({ pool })
    .then(() => {
      process.stdout.write('Migrations applied\n');
      return pool.end();
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { DEFAULT_MIGRATIONS_DIR, MIGRATION_LOCK_KEY, migrate };
