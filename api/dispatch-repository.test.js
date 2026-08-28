const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createTestDatabase } = require('../test/helpers/postgres');

const LEGACY_MIGRATIONS_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'migration-upgrade-5fe2aa9');

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
  assert.deepEqual(before.rows.map((row) => row.filename), [
    '001_delivery_dispatch.sql',
    '002_delivery_dispatch_hardening.sql',
  ]);

  const { migrate } = require('../scripts/migrate');
  await migrate({ pool, skipAdvisoryLock: database.embedded });
  const after = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
  assert.deepEqual(after.rows, before.rows);
});

test('migration upgrades the exact 5fe2aa9 schema with hardening exactly once', async () => {
  const legacyDatabase = await createTestDatabase();
  try {
    const { migrate } = require('../scripts/migrate');
    await migrate({
      pool: legacyDatabase.pool,
      migrationsDir: LEGACY_MIGRATIONS_DIR,
      skipAdvisoryLock: legacyDatabase.embedded,
    });
    const legacyApplied = await legacyDatabase.pool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    assert.deepEqual(legacyApplied.rows.map((row) => row.filename), ['001_delivery_dispatch.sql']);

    await migrate({ pool: legacyDatabase.pool, skipAdvisoryLock: legacyDatabase.embedded });
    const upgradedApplied = await legacyDatabase.pool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    assert.deepEqual(
      upgradedApplied.rows.map((row) => row.filename),
      ['001_delivery_dispatch.sql', '002_delivery_dispatch_hardening.sql'],
      'an existing 001 database must receive the additive hardening migration',
    );

    await migrate({ pool: legacyDatabase.pool, skipAdvisoryLock: legacyDatabase.embedded });
    const hardeningCount = await legacyDatabase.pool.query(`
      SELECT filename, count(*)::int AS count
      FROM schema_migrations
      WHERE filename = '002_delivery_dispatch_hardening.sql'
      GROUP BY filename
    `);
    assert.deepEqual(hardeningCount.rows, [{
      filename: '002_delivery_dispatch_hardening.sql',
      count: 1,
    }]);

    const { createRepository } = require('../lib/dispatch/repository');
    const repository = createRepository(legacyDatabase.pool);
    const driver = await repository.createDriver({ name: 'Upgrade Driver', licenseNo: 'D-UPGRADE' });
    const vehicle = await repository.createVehicle({ registrationNo: 'UPGRADE-REG', description: 'Lorry' });
    const trip = await repository.createTrip({
      tripDate: '2026-08-28',
      driverId: driver.id,
      vehicleId: vehicle.id,
    });
    const assignment = await repository.assignInvoice({
      tripId: trip.id,
      companyKey: 'enterprise',
      invoiceId: 'INV-UPGRADE',
      docNo: 'ENT-INV-UPGRADE',
      docDate: '2026-08-28',
      header: { invoiceId: 'INV-UPGRADE', docNo: 'ENT-INV-UPGRADE' },
      items: [{
        itemCode: 'OIL-DECIMAL',
        description: 'Decimal quantity',
        uom: 'CTN',
        quantity: '12345678901234567890.000125',
      }],
    });
    assert.equal(assignment.items[0].quantity, '12345678901234567890.000125');

    const immutableUpdates = [
      ['id', `${assignment.id + 1}`],
      ['company_key', "'sdn_bhd'"],
      ['invoice_id', "'INV-CHANGED'"],
      ['doc_no', "'DOC-CHANGED'"],
      ['doc_date', "'2026-08-29'"],
      ['assigned_at', "TIMESTAMP '2000-01-01 00:00:00+00'"],
      ['invoice_header', "'{}'::jsonb"],
    ];
    for (const [column, value] of immutableUpdates) {
      await assert.rejects(
        () => legacyDatabase.pool.query(
          `UPDATE delivery_assignments SET ${column} = ${value} WHERE id = $1`,
          [assignment.id],
        ),
        /immutable|snapshot/i,
        `direct update of ${column} should be rejected after upgrade`,
      );
    }

    for (const [index, quantity] of ['NaN', 'Infinity', '-Infinity'].entries()) {
      await assert.rejects(
        () => repository.assignInvoice({
          tripId: trip.id,
          companyKey: 'enterprise',
          invoiceId: `INV-UPGRADE-NONFINITE-${index}`,
          docNo: `ENT-INV-UPGRADE-NONFINITE-${index}`,
          docDate: '2026-08-28',
          header: { invoiceId: `INV-UPGRADE-NONFINITE-${index}` },
          items: [{
            itemCode: 'OIL-NONFINITE',
            description: 'Non-finite quantity',
            uom: 'CTN',
            quantity,
          }],
        }),
        /check|finite|numeric|invalid/i,
        `non-finite quantity ${quantity} should be rejected after upgrade`,
      );
    }
  } finally {
    await legacyDatabase.close();
  }
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
  await assert.rejects(
    () => pool.query('DELETE FROM delivery_assignment_items WHERE assignment_id = $1', [assignment.id]),
    /immutable|snapshot/i,
  );
});

test('assignment identity and timestamp snapshots reject direct updates', async () => {
  const { trip } = await seedTrip();
  const assignment = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-IMMUTABLE') });
  const updates = [
    ['company_key', "'sdn_bhd'"],
    ['invoice_id', "'INV-CHANGED'"],
    ['doc_no', "'DOC-CHANGED'"],
    ['doc_date', "'2026-08-29'"],
    ['assigned_at', "CURRENT_TIMESTAMP"],
    ['invoice_header', "'{}'::jsonb"],
  ];

  for (const [column, value] of updates) {
    await assert.rejects(
      () => pool.query(`UPDATE delivery_assignments SET ${column} = ${value} WHERE id = $1`, [assignment.id]),
      /immutable|snapshot/i,
      `direct update of ${column} should be rejected`,
    );
  }
});

test('numeric quantity checks reject every non-finite value and preserve decimal strings', async () => {
  const { trip } = await seedTrip();
  const valid = invoiceSnapshot('INV-FINITE');
  valid.items = [{ ...valid.items[0], quantity: '12345678901234567890.000125' }];
  const assignment = await repository.assignInvoice({ tripId: trip.id, ...valid });
  assert.equal(assignment.items[0].quantity, '12345678901234567890.000125');

  for (const [index, quantity] of ['NaN', 'Infinity', '-Infinity'].entries()) {
    const snapshot = invoiceSnapshot(`INV-NONFINITE-${index}`);
    snapshot.items = [{ ...snapshot.items[0], quantity }];
    await assert.rejects(
      () => repository.assignInvoice({ tripId: trip.id, ...snapshot }),
      /check|finite|numeric|invalid/i,
      `non-finite quantity ${quantity} should be rejected`,
    );
  }
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

test('loaded and out_for_delivery assignments stay unique, while returned assignments can be reused', async () => {
  const { trip } = await seedTrip();
  const loaded = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-LOADED') });
  await repository.updateAssignment(loaded.id, { status: 'loaded' });
  await assert.rejects(
    () => repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-LOADED') }),
    (error) => error.code === 'invoice_already_assigned' || /duplicate|unique/i.test(error.message),
  );

  const outForDelivery = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-OUT') });
  await repository.updateAssignment(outForDelivery.id, { status: 'out_for_delivery' });
  await assert.rejects(
    () => repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-OUT') }),
    (error) => error.code === 'invoice_already_assigned' || /duplicate|unique/i.test(error.message),
  );

  const returned = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-RETURNED') });
  await repository.updateAssignment(returned.id, { status: 'returned' });
  const replacement = await repository.assignInvoice({ tripId: trip.id, ...invoiceSnapshot('INV-RETURNED') });
  assert.equal(replacement.status, 'assigned');
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
  await assert.rejects(
    () => pool.query('DELETE FROM delivery_events WHERE id = $1', [events[0].id]),
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

test('assignment transaction rolls back assignment, prior items, and events after a later item fails', async () => {
  const { trip } = await seedTrip();
  const snapshot = invoiceSnapshot('INV-ROLLBACK-ASSIGNMENT');
  snapshot.items = [
    snapshot.items[0],
    { ...snapshot.items[1], itemCode: '' },
  ];

  await assert.rejects(
    () => repository.assignInvoice({ tripId: trip.id, ...snapshot }),
    /check|empty|invalid/i,
  );

  const assignmentRows = await pool.query(
    'SELECT count(*)::int AS count FROM delivery_assignments WHERE invoice_id = $1',
    [snapshot.invoiceId],
  );
  const itemRows = await pool.query(
    `SELECT count(*)::int AS count
     FROM delivery_assignment_items items
     JOIN delivery_assignments assignments ON assignments.id = items.assignment_id
     WHERE assignments.invoice_id = $1`,
    [snapshot.invoiceId],
  );
  const eventRows = await pool.query(
    'SELECT count(*)::int AS count FROM delivery_events WHERE trip_id = $1',
    [trip.id],
  );
  assert.equal(assignmentRows.rows[0].count, 0);
  assert.equal(itemRows.rows[0].count, 0);
  assert.equal(eventRows.rows[0].count, 0);
});

test('project and lockfile declare the Node 20 runtime required by Vercel Functions', () => {
  const packageJson = require('../package.json');
  const packageLock = require('../package-lock.json');
  assert.equal(packageJson.engines.node, '>=20.0.0');
  assert.equal(packageLock.packages[''].engines.node, '>=20.0.0');
});
