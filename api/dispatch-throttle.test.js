const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDatabase } = require('../test/helpers/postgres');
const { migrate } = require('../scripts/migrate');

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const throttle = optionalRequire('../lib/dispatch/throttle');
const auth = require('../lib/dispatch/auth');
const sessionApi = require('./dispatch-session');

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');
const NOW = new Date('2026-08-28T00:00:00.000Z');

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

function requireThrottle() {
  assert.ok(throttle, 'durable dispatch throttle module should exist');
  return throttle;
}

function bucketPair(label) {
  const implementation = requireThrottle();
  return {
    accountKey: implementation.deriveThrottleBucketKey(SECRET, 'account', `clerk-${label}`),
    ipKey: implementation.deriveThrottleBucketKey(SECRET, 'ip', `198.51.100.${label}`),
  };
}

async function makeEnv(clerkId = 'clerk-throttle') {
  const pinHash = await auth.hashDispatchPin('2468', { salt: Buffer.alloc(16, 11) });
  return {
    DISPATCH_SESSION_SECRET: SECRET,
    DISPATCH_USERS_JSON: JSON.stringify([{ clerkId, role: 'clerk', active: true, pinHash }]),
  };
}

let database;
let store;

test.before(async () => {
  database = await createTestDatabase();
  await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
  if (throttle) {
    store = throttle.createLoginThrottleStore(database.pool, {
      failureThreshold: 3,
      windowSeconds: 300,
      baseBlockSeconds: 60,
      maxBlockSeconds: 600,
      maxRows: 8,
      cleanupBatchSize: 4,
    });
  }
});

test.after(async () => {
  if (database) await database.close();
});

test('durable throttle stores only HMAC account and IP bucket keys', async () => {
  const keys = bucketPair('privacy');
  await store.reserveAttempt({ ...keys, now: NOW });

  const rows = await database.pool.query(
    'SELECT bucket_type, bucket_key, failure_count FROM dispatch_login_throttle_buckets ORDER BY bucket_type',
  );
  assert.deepEqual(rows.rows.map((row) => row.bucket_type), ['account', 'ip']);
  assert.ok(rows.rows.every((row) => /^[A-Za-z0-9_-]{43}$/.test(row.bucket_key)));
  assert.equal(JSON.stringify(rows.rows).includes('clerk-privacy'), false);
  assert.equal(JSON.stringify(rows.rows).includes('198.51.100.privacy'), false);
});

test('throttle blocks at the threshold with a bounded exponential retry window', async () => {
  const keys = bucketPair('threshold');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const decision = await store.reserveAttempt({ ...keys, now: new Date(NOW.getTime() + attempt * 1000) });
    assert.equal(decision.allowed, true);
  }

  const blocked = await store.reserveAttempt({ ...keys, now: new Date(NOW.getTime() + 2000) });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 60);

  const afterExpiry = await store.reserveAttempt({
    ...keys,
    now: new Date(NOW.getTime() + 64 * 1000),
  });
  assert.equal(afterExpiry.allowed, true);
});

test('expired throttle rows are removed and the failure window resets', async () => {
  const keys = bucketPair('expiry');
  await store.reserveAttempt({ ...keys, now: NOW });
  const before = await database.pool.query(
    'SELECT count(*)::int AS count FROM dispatch_login_throttle_buckets WHERE bucket_key IN ($1, $2)',
    [keys.accountKey, keys.ipKey],
  );
  assert.equal(before.rows[0].count, 2);

  const decision = await store.reserveAttempt({
    ...keys,
    now: new Date(NOW.getTime() + 301 * 1000),
  });
  assert.equal(decision.allowed, true);
  const after = await database.pool.query(
    'SELECT count(*)::int AS count FROM dispatch_login_throttle_buckets WHERE bucket_key IN ($1, $2)',
    [keys.accountKey, keys.ipKey],
  );
  assert.equal(after.rows[0].count, 2);
  const resetRows = await database.pool.query(
    'SELECT bucket_type, failure_count FROM dispatch_login_throttle_buckets WHERE bucket_key IN ($1, $2) ORDER BY bucket_type',
    [keys.accountKey, keys.ipKey],
  );
  assert.deepEqual(resetRows.rows, [
    { bucket_type: 'account', failure_count: 1 },
    { bucket_type: 'ip', failure_count: 1 },
  ]);
});

test('concurrent reservations admit only the configured number in each durable bucket', async () => {
  const keys = bucketPair('concurrent');
  const decisions = await Promise.all(Array.from({ length: 12 }, (_, attempt) => store.reserveAttempt({
    ...keys,
    now: new Date(NOW.getTime() + attempt * 10),
  })));
  assert.equal(decisions.filter((decision) => decision.allowed).length, 3);
  assert.equal(decisions.filter((decision) => !decision.allowed).length, 9);

  const rows = await database.pool.query(
    'SELECT bucket_type, failure_count FROM dispatch_login_throttle_buckets WHERE bucket_key IN ($1, $2) ORDER BY bucket_type',
    [keys.accountKey, keys.ipKey],
  );
  assert.deepEqual(rows.rows, [
    { bucket_type: 'account', failure_count: 3 },
    { bucket_type: 'ip', failure_count: 3 },
  ]);
});

test('successful login clears account failures and relaxes the IP bucket', async () => {
  const keys = bucketPair('success');
  await store.reserveAttempt({ ...keys, now: NOW });
  await store.reserveAttempt({ ...keys, now: new Date(NOW.getTime() + 1000) });
  await store.recordSuccess({ ...keys, now: new Date(NOW.getTime() + 2000) });

  const rows = await database.pool.query(
    'SELECT bucket_type, failure_count, blocked_until FROM dispatch_login_throttle_buckets WHERE bucket_key IN ($1, $2) ORDER BY bucket_type',
    [keys.accountKey, keys.ipKey],
  );
  assert.deepEqual(rows.rows, [{ bucket_type: 'ip', failure_count: 1, blocked_until: null }]);
});

test('throttle cleanup keeps bucket rows bounded', async () => {
  requireThrottle();
  for (let index = 0; index < 12; index += 1) {
    await store.reserveAttempt({
      ...bucketPair(`bound-${index}`),
      now: new Date(NOW.getTime() + index * 1000),
    });
  }
  const rows = await database.pool.query('SELECT count(*)::int AS count FROM dispatch_login_throttle_buckets');
  assert.ok(rows.rows[0].count <= 8);
});

test('trusted address extraction ignores spoofed forwarding headers without trusted metadata', () => {
  const implementation = requireThrottle();
  assert.equal(
    implementation.extractTrustedRequestAddress({ headers: { 'x-forwarded-for': '203.0.113.9' } }),
    'unknown',
  );
  assert.equal(
    implementation.extractTrustedRequestAddress({
      ip: '198.51.100.7',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    }),
    '198.51.100.7',
  );
  assert.equal(
    implementation.extractTrustedRequestAddress({
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.2' },
    }, { trustedProxy: 'vercel' }),
    '203.0.113.9',
  );
});

test('session endpoint returns generic 429 after durable threshold and does not verify again', async () => {
  const env = await makeEnv('clerk-throttle-endpoint');
  const endpointStore = throttle.createLoginThrottleStore(database.pool, {
    failureThreshold: 3,
    windowSeconds: 300,
    baseBlockSeconds: 60,
    maxBlockSeconds: 600,
    maxRows: 100,
  });
  const handler = sessionApi.createDispatchSessionHandler({
    env,
    throttleStore: endpointStore,
    now: NOW,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = responseRecorder();
    await handler({
      method: 'POST',
      ip: '203.0.113.20',
      headers: {
        'content-type': 'application/json',
        'content-length': '39',
      },
      body: JSON.stringify({ clerkId: 'clerk-throttle-endpoint', pin: '9999' }),
    }, response);
    assert.equal(response.statusCode, 401);
  }

  const blocked = responseRecorder();
  await handler({
    method: 'POST',
    ip: '203.0.113.20',
    headers: {
      'content-type': 'application/json',
      'content-length': '39',
    },
    body: JSON.stringify({ clerkId: 'clerk-throttle-endpoint', pin: '2468' }),
  }, blocked);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');
  assert.deepEqual(blocked.body.error, {
    code: 'too_many_requests',
    message: 'Too many sign-in attempts. Try again later.',
  });
});

test('unknown clerk attempts execute the same scrypt verification shape as known wrong PINs', async () => {
  const env = await makeEnv('clerk-known-shape');
  const seen = [];
  const verifyPin = async (pin, encodedHash) => {
    seen.push({ pin, parameters: encodedHash.split('$').slice(0, 4) });
    return auth.verifyScryptPin(pin, encodedHash);
  };
  const first = await auth.authenticateDispatchLogin(
    { clerkId: 'clerk-unknown-shape', pin: '9999' },
    {
      env,
      now: NOW,
      throttleStore: store,
      requestAddress: '198.51.100.41',
      verifyPin,
    },
  );
  const second = await auth.authenticateDispatchLogin(
    { clerkId: 'clerk-known-shape', pin: '9999' },
    {
      env,
      now: NOW,
      throttleStore: store,
      requestAddress: '198.51.100.42',
      verifyPin,
    },
  );
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((entry) => entry.parameters), [
    ['scrypt', '16384', '8', '1'],
    ['scrypt', '16384', '8', '1'],
  ]);
});

function loginRequest(clerkId, pin, ip) {
  const body = JSON.stringify({ clerkId, pin });
  return {
    method: 'POST',
    ip,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  };
}

function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error('timed out waiting for concurrent login responses'));
      } else {
        setImmediate(poll);
      }
    };
    poll();
  });
}

test('concurrent login requests reserve exactly the threshold before PIN verification', async () => {
  const env = await makeEnv('clerk-concurrent-admission');
  const endpointStore = throttle.createLoginThrottleStore(database.pool, {
    failureThreshold: 3,
    windowSeconds: 300,
    baseBlockSeconds: 60,
    maxBlockSeconds: 600,
    maxRows: 100,
  });
  let verifyCalls = 0;
  let releaseVerification;
  const verification = new Promise((resolve) => { releaseVerification = resolve; });
  const handler = sessionApi.createDispatchSessionHandler({
    env,
    throttleStore: endpointStore,
    now: NOW,
    scryptLimiter: auth.createScryptLimiter(20),
    verifyPin: async () => {
      verifyCalls += 1;
      return verification;
    },
  });

  const responses = Array.from({ length: 12 }, () => responseRecorder());
  const requests = Promise.all(responses.map((response) => (
    handler(loginRequest('clerk-concurrent-admission', '9999', '198.51.100.88'), response)
  )));

  let observationError;
  try {
    await waitFor(() => responses.filter((response) => response.statusCode === 429).length === 9);
    assert.equal(verifyCalls, 3, 'the fourth concurrent request must be denied before PIN verification');
  } catch (error) {
    observationError = error;
  }
  releaseVerification(false);
  await requests;
  if (observationError) throw observationError;

  assert.equal(responses.filter((response) => response.statusCode === 401).length, 3);
  assert.equal(responses.filter((response) => response.statusCode === 429).length, 9);
});

test('login reservation expiry admits again and successful verification resets the reserved state', async () => {
  const env = await makeEnv('clerk-reservation-lifecycle');
  const endpointStore = throttle.createLoginThrottleStore(database.pool, {
    failureThreshold: 3,
    windowSeconds: 300,
    baseBlockSeconds: 60,
    maxBlockSeconds: 600,
    maxRows: 100,
  });
  const baseOptions = {
    env,
    throttleStore: endpointStore,
    scryptLimiter: auth.createScryptLimiter(4),
  };
  const failedHandler = sessionApi.createDispatchSessionHandler({
    ...baseOptions,
    now: NOW,
    verifyPin: async () => false,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = responseRecorder();
    await failedHandler(loginRequest('clerk-reservation-lifecycle', '9999', '198.51.100.77'), response);
    assert.equal(response.statusCode, 401);
  }

  const blocked = responseRecorder();
  await failedHandler(loginRequest('clerk-reservation-lifecycle', '2468', '198.51.100.77'), blocked);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['Retry-After'], '60');

  const expiredHandler = sessionApi.createDispatchSessionHandler({
    ...baseOptions,
    now: new Date(NOW.getTime() + 301 * 1000),
    verifyPin: async () => false,
  });
  const afterExpiry = responseRecorder();
  await expiredHandler(loginRequest('clerk-reservation-lifecycle', '9999', '198.51.100.77'), afterExpiry);
  assert.equal(afterExpiry.statusCode, 401, 'expired blocks must not deny before verification');

  const successHandler = sessionApi.createDispatchSessionHandler({
    ...baseOptions,
    now: new Date(NOW.getTime() + 302 * 1000),
    verifyPin: async () => true,
  });
  const success = responseRecorder();
  await successHandler(loginRequest('clerk-reservation-lifecycle', '2468', '198.51.100.77'), success);
  assert.equal(success.statusCode, 200);

  const keys = {
    accountKey: throttle.deriveThrottleBucketKey(SECRET, 'account', 'clerk-reservation-lifecycle'),
    ipKey: throttle.deriveThrottleBucketKey(SECRET, 'ip', '198.51.100.77'),
  };
  const rows = await database.pool.query(
    'SELECT bucket_type, failure_count, blocked_until FROM dispatch_login_throttle_buckets WHERE bucket_key IN ($1, $2) ORDER BY bucket_type',
    [keys.accountKey, keys.ipKey],
  );
  assert.deepEqual(rows.rows, [{ bucket_type: 'ip', failure_count: 1, blocked_until: null }]);
});
