const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDatabase } = require('../test/helpers/postgres');
const { migrate } = require('../scripts/migrate');
const { createRepository } = require('../lib/dispatch/repository');
const { InvoiceAdapter } = require('../lib/dispatch/invoice-adapter');

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const assignmentsApi = optionalRequire('./dispatch-assignments');
const serviceModule = optionalRequire('../lib/dispatch/service');

const SESSION = Object.freeze({
  clerkId: 'clerk-assignment-test',
  role: 'clerk',
  iat: 1787875200,
  exp: 1787904000,
});

const COMPANY_CONFIGS = Object.freeze({
  enterprise: { companyKey: 'enterprise', name: 'Wanson Enterprise' },
  sdn_bhd: { companyKey: 'sdn_bhd', name: 'Wanson Enterprise (M) Sdn Bhd' },
});

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

function jsonRequest(method, body) {
  const encoded = JSON.stringify(body);
  return {
    method,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(encoded)),
    },
    body: encoded,
  };
}

function invoice({ companyKey, invoiceId, docNo, docDate = '2026-08-28', cancelled = false, items } = {}) {
  return {
    companyKey,
    invoiceId,
    docKey: invoiceId,
    docNo,
    docDate,
    customer: { code: `${companyKey}-customer`, name: `${companyKey} customer` },
    deliveryAddress: `${companyKey} delivery address`,
    cancelled,
    eligibility: items?.some((item) => !item.uom) ? 'blocked_missing_uom' : 'eligible',
    items: items || [{
      itemCode: 'OIL-5KG',
      description: 'Cooking Oil 5KG',
      quantity: '2.125',
      uom: 'CTN',
    }],
  };
}

async function seedTrip(repository, suffix = '001') {
  const driver = await repository.createDriver({ name: `Assignment Driver ${suffix}`, licenseNo: `D-ASN-${suffix}` });
  const vehicle = await repository.createVehicle({ registrationNo: `ASN-LORRY-${suffix}`, description: 'Dispatch lorry' });
  const trip = await repository.createTrip({
    tripDate: '2026-08-28', driverId: driver.id, vehicleId: vehicle.id, routeNotes: 'Assignment route',
  });
  return { trip, driver, vehicle };
}

function requireAssignmentsApi() {
  assert.ok(assignmentsApi, 'Task 5 assignments API should exist');
  return assignmentsApi;
}

function requireService() {
  assert.ok(serviceModule, 'Task 5 transactional service should exist');
  return serviceModule;
}

function createSource(invoicesByCompany, { calls = [], errorByCompany = {} } = {}) {
  return {
    calls,
    async getInvoice(company, invoiceId, docDate) {
      calls.push({ company: company.companyKey, accountBookId: company.accountBookId, invoiceId, docDate });
      if (errorByCompany[company.companyKey]) throw errorByCompany[company.companyKey];
      return (invoicesByCompany[company.companyKey] || []).find((row) => (
        row.invoiceId === invoiceId && row.docDate === docDate
      )) || null;
    },
  };
}

test('authoritative invoice adapter can refetch a cancelled document for assignment validation', async () => {
  const adapter = new InvoiceAdapter({
    async listInvoicePage() {
      return {
        totalCount: 1,
        data: [{
          master: {
            docKey: 'CANCELLED-ADAPTER',
            docNo: 'ENT-CANCELLED-ADAPTER',
            docDate: '2026-08-28',
            cancelled: true,
            debtorCode: 'C-ADAPTER',
            debtorName: 'Adapter Customer',
          },
          details: [{
            productCode: 'OIL-5KG',
            description: 'Cooking Oil 5KG',
            qty: '1.000',
            unit: 'CTN',
          }],
        }],
      };
    },
  });
  const result = await adapter.getInvoice(
    { companyKey: 'enterprise' },
    'CANCELLED-ADAPTER',
    '2026-08-28',
  );
  assert.equal(result.cancelled, true);
  assert.equal(result.invoiceId, 'CANCELLED-ADAPTER');
});

test('assignment POST accepts only server-owned invoice identity fields and creates a mixed-company same-trip snapshot', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository);
    const calls = [];
    const source = createSource({
      enterprise: [invoice({ companyKey: 'enterprise', invoiceId: 'ENT-001', docNo: 'ENT-SI-001' })],
      sdn_bhd: [invoice({ companyKey: 'sdn_bhd', invoiceId: 'SDN-001', docNo: 'SDN-SI-001', items: [{
        itemCode: 'AJINOMOTO', description: 'AJINOMOTO', quantity: '3.000', uom: 'CTN',
      }] })],
    }, { calls });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });

    const first = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'ENT-001', doc_no: 'ENT-SI-001',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-ent-001',
    }), first);
    assert.equal(first.statusCode, 201);
    assert.equal(first.body.assignment.companyKey, 'enterprise');
    assert.equal(first.body.assignment.items[0].quantity, '2.125');

    const second = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'sdn_bhd', invoice_id: 'SDN-001', doc_no: 'SDN-SI-001',
      doc_date: '2026-08-28', expected_trip_revision: 2, request_id: 'assignment-sdn-001',
    }), second);
    assert.equal(second.statusCode, 201);
    assert.equal(second.body.assignment.companyKey, 'sdn_bhd');
    assert.equal((await repository.getTrip(trip.id)).revision, 3);
    assert.deepEqual(calls.map((call) => call.company), ['enterprise', 'sdn_bhd']);
    assert.deepEqual((await repository.listEvents({ tripId: trip.id })).map((event) => event.eventType), ['assigned', 'assigned']);
    assert.ok((await repository.listEvents({ tripId: trip.id })).every((event) => event.actor === SESSION.clerkId));
  } finally {
    await database.close();
  }
});

test('assignment rejects extra client authoritative fields and never uses a submitted actor', async () => {
  const api = requireAssignmentsApi();
  let called = false;
  const handler = api.createDispatchAssignmentsHandler({
    service: { assignInvoice: async () => { called = true; return null; } },
    getSession: async () => SESSION,
  });
  const response = responseRecorder();
  await handler(jsonRequest('POST', {
    trip_id: 1,
    company_key: 'enterprise',
    invoice_id: 'ENT-EXTRA',
    doc_no: 'ENT-EXTRA',
    doc_date: '2026-08-28',
    expected_trip_revision: 1,
    request_id: 'assignment-extra-001',
    actor: 'attacker',
    lines: [{ itemCode: 'FORGED', quantity: '999', uom: 'KG' }],
  }), response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, 'invalid_request');
  assert.equal(called, false);
  assert.equal(JSON.stringify(response.body).includes('attacker'), false);
});

test('assignment GET and PATCH stay protected and reject extra mutation fields', async () => {
  let called = false;
  const service = {
    listAssignments: async () => { called = true; return []; },
    updateAssignmentStatus: async () => { called = true; return null; },
  };
  const protectedHandler = requireAssignmentsApi().createDispatchAssignmentsHandler({
    service,
    getSession: async () => null,
  });
  const protectedResponse = responseRecorder();
  await protectedHandler({ method: 'GET', query: {}, headers: {} }, protectedResponse);
  assert.equal(protectedResponse.statusCode, 401);
  assert.equal(protectedResponse.body.error.code, 'unauthorized');
  assert.equal(called, false);

  const authenticatedHandler = requireAssignmentsApi().createDispatchAssignmentsHandler({
    service,
    getSession: async () => SESSION,
  });
  const extraFieldResponse = responseRecorder();
  await authenticatedHandler(jsonRequest('PATCH', {
    assignment_id: 1,
    operation: 'remove',
    expected_trip_revision: 1,
    request_id: 'assignment-patch-extra-001',
    actor: 'attacker',
  }), extraFieldResponse);
  assert.equal(extraFieldResponse.statusCode, 400);
  assert.equal(extraFieldResponse.body.error.code, 'invalid_request');
  assert.equal(called, false);
});

test('assignment source refetch is company-isolated and verifies invoice identity, document fields, and boolean cancellation', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '002');
    const calls = [];
    const source = createSource({
      enterprise: [invoice({ companyKey: 'sdn_bhd', invoiceId: 'ENT-MISMATCH', docNo: 'SOURCE-DOC' })],
      sdn_bhd: [invoice({ companyKey: 'sdn_bhd', invoiceId: 'SAME-ID', docNo: 'SDN-SAME' })],
    }, { calls });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const response = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'ENT-MISMATCH', doc_no: 'ENT-MISMATCH',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-identity-001',
    }), response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.error.code, 'source_unavailable');
    assert.equal(JSON.stringify(response.body).includes('SOURCE-DOC'), false);
    assert.equal(JSON.stringify(response.body).includes('sdn_bhd'), false);
    assert.deepEqual(calls.map((call) => call.company), ['enterprise']);
    assert.equal((await repository.getTrip(trip.id)).revision, 1);
    assert.equal((await repository.listEvents({ tripId: trip.id })).length, 0);
  } finally {
    await database.close();
  }
});

test('cancelled, missing-UOM, incomplete, and unavailable source invoices fail with stable redacted errors', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '003');
    const source = createSource({
      enterprise: [
        invoice({ companyKey: 'enterprise', invoiceId: 'CANCELLED', docNo: 'ENT-CANCELLED', cancelled: true }),
        invoice({ companyKey: 'enterprise', invoiceId: 'MISSING-UOM', docNo: 'ENT-MISSING', items: [{
          itemCode: 'OIL-5KG', description: 'Cooking Oil', quantity: '2.000', uom: null,
        }] }),
        invoice({ companyKey: 'enterprise', invoiceId: 'EMPTY-LINES', docNo: 'ENT-EMPTY', items: [] }),
      ],
    });
    const service = implementation.createDispatchService({
      repository,
      invoiceAdapter: source,
      configs: COMPANY_CONFIGS,
    });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const cases = [
      ['CANCELLED', 'ENT-CANCELLED', 'invoice_cancelled', 'assignment-cancelled-001'],
      ['MISSING-UOM', 'ENT-MISSING', 'invoice_missing_uom', 'assignment-uom-001'],
      ['EMPTY-LINES', 'ENT-EMPTY', 'source_unavailable', 'assignment-empty-001'],
    ];
    for (const [invoiceId, docNo, code, requestId] of cases) {
      const response = responseRecorder();
      await handler(jsonRequest('POST', {
        trip_id: trip.id, company_key: 'enterprise', invoice_id: invoiceId, doc_no: docNo,
        doc_date: '2026-08-28', expected_trip_revision: 1, request_id: requestId,
      }), response);
      assert.equal(response.statusCode, code === 'invoice_missing_uom' ? 422 : code === 'source_unavailable' ? 503 : 409);
      assert.equal(response.body.error.code, code);
      assert.equal(JSON.stringify(response.body).includes('ENT-'), false);
      assert.equal(JSON.stringify(response.body).includes('Cooking Oil'), false);
    }

    const unavailableSource = createSource({}, {
      errorByCompany: { enterprise: Object.assign(new Error('provider payload secret'), { code: 'ECONNRESET' }) },
    });
    const unavailableService = implementation.createDispatchService({ repository, invoiceAdapter: unavailableSource, configs: COMPANY_CONFIGS });
    const unavailableHandler = api.createDispatchAssignmentsHandler({ service: unavailableService, getSession: async () => SESSION });
    const unavailable = responseRecorder();
    await unavailableHandler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'OUTAGE', doc_no: 'ENT-OUTAGE',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-outage-001',
    }), unavailable);
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.body.error.code, 'source_unavailable');
    assert.equal(JSON.stringify(unavailable.body).includes('provider payload secret'), false);
    assert.equal((await repository.getTrip(trip.id)).revision, 1);
  } finally {
    await database.close();
  }
});

test('same invoice ID is distinct across companies but cannot be actively assigned twice within one company', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '004');
    const source = createSource({
      enterprise: [invoice({ companyKey: 'enterprise', invoiceId: 'SHARED-ID', docNo: 'ENT-SHARED' })],
      sdn_bhd: [invoice({ companyKey: 'sdn_bhd', invoiceId: 'SHARED-ID', docNo: 'SDN-SHARED' })],
    });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const first = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'SHARED-ID', doc_no: 'ENT-SHARED',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-shared-ent-001',
    }), first);
    const otherCompany = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'sdn_bhd', invoice_id: 'SHARED-ID', doc_no: 'SDN-SHARED',
      doc_date: '2026-08-28', expected_trip_revision: 2, request_id: 'assignment-shared-sdn-001',
    }), otherCompany);
    assert.equal(first.statusCode, 201);
    assert.equal(otherCompany.statusCode, 201);

    const duplicate = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'SHARED-ID', doc_no: 'ENT-SHARED',
      doc_date: '2026-08-28', expected_trip_revision: 3, request_id: 'assignment-shared-ent-002',
    }), duplicate);
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.error.code, 'invoice_already_assigned');
    assert.equal((await repository.listEvents({ tripId: trip.id })).length, 2);
  } finally {
    await database.close();
  }
});

test('same invoice and same trip revision races produce one durable success without duplicate rows', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '005');
    const source = createSource({ enterprise: [invoice({ companyKey: 'enterprise', invoiceId: 'RACE', docNo: 'ENT-RACE' })] });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const responses = await Promise.all([1, 2].map(async (index) => {
      const response = responseRecorder();
      await handler(jsonRequest('POST', {
        trip_id: trip.id, company_key: 'enterprise', invoice_id: 'RACE', doc_no: 'ENT-RACE',
        doc_date: '2026-08-28', expected_trip_revision: 1, request_id: `assignment-race-00${index}`,
      }), response);
      return response;
    }));
    assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
    assert.equal(responses.filter((response) => response.statusCode === 409).length, 1);
    assert.ok(['invoice_already_assigned', 'stale_trip'].includes(
      responses.find((response) => response.statusCode === 409).body.error.code,
    ));
    assert.equal((await database.pool.query(
      "SELECT count(*)::int AS count FROM delivery_assignments WHERE company_key = 'enterprise' AND invoice_id = 'RACE' AND status <> 'removed'",
    )).rows[0].count, 1);
    assert.equal((await repository.getTrip(trip.id)).revision, 2);
  } finally {
    await database.close();
  }
});

test('assignment idempotent replay creates one event and conflicting reuse returns a safe 409', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '006');
    const source = createSource({ enterprise: [invoice({ companyKey: 'enterprise', invoiceId: 'IDEMPOTENT', docNo: 'ENT-IDEMPOTENT' })] });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const body = {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'IDEMPOTENT', doc_no: 'ENT-IDEMPOTENT',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-idempotent-001',
    };
    const first = responseRecorder();
    await handler(jsonRequest('POST', body), first);
    const replay = responseRecorder();
    await handler(jsonRequest('POST', body), replay);
    assert.equal(first.statusCode, 201);
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.body.assignment, first.body.assignment);
    assert.equal((await repository.listEvents({ assignmentId: first.body.assignment.id })).length, 1);

    const conflict = responseRecorder();
    await handler(jsonRequest('POST', { ...body, doc_no: 'ENT-OTHER' }), conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal(JSON.stringify(conflict.body).includes('ENT-OTHER'), false);
  } finally {
    await database.close();
  }
});

test('assignment snapshot line failure rolls back header, items, trip revision, event, and idempotency row', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '006B');
    const source = createSource({ enterprise: [invoice({
      companyKey: 'enterprise', invoiceId: 'ROLLBACK', docNo: 'ENT-ROLLBACK',
      items: [
        { itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' },
        { itemCode: 'OIL-1KG', description: 'Cooking Oil 1KG', quantity: '0.375', uom: 'CTN' },
      ],
    })] });
    const originalInsert = repository.insertAssignmentItem;
    let lineCount = 0;
    repository.insertAssignmentItem = async function insertAssignmentItemWithFailure(...args) {
      lineCount += 1;
      if (lineCount === 2) {
        const error = new Error('injected snapshot line failure');
        error.code = 'snapshot_line_failure';
        throw error;
      }
      return originalInsert.apply(this, args);
    };
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const response = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'ROLLBACK', doc_no: 'ENT-ROLLBACK',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-rollback-001',
    }), response);

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error.code, 'internal_error');
    assert.equal((await database.pool.query(
      "SELECT count(*)::int AS count FROM delivery_assignments WHERE invoice_id = 'ROLLBACK'",
    )).rows[0].count, 0);
    assert.equal((await database.pool.query(
      "SELECT count(*)::int AS count FROM delivery_assignment_items WHERE item_code IN ('OIL-5KG', 'OIL-1KG')",
    )).rows[0].count, 0);
    assert.equal((await repository.getTrip(trip.id)).revision, 1);
    assert.equal((await repository.listEvents({ tripId: trip.id })).length, 0);
    assert.equal((await database.pool.query(
      "SELECT count(*)::int AS count FROM dispatch_resource_idempotency WHERE request_id = 'assignment-rollback-001'",
    )).rows[0].count, 0);
    repository.insertAssignmentItem = originalInsert;
  } finally {
    await database.close();
  }
});

test('assignment status transitions, move, remove, and delivered protection update revisions and event history', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const firstTrip = await seedTrip(repository, '007');
    const secondTrip = await seedTrip(repository, '008');
    const source = createSource({ enterprise: [
      invoice({ companyKey: 'enterprise', invoiceId: 'MOVE', docNo: 'ENT-MOVE' }),
      invoice({ companyKey: 'enterprise', invoiceId: 'DELIVERED', docNo: 'ENT-DELIVERED' }),
    ] });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const assign = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: firstTrip.trip.id, company_key: 'enterprise', invoice_id: 'MOVE', doc_no: 'ENT-MOVE',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-move-create-001',
    }), assign);
    assert.equal(assign.statusCode, 201);
    const assignmentId = assign.body.assignment.id;

    const loaded = responseRecorder();
    await handler(jsonRequest('PATCH', {
      assignment_id: assignmentId, operation: 'status', status: 'loaded',
      expected_trip_revision: 2, request_id: 'assignment-status-loaded-001',
    }), loaded);
    assert.equal(loaded.statusCode, 200);
    const moved = responseRecorder();
    await handler(jsonRequest('PATCH', {
      assignment_id: assignmentId, operation: 'move', trip_id: secondTrip.trip.id,
      expected_trip_revision: 1, request_id: 'assignment-move-001',
    }), moved);
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.body.assignment.tripId, secondTrip.trip.id);

    const invalid = responseRecorder();
    await handler(jsonRequest('PATCH', {
      assignment_id: assignmentId, operation: 'status', status: 'assigned',
      expected_trip_revision: 2, request_id: 'assignment-invalid-status-001',
    }), invalid);
    assert.equal(invalid.statusCode, 409);
    assert.equal(invalid.body.error.code, 'invalid_transition');

    const removed = responseRecorder();
    await handler(jsonRequest('PATCH', {
      assignment_id: assignmentId, operation: 'remove',
      expected_trip_revision: 2, request_id: 'assignment-remove-001',
    }), removed);
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.body.assignment.status, 'removed');

    const deliveredSource = createSource({ enterprise: [invoice({ companyKey: 'enterprise', invoiceId: 'DELIVERED', docNo: 'ENT-DELIVERED' })] });
    const deliveredService = implementation.createDispatchService({ repository, invoiceAdapter: deliveredSource, configs: COMPANY_CONFIGS });
    const deliveredHandler = api.createDispatchAssignmentsHandler({ service: deliveredService, getSession: async () => SESSION });
    const delivered = responseRecorder();
    await deliveredHandler(jsonRequest('POST', {
      trip_id: firstTrip.trip.id, company_key: 'enterprise', invoice_id: 'DELIVERED', doc_no: 'ENT-DELIVERED',
      doc_date: '2026-08-28', expected_trip_revision: 4, request_id: 'assignment-delivered-create-001',
    }), delivered);
    assert.equal(delivered.statusCode, 201);
    const deliveredId = delivered.body.assignment.id;
    for (const [status, requestId] of [['loaded', 'assignment-delivered-loaded-001'], ['out_for_delivery', 'assignment-delivered-out-001'], ['delivered', 'assignment-delivered-done-001']]) {
      const response = responseRecorder();
      await deliveredHandler(jsonRequest('PATCH', {
        assignment_id: deliveredId, operation: 'status', status,
        expected_trip_revision: status === 'loaded' ? 5 : status === 'out_for_delivery' ? 6 : 7,
        request_id: requestId,
      }), response);
      assert.equal(response.statusCode, 200);
    }
    const protectedResponse = responseRecorder();
    await deliveredHandler(jsonRequest('PATCH', {
      assignment_id: deliveredId, operation: 'remove', expected_trip_revision: 8,
      request_id: 'assignment-delivered-remove-001',
    }), protectedResponse);
    assert.equal(protectedResponse.statusCode, 409);
    assert.equal(protectedResponse.body.error.code, 'invalid_transition');
    const events = await repository.listEvents({ assignmentId: deliveredId });
    assert.deepEqual(events.map((event) => event.eventType), ['assigned', 'status_changed', 'status_changed', 'status_changed']);
    assert.equal(events[1].payload.fromStatus, 'assigned');
    assert.equal(events[1].payload.toStatus, 'loaded');
    assert.equal(events.at(-1).payload.toStatus, 'delivered');
  } finally {
    await database.close();
  }
});

test('non-weight UOMs do not become capacity or lorry-weight calculations', async () => {
  const api = requireAssignmentsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { trip } = await seedTrip(repository, '009');
    const source = createSource({ enterprise: [invoice({
      companyKey: 'enterprise', invoiceId: 'CTN-ONLY', docNo: 'ENT-CTN-ONLY',
      items: [{ itemCode: 'AJINOMOTO', description: 'AJINOMOTO', quantity: '999999', uom: 'CTN' }],
    })] });
    const service = implementation.createDispatchService({ repository, invoiceAdapter: source, configs: COMPANY_CONFIGS });
    const handler = api.createDispatchAssignmentsHandler({ service, getSession: async () => SESSION });
    const response = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_id: trip.id, company_key: 'enterprise', invoice_id: 'CTN-ONLY', doc_no: 'ENT-CTN-ONLY',
      doc_date: '2026-08-28', expected_trip_revision: 1, request_id: 'assignment-ctn-only-001',
    }), response);
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.assignment.items[0].uom, 'CTN');
    assert.equal(response.body.assignment.items[0].quantity, '999999');
    assert.equal(Object.prototype.hasOwnProperty.call(response.body.assignment, 'weightKg'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body.assignment, 'capacityUsed'), false);
  } finally {
    await database.close();
  }
});
