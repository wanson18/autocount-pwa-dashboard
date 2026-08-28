const { Pool } = require('pg');
const { PGlite } = require('@electric-sql/pglite');

async function createTestDatabase() {
  if (process.env.TEST_DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    return {
      pool,
      embedded: false,
      async close() {
        await pool.end();
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
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createTestDatabase };
