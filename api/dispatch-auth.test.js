const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const auth = optionalRequire('../lib/dispatch/auth');
const sessionApi = optionalRequire('./dispatch-session');
const invoicesApi = require('./dispatch-invoices');

const SECRET = 'dispatch-test-secret-with-at-least-32-bytes';
const NOW = new Date('2026-08-28T00:00:00.000Z');

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
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

function requireAuth() {
  assert.ok(auth, 'Task 4 auth module should exist');
  return auth;
}

function requireSessionApi() {
  assert.ok(sessionApi, 'Task 4 session API should exist');
  return sessionApi;
}

async function makeEnv({ active = true } = {}) {
  const implementation = requireAuth();
  const pinHash = await implementation.hashDispatchPin('2468', { salt: Buffer.alloc(16, 7) });
  return {
    DISPATCH_SESSION_SECRET: SECRET,
    DISPATCH_USERS_JSON: JSON.stringify([
      { clerkId: 'clerk-aiman', role: 'clerk', active, pinHash },
    ]),
  };
}

function jsonRequest(method, body, contentType = 'application/json') {
  const encoded = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method,
    headers: {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(encoded)),
    },
    body: encoded,
  };
}

test('DISPATCH_USERS_JSON parsing validates private hashes and exposes only public clerk metadata', () => {
  const implementation = requireAuth();
  const raw = JSON.stringify([
    {
      clerkId: 'clerk-aiman',
      role: 'clerk',
      active: true,
      pinHash: 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  ]);

  const users = implementation.parseDispatchUsers(raw);
  assert.equal(users.length, 1);
  assert.deepEqual(implementation.publicClerk(users[0]), {
    clerkId: 'clerk-aiman',
    role: 'clerk',
    active: true,
  });
  assert.equal(JSON.stringify(implementation.publicClerk(users[0])).includes('pinHash'), false);
  assert.throws(
    () => implementation.parseDispatchUsers(JSON.stringify([
      { clerkId: 'clerk-aiman', role: 'clerk', active: true, pinHash: users[0].pinHash },
      { clerkId: 'clerk-aiman', role: 'clerk', active: true, pinHash: users[0].pinHash },
    ])),
    (error) => error.code === 'invalid_dispatch_config',
  );
});

test('scrypt PIN verification accepts the right PIN, rejects the wrong PIN, and fails closed for malformed hashes', async () => {
  const implementation = requireAuth();
  const hash = await implementation.hashDispatchPin('2468', { salt: Buffer.alloc(16, 9) });

  assert.equal(await implementation.verifyScryptPin('2468', hash), true);
  assert.equal(await implementation.verifyScryptPin('9999', hash), false);
  assert.equal(await implementation.verifyScryptPin('2468', 'not-a-scrypt-hash'), false);
});

test('timing-safe comparison handles equal and unequal buffers without length exceptions', () => {
  const implementation = requireAuth();

  assert.equal(implementation.timingSafeCompare(Buffer.from('same'), Buffer.from('same')), true);
  assert.equal(implementation.timingSafeCompare(Buffer.from('same'), Buffer.from('diff')), false);
  assert.equal(implementation.timingSafeCompare(Buffer.from('same'), Buffer.from('short')), false);
});

test('login signs an eight-hour cookie and session verification rejects tampering, expiry, and inactive clerks', async () => {
  const implementation = requireAuth();
  const env = await makeEnv();
  const login = await implementation.authenticateDispatchLogin(
    { clerkId: 'clerk-aiman', pin: '2468' },
    { env, now: NOW },
  );

  assert.ok(login);
  assert.deepEqual(login.session.clerkId, 'clerk-aiman');
  assert.equal(login.session.role, 'clerk');
  assert.match(login.cookie, /dispatch_session=/);
  assert.match(login.cookie, /Max-Age=28800/);
  assert.match(login.cookie, /HttpOnly/);
  assert.match(login.cookie, /Secure/);
  assert.match(login.cookie, /SameSite=Lax/);
  assert.match(login.cookie, /Path=\//);
  assert.equal(login.cookie.includes(SECRET), false);
  assert.equal(login.cookie.includes('2468'), false);

  const cookiePair = login.cookie.split(';', 1)[0];
  assert.deepEqual(
    implementation.verifySessionCookie(cookiePair, { env, now: new Date(NOW.getTime() + 1000) }),
    login.session,
  );

  const token = cookiePair.split('=')[1];
  const tampered = `${cookiePair.slice(0, cookiePair.indexOf(token))}${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(implementation.verifySessionCookie(tampered, { env, now: NOW }), null);
  assert.equal(
    implementation.verifySessionCookie(cookiePair, {
      env,
      now: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
    }),
    null,
  );

  const inactiveEnv = await makeEnv({ active: false });
  assert.equal(implementation.verifySessionCookie(cookiePair, { env: inactiveEnv, now: NOW }), null);
});

test('invalid auth configuration fails closed without returning the secret or hash', () => {
  const implementation = requireAuth();
  assert.throws(
    () => implementation.loadDispatchAuthConfig({
      DISPATCH_SESSION_SECRET: SECRET,
      DISPATCH_USERS_JSON: '{"not":"an array"}',
    }),
    (error) => error.code === 'invalid_dispatch_config'
      && !error.message.includes(SECRET)
      && !error.message.includes('pinHash'),
  );
});

test('session POST returns a generic failure for either an unknown clerk or a wrong PIN', async () => {
  const api = requireSessionApi();
  const env = await makeEnv();
  const handler = api.createDispatchSessionHandler({ env });

  for (const credentials of [
    { clerkId: 'not-a-clerk', pin: '2468' },
    { clerkId: 'clerk-aiman', pin: '9999' },
  ]) {
    const res = responseRecorder();
    await handler(jsonRequest('POST', credentials), res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body.error, {
      code: 'invalid_credentials',
      message: 'Invalid clerk ID or PIN.',
    });
    assert.equal(JSON.stringify(res.body).includes(credentials.clerkId), false);
    assert.equal(JSON.stringify(res.body).includes(credentials.pin), false);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
  }
});

test('session GET reports the public session and DELETE clears the same cookie scope', async () => {
  const api = requireSessionApi();
  const env = await makeEnv();
  const handler = api.createDispatchSessionHandler({ env, now: NOW });
  const loginRes = responseRecorder();

  await handler(jsonRequest('POST', { clerkId: 'clerk-aiman', pin: '2468' }), loginRes);
  assert.equal(loginRes.statusCode, 200);
  assert.equal(loginRes.body.session.clerkId, 'clerk-aiman');
  assert.equal(JSON.stringify(loginRes.body).includes('pinHash'), false);
  assert.equal(JSON.stringify(loginRes.body).includes(SECRET), false);

  const currentRes = responseRecorder();
  await handler({ method: 'GET', headers: { cookie: loginRes.headers['Set-Cookie'] } }, currentRes);
  assert.equal(currentRes.statusCode, 200);
  assert.equal(currentRes.body.authenticated, true);
  assert.deepEqual(currentRes.body.session, loginRes.body.session);

  const logoutRes = responseRecorder();
  await handler({ method: 'DELETE', headers: {} }, logoutRes);
  assert.equal(logoutRes.statusCode, 200);
  assert.match(logoutRes.headers['Set-Cookie'], /dispatch_session=;/);
  assert.match(logoutRes.headers['Set-Cookie'], /Max-Age=0/);
  assert.match(logoutRes.headers['Set-Cookie'], /HttpOnly/);
  assert.match(logoutRes.headers['Set-Cookie'], /Secure/);
  assert.match(logoutRes.headers['Set-Cookie'], /SameSite=Lax/);
  assert.match(logoutRes.headers['Set-Cookie'], /Path=\//);
});

test('session endpoint rejects unsupported methods, non-JSON bodies, extra fields, and oversized bodies safely', async () => {
  const api = requireSessionApi();
  const env = await makeEnv();
  const handler = api.createDispatchSessionHandler({ env });

  const methodRes = responseRecorder();
  await handler({ method: 'PATCH', headers: {} }, methodRes);
  assert.equal(methodRes.statusCode, 405);
  assert.equal(methodRes.body.error.code, 'method_not_allowed');

  const contentTypeRes = responseRecorder();
  await handler(jsonRequest('POST', { clerkId: 'clerk-aiman', pin: '2468' }, 'text/plain'), contentTypeRes);
  assert.equal(contentTypeRes.statusCode, 415);
  assert.equal(contentTypeRes.body.error.code, 'unsupported_media_type');

  const extraFieldRes = responseRecorder();
  await handler(jsonRequest('POST', { clerkId: 'clerk-aiman', pin: '2468', role: 'admin' }), extraFieldRes);
  assert.equal(extraFieldRes.statusCode, 400);
  assert.equal(extraFieldRes.body.error.code, 'invalid_request');
  assert.equal(JSON.stringify(extraFieldRes.body).includes('admin'), false);

  const oversizedRes = responseRecorder();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '1000000' },
    body: '{}',
  }, oversizedRes);
  assert.equal(oversizedRes.statusCode, 413);
  assert.equal(oversizedRes.body.error.code, 'payload_too_large');
});

test('dispatch invoice reads require a session before contacting the source', async () => {
  let called = false;
  const handler = invoicesApi.createDispatchInvoicesHandler({
    adapter: { listInvoices: async () => { called = true; return []; } },
    configs: {},
  });
  const res = responseRecorder();

  await handler({
    method: 'GET',
    query: { startDate: '2026-08-28', endDate: '2026-08-28', company: 'enterprise' },
    headers: {},
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'unauthorized');
  assert.equal(called, false);
  assert.equal(JSON.stringify(res.body).includes('enterprise-book'), false);
});

test('deployment configuration keeps dispatch credentials server-side and dispatch responses uncached', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.match(envExample, /^DISPATCH_SESSION_SECRET=/m);
  assert.match(envExample, /^DISPATCH_USERS_JSON=/m);

  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.deepEqual(
    vercel.rewrites.filter((rewrite) => rewrite.source.startsWith('/api/dispatch/')),
    [
      { source: '/api/dispatch/session', destination: '/api/dispatch-session.js' },
      { source: '/api/dispatch/resources', destination: '/api/dispatch-resources.js' },
      { source: '/api/dispatch/invoices', destination: '/api/dispatch-invoices.js' },
    ],
  );
  const dispatchHeaders = vercel.headers.filter((entry) => entry.source.includes('dispatch'));
  assert.ok(dispatchHeaders.some((entry) => entry.headers.some((header) => (
    header.key === 'Cache-Control' && header.value === 'no-store'
  ))));
});

test('service worker never caches or replays protected dispatch API responses', () => {
  const serviceWorker = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(serviceWorker, /isDispatchApi/);
  assert.match(serviceWorker, /if \(isDispatchApi\) \{[\s\S]*?event\.respondWith\(fetch\(request\)\)/);
});
