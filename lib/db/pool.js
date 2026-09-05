const { Pool } = require('pg');
const { attachDatabasePool } = require('@vercel/functions');

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) return null;
  const pool = new Pool({ connectionString });
  attachDatabasePool(pool);
  return pool;
}

const pool = createPool();

module.exports = { createPool, pool };
