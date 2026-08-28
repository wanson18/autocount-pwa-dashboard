const crypto = require('node:crypto');
const { promisify } = require('node:util');
const {
  DispatchLoginThrottledError,
  DispatchThrottleStoreError,
  deriveThrottleBucketKey,
  extractTrustedRequestAddress,
} = require('./throttle');

const scryptAsync = promisify(crypto.scrypt);

const SESSION_COOKIE_NAME = 'dispatch_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_MAX_AGE = SESSION_TTL_SECONDS;
const SESSION_SECRET_BYTES = 32;
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });
const DEFAULT_SCRYPT_SALT_BYTES = 16;
const USER_KEYS = Object.freeze(['active', 'clerkId', 'pinHash', 'role']);
const MIN_SCRYPT_N = 1024;
const MAX_SCRYPT_N = 65536;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 8;
const MIN_SCRYPT_SALT_BYTES = 16;
const MAX_SCRYPT_SALT_BYTES = 64;
const MIN_SCRYPT_KEY_BYTES = 32;
const MAX_SCRYPT_KEY_BYTES = 64;
const MAX_SCRYPT_MEMORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_SCRYPT_CONCURRENCY = 4;

class DispatchAuthConfigError extends Error {
  constructor(message = 'dispatch authentication configuration is invalid') {
    super(message);
    this.name = 'DispatchAuthConfigError';
    this.code = 'invalid_dispatch_config';
  }
}

function assertScryptParameters({ N, r, p, keyLength }) {
  if (!Number.isInteger(N) || N < MIN_SCRYPT_N || N > MAX_SCRYPT_N || (N & (N - 1)) !== 0) {
    throw new DispatchAuthConfigError();
  }
  if (!Number.isInteger(r) || r < 1 || r > MAX_SCRYPT_R) throw new DispatchAuthConfigError();
  if (!Number.isInteger(p) || p < 1 || p > MAX_SCRYPT_P) throw new DispatchAuthConfigError();
  if (!Number.isInteger(keyLength) || keyLength < MIN_SCRYPT_KEY_BYTES || keyLength > MAX_SCRYPT_KEY_BYTES) {
    throw new DispatchAuthConfigError();
  }
  if (128 * N * r > MAX_SCRYPT_MEMORY_BYTES) throw new DispatchAuthConfigError();
  if (N !== DEFAULT_SCRYPT.N
    || r !== DEFAULT_SCRYPT.r
    || p !== DEFAULT_SCRYPT.p
    || keyLength !== DEFAULT_SCRYPT.keyLength) {
    throw new DispatchAuthConfigError();
  }
}

function isCanonicalBase64Url(value, { minBytes = 0, maxBytes = Infinity } = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length >= minBytes
    && decoded.length <= maxBytes
    && decoded.toString('base64url') === value;
}

function parseBase64Url(value, { minBytes = 0, maxBytes = Infinity } = {}) {
  if (!isCanonicalBase64Url(value, { minBytes, maxBytes })) {
    throw new DispatchAuthConfigError();
  }
  return Buffer.from(value, 'base64url');
}

function parseScryptHash(encoded) {
  if (typeof encoded !== 'string' || !encoded) throw new DispatchAuthConfigError();
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new DispatchAuthConfigError();

  if (![parts[1], parts[2], parts[3]].every((value) => /^\d+$/.test(value))) {
    throw new DispatchAuthConfigError();
  }
  if ([parts[1], parts[2], parts[3]].some((value) => String(Number(value)) !== value)) {
    throw new DispatchAuthConfigError();
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parseBase64Url(parts[4], {
    minBytes: MIN_SCRYPT_SALT_BYTES,
    maxBytes: MAX_SCRYPT_SALT_BYTES,
  });
  const derivedKey = parseBase64Url(parts[5], {
    minBytes: MIN_SCRYPT_KEY_BYTES,
    maxBytes: MAX_SCRYPT_KEY_BYTES,
  });
  if (salt.length !== DEFAULT_SCRYPT_SALT_BYTES) throw new DispatchAuthConfigError();
  const keyLength = derivedKey.length;
  assertScryptParameters({ N, r, p, keyLength });
  return { N, r, p, salt, derivedKey, keyLength };
}

function validPin(pin) {
  return typeof pin === 'string' && pin.length > 0 && pin.length <= 128;
}

function timingSafeCompare(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(left || '');
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(right || '');
  const length = Math.max(leftBuffer.length, rightBuffer.length);
  if (length === 0) return false;
  const paddedLeft = Buffer.alloc(length);
  const paddedRight = Buffer.alloc(length);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return crypto.timingSafeEqual(paddedLeft, paddedRight)
    && leftBuffer.length === rightBuffer.length;
}

async function hashDispatchPin(pin, options = {}) {
  if (!validPin(pin)) throw new TypeError('pin must be a non-empty string');
  const parameters = { ...DEFAULT_SCRYPT, ...options };
  const salt = parameters.salt === undefined
    ? crypto.randomBytes(DEFAULT_SCRYPT_SALT_BYTES)
    : parameters.salt;
  if (!Buffer.isBuffer(salt)
    || salt.length < MIN_SCRYPT_SALT_BYTES
    || salt.length > MAX_SCRYPT_SALT_BYTES
    || salt.length !== DEFAULT_SCRYPT_SALT_BYTES) {
    throw new TypeError('salt must be a byte buffer');
  }
  assertScryptParameters(parameters);
  const derivedKey = await scryptAsync(pin, salt, parameters.keyLength, {
    N: parameters.N,
    r: parameters.r,
    p: parameters.p,
    maxmem: Math.max(32 * 1024 * 1024, 128 * parameters.N * parameters.r + 1024),
  });
  return [
    'scrypt',
    parameters.N,
    parameters.r,
    parameters.p,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

async function verifyScryptPin(pin, encodedHash) {
  if (!validPin(pin)) return false;
  try {
    const parsed = parseScryptHash(encodedHash);
    const derivedKey = await scryptAsync(pin, parsed.salt, parsed.keyLength, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: Math.max(32 * 1024 * 1024, 128 * parsed.N * parsed.r + 1024),
    });
    return timingSafeCompare(derivedKey, parsed.derivedKey);
  } catch {
    return false;
  }
}

function createScryptLimiter(maxConcurrency = DEFAULT_SCRYPT_CONCURRENCY) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
    throw new TypeError('invalid scrypt concurrency');
  }
  let active = 0;
  return Object.freeze({
    tryAcquire() {
      if (active >= maxConcurrency) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    get active() {
      return active;
    },
  });
}

const defaultScryptLimiter = createScryptLimiter();

function publicClerk(user) {
  if (!user) return null;
  return {
    clerkId: user.clerkId,
    role: user.role,
    active: user.active,
  };
}

function parseDispatchUsers(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new DispatchAuthConfigError();
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new DispatchAuthConfigError();
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 256) {
    throw new DispatchAuthConfigError();
  }

  const seen = new Set();
  const users = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DispatchAuthConfigError();
    }
    const keys = Object.keys(entry).sort();
    if (keys.length !== USER_KEYS.length || keys.some((key, index) => key !== USER_KEYS.slice().sort()[index])) {
      throw new DispatchAuthConfigError();
    }
    const clerkId = typeof entry.clerkId === 'string' ? entry.clerkId.trim() : '';
    const role = typeof entry.role === 'string' ? entry.role.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(clerkId)) throw new DispatchAuthConfigError();
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(role)) throw new DispatchAuthConfigError();
    if (seen.has(clerkId) || typeof entry.active !== 'boolean') throw new DispatchAuthConfigError();
    parseScryptHash(entry.pinHash);
    seen.add(clerkId);
    return Object.freeze({ clerkId, role, active: entry.active, pinHash: entry.pinHash });
  });
  return Object.freeze(users);
}

function loadDispatchAuthConfig(env = process.env) {
  const secret = typeof env.DISPATCH_SESSION_SECRET === 'string'
    ? env.DISPATCH_SESSION_SECRET
    : '';
  const secretBytes = parseSessionSecret(secret);
  const users = parseDispatchUsers(env.DISPATCH_USERS_JSON);
  const usersById = new Map(users.map((user) => [user.clerkId, user]));
  return Object.freeze({ secret, secretBytes, users, usersById });
}

function parseSessionSecret(secret) {
  try {
    return parseBase64Url(secret, {
      minBytes: SESSION_SECRET_BYTES,
      maxBytes: SESSION_SECRET_BYTES,
    });
  } catch {
    throw new DispatchAuthConfigError();
  }
}

function unixSeconds(now = new Date()) {
  const milliseconds = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(milliseconds)) throw new TypeError('now must be a valid date');
  return Math.floor(milliseconds / 1000);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeJson(value) {
  if (!isCanonicalBase64Url(value, { minBytes: 1, maxBytes: 4096 })) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    return encodeJson(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function signTokenPayload(payload, secret) {
  const secretBytes = Buffer.isBuffer(secret)
    ? secret
    : parseSessionSecret(secret);
  if (secretBytes.length !== SESSION_SECRET_BYTES) throw new DispatchAuthConfigError();
  return crypto.createHmac('sha256', secretBytes).update(payload).digest('base64url');
}

function createSessionToken({ clerkId }, { secret, now = new Date() } = {}) {
  const secretBytes = parseSessionSecret(secret);
  if (typeof clerkId !== 'string' || !clerkId) throw new TypeError('clerk ID is required');
  const iat = unixSeconds(now);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload = encodeJson({ clerkId, iat, exp });
  return {
    token: `${payload}.${signTokenPayload(payload, secretBytes)}`,
    session: { clerkId, iat, exp },
  };
}

function serializeSessionCookie(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function createSessionCookie(user, { secret, now = new Date() } = {}) {
  const created = createSessionToken({ clerkId: user.clerkId }, { secret, now });
  return {
    cookie: serializeSessionCookie(created.token),
    token: created.token,
    session: { ...created.session, role: user.role },
  };
}

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function cookieValue(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  let found = null;
  let seen = false;
  for (const rawPart of cookieHeader.split(';')) {
    const separator = rawPart.indexOf('=');
    const name = rawPart.slice(0, separator < 0 ? rawPart.length : separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    if (seen) return null;
    seen = true;
    if (separator < 0) return null;
    const value = rawPart.slice(separator + 1);
    if (!value || value.trim() !== value) return null;
    found = value;
  }
  return found;
}

function configFromOptions(options = {}) {
  if (options.config) return options.config;
  if (options.secret && options.users) {
    const secretBytes = parseSessionSecret(options.secret);
    return {
      secret: options.secret,
      secretBytes,
      users: options.users,
      usersById: new Map(options.users.map((user) => [user.clerkId, user])),
    };
  }
  return loadDispatchAuthConfig(options.env || process.env);
}

function verifySessionCookie(cookieHeader, options = {}) {
  const token = cookieValue(cookieHeader);
  if (!token) return null;
  let config;
  try {
    config = configFromOptions(options);
  } catch {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!isCanonicalBase64Url(parts[0], { minBytes: 1, maxBytes: 4096 })
    || !isCanonicalBase64Url(parts[1], { minBytes: 32, maxBytes: 32 })) return null;
  const expectedSignature = signTokenPayload(parts[0], config.secretBytes || config.secret);
  if (!timingSafeCompare(Buffer.from(parts[1], 'base64url'), Buffer.from(expectedSignature, 'base64url'))) {
    return null;
  }
  const claims = decodeJson(parts[0]);
  if (!claims) return null;
  const claimKeys = Object.keys(claims).sort();
  if (claimKeys.join(',') !== 'clerkId,exp,iat') return null;
  if (typeof claims.clerkId !== 'string'
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || claims.exp - claims.iat !== SESSION_TTL_SECONDS) {
    return null;
  }
  const nowSeconds = unixSeconds(options.now || new Date());
  if (claims.iat > nowSeconds + CLOCK_SKEW_SECONDS || claims.exp <= nowSeconds) return null;
  const user = config.usersById.get(claims.clerkId);
  if (!user || user.active !== true) return null;
  return { clerkId: user.clerkId, role: user.role, iat: claims.iat, exp: claims.exp };
}

function requestCookieHeader(req) {
  const headers = req?.headers || {};
  const cookieHeaders = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'cookie')
    .map(([, value]) => value)
    .filter((value) => typeof value === 'string');
  return cookieHeaders.length ? cookieHeaders.join(';') : null;
}

function getSessionFromRequest(req, options = {}) {
  return verifySessionCookie(requestCookieHeader(req), options);
}

const DUMMY_HASH = [
  'scrypt',
  DEFAULT_SCRYPT.N,
  DEFAULT_SCRYPT.r,
  DEFAULT_SCRYPT.p,
  Buffer.alloc(DEFAULT_SCRYPT_SALT_BYTES).toString('base64url'),
  Buffer.alloc(DEFAULT_SCRYPT.keyLength).toString('base64url'),
].join('$');

async function authenticateDispatchLogin(
  { clerkId, pin } = {},
  {
    env = process.env,
    now = new Date(),
    throttleStore = null,
    requestAddress = 'unknown',
    trustedProxy,
    req,
    scryptLimiter = defaultScryptLimiter,
    verifyPin = verifyScryptPin,
    config: suppliedConfig,
  } = {},
) {
  const config = suppliedConfig || loadDispatchAuthConfig(env);
  const normalizedClerkId = typeof clerkId === 'string' ? clerkId.trim() : '';
  const user = config.usersById.get(normalizedClerkId);
  const configuredTrustedProxy = trustedProxy ?? env.DISPATCH_TRUSTED_PROXY;
  const address = requestAddress === 'unknown' && req
    ? extractTrustedRequestAddress(req, { trustedProxy: configuredTrustedProxy })
    : requestAddress;
  const bucketKeys = throttleStore ? {
    accountKey: deriveThrottleBucketKey(
      config.secretBytes || config.secret,
      'account',
      normalizedClerkId || 'invalid',
    ),
    ipKey: deriveThrottleBucketKey(config.secretBytes || config.secret, 'ip', address || 'unknown'),
  } : null;
  if (throttleStore) {
    if (typeof throttleStore.reserveAttempt !== 'function') throw new DispatchThrottleStoreError();
    const decision = await throttleStore.reserveAttempt({ ...bucketKeys, now });
    if (!decision || typeof decision.allowed !== 'boolean') throw new DispatchThrottleStoreError();
    if (!decision.allowed) throw new DispatchLoginThrottledError(decision.retryAfterSeconds);
  }
  const candidateHash = user?.pinHash || DUMMY_HASH;
  const release = scryptLimiter?.tryAcquire?.();
  if (!release) throw new DispatchLoginThrottledError(1);
  let verified;
  try {
    verified = await verifyPin(typeof pin === 'string' ? pin : '', candidateHash);
  } finally {
    release();
  }
  if (!user || user.active !== true || !verified) return null;
  if (throttleStore) {
    if (typeof throttleStore.recordSuccess !== 'function') throw new DispatchThrottleStoreError();
    await throttleStore.recordSuccess({ ...bucketKeys, now });
  }
  return createSessionCookie(user, { secret: config.secret, now });
}

module.exports = {
  DispatchAuthConfigError,
  DEFAULT_SCRYPT_CONCURRENCY,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  createSessionCookie,
  createSessionToken,
  getSessionFromRequest,
  hashDispatchPin,
  loadDispatchAuthConfig,
  parseSessionSecret,
  parseScryptHash,
  parseDispatchUsers,
  publicClerk,
  timingSafeCompare,
  verifyScryptPin,
  verifySessionCookie,
  authenticateDispatchLogin,
  createScryptLimiter,
  defaultScryptLimiter,
};
