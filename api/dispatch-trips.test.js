const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDatabase } = require('../test/helpers/postgres');
const { migrate } = require('../scripts/migrate');
const { createRepository } = require('../lib/dispatch/repository');

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

const tripsApi = optionalRequire('./dispatch-trips');
const serviceModule = optionalRequire('../lib/dispatch/service');
const statusMachine = optionalRequire('../lib/dispatch/status-machine');

const SESSION = Object.freeze({
  clerkId: 'clerk-trip-test',
  role: 'clerk',
  iat: 1787875200,
  exp: 1787904000,
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

async function seedResources(repository, suffix = '001') {
  const driver = await repository.createDriver({
    name: `Trip Driver ${suffix}`,
    licenseNo: `D-TRIP-${suffix}`,
  });
  const vehicle = await repository.createVehicle({
    registrationNo: `TRIP-LORRY-${suffix}`,
    description: 'Dispatch lorry',
  });
  return { driver, vehicle };
}

function requireTripsApi() {
  assert.ok(tripsApi, 'Task 5 trips API should exist');
  return tripsApi;
}

function requireService() {
  assert.ok(serviceModule, 'Task 5 transactional service should exist');
  return serviceModule;
}

test('trip status machine accepts only the explicit forward and cancellation transitions', () => {
  assert.ok(statusMachine, 'Task 5 status machine should exist');
  assert.equal(statusMachine.canTransitionTrip('planned', 'loading'), true);
  assert.equal(statusMachine.canTransitionTrip('loading', 'dispatched'), true);
  assert.equal(statusMachine.canTransitionTrip('dispatched', 'completed'), true);
  assert.equal(statusMachine.canTransitionTrip('planned', 'cancelled'), true);
  assert.equal(statusMachine.canTransitionTrip('loading', 'cancelled'), true);
  assert.equal(statusMachine.canTransitionTrip('completed', 'loading'), false);
  assert.equal(statusMachine.canTransitionTrip('cancelled', 'planned'), false);
  assert.throws(
    () => statusMachine.assertTripTransition('completed', 'planned'),
    (error) => error.code === 'invalid_transition',
  );
});

test('protected trip POST creates an active-resource trip, actor event, and revision one', async () => {
  const api = requireTripsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { driver, vehicle } = await seedResources(repository);
    const service = implementation.createDispatchService({ repository });
    const handler = api.createDispatchTripsHandler({
      service,
      getSession: async () => SESSION,
    });
    const response = responseRecorder();

    await handler(jsonRequest('POST', {
      trip_date: '2026-08-28',
      driver_id: driver.id,
      vehicle_id: vehicle.id,
      route_notes: 'North route',
      request_id: 'trip-create-active-001',
    }), response);

    assert.equal(response.statusCode, 201);
    assert.deepEqual({
      tripDate: response.body.trip.tripDate,
      driverId: response.body.trip.driverId,
      vehicleId: response.body.trip.vehicleId,
      routeNotes: response.body.trip.routeNotes,
      status: response.body.trip.status,
      revision: response.body.trip.revision,
    }, {
      tripDate: '2026-08-28',
      driverId: driver.id,
      vehicleId: vehicle.id,
      routeNotes: 'North route',
      status: 'planned',
      revision: 1,
    });
    assert.equal(Object.prototype.hasOwnProperty.call(response.body.trip, 'driver'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body.trip, 'lorry'), false);
    const events = await repository.listEvents({ tripId: response.body.trip.id });
    assert.deepEqual(events.map((event) => event.eventType), ['trip_created']);
    assert.equal(events[0].actor, SESSION.clerkId);
    assert.equal(events[0].requestId, 'trip-create-active-001');
  } finally {
    await database.close();
  }
});

test('trip creation rejects inactive driver or lorry without a row, event, or idempotency side effect', async () => {
  const api = requireTripsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { driver, vehicle } = await seedResources(repository, '002');
    await repository.updateDriver(driver.id, { active: false });
    const service = implementation.createDispatchService({ repository });
    const handler = api.createDispatchTripsHandler({ service, getSession: async () => SESSION });
    const response = responseRecorder();

    await handler(jsonRequest('POST', {
      trip_date: '2026-08-28',
      driver_id: driver.id,
      vehicle_id: vehicle.id,
      request_id: 'trip-inactive-driver-001',
    }), response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, 'invalid_request');
    assert.equal(JSON.stringify(response.body).includes('dispatch_drivers'), false);
    assert.equal((await repository.listEvents()).filter((event) => event.requestId === 'trip-inactive-driver-001').length, 0);
    assert.equal((await repository.listEvents()).filter((event) => event.eventType === 'trip_created').length, 0);
  } finally {
    await database.close();
  }
});

test('dispatch guard rejects a trip without an active assignment and leaves state unchanged', async () => {
  const api = requireTripsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { driver, vehicle } = await seedResources(repository, '002B');
    const service = implementation.createDispatchService({ repository });
    const handler = api.createDispatchTripsHandler({ service, getSession: async () => SESSION });
    const created = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_date: '2026-08-28', driver_id: driver.id, vehicle_id: vehicle.id,
      request_id: 'trip-dispatch-guard-create-001',
    }), created);
    const loading = responseRecorder();
    await handler(jsonRequest('PATCH', {
      trip_id: created.body.trip.id,
      status: 'loading',
      expected_revision: 1,
      request_id: 'trip-dispatch-guard-loading-001',
    }), loading);
    assert.equal(loading.statusCode, 200);
    const response = responseRecorder();
    await handler(jsonRequest('PATCH', {
      trip_id: created.body.trip.id,
      status: 'dispatched',
      expected_revision: 2,
      request_id: 'trip-dispatch-guard-fail-001',
    }), response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, 'invalid_request');
    assert.equal((await repository.getTrip(created.body.trip.id)).revision, 2);
    assert.deepEqual(
      (await repository.listEvents({ tripId: created.body.trip.id })).map((event) => event.eventType),
      ['trip_created', 'trip_status_changed'],
    );
    assert.equal((await database.pool.query(
      "SELECT count(*)::int AS count FROM dispatch_resource_idempotency WHERE request_id = 'trip-dispatch-guard-fail-001'",
    )).rows[0].count, 0);
  } finally {
    await database.close();
  }
});

test('dispatch guard evaluates replacement resources from the same revisioned update', async () => {
  const api = requireTripsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { driver, vehicle } = await seedResources(repository, '002C');
    const trip = await repository.createTrip({
      tripDate: '2026-08-28',
      driverId: driver.id,
      vehicleId: vehicle.id,
      routeNotes: 'Replacement resource route',
    });
    await repository.assignInvoice({
      tripId: trip.id,
      companyKey: 'enterprise',
      invoiceId: 'DISPATCH-REPLACEMENT',
      docNo: 'ENT-DISPATCH-REPLACEMENT',
      docDate: '2026-08-28',
      header: { invoiceId: 'DISPATCH-REPLACEMENT', docNo: 'ENT-DISPATCH-REPLACEMENT' },
      items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '1.000', uom: 'CTN' }],
    });
    await repository.updateDriver(driver.id, { active: false });
    const replacement = await repository.createDriver({ name: 'Replacement Driver', licenseNo: 'D-REPLACEMENT-002C' });
    const service = implementation.createDispatchService({ repository });
    const handler = api.createDispatchTripsHandler({ service, getSession: async () => SESSION });

    const loading = responseRecorder();
    await handler(jsonRequest('PATCH', {
      trip_id: trip.id, status: 'loading', expected_revision: 1,
      request_id: 'trip-replacement-loading-001',
    }), loading);
    assert.equal(loading.statusCode, 200);
    const dispatched = responseRecorder();
    await handler(jsonRequest('PATCH', {
      trip_id: trip.id, status: 'dispatched', driver_id: replacement.id,
      expected_revision: 2, request_id: 'trip-replacement-dispatch-001',
    }), dispatched);
    assert.equal(dispatched.statusCode, 200);
    assert.equal(dispatched.body.trip.driverId, replacement.id);
    assert.equal(dispatched.body.trip.vehicleId, vehicle.id);
    assert.equal(dispatched.body.trip.revision, 3);
  } finally {
    await database.close();
  }
});

test('trip PATCH requires the exact revision, increments it once, and rejects stale concurrent updates', async () => {
  const api = requireTripsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { driver, vehicle } = await seedResources(repository, '003');
    const service = implementation.createDispatchService({ repository });
    const createHandler = api.createDispatchTripsHandler({ service, getSession: async () => SESSION });
    const created = responseRecorder();
    await createHandler(jsonRequest('POST', {
      trip_date: '2026-08-28', driver_id: driver.id, vehicle_id: vehicle.id,
      request_id: 'trip-revision-create-001',
    }), created);
    const tripId = created.body.trip.id;

    const responses = await Promise.all([
      ['loading', 'trip-revision-loading-001'],
      ['cancelled', 'trip-revision-cancelled-001'],
    ].map(async ([status, requestId]) => {
      const response = responseRecorder();
      await createHandler(jsonRequest('PATCH', {
        trip_id: tripId,
        status,
        expected_revision: 1,
        request_id: requestId,
      }), response);
      return response;
    }));

    assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
    assert.equal(responses.filter((response) => response.statusCode === 409).length, 1);
    assert.equal(responses.find((response) => response.statusCode === 409).body.error.code, 'stale_trip');
    const current = await repository.getTrip(tripId);
    assert.equal(current.revision, 2);
    assert.ok(['loading', 'cancelled'].includes(current.status));
  } finally {
    await database.close();
  }
});

test('invalid trip transition has no revision, event, or idempotency side effect', async () => {
  const api = requireTripsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { driver, vehicle } = await seedResources(repository, '004');
    const service = implementation.createDispatchService({ repository });
    const handler = api.createDispatchTripsHandler({ service, getSession: async () => SESSION });
    const created = responseRecorder();
    await handler(jsonRequest('POST', {
      trip_date: '2026-08-28', driver_id: driver.id, vehicle_id: vehicle.id,
      request_id: 'trip-transition-create-001',
    }), created);
    const beforeEvents = await repository.listEvents({ tripId: created.body.trip.id });
    const response = responseRecorder();
    await handler(jsonRequest('PATCH', {
      trip_id: created.body.trip.id,
      status: 'completed',
      expected_revision: 1,
      request_id: 'trip-invalid-transition-001',
    }), response);

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error.code, 'invalid_transition');
    assert.equal((await repository.getTrip(created.body.trip.id)).revision, 1);
    assert.deepEqual(await repository.listEvents({ tripId: created.body.trip.id }), beforeEvents);
    assert.equal((await database.pool.query(
      "SELECT count(*)::int AS count FROM dispatch_resource_idempotency WHERE request_id = 'trip-invalid-transition-001'",
    )).rows[0].count, 0);
  } finally {
    await database.close();
  }
});

test('trip idempotent replay returns the original trip and conflicting request reuse is safe', async () => {
  const api = requireTripsApi();
  const implementation = requireService();
  const database = await createTestDatabase();
  try {
    await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
    const repository = createRepository(database.pool);
    const { driver, vehicle } = await seedResources(repository, '005');
    const service = implementation.createDispatchService({ repository });
    const handler = api.createDispatchTripsHandler({ service, getSession: async () => SESSION });
    const body = {
      trip_date: '2026-08-28', driver_id: driver.id, vehicle_id: vehicle.id,
      route_notes: 'Idempotent route', request_id: 'trip-idempotent-001',
    };
    const first = responseRecorder();
    await handler(jsonRequest('POST', body), first);
    const second = responseRecorder();
    await handler(jsonRequest('POST', body), second);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.deepEqual(second.body.trip, first.body.trip);
    assert.equal((await repository.listEvents({ tripId: first.body.trip.id })).length, 1);
    const idempotencyRow = await database.pool.query(
      `SELECT operation, resource_type
       FROM dispatch_resource_idempotency
       WHERE actor = $1 AND request_id = $2`,
      [SESSION.clerkId, body.request_id],
    );
    assert.deepEqual(idempotencyRow.rows, [{ operation: 'trip.create', resource_type: 'trip' }]);

    const conflict = responseRecorder();
    await handler(jsonRequest('POST', { ...body, route_notes: 'Changed route' }), conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal(JSON.stringify(conflict.body).includes('Changed route'), false);
  } finally {
    await database.close();
  }
});

test('trip GET is protected and returns parameterized, bounded trip data', async () => {
  const api = requireTripsApi();
  let called = false;
  const handler = api.createDispatchTripsHandler({
    service: { listTrips: async () => { called = true; return []; } },
    getSession: async () => null,
  });
  const response = responseRecorder();
  await handler({ method: 'GET', query: { startDate: '2026-08-28', endDate: '2026-08-28' }, headers: {} }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, 'unauthorized');
  assert.equal(called, false);
});

test('trip GET rejects an over-bound limit before reading the repository', async () => {
  let called = false;
  const handler = requireTripsApi().createDispatchTripsHandler({
    service: { listTrips: async () => { called = true; return []; } },
    getSession: async () => SESSION,
  });
  const response = responseRecorder();
  await handler({
    method: 'GET',
    query: { limit: '101' },
    headers: {},
  }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, 'invalid_request');
  assert.equal(called, false);
});
