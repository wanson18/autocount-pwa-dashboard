const { pool } = require('../lib/db/pool');
const { createRepository } = require('../lib/dispatch/repository');
const { isValidDate } = require('../lib/dispatch/service');
const {
  ASSIGNMENT_STATUSES,
  COMPANY_NAMES,
  REPORT_COLUMNS,
  TRIP_STATUSES,
  buildReport,
  reportToCsv,
} = require('../lib/dispatch/report');
const {
  DispatchHttpError,
  methodNotAllowed,
  requireDispatchSession,
  sendCaughtError,
  sendJson,
} = require('../lib/dispatch/http');

const COMPANY_KEYS = ['all', 'enterprise', 'sdn_bhd'];
const QUERY_KEYS = ['startDate', 'endDate', 'company', 'driver_id', 'lorry_id', 'status', 'format'];
const FORMATS = new Set(['json', 'csv']);
const MAX_REPORT_RECORDS = 1000;

function queryValue(query, key) {
  const value = query?.[key];
  if (Array.isArray(value) || (value !== undefined && typeof value !== 'string')) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function idField(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new DispatchHttpError(400, 'invalid_request');
  return id;
}

function statusField(value) {
  if (typeof value !== 'string' || (!TRIP_STATUSES.has(value) && !ASSIGNMENT_STATUSES.has(value))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  return value;
}

function normalizeQuery(req) {
  const query = req?.query || {};
  if (Object.keys(query).some((key) => !QUERY_KEYS.includes(key))) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  const startDate = queryValue(query, 'startDate');
  const endDate = queryValue(query, 'endDate');
  const company = queryValue(query, 'company') ?? 'all';
  const driver = queryValue(query, 'driver_id');
  const lorry = queryValue(query, 'lorry_id');
  const status = queryValue(query, 'status');
  const format = queryValue(query, 'format') ?? 'json';
  if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  if (!COMPANY_KEYS.includes(company) || !FORMATS.has(format)) {
    throw new DispatchHttpError(400, 'invalid_request');
  }
  if (status !== undefined) statusField(status);
  return {
    startDate,
    endDate,
    company,
    driverId: driver === undefined ? null : idField(driver),
    vehicleId: lorry === undefined ? null : idField(lorry),
    status: status === undefined ? null : status,
    format,
  };
}

function resolveRepository(repository) {
  if (repository) return repository;
  if (!pool) {
    const error = new Error('dispatch reports database is not configured');
    error.code = 'configuration_error';
    throw error;
  }
  return createRepository(pool);
}

function sendCsv(res, report) {
  const csv = reportToCsv(report.records);
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="dispatch-report-${report.startDate}-to-${report.endDate}.csv"`);
  }
  if (typeof res.send === 'function') return res.status(200).send(csv);
  return res.status(200).end(csv);
}

function createDispatchReportsHandler({ repository, getSession, env = process.env, now } = {}) {
  return async function dispatchReports(req, res) {
    if (req?.method === 'OPTIONS') {
      if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', 'GET, OPTIONS');
        res.setHeader('Cache-Control', 'no-store');
      }
      return res.status(204).end();
    }

    try {
      const session = await requireDispatchSession(req, res, { getSession, env, now });
      if (!session) return;
      if (req?.method !== 'GET') return methodNotAllowed(res, ['GET', 'OPTIONS']);
      const query = normalizeQuery(req);
      const { format, ...repositoryFilters } = query;
      const records = await resolveRepository(repository).listReportRecords({
        ...repositoryFilters,
        limit: MAX_REPORT_RECORDS,
      });
      const result = buildReport(records, repositoryFilters);
      if (format === 'csv') return sendCsv(res, result);
      return sendJson(res, 200, {
        success: true,
        ...result,
        filters: {
          company: query.company,
          driverId: query.driverId,
          lorryId: query.vehicleId,
          status: query.status,
        },
      });
    } catch (error) {
      return sendCaughtError(res, error);
    }
  };
}

module.exports = createDispatchReportsHandler();
module.exports.COMPANY_NAMES = COMPANY_NAMES;
module.exports.MAX_REPORT_RECORDS = MAX_REPORT_RECORDS;
module.exports.REPORT_COLUMNS = REPORT_COLUMNS;
module.exports.createDispatchReportsHandler = createDispatchReportsHandler;
module.exports.normalizeQuery = normalizeQuery;
module.exports.sendCsv = sendCsv;
