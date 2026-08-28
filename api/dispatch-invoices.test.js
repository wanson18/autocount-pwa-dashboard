const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadCompanyConfigs, publicCompany } = require('../lib/autocount/company-config');
const { InvoiceAdapter, DuplicateInvoiceError } = require('../lib/dispatch/invoice-adapter');
const { createDispatchInvoicesHandler } = require('./dispatch-invoices');

const enterpriseFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'autocount-enterprise-invoices.json')),
);
const sdnBhdFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'autocount-sdn-bhd-invoices.json')),
);

const ENV = {
  AUTOCOUNT_API_URL: 'https://example.invalid',
  AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: 'enterprise-book-fixture',
  AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: 'sdn-bhd-book-fixture',
  AUTOCOUNT_KEY_ID_WANSON_ENTERPRISE: 'enterprise-key-fixture',
  AUTOCOUNT_API_KEY_WANSON_ENTERPRISE: 'enterprise-api-fixture',
  AUTOCOUNT_KEY_ID_WANSON_SDN_BHD: 'sdn-bhd-key-fixture',
  AUTOCOUNT_API_KEY_WANSON_SDN_BHD: 'sdn-bhd-api-fixture',
};

function fakeClient(pagesByCompany) {
  const calls = [];
  return {
    calls,
    async listInvoicePage(company, params) {
      calls.push({ company: company.companyKey, ...params });
      return pagesByCompany[company.companyKey][params.page - 1] || { data: [], totalCount: 0 };
    },
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      return this;
    },
  };
}

test('company config isolates both books and exposes only public company identity', () => {
  const configs = loadCompanyConfigs(ENV);

  assert.deepEqual(Object.keys(configs), ['enterprise', 'sdn_bhd']);
  assert.equal(configs.enterprise.accountBookId, 'enterprise-book-fixture');
  assert.equal(configs.sdn_bhd.accountBookId, 'sdn-bhd-book-fixture');
  assert.equal(configs.enterprise.apiKey, 'enterprise-api-fixture');
  assert.equal(configs.sdn_bhd.apiKey, 'sdn-bhd-api-fixture');
  assert.deepEqual(publicCompany(configs.enterprise), {
    companyKey: 'enterprise',
    name: 'Wanson Enterprise',
  });
  assert.deepEqual(publicCompany(configs.sdn_bhd), {
    companyKey: 'sdn_bhd',
    name: 'Wanson Enterprise (M) Sdn Bhd',
  });
  assert.equal(JSON.stringify(publicCompany(configs.enterprise)).includes('book'), false);
});

test('company config uses shared credentials only when both shared values exist', () => {
  const configs = loadCompanyConfigs({
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: 'enterprise-book-fixture',
    AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: 'sdn-bhd-book-fixture',
    AUTOCOUNT_API_KEY_ID: 'shared-key-fixture',
    AUTOCOUNT_API_KEY: 'shared-api-fixture',
  });

  assert.equal(configs.enterprise.keyId, 'shared-key-fixture');
  assert.equal(configs.sdn_bhd.apiKey, 'shared-api-fixture');
  assert.throws(
    () => loadCompanyConfigs({
      AUTOCOUNT_ACCOUNT_BOOK_WANSON_ENTERPRISE: 'enterprise-book-fixture',
      AUTOCOUNT_ACCOUNT_BOOK_WANSON_SDN_BHD: 'sdn-bhd-book-fixture',
      AUTOCOUNT_API_KEY_ID: 'shared-key-fixture',
    }),
    /shared AutoCount credentials/,
  );
});

test('adapter consumes all pages, excludes cancelled invoices, and keeps exact item decimals', async () => {
  const configs = loadCompanyConfigs(ENV);
  const client = fakeClient({
    enterprise: [enterpriseFixture],
    sdn_bhd: [{ data: [], totalCount: 0 }],
  });
  const adapter = new InvoiceAdapter(client);

  const invoices = await adapter.listInvoices(configs.enterprise, '2026-08-28', '2026-08-28');

  assert.equal(invoices.length, 1);
  assert.deepEqual(invoices[0], {
    companyKey: 'enterprise',
    invoiceId: 'enterprise-doc-001',
    docKey: 'enterprise-doc-001',
    docNo: 'ENT-SI-0001',
    docDate: '2026-08-28',
    customer: { code: 'ENT-CUST-001', name: 'Sanitized Enterprise Customer' },
    deliveryAddress: 'Sanitized Enterprise Delivery Address',
    cancelled: false,
    eligibility: 'eligible',
    items: [
      {
        itemCode: 'OIL-5KG',
        description: 'Cooking Oil 5KG',
        quantity: '2.125',
        uom: 'CTN',
      },
    ],
  });
  assert.deepEqual(
    client.calls.map(({ company, page, startDate, endDate }) => ({ company, page, startDate, endDate })),
    [{ company: 'enterprise', page: 1, startDate: '2026-08-28', endDate: '2026-08-28' }],
  );
});

test('adapter follows pagination until totalCount is reached', async () => {
  const configs = loadCompanyConfigs(ENV);
  const first = enterpriseFixture.data[0];
  const second = sdnBhdFixture.data[0];
  const client = fakeClient({
    enterprise: [
      { data: [first], totalCount: 2 },
      { data: [{ ...second, master: { ...second.master, docKey: 'enterprise-doc-002', docNo: 'ENT-SI-0003' } }], totalCount: 2 },
    ],
    sdn_bhd: [{ data: [], totalCount: 0 }],
  });

  const invoices = await new InvoiceAdapter(client).listInvoices(configs.enterprise, '2026-08-28', '2026-08-28');

  assert.deepEqual(invoices.map((invoice) => invoice.docNo), ['ENT-SI-0001', 'ENT-SI-0003']);
  assert.deepEqual(client.calls.map((call) => call.page), [1, 2]);
});

test('adapter rejects a duplicate docKey across pages instead of returning ambiguous identity', async () => {
  const configs = loadCompanyConfigs(ENV);
  const duplicate = enterpriseFixture.data[0];
  const client = fakeClient({
    enterprise: [
      { data: [duplicate], totalCount: 2 },
      { data: [duplicate], totalCount: 2 },
    ],
    sdn_bhd: [{ data: [], totalCount: 0 }],
  });

  await assert.rejects(
    () => new InvoiceAdapter(client).listInvoices(configs.enterprise, '2026-08-28', '2026-08-28'),
    (error) => error instanceof DuplicateInvoiceError && error.code === 'duplicate_doc_key',
  );
});

test('adapter marks a non-cancelled invoice without authoritative UOM as blocked', async () => {
  const configs = loadCompanyConfigs(ENV);
  const missingUom = {
    ...enterpriseFixture.data[0],
    master: { ...enterpriseFixture.data[0].master, docKey: 'enterprise-doc-missing-uom', docNo: 'ENT-SI-0002' },
    details: [{ ...enterpriseFixture.data[0].details[0], unit: undefined }],
  };
  const client = fakeClient({
    enterprise: [{ data: [missingUom], totalCount: 1 }],
    sdn_bhd: [{ data: [], totalCount: 0 }],
  });

  const [invoice] = await new InvoiceAdapter(client).listInvoices(configs.enterprise, '2026-08-28', '2026-08-28');

  assert.equal(invoice.eligibility, 'blocked_missing_uom');
  assert.equal(invoice.items[0].uom, null);
});

test('adapter enriches missing detail UOM from the documented product master', async () => {
  const configs = loadCompanyConfigs(ENV);
  const client = fakeClient({
    enterprise: [{ data: [{
      ...enterpriseFixture.data[0],
      master: { ...enterpriseFixture.data[0].master, docKey: 'enterprise-doc-product-uom' },
      details: [{ ...enterpriseFixture.data[0].details[0], unit: undefined }],
    }], totalCount: 1 }],
    sdn_bhd: [{ data: [], totalCount: 0 }],
  });
  client.getProduct = async () => ({ product: { productCode: 'OIL-5KG', unit: 'CTN' } });

  const [invoice] = await new InvoiceAdapter(client).listInvoices(configs.enterprise, '2026-08-28', '2026-08-28');

  assert.equal(invoice.items[0].uom, 'CTN');
  assert.equal(invoice.eligibility, 'eligible');
});

test('endpoint validates ISO dates before contacting AutoCount', async () => {
  let called = false;
  const handler = createDispatchInvoicesHandler({
    adapter: { listInvoices: async () => { called = true; return []; } },
    configs: loadCompanyConfigs(ENV),
  });
  const res = responseRecorder();

  await handler({ method: 'GET', query: { startDate: '2026-02-30', endDate: '2026-08-28', company: 'enterprise' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'invalid_request');
  assert.equal(called, false);
});

test('all endpoint returns mixed company invoices and source health', async () => {
  const configs = loadCompanyConfigs(ENV);
  const adapter = {
    async listInvoices(company) {
      if (company.companyKey === 'sdn_bhd') throw new Error('source unavailable');
      return [{ companyKey: 'enterprise', docKey: 'enterprise-doc-001' }];
    },
  };
  const handler = createDispatchInvoicesHandler({ adapter, configs });
  const res = responseRecorder();

  await handler({ method: 'GET', query: { startDate: '2026-08-28', endDate: '2026-08-28', company: 'all' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.invoices.length, 1);
  assert.equal(res.body.invoices[0].companyKey, 'enterprise');
  assert.deepEqual(res.body.sources.enterprise, { status: 'ok', invoiceCount: 1 });
  assert.deepEqual(res.body.sources.sdn_bhd, { status: 'unavailable', errorCode: 'source_unavailable' });
  assert.equal(JSON.stringify(res.body).includes('source unavailable'), false);
  assert.equal(JSON.stringify(res.body).includes('enterprise-book-fixture'), false);
});

test('single-company endpoint does not fetch the other company', async () => {
  const configs = loadCompanyConfigs(ENV);
  const seen = [];
  const handler = createDispatchInvoicesHandler({
    adapter: {
      async listInvoices(company) {
        seen.push(company.companyKey);
        return [];
      },
    },
    configs,
  });
  const res = responseRecorder();

  await handler({ method: 'GET', query: { startDate: '2026-08-28', endDate: '2026-08-28', company: 'sdn_bhd' } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, ['sdn_bhd']);
  assert.deepEqual(res.body.sources, { sdn_bhd: { status: 'ok', invoiceCount: 0 } });
});
