const { pool } = require('../lib/db/pool');
const { createRepository } = require('../lib/dispatch/repository');
const { createDispatchService, isValidDate } = require('../lib/dispatch/service');
const { TRIP_STATUSES } = require('../lib/dispatch/status-machine');
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

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TRIP_CREATE_KEYS = ['trip_date', 'driver_id', 'vehicle_id', 'route_notes', 'request_id'];
const TRIP_PATCH_KEYS = [
  'trip_id', 'status', 'driver_id', 'vehicle_id', 'route_notes', 'expected_revision', 'request_id',
];
const TRIP_QUERY_KEYS = ['trip_id', 'startDate', 'endDate', 'status', 'limit'];
const MAX_LIMIT = 100;

function idField(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  throw new DispatchHttpError(400, 'invalid_request');
}

function revisionField(value) {
  return idField(value);
}

function requestIdField(value) {
  if (typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) return value;
  throw new DispatchHttpError(400, 'invalid_request');
}

function dateField(value) {
  if (!isValidDate(value)) throw new DispatchHttpError(400, 'invalid_request');
  return value;
}

function routeNotesField(value, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim().length > 500) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function statusField(value) {
  if (typeof value !== 'string' || !TRIP_STATUSES.includes(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function queryValue(query, key) {
  const value = query?.[key];
  if (Array.isArray(value) || (value !== undefined && typeof value !== 'string')) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function limitField(value) {
  if (value === undefined) return MAX_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return limit;
}

function normalizeCreateBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, TRIP_CREATE_KEYS);
  return {
    tripDate: dateField(body.trip_date),
    driverId: idField(body.driver_id),
    vehicleId: idField(body.vehicle_id),
    routeNotes: routeNotesField(body.route_notes) || '',
    requestId: requestIdField(body.request_id),
  };
}

function normalizePatchBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, TRIP_PATCH_KEYS);
  const changes = {};
  if (body.status !== undefined) changes.status = statusField(body.status);
  if (body.driver_id !== undefined) changes.driverId = idField(body.driver_id);
  if (body.vehicle_id !== undefined) changes.vehicleId = idField(body.vehicle_id);
  if (body.route_notes !== undefined) changes.routeNotes = routeNotesField(body.route_notes);
  if (!Object.keys(changes).length) throw new DispatchHttpError(400, 'invalid_request');
  return {
    id: idField(body.trip_id),
    expectedRevision: revisionField(body.expected_revision),
    changes,
    requestId: requestIdField(body.request_id),
  };
}

function normalizeQuery(req) {
  const query = req?.query || {};
  if (Object.keys(query).some((key) => !TRIP_QUERY_KEYS.includes(key))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const tripId = queryValue(query, 'trip_id');
  const startDate = queryValue(query, 'startDate');
  const endDate = queryValue(query, 'endDate');
  const status = queryValue(query, 'status');
  if (startDate !== undefined) dateField(startDate);
  if (endDate !== undefined) dateField(endDate);
  if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  if (status !== undefined) statusField(status);
  return {
    tripId: tripId === undefined ? null : idField(tripId),
    startDate: startDate === undefined ? null : startDate,
    endDate: endDate === undefined ? null : endDate,
    status: status === undefined ? null : status,
    limit: limitField(queryValue(query, 'limit')),
  };
}

function resolveService({ service, repository } = {}) {
  if (service) return service;
  if (repository) return createDispatchService({ repository });
  if (!pool) {
    const error = new Error('dispatch trip database is not configured');
    error.code = 'configuration_error';
    throw error;
  }
  return createDispatchService({ repository: createRepository(pool) });
}

function createDispatchTripsHandler({ service, repository, getSession, env = process.env, now } = {}) {
  return async function dispatchTrips(req, res) {
    if (req?.method === 'OPTIONS') {
      if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET, POST, PATCH, OPTIONS');
      return res.status(204).end();
    }

    try {
      const session = await requireDispatchSession(req, res, { getSession, env, now });
      if (!session) return;
      const resolvedService = resolveService({ service, repository });

      if (req?.method === 'GET') {
        const filters = normalizeQuery(req);
        if (filters.tripId !== null) {
          const trip = await resolvedService.getTrip(filters.tripId);
          if (!trip) return sendError(res, 404, 'resource_not_found');
          return sendJson(res, 200, { success: true, trip });
        }
        const trips = await resolvedService.listTrips(filters);
        return sendJson(res, 200, { success: true, trips });
      }

      if (req?.method === 'POST') {
        const normalized = normalizeCreateBody(await parseJsonBody(req));
        const trip = await resolvedService.createTrip({
          ...normalized,
          actor: session.clerkId,
        });
        return sendJson(res, 201, { success: true, trip });
      }

      if (req?.method === 'PATCH') {
        const normalized = normalizePatchBody(await parseJsonBody(req));
        const trip = await resolvedService.updateTrip({
          ...normalized,
          actor: session.clerkId,
        });
        return sendJson(res, 200, { success: true, trip });
      }

      return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'OPTIONS']);
    } catch (error) {
      return sendCaughtError(res, error);
    }
  };
}

module.exports = createDispatchTripsHandler();
module.exports.createDispatchTripsHandler = createDispatchTripsHandler;
module.exports.normalizeCreateBody = normalizeCreateBody;
module.exports.normalizePatchBody = normalizePatchBody;
module.exports.normalizeQuery = normalizeQuery;
