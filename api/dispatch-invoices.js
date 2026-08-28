const { AutoCountClient } = require('../lib/autocount/client');
const { loadCompanyConfigs } = require('../lib/autocount/company-config');
const { InvoiceAdapter } = require('../lib/dispatch/invoice-adapter');
const {
  methodNotAllowed,
  requireDispatchSession,
  sendCaughtError,
  sendError,
  sendJson,
} = require('../lib/dispatch/http');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY_KEYS = ['enterprise', 'sdn_bhd'];

function isValidDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(value.slice(0, 4))
    && date.getUTCMonth() + 1 === Number(value.slice(5, 7))
    && date.getUTCDate() === Number(value.slice(8, 10));
}

function requestError(res, message) {
  return sendError(res, 400, 'invalid_request', message);
}

function createDispatchInvoicesHandler({ adapter, configs, getSession, env = process.env, now } = {}) {
  return async function dispatchInvoices(req, res) {
    if (req.method === 'OPTIONS') {
      if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET, OPTIONS');
      return res.status(204).end();
    }

    try {
      const session = await requireDispatchSession(req, res, { getSession, env, now });
      if (!session) return;
      if (req.method !== 'GET') {
        return methodNotAllowed(res, ['GET', 'OPTIONS']);
      }

      const query = req.query || {};
      const startDate = query.startDate;
      const endDate = query.endDate;
      const company = query.company || 'all';
      if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
        return requestError(res, 'startDate and endDate must be valid YYYY-MM-DD dates with startDate <= endDate');
      }
      if (company !== 'all' && !COMPANY_KEYS.includes(company)) {
        return requestError(res, 'company must be all, enterprise, or sdn_bhd');
      }

      const resolvedConfigs = configs || loadCompanyConfigs();
      const resolvedAdapter = adapter || new InvoiceAdapter(new AutoCountClient());
      const keys = company === 'all' ? COMPANY_KEYS : [company];
      const sourceResults = await Promise.all(keys.map(async (key) => {
        try {
          const invoices = await resolvedAdapter.listInvoices(resolvedConfigs[key], startDate, endDate);
          return [key, { status: 'ok', invoiceCount: invoices.length }, invoices];
        } catch (error) {
          const integrityError = error && ['duplicate_doc_key', 'invalid_source_data'].includes(error.code);
          return [
            key,
            integrityError
              ? { status: 'invalid', errorCode: error.code }
              : { status: 'unavailable', errorCode: 'source_unavailable' },
            [],
          ];
        }
      }));

      const sources = {};
      const invoices = [];
      for (const [key, health, rows] of sourceResults) {
        sources[key] = health;
        invoices.push(...rows);
      }
      return sendJson(res, 200, {
        success: true,
        dateRange: { startDate, endDate },
        company,
        invoices,
        sources,
      });
    } catch (error) {
      if (error && error.name === 'CompanyConfigError') {
        return sendError(res, 503, 'source_unavailable');
      }
      return sendCaughtError(res, error);
    }
  };
}

module.exports = createDispatchInvoicesHandler();
module.exports.createDispatchInvoicesHandler = createDispatchInvoicesHandler;
module.exports.isValidDate = isValidDate;
