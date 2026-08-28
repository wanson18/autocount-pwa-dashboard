const defaultAuth = require('../lib/dispatch/auth');
const {
  assertAllowedKeys,
  assertPlainObject,
  methodNotAllowed,
  parseJsonBody,
  sendCaughtError,
  sendError,
  sendJson,
} = require('../lib/dispatch/http');

const LOGIN_BODY_KEYS = ['clerkId', 'pin'];

function createDispatchSessionHandler({ auth = defaultAuth, env = process.env, now } = {}) {
  return async function dispatchSession(req, res) {
    if (req?.method === 'OPTIONS') {
      if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      return res.status(204).end();
    }

    try {
      if (req?.method === 'GET') {
        const session = auth.getSessionFromRequest(req, { env, now });
        return sendJson(res, 200, {
          success: true,
          authenticated: Boolean(session),
          session: session || null,
        });
      }

      if (req?.method === 'DELETE') {
        if (typeof res.setHeader === 'function') res.setHeader('Set-Cookie', auth.clearSessionCookie());
        return sendJson(res, 200, { success: true, authenticated: false, session: null });
      }

      if (req?.method !== 'POST') {
        return methodNotAllowed(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
      }

      const body = assertPlainObject(await parseJsonBody(req, { maxBytes: 8 * 1024 }));
      assertAllowedKeys(body, LOGIN_BODY_KEYS);
      if (typeof body.clerkId !== 'string' || !body.clerkId.trim()
        || typeof body.pin !== 'string' || !body.pin) {
        return sendError(res, 400, 'invalid_request');
      }

      const login = await auth.authenticateDispatchLogin(
        { clerkId: body.clerkId, pin: body.pin },
        { env, now },
      );
      if (!login) return sendError(res, 401, 'invalid_credentials');
      if (typeof res.setHeader === 'function') res.setHeader('Set-Cookie', login.cookie);
      return sendJson(res, 200, {
        success: true,
        authenticated: true,
        session: login.session,
      });
    } catch (error) {
      return sendCaughtError(res, error);
    }
  };
}

module.exports = createDispatchSessionHandler();
module.exports.createDispatchSessionHandler = createDispatchSessionHandler;
