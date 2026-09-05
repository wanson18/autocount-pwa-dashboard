const test = require('node:test');
const assert = require('node:assert/strict');

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const loadingSheet = optionalRequire('../lib/dispatch/loading-sheet');
const loadingApi = optionalRequire('./dispatch-loading-sheet');

function requireLoadingSheet() {
  assert.ok(loadingSheet, 'loading-sheet domain module should exist');
  return loadingSheet;
}

function responseRecorder() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end(value) { if (value !== undefined) this.body = value; return this; },
  };
}

function tripFixture() {
  return {
    id: 77,
    tripDate: '2026-08-28',
    status: 'loading',
    routeNotes: 'North <route>',
    driver: { id: 4, name: 'Aiman Driver', licenseNo: 'D-004', phone: '012' },
    lorry: { id: 9, registrationNo: 'WXY 1001', description: '10 tonne' },
    assignments: [
      {
        id: 101,
        companyKey: 'enterprise',
        invoiceId: 'shared-invoice',
        docNo: 'ENT-001',
        docDate: '2026-08-28',
        status: 'assigned',
        assignedAt: '2026-08-27T16:00:00.000Z',
        updatedAt: '2026-08-27T16:05:00.000Z',
        header: {
          companyKey: 'enterprise',
          invoiceId: 'shared-invoice',
          docNo: 'ENT-001',
          docDate: '2026-08-28',
          customer: { code: 'E-001', name: 'Enterprise <Customer>' },
          price: '999999.99',
        },
        items: [
          { itemCode: 'OIL-5KG', description: 'Cooking Oil', uom: 'CTN', quantity: '0.10' },
          { itemCode: 'OIL-5KG', description: 'Different description', uom: 'CTN', quantity: '0.20' },
          { itemCode: 'OIL-5KG', description: 'Cooking Oil', uom: 'UNIT', quantity: '100' },
        ],
      },
      {
        id: 102,
        companyKey: 'sdn_bhd',
        invoiceId: 'shared-invoice',
        docNo: 'SDN-001',
        docDate: '2026-08-28',
        status: 'returned',
        assignedAt: '2026-08-27T17:00:00.000Z',
        updatedAt: '2026-08-27T17:05:00.000Z',
        header: {
          companyKey: 'sdn_bhd',
          invoiceId: 'shared-invoice',
          docNo: 'SDN-001',
          docDate: '2026-08-28',
          customer: { code: 'S-001', name: 'Sdn Customer' },
        },
        items: [
          { itemCode: 'OIL-5KG', description: 'Cooking Oil', uom: 'CTN', quantity: '3.000' },
          { itemCode: 'AJINOMOTO', description: 'AJINOMOTO', uom: 'CTN', quantity: '2' },
        ],
      },
      {
        id: 103,
        companyKey: 'enterprise',
        invoiceId: 'removed-invoice',
        docNo: 'ENT-REMOVED',
        docDate: '2026-08-28',
        status: 'removed',
        header: { customer: { code: 'E-REMOVED', name: 'Removed Customer' } },
        items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil', uom: 'CTN', quantity: '999' }],
      },
    ],
  };
}

test('loading sheet groups exact item code and UOM pairs with exact decimal strings', () => {
  const { buildLoadingSheet } = requireLoadingSheet();
  const sheet = buildLoadingSheet(tripFixture());

  assert.deepEqual(sheet.counts, { enterprise: 1, sdn_bhd: 1, total: 2 });
  assert.deepEqual(sheet.items, [
    { itemCode: 'AJINOMOTO', description: 'AJINOMOTO', uom: 'CTN', enterprise: '0', sdn_bhd: '2', total: '2' },
    { itemCode: 'OIL-5KG', description: 'Cooking Oil', uom: 'CTN', enterprise: '0.30', sdn_bhd: '3.000', total: '3.300' },
    { itemCode: 'OIL-5KG', description: 'Cooking Oil', uom: 'UNIT', enterprise: '100', sdn_bhd: '0', total: '100' },
  ]);
  assert.equal(JSON.stringify(sheet).includes('999999.99'), false, 'prices must not cross the loading-sheet boundary');
  assert.equal(sheet.invoices.some((invoice) => invoice.invoiceId === 'removed-invoice'), false);
});

test('loading sheet keeps same invoice numbers distinct by company and excludes only removed assignments', () => {
  const { buildLoadingSheet } = requireLoadingSheet();
  const sheet = buildLoadingSheet(tripFixture());

  assert.deepEqual(sheet.invoices.map((invoice) => [invoice.companyKey, invoice.invoiceId]), [
    ['enterprise', 'shared-invoice'],
    ['sdn_bhd', 'shared-invoice'],
  ]);
  assert.deepEqual(sheet.invoices.map((invoice) => invoice.status), ['assigned', 'returned']);
  assert.equal(sheet.invoices[0].customer.name, 'Enterprise <Customer>');
  assert.equal(sheet.trip.routeNotes, 'North <route>');
});

test('loading sheet reads persisted trip snapshots without a live invoice source and remains stable', async () => {
  const { loadLoadingSheet } = requireLoadingSheet();
  const trip = tripFixture();
  const persistedSnapshot = structuredClone(trip);
  let sourceCalls = 0;
  const repository = {
    async getTripDetails(tripId) {
      assert.equal(tripId, 77);
      return structuredClone(persistedSnapshot);
    },
  };
  const first = await loadLoadingSheet(repository, 77);
  trip.assignments[0].header.customer.name = 'Changed source customer';
  trip.assignments[0].items[0].quantity = '1000000';
  const second = await loadLoadingSheet(repository, 77, {
    source: { async getInvoice() { sourceCalls += 1; } },
  });

  assert.deepEqual(second, first);
  assert.equal(sourceCalls, 0);
});

test('loading sheet API requires one positive trip id, authenticates before repository access, and returns 404', async () => {
  assert.ok(loadingApi, 'loading-sheet API should exist');
  assert.equal(typeof loadingApi.createDispatchLoadingSheetHandler, 'function');
  const calls = [];
  const repository = {
    async getTripDetails(id) { calls.push(id); return null; },
  };
  const handler = loadingApi.createDispatchLoadingSheetHandler({
    repository,
    getSession: async () => ({ clerkId: 'clerk-1' }),
  });
  const invalid = responseRecorder();
  await handler({ method: 'GET', query: { trip_id: ['77', '78'] } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 0);

  const missing = responseRecorder();
  await handler({ method: 'GET', query: { trip_id: '77' } }, missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(calls.length, 1);
  assert.equal(missing.headers['Cache-Control'], 'no-store');
});

test('loading sheet API rejects unknown fields and unsupported methods without data access', async () => {
  assert.ok(loadingApi, 'loading-sheet API should exist');
  let reads = 0;
  const handler = loadingApi.createDispatchLoadingSheetHandler({
    repository: { async getTripDetails() { reads += 1; return tripFixture(); } },
    getSession: async () => ({ clerkId: 'clerk-1' }),
  });
  const unknown = responseRecorder();
  await handler({ method: 'GET', query: { trip_id: '77', extra: 'reject-me' } }, unknown);
  assert.equal(unknown.statusCode, 400);
  assert.equal(reads, 0);

  const post = responseRecorder();
  await handler({ method: 'POST', query: { trip_id: '77' } }, post);
  assert.equal(post.statusCode, 405);
  assert.equal(reads, 0);

  const unauthorized = responseRecorder();
  const protectedHandler = loadingApi.createDispatchLoadingSheetHandler({
    repository: { async getTripDetails() { throw new Error('must not read'); } },
    getSession: async () => null,
  });
  await protectedHandler({ method: 'GET', query: { trip_id: '77' } }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
});
