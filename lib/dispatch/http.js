const { DispatchAuthConfigError, getSessionFromRequest } = require('./auth');

const DEFAULT_MAX_BODY_BYTES = 32 * 1024;
const SAFE_MESSAGES = Object.freeze({
  unauthorized: 'Authentication is required.',
  invalid_credentials: 'Invalid clerk ID or PIN.',
  invalid_request: 'The request is invalid.',
  unsupported_media_type: 'JSON request bodies are required.',
  payload_too_large: 'The request body is too large.',
  method_not_allowed: 'Method not allowed.',
  configuration_error: 'Dispatch authentication is temporarily unavailable.',
  resource_conflict: 'A resource with that identity already exists.',
  resource_not_found: 'The requested resource was not found.',
  internal_error: 'An internal server error occurred.',
});

class DispatchHttpError extends Error {
  constructor(status, code, message) {
    super(message || SAFE_MESSAGES[code] || SAFE_MESSAGES.internal_error);
    this.name = 'DispatchHttpError';
    this.status = status;
    this.code = code;
    this.publicMessage = message || SAFE_MESSAGES[code] || SAFE_MESSAGES.internal_error;
  }
}

function sendJson(res, status, body, headers = {}) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  }
  return res.status(status).json(body);
}

function sendError(res, status, code, message) {
  const publicMessage = message || SAFE_MESSAGES[code] || SAFE_MESSAGES.internal_error;
  return sendJson(res, status, {
    success: false,
    error: { code, message: publicMessage },
  });
}

function methodNotAllowed(res, methods) {
  return sendJson(res, 405, {
    success: false,
    error: { code: 'method_not_allowed', message: SAFE_MESSAGES.method_not_allowed },
  }, { Allow: methods.join(', ') });
}

function assertMethod(req, methods) {
  if (!methods.includes(req?.method)) {
    throw new DispatchHttpError(405, 'method_not_allowed');
  }
}

function header(req, name) {
  const headers = req?.headers || {};
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
  return entry ? entry[1] : undefined;
}

function requireJsonContentType(req) {
  const contentType = header(req, 'content-type');
  if (typeof contentType !== 'string' || !/^application\/json\s*(?:;|$)/i.test(contentType)) {
    throw new DispatchHttpError(415, 'unsupported_media_type');
  }
}

function declaredBodySize(req) {
  const rawLength = header(req, 'content-length');
  if (rawLength === undefined) return null;
  if (typeof rawLength !== 'string' && typeof rawLength !== 'number') {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0) throw new DispatchHttpError(400, 'invalid_request');
  return length;
}

async function readStreamBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new DispatchHttpError(413, 'payload_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseJsonBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  requireJsonContentType(req);
  const declared = declaredBodySize(req);
  if (declared !== null && declared > maxBytes) throw new DispatchHttpError(413, 'payload_too_large');

  let text;
  if (req && req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > maxBytes) throw new DispatchHttpError(413, 'payload_too_large');
      text = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body, 'utf8') > maxBytes) throw new DispatchHttpError(413, 'payload_too_large');
      text = req.body;
    } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      try {
        text = JSON.stringify(req.body);
      } catch {
        throw new DispatchHttpError(400, 'invalid_request');
      }
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new DispatchHttpError(413, 'payload_too_large');
    } else {
      throw new DispatchHttpError(400, 'invalid_request');
    }
  } else if (req && typeof req[Symbol.asyncIterator] === 'function') {
    text = await readStreamBody(req, maxBytes);
  } else {
    throw new DispatchHttpError(400, 'invalid_request');
  }

  if (!text || !text.trim()) throw new DispatchHttpError(400, 'invalid_request');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be an object');
    }
    return parsed;
  } catch {
    throw new DispatchHttpError(400, 'invalid_request');
  }
}

function assertPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function assertAllowedKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
}

async function requireDispatchSession(req, res, {
  getSession = getSessionFromRequest,
  env,
  now,
} = {}) {
  try {
    const session = await getSession(req, { env, now });
    if (!session) {
      sendError(res, 401, 'unauthorized');
      return null;
    }
    return session;
  } catch (error) {
    if (error instanceof DispatchAuthConfigError || error?.code === 'invalid_dispatch_config') {
      sendError(res, 503, 'configuration_error');
      return null;
    }
    throw error;
  }
}

function sendCaughtError(res, error) {
  if (error instanceof DispatchHttpError) {
    return sendError(res, error.status, error.code, error.publicMessage);
  }
  if (error instanceof DispatchAuthConfigError || error?.code === 'invalid_dispatch_config') {
    return sendError(res, 503, 'configuration_error');
  }
  if (error?.code === 'resource_conflict') return sendError(res, 409, 'resource_conflict');
  if (error?.code === 'resource_not_found') return sendError(res, 404, 'resource_not_found');
  return sendError(res, 500, 'internal_error');
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES,
  DispatchHttpError,
  assertAllowedKeys,
  assertMethod,
  assertPlainObject,
  header,
  methodNotAllowed,
  parseJsonBody,
  requireDispatchSession,
  requireJsonContentType,
  sendCaughtError,
  sendError,
  sendJson,
};
