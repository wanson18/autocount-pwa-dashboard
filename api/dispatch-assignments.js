const { AutoCountClient } = require('../lib/autocount/client');
const { pool } = require('../lib/db/pool');
const { createRepository } = require('../lib/dispatch/repository');
const { createDispatchService } = require('../lib/dispatch/service');
const { ASSIGNMENT_STATUSES } = require('../lib/dispatch/status-machine');
const { InvoiceAdapter } = require('../lib/dispatch/invoice-adapter');
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
const COMPANY_KEYS = new Set(['enterprise', 'sdn_bhd']);
const ASSIGNMENT_CREATE_KEYS = [
  'trip_id', 'company_key', 'invoice_id', 'doc_no', 'doc_date', 'expected_trip_revision', 'request_id',
];
const ASSIGNMENT_PATCH_KEYS = [
  'assignment_id', 'operation', 'trip_id', 'status', 'expected_trip_revision', 'request_id',
];
const ASSIGNMENT_QUERY_KEYS = ['assignment_id', 'trip_id', 'limit'];
const OPERATIONS = new Set(['move', 'remove', 'status']);
const MAX_LIMIT = 100;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function idField(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  throw new DispatchHttpError(400, 'invalid_request');
}

function requiredText(value, max = 256) {
  if (typeof value !== 'string') throw new DispatchHttpError(400, 'invalid_request');
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new DispatchHttpError(400, 'invalid_request');
  return normalized;
}

function dateField(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== Number(value.slice(0, 4))
    || date.getUTCMonth() + 1 !== Number(value.slice(5, 7))
    || date.getUTCDate() !== Number(value.slice(8, 10))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function revisionField(value) {
  return idField(value);
}

function requestIdField(value) {
  if (typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) return value;
  throw new DispatchHttpError(400, 'invalid_request');
}

function statusField(value) {
  if (typeof value !== 'string' || !ASSIGNMENT_STATUSES.includes(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function operationField(value) {
  if (typeof value !== 'string' || !OPERATIONS.has(value)) {
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
  assertAllowedKeys(body, ASSIGNMENT_CREATE_KEYS);
  if (!COMPANY_KEYS.has(body.company_key)) throw new DispatchHttpError(400, 'invalid_request');
  return {
    tripId: idField(body.trip_id),
    companyKey: body.company_key,
    invoiceId: requiredText(body.invoice_id),
    docNo: requiredText(body.doc_no),
    docDate: dateField(body.doc_date),
    expectedTripRevision: revisionField(body.expected_trip_revision),
    requestId: requestIdField(body.request_id),
  };
}

function normalizePatchBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ASSIGNMENT_PATCH_KEYS);
  const operation = operationField(body.operation);
  const normalized = {
    assignmentId: idField(body.assignment_id),
    operation,
    expectedTripRevision: revisionField(body.expected_trip_revision),
    requestId: requestIdField(body.request_id),
  };
  if (operation === 'move') {
    if (body.status !== undefined) throw new DispatchHttpError(400, 'invalid_request');
    normalized.tripId = idField(body.trip_id);
  } else if (operation === 'remove') {
    if (body.trip_id !== undefined || body.status !== undefined) {
      throw new DispatchHttpError(400, 'invalid_request');
    }
  } else {
    if (body.trip_id !== undefined || body.status === undefined) {
      throw new DispatchHttpError(400, 'invalid_request');
    }
    normalized.status = statusField(body.status);
    if (normalized.status === 'removed') throw new DispatchHttpError(400, 'invalid_request');
  }
  return normalized;
}

function normalizeQuery(req) {
  const query = req?.query || {};
  if (Object.keys(query).some((key) => !ASSIGNMENT_QUERY_KEYS.includes(key))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const assignmentId = queryValue(query, 'assignment_id');
  const tripId = queryValue(query, 'trip_id');
  if (assignmentId !== undefined && tripId !== undefined) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return {
    assignmentId: assignmentId === undefined ? null : idField(assignmentId),
    tripId: tripId === undefined ? null : idField(tripId),
    limit: limitField(queryValue(query, 'limit')),
  };
}

function resolveService({ service, repository } = {}) {
  if (service) return service;
  if (repository) {
    return createDispatchService({
      repository,
      invoiceAdapter: new InvoiceAdapter(new AutoCountClient()),
    });
  }
  if (!pool) {
    const error = new Error('dispatch assignment database is not configured');
    error.code = 'configuration_error';
    throw error;
  }
  return createDispatchService({
    repository: createRepository(pool),
    invoiceAdapter: new InvoiceAdapter(new AutoCountClient()),
  });
}

function mutationResponse(res, result) {
  return sendJson(res, 200, {
    success: true,
    ...result,
  });
}

function createDispatchAssignmentsHandler({ service, repository, getSession, env = process.env, now } = {}) {
  return async function dispatchAssignments(req, res) {
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
        if (filters.assignmentId !== null) {
          const assignment = await resolvedService.getAssignment(filters.assignmentId);
          if (!assignment) return sendError(res, 404, 'resource_not_found');
          return sendJson(res, 200, { success: true, assignment });
        }
        const assignments = await resolvedService.listAssignments(filters);
        return sendJson(res, 200, { success: true, assignments });
      }

      if (req?.method === 'POST') {
        const normalized = normalizeCreateBody(await parseJsonBody(req));
        const result = await resolvedService.assignInvoice({
          ...normalized,
          actor: session.clerkId,
        });
        return sendJson(res, 201, { success: true, ...result });
      }

      if (req?.method === 'PATCH') {
        const normalized = normalizePatchBody(await parseJsonBody(req));
        let result;
        if (normalized.operation === 'move') {
          result = await resolvedService.moveAssignment({
            id: normalized.assignmentId,
            tripId: normalized.tripId,
            expectedTripRevision: normalized.expectedTripRevision,
            actor: session.clerkId,
            requestId: normalized.requestId,
          });
        } else if (normalized.operation === 'remove') {
          result = await resolvedService.removeAssignment({
            id: normalized.assignmentId,
            expectedTripRevision: normalized.expectedTripRevision,
            actor: session.clerkId,
            requestId: normalized.requestId,
          });
        } else {
          result = await resolvedService.updateAssignmentStatus({
            id: normalized.assignmentId,
            status: normalized.status,
            expectedTripRevision: normalized.expectedTripRevision,
            actor: session.clerkId,
            requestId: normalized.requestId,
          });
        }
        return mutationResponse(res, result);
      }

      return methodNotAllowed(res, ['GET', 'POST', 'PATCH', 'OPTIONS']);
    } catch (error) {
      return sendCaughtError(res, error);
    }
  };
}

module.exports = createDispatchAssignmentsHandler();
module.exports.createDispatchAssignmentsHandler = createDispatchAssignmentsHandler;
module.exports.normalizeCreateBody = normalizeCreateBody;
module.exports.normalizePatchBody = normalizePatchBody;
module.exports.normalizeQuery = normalizeQuery;
