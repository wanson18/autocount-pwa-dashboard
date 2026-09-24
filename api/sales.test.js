const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateBySKU,
  getLocalToday,
  getCompanyConfigs,
  fetchAllInvoices,
  loadCompanyInvoices,
  combineCompanyResults,
  normalizeInvoices,
  resolveMultiPackRates,
  parseOutstandingAmount,
  classifyPaymentStatus,
  computePaymentSummary,
} = require('./sales.js');

test('getCompanyConfigs maps both books to their matching credentials', () => {
  const configs = getCompanyConfigs({
    AUTOCOUNT_ENTERPRISE_API_KEY: 'enterprise-key',
    AUTOCOUNT_ENTERPRISE_KEY_ID: 'enterprise-id',
    AUTOCOUNT_SDN_BHD_API_KEY: 'sdn-key',
    AUTOCOUNT_SDN_BHD_KEY_ID: 'sdn-id',
  });

  assert.deepEqual(
    configs.map(({ id, name, accountBookId, apiKey, keyId, credentialsConfigured }) => ({
      id,
      name,
      accountBookId,
      apiKey,
      keyId,
      credentialsConfigured,
    })),
    [
      {
        id: 'enterprise',
        name: 'Wanson Enterprise',
        accountBookId: '63750',
        apiKey: 'enterprise-key',
        keyId: 'enterprise-id',
        credentialsConfigured: true,
      },
      {
        id: 'sdnBhd',
        name: 'Wanson Sdn Bhd',
        accountBookId: '63688',
        apiKey: 'sdn-key',
        keyId: 'sdn-id',
        credentialsConfigured: true,
      },
    ],
  );
});

test('getCompanyConfigs never reuses Enterprise credentials for Sdn Bhd', () => {
  const [enterprise, sdnBhd] = getCompanyConfigs({
    AUTOCOUNT_API_KEY: 'legacy-enterprise-key',
    AUTOCOUNT_KEY_ID: 'legacy-enterprise-id',
  });

  assert.equal(enterprise.apiKey, 'legacy-enterprise-key');
  assert.equal(enterprise.keyId, 'legacy-enterprise-id');
  assert.equal(sdnBhd.apiKey, null);
  assert.equal(sdnBhd.keyId, null);
  assert.equal(sdnBhd.credentialsConfigured, false);
});

test('getCompanyConfigs accepts the existing Vercel company-scoped variable names', () => {
  const configs = getCompanyConfigs({
    AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: 'enterprise-key',
    AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE: 'enterprise-id',
    AUTOCOUNT_API_KEY_WANSON_SDN_BHD: 'sdn-key',
    AUTOCOUNT_KEY_ID_WANSON_SDN_BHD: 'sdn-id',
  });

  assert.deepEqual(
    configs.map(({ id, accountBookId, apiKey, keyId, credentialsConfigured }) => ({
      id,
      accountBookId,
      apiKey,
      keyId,
      credentialsConfigured,
    })),
    [
      { id: 'enterprise', accountBookId: '63750', apiKey: 'enterprise-key', keyId: 'enterprise-id', credentialsConfigured: true },
      { id: 'sdnBhd', accountBookId: '63688', apiKey: 'sdn-key', keyId: 'sdn-id', credentialsConfigured: true },
    ],
  );
});

test('fetchAllInvoices continues pagination when AutoCount omits totalCount', async () => {
  const pages = [
    { status: 200, data: { data: [{ id: 1 }, { id: 2 }] } },
    { status: 200, data: { data: [{ id: 3 }] } },
    { status: 200, data: { data: [] } },
  ];
  const calls = [];
  const company = {
    name: 'Wanson Sdn Bhd',
    accountBookId: '63688',
    apiUrl: 'https://accounting-api.autocountcloud.com/',
    apiKey: 'sdn-key',
    keyId: 'sdn-id',
  };
  const httpClient = {
    get: async (url, options) => {
      calls.push({ url, options });
      return pages.shift();
    },
  };

  const result = await fetchAllInvoices('2026-09-01', '2026-09-01', company, httpClient);

  assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://accounting-api.autocountcloud.com/63688/invoice/listing');
  assert.deepEqual(calls[0].options.headers, {
    'API-Key': 'sdn-key',
    'Key-ID': 'sdn-id',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(calls.map(({ options }) => options.params.page), [1, 2, 3]);
});

test('loadCompanyInvoices reports missing book-scoped credentials without calling AutoCount', async () => {
  const result = await loadCompanyInvoices(
    '2026-09-01',
    '2026-09-01',
    {
      id: 'sdnBhd',
      name: 'Wanson Sdn Bhd',
      accountBookId: '63688',
      apiUrl: 'https://accounting-api.autocountcloud.com',
      apiKey: null,
      keyId: null,
      credentialsConfigured: false,
    },
    false,
  );

  assert.deepEqual(
    {
      status: result.status,
      error: result.error,
      invoices: result.invoices,
    },
    {
      status: 'error',
      error: 'Credentials not configured',
      invoices: [],
    },
  );
});

test('loadCompanyInvoices normalizes the mock envelope and keeps line items', async () => {
  const result = await loadCompanyInvoices(
    '2026-09-01',
    '2026-09-01',
    {
      id: 'enterprise',
      name: 'Wanson Enterprise',
      accountBookId: '63750',
      credentialsConfigured: false,
    },
    true,
  );

  assert.equal(result.status, 'ok');
  assert.equal(result.dataSource, 'mock');
  assert.equal(result.invoices.length, 5);
  assert.deepEqual(result.invoices[0].lineItems[0], {
    sku: 'OIL-PKO-20L',
    description: 'Palm Kernel Oil 20L Drum',
    quantity: 50,
    unitPrice: 125,
    total: 6250,
  });
  assert.equal(result.invoices[0].grandTotal, 9757.3);
});

test('loadCompanyInvoices converts multipack quantities using the AutoCount product master', async () => {
  const rawPages = [
    {
      status: 200,
      data: {
        data: [
          {
            master: {
              docNo: 'CS-035525',
              docDate: '2026-09-24',
              debtorName: 'INFLOW GLOBALL MARKETING SDN BHD',
              finalTotal: '13144.00',
              outstandingAmount: '13144.00',
            },
            details: [
              { productCode: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', qty: '100', unit: 'BOX', unitPrice: '118', subTotal: '11800' },
              { productCode: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', qty: '30', unit: 'BTL', unitPrice: '28', subTotal: '840' },
            ],
          },
        ],
      },
    },
    { status: 200, data: { data: [] } },
  ];
  const httpClient = { get: async () => rawPages.shift() || { status: 200, data: { data: [] } } };
  const requested = [];
  const getProduct = async (sku) => {
    requested.push(sku);
    return { product: { unit: 'BTL' }, productMultiPacks: [{ multiPack: 'BOX', multiPackRate: '4.00000000' }] };
  };

  const result = await loadCompanyInvoices(
    '2026-09-24',
    '2026-09-24',
    {
      id: 'sdnBhd',
      name: 'Wanson Sdn Bhd',
      accountBookId: '63688',
      apiUrl: 'https://accounting-api.autocountcloud.com',
      apiKey: 'sdn-key',
      keyId: 'sdn-id',
      credentialsConfigured: true,
    },
    false,
    { httpClient, getProduct },
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(requested, ['1110100002']);
  assert.equal(result.invoices[0].lineItems[0].unitRate, 4);
  assert.equal(result.invoices[0].lineItems[0].baseUnit, 'BTL');
  assert.equal(result.invoices[0].lineItems[1].unitRate, 1);
});

test('loadCompanyInvoices still returns invoices when the product master is unavailable', async () => {
  const rawPages = [
    {
      status: 200,
      data: {
        data: [
          {
            master: { docNo: 'CS-035525', docDate: '2026-09-24', debtorName: 'INFLOW GLOBALL MARKETING SDN BHD', finalTotal: '11800.00' },
            details: [
              { productCode: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', qty: '100', unit: 'BOX', unitPrice: '118', subTotal: '11800' },
              { productCode: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', qty: '30', unit: 'BTL', unitPrice: '28', subTotal: '840' },
            ],
          },
        ],
      },
    },
    { status: 200, data: { data: [] } },
  ];
  const httpClient = { get: async () => rawPages.shift() || { status: 200, data: { data: [] } } };
  const requested = [];
  const getProduct = async (sku) => {
    requested.push(sku);
    throw new Error('AutoCount API unavailable');
  };

  const result = await loadCompanyInvoices(
    '2026-09-24',
    '2026-09-24',
    {
      id: 'sdnBhd',
      name: 'Wanson Sdn Bhd',
      accountBookId: '63688',
      apiUrl: 'https://accounting-api.autocountcloud.com',
      apiKey: 'sdn-key',
      keyId: 'sdn-id',
      credentialsConfigured: true,
    },
    false,
    { httpClient, getProduct },
  );

  assert.equal(result.status, 'ok');
  assert.deepEqual(requested, ['1110100002']);
  assert.equal(result.invoices[0].lineItems[0].unitRate, undefined);
  assert.equal(result.invoices[0].lineItems[0].quantity, 100);
});

test('combineCompanyResults preserves company identity and reports both totals', () => {
  const result = combineCompanyResults(
    [
      {
        company: { id: 'enterprise', name: 'Wanson Enterprise', accountBookId: '63750' },
        status: 'ok',
        dataSource: 'live',
        invoices: [
          {
            docNo: 'INV-1',
            docDate: '2026-09-01',
            customerName: 'Same Customer',
            grandTotal: 100,
            outstandingAmount: 0,
            lineItems: [{ sku: 'SKU-1', description: 'Oil', quantity: 2, unitPrice: 50, total: 100 }],
          },
        ],
      },
      {
        company: { id: 'sdnBhd', name: 'Wanson Sdn Bhd', accountBookId: '63688' },
        status: 'ok',
        dataSource: 'live',
        invoices: [
          {
            docNo: 'INV-1',
            docDate: '2026-09-01',
            customerName: 'Same Customer',
            grandTotal: 200,
            outstandingAmount: 200,
            lineItems: [{ sku: 'SKU-1', description: 'Oil', quantity: 4, unitPrice: 50, total: 200 }],
          },
        ],
      },
    ],
    '2026-09-01',
    '2026-09-01',
    '2026-09-01T05:00:00.000Z',
  );

  assert.equal(result.success, true);
  assert.equal(result.complete, true);
  assert.equal(result.kpis.totalInvoices, 2);
  assert.equal(result.kpis.totalRevenue, 300);
  assert.deepEqual(result.invoices.map(({ docNo, companyId, companyName, accountBookId }) => ({ docNo, companyId, companyName, accountBookId })), [
    { docNo: 'INV-1', companyId: 'enterprise', companyName: 'Wanson Enterprise', accountBookId: '63750' },
    { docNo: 'INV-1', companyId: 'sdnBhd', companyName: 'Wanson Sdn Bhd', accountBookId: '63688' },
  ]);
  assert.deepEqual(result.invoices.map(({ lineItems }) => lineItems), [
    [{ sku: 'SKU-1', description: 'Oil', quantity: 2, unitPrice: 50, total: 100 }],
    [{ sku: 'SKU-1', description: 'Oil', quantity: 4, unitPrice: 50, total: 200 }],
  ]);
  assert.deepEqual(result.companies.map(({ id, accountBookId, status, invoiceCount, totalRevenue }) => ({ id, accountBookId, status, invoiceCount, totalRevenue })), [
    { id: 'enterprise', accountBookId: '63750', status: 'ok', invoiceCount: 1, totalRevenue: 100 },
    { id: 'sdnBhd', accountBookId: '63688', status: 'ok', invoiceCount: 1, totalRevenue: 200 },
  ]);
  assert.deepEqual(
    result.skuBreakdown.map(({ companyId, companyName, customers }) => ({ companyId, companyName, customers })),
    [
      {
        companyId: 'sdnBhd',
        companyName: 'Wanson Sdn Bhd',
        customers: [{ companyId: 'sdnBhd', companyName: 'Wanson Sdn Bhd', name: 'Same Customer', quantity: 4 }],
      },
      {
        companyId: 'enterprise',
        companyName: 'Wanson Enterprise',
        customers: [{ companyId: 'enterprise', companyName: 'Wanson Enterprise', name: 'Same Customer', quantity: 2 }],
      },
    ],
  );
});

test('combineCompanyResults marks the response partial when one book fails', () => {
  const result = combineCompanyResults(
    [
      {
        company: { id: 'enterprise', name: 'Wanson Enterprise', accountBookId: '63750' },
        status: 'ok',
        dataSource: 'live',
        invoices: [],
      },
      {
        company: { id: 'sdnBhd', name: 'Wanson Sdn Bhd', accountBookId: '63688' },
        status: 'error',
        error: 'Credentials not configured',
        invoices: [],
      },
    ],
    '2026-09-01',
    '2026-09-01',
    '2026-09-01T05:00:00.000Z',
  );

  assert.equal(result.success, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.warnings, ['Wanson Sdn Bhd: Credentials not configured']);
  assert.deepEqual(result.companies.map(({ id, status, error }) => ({ id, status, error })), [
    { id: 'enterprise', status: 'ok', error: undefined },
    { id: 'sdnBhd', status: 'error', error: 'Credentials not configured' },
  ]);
});

test('aggregateBySKU groups quantity sold per customer, sorted descending', () => {
  const invoices = [
    {
      customerName: 'ABC Trading Sdn Bhd',
      grandTotal: 6250,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 50, unitPrice: 125, total: 6250 },
      ],
    },
    {
      customerName: 'XYZ Industries Ltd',
      grandTotal: 3750,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 30, unitPrice: 125, total: 3750 },
      ],
    },
    {
      customerName: 'ABC Trading Sdn Bhd',
      grandTotal: 1250,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 10, unitPrice: 125, total: 1250 },
      ],
    },
  ];

  const [result] = aggregateBySKU(invoices);

  assert.equal(result.sku, 'OIL-PKO-20L');
  assert.deepEqual(result.customers, [
    { name: 'ABC Trading Sdn Bhd', quantity: 60 },
    { name: 'XYZ Industries Ltd', quantity: 30 },
  ]);
});

test('aggregateBySKU keeps the same item code separate across company books', () => {
  const result = aggregateBySKU([
    {
      companyId: 'enterprise',
      companyName: 'Wanson Enterprise',
      customerName: 'Enterprise customer',
      lineItems: [{ sku: '00022', description: 'RENTAL', quantity: 1, unitPrice: 1000, total: 1000 }],
    },
    {
      companyId: 'sdnBhd',
      companyName: 'Wanson Sdn Bhd',
      customerName: 'Sdn Bhd customer',
      lineItems: [{ sku: '00022', description: 'TEPUNG BERAS CAP ERAWAN 3 GAJAH 1KG', quantity: 15, unitPrice: 43, total: 645 }],
    },
  ]);

  assert.deepEqual(
    result.map(({ sku, description, companyId, companyName, totalUnits, totalRevenue }) => ({
      sku,
      description,
      companyId,
      companyName,
      totalUnits,
      totalRevenue,
    })),
    [
      {
        sku: '00022',
        description: 'RENTAL',
        companyId: 'enterprise',
        companyName: 'Wanson Enterprise',
        totalUnits: 1,
        totalRevenue: 1000,
      },
      {
        sku: '00022',
        description: 'TEPUNG BERAS CAP ERAWAN 3 GAJAH 1KG',
        companyId: 'sdnBhd',
        companyName: 'Wanson Sdn Bhd',
        totalUnits: 15,
        totalRevenue: 645,
      },
    ],
  );
});

test('resolveMultiPackRates converts multipack lines to the item base unit for mixed-unit SKUs only', async () => {
  const invoices = [
    {
      companyId: 'sdnBhd',
      customerName: 'INFLOW GLOBALL MARKETING SDN BHD',
      lineItems: [
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 100, unit: 'BOX', unitPrice: 118, total: 11800 },
      ],
    },
    {
      companyId: 'sdnBhd',
      customerName: 'ONG ST ENTERPRISE',
      lineItems: [
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 30, unit: 'BTL', unitPrice: 28, total: 840 },
      ],
    },
    {
      companyId: 'sdnBhd',
      customerName: 'INFLOW GLOBALL MARKETING SDN BHD',
      lineItems: [
        { sku: '1110100005', description: 'MINYAK MASAK 1KG 食油', quantity: 200, unit: 'BTL', unitPrice: 6, total: 1200 },
      ],
    },
  ];
  const requested = [];
  const getProduct = async (sku) => {
    requested.push(sku);
    return { product: { unit: 'BTL' }, productMultiPacks: [{ multiPack: 'BOX', multiPackRate: '4.00000000' }] };
  };

  const result = await resolveMultiPackRates(invoices, getProduct);

  assert.deepEqual(requested, ['1110100002']);
  assert.equal(result[0].lineItems[0].unitRate, 4);
  assert.equal(result[0].lineItems[0].baseUnit, 'BTL');
  assert.equal(result[1].lineItems[0].unitRate, 1);
  assert.equal(result[1].lineItems[0].baseUnit, 'BTL');
  assert.equal(result[2].lineItems[0].unitRate, undefined);
  assert.equal(result[2].lineItems[0].baseUnit, undefined);
});

test('resolveMultiPackRates leaves mixed-unit quantities untouched when the product lookup fails', async () => {
  const invoices = [
    {
      companyId: 'sdnBhd',
      customerName: 'INFLOW GLOBALL MARKETING SDN BHD',
      lineItems: [
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 100, unit: 'BOX', unitPrice: 118, total: 11800 },
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 30, unit: 'BTL', unitPrice: 28, total: 840 },
      ],
    },
  ];
  const getProduct = async () => {
    throw new Error('AutoCount API unavailable');
  };

  const result = await resolveMultiPackRates(invoices, getProduct);

  assert.equal(result[0].lineItems[0].unitRate, undefined);
  assert.equal(result[0].lineItems[1].unitRate, undefined);
});

test('resolveMultiPackRates does not convert a mixed SKU when the product master cannot explain every unit', async () => {
  const invoices = [
    {
      companyId: 'sdnBhd',
      customerName: 'MIXED UOM CUSTOMER',
      lineItems: [
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 100, unit: 'BOX', unitPrice: 118, total: 11800 },
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 5, unit: 'CTN', unitPrice: 118, total: 590 },
      ],
    },
  ];
  const getProduct = async () => ({
    product: { unit: 'BTL' },
    productMultiPacks: [{ multiPack: 'BOX', multiPackRate: '4.00000000' }],
  });

  const result = await resolveMultiPackRates(invoices, getProduct);

  assert.equal(result[0].lineItems[0].unitRate, undefined);
  assert.equal(result[0].lineItems[1].unitRate, undefined);
});

test('aggregateBySKU counts multipack lines in the item base unit', () => {
  const result = aggregateBySKU([
    {
      companyId: 'sdnBhd',
      companyName: 'Wanson Sdn Bhd',
      customerName: 'INFLOW GLOBALL MARKETING SDN BHD',
      lineItems: [
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 100, unit: 'BOX', unitRate: 4, baseUnit: 'BTL', unitPrice: 118, total: 11800 },
      ],
    },
    {
      companyId: 'sdnBhd',
      companyName: 'Wanson Sdn Bhd',
      customerName: 'ONG ST ENTERPRISE',
      lineItems: [
        { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 30, unit: 'BTL', unitRate: 1, baseUnit: 'BTL', unitPrice: 28, total: 840 },
      ],
    },
  ]);

  const [sku] = result;

  assert.equal(sku.totalUnits, 430);
  assert.equal(sku.unit, 'BTL');
  assert.equal(sku.totalCost, 12640);
  assert.equal(sku.avgPricePerUnit, 29.4);
  assert.deepEqual(sku.customers, [
    { name: 'INFLOW GLOBALL MARKETING SDN BHD', quantity: 400, companyId: 'sdnBhd', companyName: 'Wanson Sdn Bhd' },
    { name: 'ONG ST ENTERPRISE', quantity: 30, companyId: 'sdnBhd', companyName: 'Wanson Sdn Bhd' },
  ]);
});

test('aggregateBySKU reports the unit for single-UOM SKUs and omits it when mixed units stay unresolved', () => {
  const result = aggregateBySKU([
    {
      customerName: 'BTL customer',
      lineItems: [{ sku: 'BTL-ONLY', description: 'Bottled oil', quantity: 5, unit: 'BTL', unitPrice: 10, total: 50 }],
    },
    {
      customerName: 'Mixed customer',
      lineItems: [{ sku: 'MIXED', description: 'Mixed oil', quantity: 1, unit: 'BOX', unitPrice: 100, total: 100 }],
    },
    {
      customerName: 'Mixed customer',
      lineItems: [{ sku: 'MIXED', description: 'Mixed oil', quantity: 2, unit: 'BTL', unitPrice: 10, total: 20 }],
    },
  ]);

  const bySku = Object.fromEntries(result.map((entry) => [entry.sku, entry]));

  assert.equal(bySku['BTL-ONLY'].unit, 'BTL');
  assert.equal('unit' in bySku.MIXED, false);
});

test('combineCompanyResults converts multipack lines before computing units sold', () => {
  const result = combineCompanyResults(
    [
      {
        company: { id: 'sdnBhd', name: 'Wanson Sdn Bhd', accountBookId: '63688' },
        status: 'ok',
        dataSource: 'live',
        invoices: [
          {
            docNo: 'CS-035525',
            docDate: '2026-09-24',
            customerName: 'INFLOW GLOBALL MARKETING SDN BHD',
            grandTotal: 13144,
            outstandingAmount: 13144,
            lineItems: [
              { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 100, unit: 'BOX', unitRate: 4, baseUnit: 'BTL', unitPrice: 118, total: 11800 },
              { sku: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', quantity: 30, unit: 'BTL', unitRate: 1, baseUnit: 'BTL', unitPrice: 28, total: 840 },
            ],
          },
        ],
      },
    ],
    '2026-09-24',
    '2026-09-24',
    '2026-09-24T05:00:00.000Z',
  );

  assert.equal(result.kpis.totalItemsSold, 430);
  assert.equal(result.skuBreakdown[0].totalUnits, 430);
  assert.equal(result.skuBreakdown[0].unit, 'BTL');
  assert.deepEqual(result.invoices[0].lineItems[0], {
    sku: '1110100002',
    description: 'MINYAK MASAK TOMATO MERAH 5KG 食油',
    quantity: 100,
    unit: 'BOX',
    unitPrice: 118,
    total: 11800,
  });
});

test('getLocalToday returns the UTC+8 date, not the UTC date, after 16:00 UTC', () => {
  // 2026-08-12 16:30 UTC is already 2026-08-13 00:30 in Kuala Lumpur.
  const now = new Date('2026-08-12T16:30:00Z');

  assert.equal(now.toISOString().slice(0, 10), '2026-08-12', 'sanity: UTC date is the previous day');
  assert.equal(getLocalToday('Asia/Kuala_Lumpur', now), '2026-08-13');
});

test('getLocalToday matches the UTC date during Malaysian business hours', () => {
  // 2026-08-12 04:00 UTC is 12:00 noon in Kuala Lumpur — same calendar day.
  const now = new Date('2026-08-12T04:00:00Z');

  assert.equal(getLocalToday('Asia/Kuala_Lumpur', now), '2026-08-12');
});

test('getLocalToday handles month and year rollover in local time', () => {
  const newYearEve = new Date('2026-12-31T16:00:00Z');
  assert.equal(getLocalToday('Asia/Kuala_Lumpur', newYearEve), '2027-01-01');

  const monthEnd = new Date('2026-08-31T17:00:00Z');
  assert.equal(getLocalToday('Asia/Kuala_Lumpur', monthEnd), '2026-09-01');
});

test('getLocalToday always emits a zero-padded YYYY-MM-DD string', () => {
  const earlyMonth = new Date('2026-01-05T02:00:00Z');
  const result = getLocalToday('Asia/Kuala_Lumpur', earlyMonth);

  assert.equal(result, '2026-01-05');
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('getLocalToday respects a different reporting timezone', () => {
  const now = new Date('2026-08-12T16:30:00Z');

  assert.equal(getLocalToday('UTC', now), '2026-08-12');
  assert.equal(getLocalToday('America/New_York', now), '2026-08-12');
});

test('getLocalToday falls back to the UTC date when the timezone is invalid', () => {
  const now = new Date('2026-08-12T16:30:00Z');

  assert.equal(getLocalToday('Not/AZone', now), '2026-08-12');
});

test('parseOutstandingAmount parses a numeric string and rounds to 2 decimals', () => {
  assert.equal(parseOutstandingAmount('1234.5678'), 1234.57);
});

test('parseOutstandingAmount returns null when the value is missing', () => {
  assert.equal(parseOutstandingAmount(undefined), null);
  assert.equal(parseOutstandingAmount(null), null);
});

test('parseOutstandingAmount returns null for a non-numeric value', () => {
  assert.equal(parseOutstandingAmount('not-a-number'), null);
});

test('normalizeInvoices reads outstandingAmount from the raw invoice master record', () => {
  const rawInvoices = [
    {
      master: {
        docNo: 'SI-001',
        docDate: '2026-08-14',
        debtorName: 'ABC Trading Sdn Bhd',
        finalTotal: '1000.00',
        outstandingAmount: '250.00',
      },
      details: [],
    },
  ];

  const [result] = normalizeInvoices(rawInvoices);

  assert.equal(result.grandTotal, 1000);
  assert.equal(result.outstandingAmount, 250);
});

test('normalizeInvoices sets outstandingAmount to null when AutoCount does not return the field', () => {
  const rawInvoices = [
    {
      master: {
        docNo: 'SI-002',
        docDate: '2026-08-14',
        debtorName: 'XYZ Industries Ltd',
        finalTotal: '500.00',
      },
      details: [],
    },
  ];

  const [result] = normalizeInvoices(rawInvoices);

  assert.equal(result.outstandingAmount, null);
});

test('normalizeInvoices excludes AutoCount cancelled invoice rows from sales', () => {
  const invoices = normalizeInvoices([
    {
      master: {
        docNo: 'SI-ACTIVE',
        docDate: '2026-09-09',
        debtorName: 'Active Customer',
        finalTotal: '100.00',
        cancelled: false,
      },
      details: [],
    },
    {
      master: {
        docNo: 'SI-VOID',
        docDate: '2026-09-09',
        debtorName: 'Voided Customer',
        finalTotal: '200.00',
        cancelled: true,
      },
      details: [],
    },
    {
      master: {
        docNo: 'SI-VOID-ALIAS',
        docDate: '2026-09-09',
        debtorName: 'Voided Alias Customer',
        finalTotal: '300.00',
        isCancelled: '1',
      },
      details: [],
    },
  ]);

  assert.deepEqual(invoices.map((invoice) => invoice.docNo), ['SI-ACTIVE']);
});

test('normalizeInvoices keeps the AutoCount line unit so multipack quantities can be converted', () => {
  const [invoice] = normalizeInvoices([
    {
      master: {
        docNo: 'CS-035525',
        docDate: '2026-09-24',
        debtorName: 'INFLOW GLOBALL MARKETING SDN BHD',
        finalTotal: '13144.00',
      },
      details: [
        { productCode: '1110100002', description: 'MINYAK MASAK TOMATO MERAH 5KG 食油', qty: '100', unit: 'BOX', unitPrice: '118', subTotal: '11800' },
      ],
    },
  ]);

  assert.deepEqual(invoice.lineItems[0], {
    sku: '1110100002',
    description: 'MINYAK MASAK TOMATO MERAH 5KG 食油',
    quantity: 100,
    unit: 'BOX',
    unitPrice: 118,
    total: 11800,
  });
});

test('classifyPaymentStatus returns paid when outstanding is zero', () => {
  assert.equal(classifyPaymentStatus(1000, 0), 'paid');
});

test('classifyPaymentStatus returns paid when outstanding is negative (defensive)', () => {
  assert.equal(classifyPaymentStatus(1000, -0.01), 'paid');
});

test('classifyPaymentStatus returns partial when outstanding is between 0 and the total', () => {
  assert.equal(classifyPaymentStatus(1000, 400), 'partial');
});

test('classifyPaymentStatus returns unpaid when outstanding equals the total', () => {
  assert.equal(classifyPaymentStatus(1000, 1000), 'unpaid');
});

test('classifyPaymentStatus returns unpaid when outstanding exceeds the total (defensive)', () => {
  assert.equal(classifyPaymentStatus(1000, 1200), 'unpaid');
});

test('classifyPaymentStatus returns unknown when outstanding is null or undefined', () => {
  assert.equal(classifyPaymentStatus(1000, null), 'unknown');
  assert.equal(classifyPaymentStatus(1000, undefined), 'unknown');
});

test('computePaymentSummary tallies counts and totals per bucket', () => {
  const invoices = [
    { grandTotal: 1000, outstandingAmount: 0, paymentStatus: 'paid' },
    { grandTotal: 2000, outstandingAmount: 0, paymentStatus: 'paid' },
    { grandTotal: 500, outstandingAmount: 200, paymentStatus: 'partial' },
    { grandTotal: 800, outstandingAmount: 800, paymentStatus: 'unpaid' },
    { grandTotal: 300, outstandingAmount: null, paymentStatus: 'unknown' },
  ];

  const summary = computePaymentSummary(invoices);

  assert.deepEqual(summary, {
    paid: { count: 2, total: 3000 },
    partial: { count: 1, outstanding: 200 },
    unpaid: { count: 1, total: 800 },
    unknown: { count: 1, total: 300 },
    stillUnpaidTotal: 1000,
  });
});

test('computePaymentSummary returns an all-zero summary for an empty invoice list', () => {
  const summary = computePaymentSummary([]);

  assert.deepEqual(summary, {
    paid: { count: 0, total: 0 },
    partial: { count: 0, outstanding: 0 },
    unpaid: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
    stillUnpaidTotal: 0,
  });
});

test('computePaymentSummary excludes unknown invoices from stillUnpaidTotal', () => {
  const invoices = [{ grandTotal: 5000, outstandingAmount: null, paymentStatus: 'unknown' }];

  const summary = computePaymentSummary(invoices);

  assert.equal(summary.stillUnpaidTotal, 0);
  assert.equal(summary.unknown.total, 5000);
});
