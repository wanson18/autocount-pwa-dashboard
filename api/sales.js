const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const cacheStore = Object.create(null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getCacheTTL() {
  const parsed = parseInt(process.env.CACHE_TTL_MINUTES, 10);
  const minutes = Number.isNaN(parsed) ? 10 : parsed;
  return minutes * 60 * 1000;
}

function getCacheKey(startDate, endDate) {
  return `${startDate}_${endDate}`;
}

function isValidDate(value) {
  return typeof value === 'string' && DATE_RE.test(value);
}

function isCacheValid(key) {
  const entry = cacheStore[key];
  return entry && (Date.now() - entry.timestamp) < getCacheTTL();
}

function getHeaders() {
  return {
    'API-Key': process.env.AUTOCOUNT_API_KEY,
    'Key-ID': process.env.AUTOCOUNT_KEY_ID,
    'Content-Type': 'application/json',
  };
}

async function fetchAllInvoices(startDate, endDate) {
  const baseUrl = process.env.AUTOCOUNT_API_URL || 'https://accounting-api.autocountcloud.com';
  const accountBookId = process.env.AUTOCOUNT_ACCOUNT_BOOK_ID;

  if (!accountBookId || !process.env.AUTOCOUNT_API_KEY || !process.env.AUTOCOUNT_KEY_ID) {
    console.error('Missing AutoCount credentials');
    return null;
  }

  const allInvoices = [];
  let page = 1;
  let totalCount = 0;
  const headers = getHeaders();

  try {
    while (true) {
      const url = `${baseUrl}/${accountBookId}/invoice/listing`;
      const response = await axios.get(url, { headers, timeout: 15000, params: { page, startDate, endDate } });

      if (response.status === 200 && response.data?.data) {
        allInvoices.push(...response.data.data);
        totalCount = response.data.totalCount || response.data.data.length;
        if (allInvoices.length >= totalCount || response.data.data.length === 0) break;
        page++;
      } else {
        break;
      }
    }

    console.log(`Fetched ${allInvoices.length} invoices for ${startDate} to ${endDate}`);
    return allInvoices;
  } catch (error) {
    console.error('AutoCount API error:', error.message);
    return null;
  }
}

function normalizeInvoices(rawInvoices) {
  return rawInvoices.map(inv => {
    const master = inv.master || inv;
    const details = inv.details || [];

    return {
      docNo: master.docNo || '',
      docDate: master.docDate || '',
      customerName: master.debtorName || master.customerName || '',
      grandTotal: Math.round(parseFloat(master.finalTotal || master.total || 0) * 100) / 100,
      lineItems: details.map(d => ({
        sku: d.productCode || d.sku || '',
        description: d.description || '',
        quantity: parseFloat(d.qty || d.quantity || 0),
        unitPrice: parseFloat(d.unitPrice || 0),
        total: parseFloat(d.subTotal || d.total || 0),
      })),
    };
  });
}

function loadMockData() {
  const mockPath = path.join(__dirname, 'mock-sales.json');
  const raw = fs.readFileSync(mockPath, 'utf8');
  return JSON.parse(raw);
}

function aggregateBySKU(invoices) {
  const skuMap = Object.create(null);

  for (const invoice of invoices) {
    for (const item of (invoice.lineItems || [])) {
      if (!skuMap[item.sku]) {
        skuMap[item.sku] = {
          sku: item.sku,
          description: item.description,
          totalRevenue: 0,
          totalUnits: 0,
          orderCount: 0,
          totalCost: 0
        };
      }
      skuMap[item.sku].totalRevenue = Math.round((skuMap[item.sku].totalRevenue + item.total) * 100) / 100;
      skuMap[item.sku].totalUnits = Math.round((skuMap[item.sku].totalUnits + item.quantity) * 100) / 100;
      skuMap[item.sku].orderCount += 1;
      skuMap[item.sku].totalCost = Math.round((skuMap[item.sku].totalCost + item.unitPrice * item.quantity) * 100) / 100;
    }
  }

  return Object.values(skuMap).map(sku => ({
    ...sku,
    totalRevenue: Math.round(sku.totalRevenue * 100) / 100,
    avgPricePerUnit: sku.totalUnits ? Math.round((sku.totalRevenue / sku.totalUnits) * 100) / 100 : 0
  })).sort((a, b) => b.totalRevenue - a.totalRevenue);
}

function computeKPIs(invoices) {
  let totalRevenue = 0;
  let totalItems = 0;
  const customerMap = Object.create(null);

  for (const invoice of invoices) {
    totalRevenue = Math.round((totalRevenue + invoice.grandTotal) * 100) / 100;
    for (const item of (invoice.lineItems || [])) {
      totalItems += item.quantity;
    }
    customerMap[invoice.customerName] = (customerMap[invoice.customerName] || 0) + invoice.grandTotal;
  }

  const topCustomer = Object.entries(customerMap).sort((a, b) => b[1] - a[1])[0];

  return {
    totalRevenue,
    totalInvoices: invoices.length,
    totalItemsSold: totalItems,
    avgOrderValue: invoices.length ? Math.round((totalRevenue / invoices.length) * 100) / 100 : 0,
    topCustomer: topCustomer ? { name: topCustomer[0], revenue: Math.round(topCustomer[1] * 100) / 100 } : null
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    const startDate = req.query.startDate || today;
    const endDate = req.query.endDate || today;

    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return res.status(400).json({
        success: false,
        error: 'startDate and endDate must be in YYYY-MM-DD format'
      });
    }

    const cacheKey = getCacheKey(startDate, endDate);
    if (isCacheValid(cacheKey)) {
      return res.status(200).json({ ...cacheStore[cacheKey].data, cached: true });
    }

    let invoices;
    let dataSource = 'live';
    const useMock = process.env.USE_MOCK_DATA === 'true';

    if (!useMock) {
      const rawInvoices = await fetchAllInvoices(startDate, endDate);
      if (rawInvoices && rawInvoices.length > 0) {
        invoices = normalizeInvoices(rawInvoices);
      }
    }

    if (!invoices) {
      const mockData = loadMockData();
      invoices = mockData.invoices || mockData;
      dataSource = 'mock';
    }

    const aggregated = aggregateBySKU(invoices);
    const kpis = computeKPIs(invoices);

    const result = {
      success: true,
      cached: false,
      dataSource,
      timestamp: new Date().toISOString(),
      dateRange: { startDate, endDate },
      kpis,
      topSKUs: aggregated.slice(0, 5),
      skuBreakdown: aggregated
    };

    cacheStore[cacheKey] = { data: result, timestamp: Date.now() };

    return res.status(200).json(result);
  } catch (error) {
    console.error('Sales API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
};
