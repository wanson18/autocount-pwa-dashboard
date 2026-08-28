const { pool } = require('../lib/db/pool');
const { createRepository } = require('../lib/dispatch/repository');
const {
  assertAllowedKeys,
  assertPlainObject,
  DispatchHttpError,
  methodNotAllowed,
  parseJsonBody,
  requireDispatchSession,
  sendCaughtError,
  sendError,
  sendJson,
} = require('../lib/dispatch/http');

const RESOURCE_TYPES = new Set(['driver', 'lorry']);
const ACTIVE_FILTERS = new Set(['true', 'false', 'all']);
const DRIVER_CREATE_KEYS = ['type', 'name', 'licenseNo', 'phone', 'active'];
const LORRY_CREATE_KEYS = ['type', 'registrationNo', 'description', 'active'];
const DRIVER_PATCH_KEYS = ['type', 'id', 'name', 'licenseNo', 'phone', 'active'];
const LORRY_PATCH_KEYS = ['type', 'id', 'registrationNo', 'description', 'active'];

function textField(value, { required = false, max = 160 } = {}) {
  if (value === null && !required) return null;
  if (typeof value !== 'string') throw new DispatchHttpError(400, 'invalid_request');
  const normalized = value.trim();
  if (required && !normalized) throw new DispatchHttpError(400, 'invalid_request');
  if (normalized.length > max) throw new DispatchHttpError(400, 'invalid_request');
  return normalized;
}

function booleanField(value) {
  if (typeof value !== 'boolean') throw new DispatchHttpError(400, 'invalid_request');
  return value;
}

function idField(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  throw new DispatchHttpError(400, 'invalid_request');
}

function normalizeCreateBody(body) {
  assertPlainObject(body);
  if (!RESOURCE_TYPES.has(body.type)) throw new DispatchHttpError(400, 'invalid_request');
  if (body.type === 'driver') {
    assertAllowedKeys(body, DRIVER_CREATE_KEYS);
    const result = {
      name: textField(body.name, { required: true, max: 120 }),
      licenseNo: textField(body.licenseNo, { required: true, max: 64 }),
      phone: body.phone === undefined ? null : textField(body.phone, { max: 64 }),
      active: body.active === undefined ? true : booleanField(body.active),
    };
    return { type: body.type, values: result };
  }
  assertAllowedKeys(body, LORRY_CREATE_KEYS);
  return {
    type: body.type,
    values: {
      registrationNo: textField(body.registrationNo, { required: true, max: 64 }),
      description: body.description === undefined ? null : textField(body.description, { max: 160 }),
      active: body.active === undefined ? true : booleanField(body.active),
    },
  };
}

function normalizePatchBody(body) {
  assertPlainObject(body);
  if (!RESOURCE_TYPES.has(body.type)) throw new DispatchHttpError(400, 'invalid_request');
  const keys = body.type === 'driver' ? DRIVER_PATCH_KEYS : LORRY_PATCH_KEYS;
  assertAllowedKeys(body, keys);
  const values = {};
  if (body.type === 'driver') {
    if (body.name !== undefined) values.name = textField(body.name, { required: true, max: 120 });
    if (body.licenseNo !== undefined) values.licenseNo = textField(body.licenseNo, { required: true, max: 64 });
    if (body.phone !== undefined) values.phone = textField(body.phone, { max: 64 });
  } else {
    if (body.registrationNo !== undefined) {
      values.registrationNo = textField(body.registrationNo, { required: true, max: 64 });
    }
    if (body.description !== undefined) values.description = textField(body.description, { max: 160 });
  }
  if (body.active !== undefined) values.active = booleanField(body.active);
  if (!Object.keys(values).length) throw new DispatchHttpError(400, 'invalid_request');
  return { type: body.type, id: idField(body.id), values };
}

function activeFilter(req) {
  const value = req?.query?.active === undefined ? 'true' : req.query.active;
  if (typeof value !== 'string' || !ACTIVE_FILTERS.has(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value === 'all' ? null : value === 'true';
}

function publicResource(type, resource) {
  return { type, ...resource };
}

function resolveRepository(repository) {
  if (repository) return repository;
  if (!pool) {
    const error = new Error('dispatch resource database is not configured');
    error.code = 'configuration_error';
    throw error;
  }
  return createRepository(pool);
}

function createDispatchResourcesHandler({ repository, getSession, env = process.env, now } = {}) {
  return async function dispatchResources(req, res) {
    if (req?.method === 'OPTIONS') {
      if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET, POST, PATCH, OPTIONS');
      return res.status(204).end();
    }

    try {
      const session = await requireDispatchSession(req, res, { getSession, env, now });
      if (!session) return;
      const resolvedRepository = resolveRepository(repository);

      if (req?.method === 'GET') {
        const active = activeFilter(req);
        const [drivers, lorries] = await Promise.all([
          resolvedRepository.listDrivers({ active }),
          resolvedRepository.listVehicles({ active }),
        ]);
        return sendJson(res, 200, {
          success: true,
          active: active === null ? 'all' : String(active),
          drivers: drivers.map((driver) => publicResource('driver', driver)),
          lorries: lorries.map((lorry) => publicResource('lorry', lorry)),
        });
      }

      if (req?.method === 'POST') {
        const body = await parseJsonBody(req);
        const normalized = normalizeCreateBody(body);
        const values = { ...normalized.values, actor: session.clerkId };
        const resource = normalized.type === 'driver'
          ? await resolvedRepository.createDriver(values)
          : await resolvedRepository.createVehicle(values);
        return sendJson(res, 201, {
          success: true,
          resource: publicResource(normalized.type, resource),
        });
      }

      if (req?.method === 'PATCH') {
        const body = await parseJsonBody(req);
        const normalized = normalizePatchBody(body);
        const values = { ...normalized.values, actor: session.clerkId };
        const resource = normalized.type === 'driver'
          ? await resolvedRepository.updateDriver(normalized.id, values)
          : await resolvedRepository.updateVehicle(normalized.id, values);
        if (!resource) return sendError(res, 404, 'resource_not_found');
        return sendJson(res, 200, {
          success: true,
          resource: publicResource(normalized.type, resource),
        });
      }

      return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'OPTIONS']);
    } catch (error) {
      if (error?.code === '23505') return sendError(res, 409, 'resource_conflict');
      if (error?.code === 'configuration_error') return sendError(res, 503, 'configuration_error');
      return sendCaughtError(res, error);
    }
  };
}

module.exports = createDispatchResourcesHandler();
module.exports.createDispatchResourcesHandler = createDispatchResourcesHandler;
