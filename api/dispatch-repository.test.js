const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestDatabase } = require('../test/helpers/postgres');

let database;
let repository;
let pool;
let resourceSequence = 0;

test.before(async () => {
  database = await createTestDatabase();
  pool = database.pool;
  const { migrate } = require('../scripts/migrate');
  await migrate({ pool, skipAdvisoryLock: database.embedded });
  const { createRepository } = require('../lib/dispatch/repository');
  repository = createRepository(pool);
});

test.after(async () => {
  await database.close();
});

async function seedResources() {
  resourceSequence += 1;
  const driver = await repository.createDriver({
    name: 'Aiman Driver',
    licenseNo: `D-1001-${resourceSequence}`,
  });
  const vehicle = await repository.createVehicle({
    registrationNo: `WXY 1001-${resourceSequence}`,
    description: '10-ton lorry',
  });
  return { driver, vehicle };
}

async function seedTrip() {
  const { driver, vehicle } = await seedResources();
  const trip = await repository.createTrip({
    tripDate: '2026-08-28',
    driverId: driver.id,
    vehicleId: vehicle.id,
    routeNotes: 'North route',
  });
  return { trip, driver, vehicle };
}

function invoiceSnapshot(invoiceId, companyKey = 'enterprise') {
  return {
    companyKey,
    invoiceId,
    docNo: `${companyKey.toUpperCase()}-${invoiceId}`,
    docDate: '2026-08-28',
    header: {
      invoiceId,
      docNo: `${companyKey.toUpperCase()}-${invoiceId}`,
      customer: { code: 'C-001', name: 'Sanitized Customer' },
      deliveryAddress: 'Sanitized Delivery Address',
    },
    items: [
      { itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' },
      { itemCode: 'OIL-1KG', description: 'Cooking Oil 1KG', quantity: '0.375', uom: 'CTN' },
    ],
  };
}

test('migration creates the six dispatch tables and is idempotent', async () => {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'dispatch_drivers', 'dispatch_vehicles', 'delivery_trips',
        'delivery_assignments', 'delivery_assignment_items', 'delivery_events',
        'schema_migrations'
      )
    ORDER BY table_name
  `);
  assert.deepEqual(tables.rows.map((row) => row.table_name), [
    'delivery_assignment_items',
    'delivery_assignments',
    'delivery_events',
    'delivery_trips',
    'dispatch_drivers',
    'dispatch_vehicles',
    'schema_migrations',
  ]);

  const before = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
  assert.deepEqual(before.rows.map((row) => row.filename), ['001_delivery_dispatch.sql']);

  const { migrate } = require('../scripts/migrate');
  await migrate({ pool, skipAdvisoryLock: database.embedded });
  const after = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
  assert.deepEqual(after.rows, before.rows);
});

test('database checks reject unknown companies and statuses', async () => {
  const { trip } = await seedTrip();
  await assert.rejects(
    () => pool.query(`
      INSERT INTO delivery_assignments
        (trip_id, company_key, invoice_id, doc_no, doc_date, invoice_header)
      VALUES ($1, 'unknown', 'BAD-001', 'BAD-001', '2026-08-28', '{}')
    `, [trip.id]),
    /./,
  );
  await assert.rejects(
    () => pool.query("UPDATE delivery_trips SET status = 'bogus' WHERE id = $1", [trip.id]),
    /./,
  );
});

test('driver license and vehicle registration records are unique', async () => {
  const first = await repository.createDriver({ name: 'Unique Driver', licenseNo: 'D-UNIQUE' });
  assert.equal(typeof first.id, 'number');
  await assert.rejects(
    () => repository.createDriver({ name: 'Another Driver', licenseNo: 'D-UNIQUE' }),
    /duplicate|unique|already/i,
  );

  await repository.createVehicle({ registrationNo: 'UNIQUE-REG', description: 'Lorry' });
  await assert.rejects(
    () => repository.createVehicle({ registrationNo: 'UNIQUE-REG', description: 'Another lorry' }),
    /duplicate|unique|already/i,
  );
});

test('trip updates require the current revision and increment it', async () => {
  const { trip } = await seedTrip();
  assert.equal(trip.revision, 1);

  const updated = await repository.updateTrip(trip.id, 1, { status: 'loading' });
  assert.equal(updated.status, 'loading');
  assert.equal(updated.revision, 2);

  const stale = await repository.updateTrip(trip.id, 1, { status: 'dispatched' });
  assert.equal(stale, null);
  assert.equal((await repository.getTrip(trip.id)).status, 'loading');
});

test('assignment preserves exact numeric quantities and immutable snapshots', async () => {
  const { trip } = await seedTrip();
  const assignment = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-001') });
  assert.deepEqual(assignment.items.map((item) => item.quantity), ['2.125', '0.375']);
  assert.equal(assignment.header.customer.name, 'Sanitized Customer');

  const changed = await repository.updateAssignment(assignment.id, { status: 'loaded' });
  assert.equal(changed.status, 'loaded');
  assert.deepEqual(changed.items.map((item) => item.quantity), ['2.125', '0.375']);
  assert.equal(changed.header.customer.name, 'Sanitized Customer');

  await assert.rejects(
    () => pool.query("UPDATE delivery_assignments SET invoice_header = '{}'::jsonb WHERE id = $1", [assignment.id]),
    /immutable|snapshot/i,
  );
  await assert.rejects(
    () => pool.query('UPDATE delivery_assignment_items SET quantity = 9.999 WHERE assignment_id = $1', [assignment.id]),
    /immutable|snapshot/i,
  );
});

test('active assignment uniqueness is company-scoped and permits reassignment after removal', async () => {
  const { trip } = await seedTrip();
  const first = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-002', 'enterprise') });
  await assert.rejects(
    () => repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-002', 'enterprise') }),
    (error) => error.code === 'invoice_already_assigned' || /duplicate|unique/i.test(error.message),
  );

  const otherCompany = await repository.assignInvoice({
    tripId: trip.id,
    ...invoiceSnapshot('INV-002', 'sdn_bhd'),
  });
  assert.equal(otherCompany.companyKey, 'sdn_bhd');

  await repository.updateAssignment(first.id, { status: 'removed' });
  const replacement = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-002', 'enterprise') });
  assert.equal(replacement.status, 'assigned');
});

test('failed and returned assignments may be replaced but delivered assignments remain protected', async () => {
  const { trip } = await seedTrip();
  const failed = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-003') });
  await repository.updateAssignment(failed.id, { status: 'failed' });
  await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-003') });

  const delivered = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-004') });
  await repository.updateAssignment(delivered.id, { status: 'delivered' });
  await assert.rejects(
    () => repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-004') }),
    (error) => error.code === 'invoice_already_assigned' || /duplicate|unique/i.test(error.message),
  );
});

test('assignment moves keep snapshots and append event history', async () => {
  const first = await seedTrip();
  const second = await seedTrip();
  const assignment = await repository.assignInvoice({ tripId: first.trip.id, ...invoiceSnapshot('INV-005') });
  await repository.moveAssignment(assignment.id, second.trip.id);
  await repository.updateAssignment(assignment.id, { status: 'out_for_delivery' });

  const events = await repository.listEvents({ assignmentId: assignment.id });
  assert.deepEqual(events.map((event) => event.eventType), ['assigned', 'moved', 'status_changed']);
  assert.deepEqual(events[1].payload, {
    fromTripId: first.trip.id,
    toTripId: second.trip.id,
  });
  await assert.rejects(
    () => pool.query("UPDATE delivery_events SET event_type = 'tampered' WHERE id = $1", [events[0].id]),
    /append.only|immutable|event history/i,
  );
  const current = await repository.getAssignment(assignment.id);
  assert.equal(current.tripId, second.trip.id);
  assert.equal(current.header.docNo, 'ENTERPRISE-INV-005');
  assert.equal(current.items[0].quantity, '2.125');
  assert.equal(typeof repository.deleteAssignment, 'undefined');
  assert.equal(typeof repository.deleteTrip, 'undefined');
});

test('transaction helper rolls back all work after a failure', async () => {
  const { withTransaction } = require('../lib/dispatch/repository');
  await assert.rejects(
    () => withTransaction(pool, async (client) => {
      await client.query("INSERT INTO dispatch_drivers (name, license_no) VALUES ('Rolled Back', 'D-ROLLBACK')");
      throw new Error('force rollback');
    }),
    /force rollback/,
  );
  const result = await pool.query("SELECT count(*)::int AS count FROM dispatch_drivers WHERE license_no = 'D-ROLLBACK'");
  assert.equal(result.rows[0].count, 0);
});
