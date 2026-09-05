const { pool } = require('../lib/db/pool');
const { createRepository } = require('../lib/dispatch/repository');
const { loadLoadingSheet } = require('../lib/dispatch/loading-sheet');
const {
  methodNotAllowed,
  requireDispatchSession,
  sendCaughtError,
  sendError,
  sendJson,
  DispatchHttpError,
} = require('../lib/dispatch/http');

const QUERY_KEYS = ['trip_id'];

function queryValue(query, key) {
  const value = query?.[key];
  if (Array.isArray(value) || (value !== undefined && typeof value !== 'string')) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function tripIdField(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const tripId = Number(value);
    if (Number.isSafeInteger(tripId) && tripId > 0) return tripId;
  }
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new DispatchHttpError(400, 'invalid_request');
}

function normalizeQuery(req) {
  const query = req?.query || {};
  if (Object.keys(query).some((key) => !QUERY_KEYS.includes(key))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return { tripId: tripIdField(queryValue(query, 'trip_id')) };
}

function resolveRepository(repository) {
  if (repository) return repository;
  if (!pool) {
    const error = new Error('dispatch loading-sheet database is not configured');
    error.code = 'configuration_error';
    throw error;
  }
  return createRepository(pool);
}

function optionsResponse(res) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
  }
  return res.status(204).end();
}

function createDispatchLoadingSheetHandler({ repository, getSession, env = process.env, now } = {}) {
  return async function dispatchLoadingSheet(req, res) {
    if (req?.method === 'OPTIONS') return optionsResponse(res);

    try {
      const session = await requireDispatchSession(req, res, { getSession, env, now });
      if (!session) return;
      if (req?.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);
      const { tripId } = normalizeQuery(req);
      const sheet = await loadLoadingSheet(resolveRepository(repository), tripId);
      if (!sheet) return sendError(res, 404, 'resource_not_found');
      return sendJson(res, 200, { success: true, sheet });
    } catch (error) {
      return sendCaughtError(res, error);
    }
  };
}

module.exports = createDispatchLoadingSheetHandler();
module.exports.createDispatchLoadingSheetHandler = createDispatchLoadingSheetHandler;
module.exports.normalizeQuery = normalizeQuery;
module.exports.tripIdField = tripIdField;
