const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const SESSION_COOKIE_NAME = 'dispatch_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SESSION_MAX_AGE = SESSION_TTL_SECONDS;
const MIN_SECRET_BYTES = 32;
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });
const USER_KEYS = Object.freeze(['active', 'clerkId', 'pinHash', 'role']);

class DispatchAuthConfigError extends Error {
  constructor(message = 'dispatch authentication configuration is invalid') {
    super(message);
    this.name = 'DispatchAuthConfigError';
    this.code = 'invalid_dispatch_config';
  }
}

function assertScryptParameters({ N, r, p, keyLength }) {
  if (!Number.isInteger(N) || N < 1024 || N > 1_048_576 || (N & (N - 1)) !== 0) {
    throw new DispatchAuthConfigError();
  }
  if (!Number.isInteger(r) || r < 1 || r > 32) throw new DispatchAuthConfigError();
  if (!Number.isInteger(p) || p < 1 || p > 16) throw new DispatchAuthConfigError();
  if (!Number.isInteger(keyLength) || keyLength < 16 || keyLength > 128) {
    throw new DispatchAuthConfigError();
  }
  if (128 * N * r > 256 * 1024 * 1024) throw new DispatchAuthConfigError();
}

function parseBase64Url(value, minimumLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new DispatchAuthConfigError();
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < minimumLength) throw new DispatchAuthConfigError();
  return decoded;
}

function parseScryptHash(encoded) {
  if (typeof encoded !== 'string' || !encoded) throw new DispatchAuthConfigError();
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new DispatchAuthConfigError();

  let N;
  let r;
  let p;
  if (/^\d+$/.test(parts[1])) {
    N = Number(parts[1]);
    r = Number(parts[2]);
    p = Number(parts[3]);
  } else {
    const parameters = Object.create(null);
    for (const pair of parts[1].split(',')) {
      const [key, value] = pair.split('=');
      if (!key || !value || parameters[key] !== undefined) throw new DispatchAuthConfigError();
      parameters[key] = value;
    }
    const logN = Number(parameters.ln);
    N = Number.isInteger(logN) ? 2 ** logN : NaN;
    r = Number(parameters.r);
    p = Number(parameters.p);
  }
  const salt = parseBase64Url(parts[4], 8);
  const derivedKey = parseBase64Url(parts[5], 16);
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
  const salt = parameters.salt === undefined ? crypto.randomBytes(16) : parameters.salt;
  if (!Buffer.isBuffer(salt) || salt.length < 8 || salt.length > 64) {
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
    ? env.DISPATCH_SESSION_SECRET.trim()
    : '';
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) throw new DispatchAuthConfigError();
  const users = parseDispatchUsers(env.DISPATCH_USERS_JSON);
  const usersById = new Map(users.map((user) => [user.clerkId, user]));
  return Object.freeze({ secret, users, usersById });
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
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function signTokenPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken({ clerkId }, { secret, now = new Date() } = {}) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('session secret is required');
  const iat = unixSeconds(now);
  const exp = iat + SESSION_TTL_SECONDS;
  const payload = encodeJson({ clerkId, iat, exp });
  return {
    token: `${payload}.${signTokenPayload(payload, secret)}`,
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
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === SESSION_COOKIE_NAME) return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function configFromOptions(options = {}) {
  if (options.config) return options.config;
  if (options.secret && options.users) {
    return {
      secret: options.secret,
      users: options.users,
      usersById: new Map(options.users.map((user) => [user.clerkId, user])),
    };
  }
  return loadDispatchAuthConfig(options.env || process.env);
}

function verifySessionCookie(cookieHeader, options = {}) {
  const token = cookieValue(cookieHeader);
  if (!token) return null;
  const config = configFromOptions(options);
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expectedSignature = signTokenPayload(parts[0], config.secret);
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
  return headers.cookie || headers.Cookie || null;
}

function getSessionFromRequest(req, options = {}) {
  return verifySessionCookie(requestCookieHeader(req), options);
}

const DUMMY_HASH = [
  'scrypt',
  DEFAULT_SCRYPT.N,
  DEFAULT_SCRYPT.r,
  DEFAULT_SCRYPT.p,
  Buffer.alloc(16).toString('base64url'),
  Buffer.alloc(DEFAULT_SCRYPT.keyLength).toString('base64url'),
].join('$');

async function authenticateDispatchLogin({ clerkId, pin } = {}, { env = process.env, now = new Date() } = {}) {
  const config = loadDispatchAuthConfig(env);
  const normalizedClerkId = typeof clerkId === 'string' ? clerkId.trim() : '';
  const user = config.usersById.get(normalizedClerkId);
  const candidateHash = user?.pinHash || DUMMY_HASH;
  const verified = await verifyScryptPin(typeof pin === 'string' ? pin : '', candidateHash);
  if (!user || user.active !== true || !verified) return null;
  return createSessionCookie(user, { secret: config.secret, now });
}

module.exports = {
  DispatchAuthConfigError,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  createSessionCookie,
  createSessionToken,
  getSessionFromRequest,
  hashDispatchPin,
  loadDispatchAuthConfig,
  parseDispatchUsers,
  publicClerk,
  timingSafeCompare,
  verifyScryptPin,
  verifySessionCookie,
  authenticateDispatchLogin,
};
