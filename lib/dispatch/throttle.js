const crypto = require('node:crypto');
const net = require('node:net');

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_BASE_BLOCK_SECONDS = 30;
const DEFAULT_MAX_BLOCK_SECONDS = 15 * 60;
const DEFAULT_MAX_ROWS = 4096;
const DEFAULT_CLEANUP_BATCH_SIZE = 100;
const THROTTLE_META_ID = 1;
const BUCKET_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

class DispatchThrottleStoreError extends Error {
  constructor() {
    super('dispatch authentication is temporarily unavailable');
    this.name = 'DispatchThrottleStoreError';
    this.code = 'dispatch_auth_store_unavailable';
  }
}

class DispatchLoginThrottledError extends Error {
  constructor(retryAfterSeconds) {
    super('too many sign-in attempts');
    this.name = 'DispatchLoginThrottledError';
    this.code = 'too_many_requests';
    this.retryAfterSeconds = Math.max(1, Math.min(24 * 60 * 60, Math.ceil(retryAfterSeconds || 1)));
  }
}

function normalizePositiveInteger(value, fallback, maximum) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new TypeError('invalid throttle option');
  }
  return normalized;
}

function canonicalSecretBytes(secret) {
  if (Buffer.isBuffer(secret)) {
    if (secret.length !== 32) throw new TypeError('invalid session secret');
    return secret;
  }
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new TypeError('invalid session secret');
  }
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== secret) {
    throw new TypeError('invalid session secret');
  }
  return decoded;
}

function deriveThrottleBucketKey(secret, bucketType, value) {
  if (bucketType !== 'account' && bucketType !== 'ip') throw new TypeError('invalid throttle bucket type');
  if (typeof value !== 'string' || !value) throw new TypeError('invalid throttle bucket value');
  return crypto.createHmac('sha256', canonicalSecretBytes(secret))
    .update(`dispatch-login-throttle-v1\0${bucketType}\0${value}`, 'utf8')
    .digest('base64url');
}

function normalizeAddress(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  if (net.isIP(trimmed) === 4 || net.isIP(trimmed) === 6) {
    if (trimmed.startsWith('::ffff:') && net.isIP(trimmed.slice(7)) === 4) return trimmed.slice(7);
    return trimmed;
  }
  return null;
}

function extractTrustedRequestAddress(req, { trustedProxy = undefined } = {}) {
  const direct = normalizeAddress(req?.ip);
  if (direct) return direct;
  const socketAddress = normalizeAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress);
  if (socketAddress) return socketAddress;
  if (trustedProxy === 'vercel' || trustedProxy === true) {
    const forwarded = Object.entries(req?.headers || {})
      .find(([name]) => name.toLowerCase() === 'x-forwarded-for')?.[1];
    if (typeof forwarded === 'string') {
      const first = forwarded.split(',').map((part) => normalizeAddress(part)).find(Boolean);
      if (first) return first;
    }
  }
  return 'unknown';
}

function assertBucketKey(key) {
  if (typeof key !== 'string' || !BUCKET_KEY_RE.test(key)) throw new TypeError('invalid throttle bucket key');
}

function normalizeNow(now) {
  const value = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (Number.isNaN(value.getTime())) throw new TypeError('invalid throttle time');
  return value;
}

function secondsUntil(value, now) {
  if (!value) return 0;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - now.getTime()) / 1000));
}

function createLoginThrottleStore(pool, options = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    return {
      async check() { throw new DispatchThrottleStoreError(); },
      async recordFailure() { throw new DispatchThrottleStoreError(); },
      async recordSuccess() { throw new DispatchThrottleStoreError(); },
    };
  }

  const failureThreshold = normalizePositiveInteger(options.failureThreshold, DEFAULT_FAILURE_THRESHOLD, 1000);
  const windowSeconds = normalizePositiveInteger(options.windowSeconds, DEFAULT_WINDOW_SECONDS, 7 * 24 * 60 * 60);
  const baseBlockSeconds = normalizePositiveInteger(options.baseBlockSeconds, DEFAULT_BASE_BLOCK_SECONDS, 24 * 60 * 60);
  const maxBlockSeconds = normalizePositiveInteger(options.maxBlockSeconds, DEFAULT_MAX_BLOCK_SECONDS, 7 * 24 * 60 * 60);
  const maxRows = normalizePositiveInteger(options.maxRows, DEFAULT_MAX_ROWS, 1_000_000);
  const cleanupBatchSize = normalizePositiveInteger(options.cleanupBatchSize, DEFAULT_CLEANUP_BATCH_SIZE, 10_000);
  if (baseBlockSeconds > maxBlockSeconds) throw new TypeError('invalid throttle option');

  async function withTransaction(callback) {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const meta = await client.query(
        'SELECT id FROM dispatch_login_throttle_meta WHERE id = $1 FOR UPDATE',
        [THROTTLE_META_ID],
      );
      if (!meta.rows[0]) throw new DispatchThrottleStoreError();
      const result = await callback(client);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the generic store failure.
        }
      }
      if (error instanceof DispatchThrottleStoreError) throw error;
      throw new DispatchThrottleStoreError();
    } finally {
      client.release();
    }
  }

  async function enforceBound(client) {
    const countResult = await client.query(
      'SELECT count(*)::int AS count FROM dispatch_login_throttle_buckets',
    );
    const count = Number(countResult.rows[0]?.count || 0);
    const excess = count - maxRows;
    if (excess <= 0) return;
    const oldRows = await client.query(`
      SELECT bucket_type, bucket_key
      FROM dispatch_login_throttle_buckets
      ORDER BY updated_at, bucket_type, bucket_key
      LIMIT $1
    `, [excess]);
    for (const row of oldRows.rows) {
      await client.query(
        'DELETE FROM dispatch_login_throttle_buckets WHERE bucket_type = $1 AND bucket_key = $2',
        [row.bucket_type, row.bucket_key],
      );
    }
  }

  async function cleanup(client, now) {
    const cutoff = new Date(now.getTime() - windowSeconds * 1000).toISOString();
    const expired = await client.query(`
      WITH expired AS (
        SELECT bucket_type, bucket_key
        FROM dispatch_login_throttle_buckets
        WHERE (last_failure_at IS NULL OR last_failure_at <= $1::timestamptz)
          AND (blocked_until IS NULL OR blocked_until <= $2::timestamptz)
        ORDER BY updated_at, bucket_type, bucket_key
        LIMIT $3
      )
      DELETE FROM dispatch_login_throttle_buckets buckets
      USING expired
      WHERE buckets.bucket_type = expired.bucket_type
        AND buckets.bucket_key = expired.bucket_key
    `, [cutoff, now.toISOString(), cleanupBatchSize]);
    void expired;
    await enforceBound(client);
  }

  function validateKeys({ accountKey, ipKey }) {
    assertBucketKey(accountKey);
    assertBucketKey(ipKey);
  }

  async function check({ accountKey, ipKey, now } = {}) {
    validateKeys({ accountKey, ipKey });
    const current = normalizeNow(now);
    return withTransaction(async (client) => {
      await cleanup(client, current);
      const result = await client.query(`
        SELECT blocked_until
        FROM dispatch_login_throttle_buckets
        WHERE (bucket_type = 'account' AND bucket_key = $1)
           OR (bucket_type = 'ip' AND bucket_key = $2)
      `, [accountKey, ipKey]);
      const retryAfterSeconds = result.rows.reduce((longest, row) => Math.max(
        longest,
        secondsUntil(row.blocked_until, current),
      ), 0);
      return { allowed: retryAfterSeconds === 0, retryAfterSeconds };
    });
  }

  async function recordFailure({ accountKey, ipKey, now } = {}) {
    validateKeys({ accountKey, ipKey });
    const current = normalizeNow(now);
    const nowIso = current.toISOString();
    const cutoffIso = new Date(current.getTime() - windowSeconds * 1000).toISOString();
    return withTransaction(async (client) => {
      await cleanup(client, current);
      let failureCount = 0;
      for (const [bucketType, bucketKey] of [['account', accountKey], ['ip', ipKey]]) {
        await client.query(`
          INSERT INTO dispatch_login_throttle_buckets
            (bucket_type, bucket_key, failure_count, last_failure_at, blocked_until, updated_at)
          VALUES ($1, $2, 1, $3::timestamptz, NULL, $3::timestamptz)
          ON CONFLICT (bucket_type, bucket_key) DO UPDATE
          SET failure_count = CASE
                WHEN dispatch_login_throttle_buckets.last_failure_at IS NULL
                  OR dispatch_login_throttle_buckets.last_failure_at <= $4::timestamptz
                THEN 1
                ELSE dispatch_login_throttle_buckets.failure_count + 1
              END,
              last_failure_at = $3::timestamptz,
              updated_at = $3::timestamptz
        `, [bucketType, bucketKey, nowIso, cutoffIso]);
        const row = await client.query(`
          SELECT failure_count
          FROM dispatch_login_throttle_buckets
          WHERE bucket_type = $1 AND bucket_key = $2
        `, [bucketType, bucketKey]);
        const count = Number(row.rows[0]?.failure_count || 0);
        failureCount = Math.max(failureCount, count);
        const blockSeconds = count >= failureThreshold
          ? Math.min(maxBlockSeconds, baseBlockSeconds * (2 ** Math.min(31, count - failureThreshold)))
          : 0;
        await client.query(`
          UPDATE dispatch_login_throttle_buckets
          SET blocked_until = $3::timestamptz,
              updated_at = $4::timestamptz
          WHERE bucket_type = $1 AND bucket_key = $2
        `, [
          bucketType,
          bucketKey,
          blockSeconds ? new Date(current.getTime() + blockSeconds * 1000).toISOString() : null,
          nowIso,
        ]);
      }
      await enforceBound(client);
      return { failureCount };
    });
  }

  async function recordSuccess({ accountKey, ipKey, now } = {}) {
    validateKeys({ accountKey, ipKey });
    const current = normalizeNow(now);
    return withTransaction(async (client) => {
      await cleanup(client, current);
      await client.query(
        'DELETE FROM dispatch_login_throttle_buckets WHERE bucket_type = $1 AND bucket_key = $2',
        ['account', accountKey],
      );
      await client.query(`
        UPDATE dispatch_login_throttle_buckets
        SET failure_count = GREATEST(failure_count - 1, 0),
            blocked_until = NULL,
            updated_at = $3::timestamptz
        WHERE bucket_type = $1 AND bucket_key = $2
      `, ['ip', ipKey, current.toISOString()]);
      await client.query(
        'DELETE FROM dispatch_login_throttle_buckets WHERE bucket_type = $1 AND bucket_key = $2 AND failure_count <= 0',
        ['ip', ipKey],
      );
      await enforceBound(client);
      return { cleared: true };
    });
  }

  return Object.freeze({ check, recordFailure, recordSuccess });
}

module.exports = {
  BUCKET_KEY_RE,
  DEFAULT_BASE_BLOCK_SECONDS,
  DEFAULT_CLEANUP_BATCH_SIZE,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MAX_BLOCK_SECONDS,
  DEFAULT_MAX_ROWS,
  DEFAULT_WINDOW_SECONDS,
  DispatchLoginThrottledError,
  DispatchThrottleStoreError,
  deriveThrottleBucketKey,
  extractTrustedRequestAddress,
  createLoginThrottleStore,
};
