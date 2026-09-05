const { Pool } = require('pg');
const { PGlite } = require('@electric-sql/pglite');

let providerSchemaSequence = 0;

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function nextProviderSchema() {
  providerSchemaSequence += 1;
  return `dispatch_test_${process.pid}_${Date.now().toString(36)}_${providerSchemaSequence}`;
}

async function dropProviderSchema(connectionString, schema) {
  const cleanupPool = new Pool({ connectionString, max: 1 });
  try {
    await cleanupPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  } finally {
    await cleanupPool.end();
  }
}

async function createProviderTestDatabases(databaseFactory = createTestDatabase) {
  let first;
  try {
    first = await databaseFactory();
    const second = await databaseFactory();
    return { first, second };
  } catch (error) {
    if (first) {
      try {
        await first.close();
      } catch {
        // Preserve the original provider setup error.
      }
    }
    throw error;
  }
}

async function createTestDatabase() {
  if (process.env.TEST_DATABASE_URL) {
    const connectionString = process.env.TEST_DATABASE_URL;
    const schema = nextProviderSchema();
    const adminPool = new Pool({ connectionString, max: 1 });
    try {
      await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    } finally {
      await adminPool.end();
    }

    let pool;
    try {
      pool = new Pool({
        connectionString,
        options: `-c search_path=${quoteIdentifier(schema)}`,
      });
      await pool.query('SELECT current_schema()');
    } catch (error) {
      if (pool) await pool.end();
      await dropProviderSchema(connectionString, schema);
      throw error;
    }

    let closed = false;
    return {
      pool,
      embedded: false,
      schema,
      async close() {
        if (closed) return;
        closed = true;
        let poolError;
        try {
          await pool.end();
        } catch (error) {
          poolError = error;
        }
        try {
          await dropProviderSchema(connectionString, schema);
        } catch (error) {
          if (!poolError) poolError = error;
        }
        if (poolError) throw poolError;
      },
    };
  }

  const database = new PGlite('memory://');
  await database.waitReady;
  const query = (text, values) => {
    if (values === undefined && text.includes(';')) {
      return database.exec(text).then(() => ({ rows: [] }));
    }
    return database.query(text, values);
  };
  const client = {
    query,
    release() {},
  };
  const pool = {
    connect: async () => client,
    query,
    async end() {
      await database.close();
    },
  };
  return {
    pool,
    embedded: true,
    schema: null,
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createProviderTestDatabases, createTestDatabase };
