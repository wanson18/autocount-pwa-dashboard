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

const resourcesApi = optionalRequire('./dispatch-resources');

const SESSION = Object.freeze({
  clerkId: 'clerk-aiman',
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

function jsonRequest(method, body, contentType = 'application/json') {
  const encoded = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method,
    headers: {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(encoded)),
    },
    body: encoded,
  };
}

let database;
let repository;
let handler;
let actorCalls;

test.before(async () => {
  if (!resourcesApi) return;
  database = await createTestDatabase();
  await migrate({ pool: database.pool, skipAdvisoryLock: database.embedded });
  repository = createRepository(database.pool);
  actorCalls = [];
  const repositoryWithActorEvidence = {
    listDrivers: (options) => repository.listDrivers(options),
    listVehicles: (options) => repository.listVehicles(options),
    createDriver: async (payload) => {
      actorCalls.push({ type: 'driver', actor: payload.actor });
      return repository.createDriver(payload);
    },
    createVehicle: async (payload) => {
      actorCalls.push({ type: 'lorry', actor: payload.actor });
      return repository.createVehicle(payload);
    },
    updateDriver: async (id, payload) => {
      actorCalls.push({ type: 'driver', actor: payload.actor });
      return repository.updateDriver(id, payload);
    },
    updateVehicle: async (id, payload) => {
      actorCalls.push({ type: 'lorry', actor: payload.actor });
      return repository.updateVehicle(id, payload);
    },
  };
  handler = resourcesApi.createDispatchResourcesHandler({
    repository: repositoryWithActorEvidence,
    getSession: async () => SESSION,
  });
});

test.after(async () => {
  if (database) await database.close();
});

test('resource API creates driver and lorry records through the database repository', async () => {
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const driverRes = responseRecorder();
  await handler(jsonRequest('POST', {
    type: 'driver',
    name: 'Aiman Driver',
    licenseNo: 'D-RESOURCE-001',
    phone: '0123456789',
    assigned_by: 'attacker-supplied-actor',
  }), driverRes);

  assert.equal(driverRes.statusCode, 400);
  assert.equal(driverRes.body.error.code, 'invalid_request');
  assert.equal(actorCalls.length, 0);

  const validDriverRes = responseRecorder();
  await handler(jsonRequest('POST', {
    type: 'driver',
    name: 'Aiman Driver',
    licenseNo: 'D-RESOURCE-001',
    phone: '0123456789',
    request_id: 'resource-create-driver-001',
  }), validDriverRes);
  assert.equal(validDriverRes.statusCode, 201);
  assert.equal(validDriverRes.body.resource.type, 'driver');
  assert.equal(validDriverRes.body.resource.name, 'Aiman Driver');
  assert.equal(validDriverRes.body.resource.active, true);
  assert.equal(actorCalls.at(-1).actor, SESSION.clerkId);
  const driverEvents = await repository.listEvents();
  assert.ok(driverEvents.some((event) => (
    event.eventType === 'driver_created'
    && event.actor === SESSION.clerkId
    && event.payload.driverId === validDriverRes.body.resource.id
  )));

  const lorryRes = responseRecorder();
  await handler(jsonRequest('POST', {
    type: 'lorry',
    registrationNo: 'WXY-RESOURCE-001',
    description: '10-ton lorry',
    request_id: 'resource-create-lorry-001',
  }), lorryRes);
  assert.equal(lorryRes.statusCode, 201);
  assert.equal(lorryRes.body.resource.type, 'lorry');
  assert.equal(lorryRes.body.resource.registrationNo, 'WXY-RESOURCE-001');
  assert.equal(actorCalls.at(-1).actor, SESSION.clerkId);
  const lorryEvents = await repository.listEvents();
  assert.ok(lorryEvents.some((event) => (
    event.eventType === 'lorry_created'
    && event.actor === SESSION.clerkId
    && event.payload.vehicleId === lorryRes.body.resource.id
  )));
});

test('resource GET supports active-only and all-resource views', async () => {
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const allBeforeRes = responseRecorder();
  await handler({ method: 'GET', query: { active: 'all' }, headers: {} }, allBeforeRes);
  assert.equal(allBeforeRes.statusCode, 200);
  assert.equal(allBeforeRes.body.drivers.length, 1);
  assert.equal(allBeforeRes.body.lorries.length, 1);

  const driverId = allBeforeRes.body.drivers[0].id;
  const deactivateRes = responseRecorder();
  await handler(jsonRequest('PATCH', {
    type: 'driver',
    id: driverId,
    active: false,
    request_id: 'resource-deactivate-driver-001',
  }), deactivateRes);
  assert.equal(deactivateRes.statusCode, 200);
  assert.equal(deactivateRes.body.resource.active, false);
  const deactivationEvents = await repository.listEvents();
  assert.ok(deactivationEvents.some((event) => (
    event.eventType === 'driver_deactivated'
    && event.actor === SESSION.clerkId
    && event.payload.driverId === driverId
  )));

  const activeRes = responseRecorder();
  await handler({ method: 'GET', query: { active: 'true' }, headers: {} }, activeRes);
  assert.equal(activeRes.statusCode, 200);
  assert.deepEqual(activeRes.body.drivers, []);

  const allAfterRes = responseRecorder();
  await handler({ method: 'GET', query: { active: 'all' }, headers: {} }, allAfterRes);
  assert.equal(allAfterRes.body.drivers[0].active, false);

  const reactivateRes = responseRecorder();
  await handler(jsonRequest('PATCH', {
    type: 'driver',
    id: driverId,
    active: true,
    request_id: 'resource-reactivate-driver-001',
  }), reactivateRes);
  assert.equal(reactivateRes.statusCode, 200);
  assert.equal(reactivateRes.body.resource.active, true);
  assert.equal(actorCalls.at(-1).actor, SESSION.clerkId);
  const reactivationEvents = await repository.listEvents();
  assert.ok(reactivationEvents.some((event) => (
    event.eventType === 'driver_reactivated'
    && event.actor === SESSION.clerkId
    && event.payload.driverId === driverId
  )));
});

test('duplicate resource identities return a safe 409 without provider details', async () => {
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const duplicateRes = responseRecorder();
  await handler(jsonRequest('POST', {
    type: 'driver',
    name: 'Duplicate Driver',
    licenseNo: 'D-RESOURCE-001',
    request_id: 'resource-duplicate-driver-001',
  }), duplicateRes);

  assert.equal(duplicateRes.statusCode, 409);
  assert.equal(duplicateRes.body.error.code, 'resource_conflict');
  assert.equal(JSON.stringify(duplicateRes.body).includes('23505'), false);
  assert.equal(JSON.stringify(duplicateRes.body).includes('dispatch_drivers'), false);
});

test('resource API rejects invalid methods, query values, content types, and authoritative body fields', async () => {
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const deleteRes = responseRecorder();
  await handler({ method: 'DELETE', headers: {} }, deleteRes);
  assert.equal(deleteRes.statusCode, 405);
  assert.equal(deleteRes.body.error.code, 'method_not_allowed');

  const queryRes = responseRecorder();
  await handler({ method: 'GET', query: { active: 'sometimes' }, headers: {} }, queryRes);
  assert.equal(queryRes.statusCode, 400);
  assert.equal(queryRes.body.error.code, 'invalid_request');

  const contentTypeRes = responseRecorder();
  await handler(jsonRequest('POST', { type: 'lorry', registrationNo: 'BAD-TYPE' }, 'text/plain'), contentTypeRes);
  assert.equal(contentTypeRes.statusCode, 415);
  assert.equal(contentTypeRes.body.error.code, 'unsupported_media_type');

  const extraRes = responseRecorder();
  await handler(jsonRequest('PATCH', {
    type: 'lorry',
    id: 1,
    active: false,
    request_id: 'resource-invalid-actor-001',
    actor_id: 'attacker-supplied-actor',
  }), extraRes);
  assert.equal(extraRes.statusCode, 400);
  assert.equal(extraRes.body.error.code, 'invalid_request');
  assert.equal(JSON.stringify(extraRes.body).includes('attacker-supplied-actor'), false);
});

test('resource POST requires a validated client request_id before repository access', async () => {
  let called = false;
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const protectedHandler = resourcesApi.createDispatchResourcesHandler({
    repository: {
      createDriver: async () => { called = true; return null; },
      createVehicle: async () => { called = true; return null; },
    },
    getSession: async () => SESSION,
  });
  const res = responseRecorder();

  await protectedHandler(jsonRequest('POST', {
    type: 'driver',
    name: 'Missing Request ID',
    licenseNo: 'D-MISSING-REQUEST-ID',
  }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'invalid_request');
  assert.equal(called, false);
});

test('resource idempotency replays the original row and event, while conflicting reuse is rejected', async () => {
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const requestId = 'resource-idempotent-driver-001';
  const first = responseRecorder();
  await handler(jsonRequest('POST', {
    type: 'driver',
    name: 'Idempotent Driver',
    licenseNo: 'D-IDEMPOTENT-001',
    request_id: requestId,
  }), first);
  assert.equal(first.statusCode, 201);

  const eventsBeforeReplay = await repository.listEvents();
  const second = responseRecorder();
  await handler(jsonRequest('POST', {
    type: 'driver',
    name: 'Idempotent Driver',
    licenseNo: 'D-IDEMPOTENT-001',
    request_id: requestId,
  }), second);
  assert.equal(second.statusCode, 201);
  assert.deepEqual(second.body.resource, first.body.resource);
  const eventsAfterReplay = await repository.listEvents();
  assert.equal(eventsAfterReplay.length, eventsBeforeReplay.length);
  assert.equal((await repository.listDrivers({ active: null })).filter((row) => row.licenseNo === 'D-IDEMPOTENT-001').length, 1);

  const conflict = responseRecorder();
  await handler(jsonRequest('POST', {
    type: 'driver',
    name: 'Changed Payload',
    licenseNo: 'D-IDEMPOTENT-002',
    request_id: requestId,
  }), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  assert.equal(JSON.stringify(conflict.body).includes('D-IDEMPOTENT-002'), false);
});

test('resource PATCH is state-aware: no-op has no event, then deactivate and reactivate derive state transitions', async () => {
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const all = responseRecorder();
  await handler({ method: 'GET', query: { active: 'all' }, headers: {} }, all);
  const driver = all.body.drivers.find((row) => row.licenseNo === 'D-IDEMPOTENT-001');
  assert.ok(driver);
  const before = await repository.listEvents();

  const noop = responseRecorder();
  await handler(jsonRequest('PATCH', {
    type: 'driver',
    id: driver.id,
    active: true,
    request_id: 'resource-noop-driver-001',
  }), noop);
  assert.equal(noop.statusCode, 200);
  assert.equal(noop.body.resource.active, true);
  assert.equal((await repository.listEvents()).length, before.length);

  const deactivate = responseRecorder();
  await handler(jsonRequest('PATCH', {
    type: 'driver',
    id: driver.id,
    active: false,
    request_id: 'resource-state-driver-002',
  }), deactivate);
  const reactivate = responseRecorder();
  await handler(jsonRequest('PATCH', {
    type: 'driver',
    id: driver.id,
    active: true,
    request_id: 'resource-state-driver-003',
  }), reactivate);
  assert.equal(deactivate.body.resource.active, false);
  assert.equal(reactivate.body.resource.active, true);

  const transitions = (await repository.listEvents()).filter((event) => (
    event.payload.driverId === driver.id
    && ['driver_deactivated', 'driver_reactivated'].includes(event.eventType)
  ));
  assert.deepEqual(transitions.map((event) => event.eventType), ['driver_deactivated', 'driver_reactivated']);
  assert.equal(transitions[0].payload.before.active, true);
  assert.equal(transitions[0].payload.after.active, false);
  assert.equal(transitions[1].payload.before.active, false);
  assert.equal(transitions[1].payload.after.active, true);
});

test('concurrent duplicate resource POSTs replay one durable result and create one event', async () => {
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const body = {
    type: 'lorry',
    registrationNo: 'IDEMPOTENT-CONCURRENT-001',
    description: 'Concurrent lorry',
    request_id: 'resource-concurrent-lorry-001',
  };
  const responses = await Promise.all([1, 2].map(async () => {
    const response = responseRecorder();
    await handler(jsonRequest('POST', body), response);
    return response;
  }));
  assert.deepEqual(responses.map((response) => response.statusCode), [201, 201]);
  assert.deepEqual(responses[1].body.resource, responses[0].body.resource);
  assert.equal((await repository.listVehicles({ active: null })).filter((row) => row.registrationNo === body.registrationNo).length, 1);
  const events = await repository.listEvents();
  assert.equal(events.filter((event) => event.payload.vehicleId === responses[0].body.resource.id).length, 1);
});

test('resource reads return 401 before repository access when no session exists', async () => {
  let called = false;
  assert.ok(resourcesApi, 'Task 4 resources API should exist');
  const protectedHandler = resourcesApi.createDispatchResourcesHandler({
    repository: {
      listDrivers: async () => { called = true; return []; },
      listVehicles: async () => { called = true; return []; },
    },
    getSession: async () => null,
  });
  const res = responseRecorder();

  await protectedHandler({ method: 'GET', query: { active: 'all' }, headers: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'unauthorized');
  assert.equal(called, false);
});
