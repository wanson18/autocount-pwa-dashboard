const fs = require('fs');
const path = require('path');
const axios = require('axios');
// Vercel dev does not consistently inject `.env.local` into plain Node
// serverless functions, so load the local override explicitly before `.env`.
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_API_URL = 'https://accounting-api.autocountcloud.com';
const COMPANY_DEFINITIONS = Object.freeze([
  {
    id: 'enterprise',
    name: 'Wanson Enterprise',
    accountBookId: '63750',
    apiKeyEnv: 'AUTOCOUNT_ENTERPRISE_API_KEY',
    keyIdEnv: 'AUTOCOUNT_ENTERPRISE_KEY_ID',
    apiUrlEnv: 'AUTOCOUNT_ENTERPRISE_API_URL',
    apiKeyAliases: ['AUTOCOUNT_API_KEY_WANSON_ENTERPRISE'],
    keyIdAliases: ['AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE'],
    legacyApiKeyEnv: 'AUTOCOUNT_API_KEY',
    legacyKeyIdEnv: 'AUTOCOUNT_KEY_ID',
  },
  {
    id: 'sdnBhd',
    name: 'Wanson Sdn Bhd',
    accountBookId: '63688',
    apiKeyEnv: 'AUTOCOUNT_SDN_BHD_API_KEY',
    keyIdEnv: 'AUTOCOUNT_SDN_BHD_KEY_ID',
    apiUrlEnv: 'AUTOCOUNT_SDN_BHD_API_URL',
    apiKeyAliases: ['AUTOCOUNT_API_KEY_WANSON_SDN_BHD'],
    keyIdAliases: ['AUTOCOUNT_KEY_ID_WANSON_SDN_BHD'],
  },
]);

// Serverless runtimes (Vercel) run with TZ=UTC, so `new Date()` local time is
// NOT the business's local time. The reporting timezone must be explicit,
// otherwise "today" rolls over 8 hours late for a UTC+8 business.
const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur';

function getReportingTimeZone() {
  return process.env.REPORT_TIMEZONE || DEFAULT_TIMEZONE;
}

/**
 * Current date as YYYY-MM-DD in the reporting timezone.
 * Replaces `new Date().toISOString().slice(0, 10)`, which returns the UTC date.
 */
function getLocalToday(timeZone = getReportingTimeZone(), now = new Date()) {
  try {
    // en-CA formats as YYYY-MM-DD, and formatToParts avoids locale surprises.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);

    const get = (type) => parts.find((p) => p.type === type)?.value;
    const [year, month, day] = [get('year'), get('month'), get('day')];

    if (year && month && day) return `${year}-${month}-${day}`;
  } catch (error) {
    console.warn(`Invalid REPORT_TIMEZONE "${timeZone}", falling back to UTC:`, error.message);
  }

  return now.toISOString().slice(0, 10);
}

function isValidDate(value) {
  return typeof value === 'string' && DATE_RE.test(value);
}

function getHeaders(company) {
  return {
    'API-Key': company.apiKey,
    'Key-ID': company.keyId,
    'Content-Type': 'application/json',
  };
}

function getCompanyConfigs(env = process.env) {
  return COMPANY_DEFINITIONS.map((definition) => {
    const firstConfigured = (names) => names.map((name) => env[name]).find(Boolean) || null;
    const apiKey = firstConfigured([
      definition.apiKeyEnv,
      ...(definition.apiKeyAliases || []),
      ...(definition.legacyApiKeyEnv ? [definition.legacyApiKeyEnv] : []),
    ]);
    const keyId = firstConfigured([
      definition.keyIdEnv,
      ...(definition.keyIdAliases || []),
      ...(definition.legacyKeyIdEnv ? [definition.legacyKeyIdEnv] : []),
    ]);

    return {
      id: definition.id,
      name: definition.name,
      accountBookId: definition.accountBookId,
      apiUrl: env[definition.apiUrlEnv] || env.AUTOCOUNT_API_URL || DEFAULT_API_URL,
      apiKey,
      keyId,
      credentialsConfigured: Boolean(apiKey && keyId),
    };
  });
}

async function fetchAllInvoices(startDate, endDate, company, httpClient = axios) {
  const baseUrl = (company?.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const accountBookId = company?.accountBookId;

  if (!accountBookId || !company?.apiKey || !company?.keyId) {
    console.error(`Missing AutoCount credentials for ${company?.name || 'unknown company'}`);
    return null;
  }

  const allInvoices = [];
  let page = 1;

  try {
    while (true) {
      const url = `${baseUrl}/${accountBookId}/invoice/listing`;
      const response = await httpClient.get(url, {
        headers: getHeaders(company),
        timeout: 15000,
        params: { page, startDate, endDate },
      });
      const pageData = Array.isArray(response.data?.data) ? response.data.data : null;

      if (response.status !== 200 || !pageData) return null;

      allInvoices.push(...pageData);
      if (pageData.length === 0) break;

      const totalCount = Number(response.data.totalCount);
      if (Number.isFinite(totalCount) && allInvoices.length >= totalCount) break;

      const pageSize = Number(response.data.pageSize || response.data.page_size || response.data.limit);
      if (!Number.isFinite(totalCount) && Number.isFinite(pageSize) && pageData.length < pageSize) break;

      page += 1;
      if (page > 100) throw new Error(`AutoCount pagination exceeded 100 pages for ${company.name}`);
    }

    console.log(`Fetched ${allInvoices.length} invoices for ${startDate} to ${endDate}`);
    return allInvoices;
  } catch (error) {
    console.error('AutoCount API error:', error.message);
    return null;
  }
}

function parseOutstandingAmount(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const parsed = parseFloat(rawValue);
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function isCancelledInvoice(master) {
  const cancellationState = master.cancelled ?? master.isCancelled;
  return cancellationState === true || cancellationState === 1 || cancellationState === '1';
}

function normalizeInvoices(rawInvoices, company = null) {
  return rawInvoices.filter((inv) => !isCancelledInvoice(inv.master || inv)).map((inv) => {
    const master = inv.master || inv;
    const details = inv.details || inv.lineItems || [];

    const normalized = {
      docNo: master.docNo || '',
      docDate: master.docDate || '',
      customerName: master.debtorName || master.customerName || '',
      grandTotal: Math.round(parseFloat(master.finalTotal || master.total || master.grandTotal || 0) * 100) / 100,
      outstandingAmount: parseOutstandingAmount(master.outstandingAmount),
      lineItems: details.map((d) => ({
        sku: d.productCode || d.sku || '',
        description: d.description || '',
        quantity: parseFloat(d.qty || d.quantity || 0),
        unitPrice: parseFloat(d.unitPrice || 0),
        total: parseFloat(d.subTotal || d.total || 0),
      })),
    };

    if (company) {
      normalized.companyId = company.id;
      normalized.companyName = company.name;
      normalized.accountBookId = company.accountBookId;
    }

    return normalized;
  });
}

function loadMockData(company) {
  if (company.id !== 'enterprise') {
    throw new Error(`Mock data is not configured for ${company.name}`);
  }

  const mockPath = path.join(__dirname, 'mock-sales.json');
  const raw = fs.readFileSync(mockPath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.invoices || [];
}

function aggregateBySKU(invoices) {
  const skuMap = Object.create(null);

  for (const invoice of invoices) {
    for (const item of invoice.lineItems || []) {
      // Item codes are scoped to an AutoCount company book. The same code can
      // legitimately identify different products in the two companies.
      const aggregationKey = invoice.companyId ? `${invoice.companyId}\u0000${item.sku}` : item.sku;
      if (!skuMap[aggregationKey]) {
        skuMap[aggregationKey] = {
          sku: item.sku,
          description: item.description,
          totalRevenue: 0,
          totalUnits: 0,
          orderCount: 0,
          totalCost: 0,
          customerQuantities: {},
        };
        if (invoice.companyId) {
          skuMap[aggregationKey].companyId = invoice.companyId;
          skuMap[aggregationKey].companyName = invoice.companyName;
        }
      }
      skuMap[aggregationKey].totalRevenue = Math.round((skuMap[aggregationKey].totalRevenue + item.total) * 100) / 100;
      skuMap[aggregationKey].totalUnits = Math.round((skuMap[aggregationKey].totalUnits + item.quantity) * 100) / 100;
      skuMap[aggregationKey].orderCount += 1;
      skuMap[aggregationKey].totalCost =
        Math.round((skuMap[aggregationKey].totalCost + item.unitPrice * item.quantity) * 100) / 100;
      const customerKey = invoice.companyId ? `${invoice.companyId}\u0000${invoice.customerName}` : invoice.customerName;
      if (!skuMap[aggregationKey].customerQuantities[customerKey]) {
        skuMap[aggregationKey].customerQuantities[customerKey] = {
          name: invoice.customerName,
          quantity: 0,
          companyId: invoice.companyId,
          companyName: invoice.companyName,
        };
      }
      skuMap[aggregationKey].customerQuantities[customerKey].quantity += item.quantity;
    }
  }

  return Object.values(skuMap)
    .map(({ customerQuantities, ...sku }) => ({
      ...sku,
      totalRevenue: Math.round(sku.totalRevenue * 100) / 100,
      avgPricePerUnit: sku.totalUnits ? Math.round((sku.totalRevenue / sku.totalUnits) * 100) / 100 : 0,
      customers: Object.values(customerQuantities)
        .map((customer) => {
          const result = { name: customer.name, quantity: Math.round(customer.quantity * 100) / 100 };
          if (customer.companyId) {
            result.companyId = customer.companyId;
            result.companyName = customer.companyName;
          }
          return result;
        })
        .sort((a, b) => b.quantity - a.quantity),
    }))
    .sort((a, b) => b.totalRevenue - a.totalRevenue);
}

function computeKPIs(invoices) {
  let totalRevenue = 0;
  let totalItems = 0;
  const customerMap = Object.create(null);

  for (const invoice of invoices) {
    totalRevenue = Math.round((totalRevenue + invoice.grandTotal) * 100) / 100;
    for (const item of invoice.lineItems || []) {
      totalItems += item.quantity;
    }
    const customerKey = invoice.companyId ? `${invoice.companyId}\u0000${invoice.customerName}` : invoice.customerName;
    if (!customerMap[customerKey]) {
      customerMap[customerKey] = {
        name: invoice.customerName,
        revenue: 0,
        companyId: invoice.companyId,
        companyName: invoice.companyName,
      };
    }
    customerMap[customerKey].revenue += invoice.grandTotal;
  }

  const topCustomer = Object.values(customerMap).sort((a, b) => b.revenue - a.revenue)[0];

  const result = {
    totalRevenue,
    totalInvoices: invoices.length,
    totalItemsSold: totalItems,
    avgOrderValue: invoices.length ? Math.round((totalRevenue / invoices.length) * 100) / 100 : 0,
    topCustomer: topCustomer
      ? { name: topCustomer.name, revenue: Math.round(topCustomer.revenue * 100) / 100 }
      : null,
  };

  if (topCustomer?.companyId) {
    result.topCustomer.companyId = topCustomer.companyId;
    result.topCustomer.companyName = topCustomer.companyName;
  }

  return result;
}

function classifyPaymentStatus(grandTotal, outstandingAmount) {
  if (outstandingAmount === null || outstandingAmount === undefined) return 'unknown';
  if (outstandingAmount <= 0) return 'paid';
  if (outstandingAmount >= grandTotal) return 'unpaid';
  return 'partial';
}

function computePaymentSummary(invoices) {
  const summary = {
    paid: { count: 0, total: 0 },
    partial: { count: 0, outstanding: 0 },
    unpaid: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
    stillUnpaidTotal: 0,
  };

  for (const invoice of invoices) {
    const { grandTotal, outstandingAmount, paymentStatus } = invoice;

    if (paymentStatus === 'paid') {
      summary.paid.count += 1;
      summary.paid.total = Math.round((summary.paid.total + grandTotal) * 100) / 100;
    } else if (paymentStatus === 'partial') {
      summary.partial.count += 1;
      summary.partial.outstanding = Math.round((summary.partial.outstanding + outstandingAmount) * 100) / 100;
      summary.stillUnpaidTotal = Math.round((summary.stillUnpaidTotal + outstandingAmount) * 100) / 100;
    } else if (paymentStatus === 'unpaid') {
      summary.unpaid.count += 1;
      summary.unpaid.total = Math.round((summary.unpaid.total + grandTotal) * 100) / 100;
      summary.stillUnpaidTotal = Math.round((summary.stillUnpaidTotal + grandTotal) * 100) / 100;
    } else {
      summary.unknown.count += 1;
      summary.unknown.total = Math.round((summary.unknown.total + grandTotal) * 100) / 100;
    }
  }

  return summary;
}

async function loadCompanyInvoices(startDate, endDate, company, useMock) {
  if (!useMock && !company.credentialsConfigured) {
    return {
      company,
      status: 'error',
      error: 'Credentials not configured',
      invoices: [],
    };
  }

  try {
    const rawInvoices = useMock ? loadMockData(company) : await fetchAllInvoices(startDate, endDate, company);
    if (!rawInvoices) {
      return {
        company,
        status: 'error',
        error: 'AutoCount API unavailable',
        invoices: [],
      };
    }

    return {
      company,
      status: 'ok',
      dataSource: useMock ? 'mock' : 'live',
      invoices: normalizeInvoices(rawInvoices, company),
    };
  } catch (error) {
    console.error(`AutoCount ${company.name} load error:`, error.message);
    return {
      company,
      status: 'error',
      error: useMock ? 'Mock data unavailable' : 'AutoCount API unavailable',
      invoices: [],
    };
  }
}

function publicCompanySummary(result) {
  const { company } = result;
  if (result.status !== 'ok') {
    return {
      id: company.id,
      name: company.name,
      accountBookId: company.accountBookId,
      status: 'error',
      invoiceCount: 0,
      totalRevenue: 0,
      totalItemsSold: 0,
      error: result.error,
    };
  }

  const kpis = computeKPIs(result.invoices);
  return {
    id: company.id,
    name: company.name,
    accountBookId: company.accountBookId,
    status: 'ok',
    invoiceCount: kpis.totalInvoices,
    totalRevenue: kpis.totalRevenue,
    totalItemsSold: kpis.totalItemsSold,
  };
}

function combineCompanyResults(companyResults, startDate, endDate, timestamp = new Date().toISOString()) {
  const companies = companyResults.map(publicCompanySummary);
  const successfulResults = companyResults.filter((result) => result.status === 'ok');
  const invoices = successfulResults.flatMap((result) =>
    result.invoices.map((invoice) => ({
      ...invoice,
      companyId: invoice.companyId || result.company.id,
      companyName: invoice.companyName || result.company.name,
      accountBookId: invoice.accountBookId || result.company.accountBookId,
    })),
  );
  const classifiedInvoices = invoices.map((invoice) => ({
    ...invoice,
    paymentStatus: classifyPaymentStatus(invoice.grandTotal, invoice.outstandingAmount),
  }));
  const aggregated = aggregateBySKU(classifiedInvoices);
  const failedCompanies = companies.filter((company) => company.status !== 'ok');
  const sources = new Set(successfulResults.map((result) => result.dataSource));

  return {
    success: successfulResults.length > 0,
    complete: failedCompanies.length === 0,
    dataSource: sources.size === 1 ? [...sources][0] : sources.size > 1 ? 'mixed' : null,
    company: 'Wanson Companies',
    accountBooks: companies.map(({ id, name, accountBookId }) => ({ id, name, accountBookId })),
    companies,
    warnings: failedCompanies.map((company) => `${company.name}: ${company.error}`),
    cached: false,
    timestamp,
    dateRange: { startDate, endDate },
    kpis: computeKPIs(classifiedInvoices),
    topSKUs: aggregated.slice(0, 5),
    skuBreakdown: aggregated,
    invoices: classifiedInvoices.map((invoice) => ({
      docNo: invoice.docNo,
      docDate: invoice.docDate,
      customerName: invoice.customerName,
      grandTotal: invoice.grandTotal,
      outstandingAmount: invoice.outstandingAmount,
      paymentStatus: invoice.paymentStatus,
      companyId: invoice.companyId,
      companyName: invoice.companyName,
      accountBookId: invoice.accountBookId,
      lineItems: (invoice.lineItems || []).map((item) => ({
        sku: item.sku,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
      })),
    })),
    paymentSummary: computePaymentSummary(classifiedInvoices),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const today = getLocalToday();
    const startDate = req.query.startDate || today;
    const endDate = req.query.endDate || today;

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate must be in YYYY-MM-DD format',
      });
    }

    const companies = getCompanyConfigs();
    const useMock = process.env.USE_MOCK_DATA === 'true';
    const companyResults = await Promise.all(
      companies.map((company) => loadCompanyInvoices(startDate, endDate, company, useMock)),
    );
    const result = combineCompanyResults(companyResults, startDate, endDate);

    if (!result.success) {
      return res.status(502).json({
        ...result,
        error: 'No company data could be loaded',
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('Sales API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

module.exports.aggregateBySKU = aggregateBySKU;
module.exports.getLocalToday = getLocalToday;
module.exports.fetchAllInvoices = fetchAllInvoices;
module.exports.getCompanyConfigs = getCompanyConfigs;
module.exports.loadCompanyInvoices = loadCompanyInvoices;
module.exports.combineCompanyResults = combineCompanyResults;
module.exports.normalizeInvoices = normalizeInvoices;
module.exports.parseOutstandingAmount = parseOutstandingAmount;
module.exports.classifyPaymentStatus = classifyPaymentStatus;
module.exports.computePaymentSummary = computePaymentSummary;
