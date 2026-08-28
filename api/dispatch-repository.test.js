const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const {
  createProviderTestDatabases,
  createTestDatabase,
} = require('../test/helpers/postgres');
const { createRepository } = require('../lib/dispatch/repository');

const LEGACY_MIGRATIONS_DIR = path.join(__dirname, '..', 'test', 'fixtures', 'migration-upgrade-5fe2aa9');
const HARDENING_MIGRATION_PATH = path.join(__dirname, '..', 'db', 'migrations', '002_delivery_dispatch_hardening.sql');

let database;
let repository;
let pool;
let resourceSequence = 0;

async function initializePrimaryDatabase() {
  database = await createTestDatabase();
  pool = database.pool;
  const { migrate } = require('../scripts/migrate');
  await migrate({ pool, skipAdvisoryLock: database.embedded });
  const { createRepository } = require('../lib/dispatch/repository');
  repository = createRepository(pool);
}

test.before(async () => {
  if (!process.env.TEST_DATABASE_URL) await initializePrimaryDatabase();
});

test.beforeEach(async () => {
  if (process.env.TEST_DATABASE_URL) await initializePrimaryDatabase();
});

test.afterEach(async () => {
  if (process.env.TEST_DATABASE_URL && database) {
    const currentDatabase = database;
    database = null;
    pool = null;
    repository = null;
    await currentDatabase.close();
  }
});

test.after(async () => {
  if (database) await database.close();
});

test('embedded test database remains independent from provider schema isolation', {
  skip: Boolean(process.env.TEST_DATABASE_URL),
}, () => {
  assert.equal(database.embedded, true);
  assert.equal(database.schema, null);
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

test('migration creates the dispatch tables and is idempotent', async () => {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'dispatch_drivers', 'dispatch_vehicles', 'delivery_trips',
        'delivery_assignments', 'delivery_assignment_items', 'delivery_events',
        'dispatch_login_throttle_buckets', 'dispatch_login_throttle_meta',
        'dispatch_resource_idempotency', 'schema_migrations'
      )
    ORDER BY table_name
  `);
  assert.deepEqual(tables.rows.map((row) => row.table_name), [
    'delivery_assignment_items',
    'delivery_assignments',
    'delivery_events',
    'delivery_trips',
    'dispatch_drivers',
    'dispatch_login_throttle_buckets',
    'dispatch_login_throttle_meta',
    'dispatch_resource_idempotency',
    'dispatch_vehicles',
    'schema_migrations',
  ]);

  const before = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
  assert.deepEqual(before.rows.map((row) => row.filename), [
    '001_delivery_dispatch.sql',
    '002_delivery_dispatch_hardening.sql',
    '003_dispatch_login_throttling.sql',
    '004_dispatch_resource_idempotency.sql',
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
      [
        '001_delivery_dispatch.sql',
        '002_delivery_dispatch_hardening.sql',
        '003_dispatch_login_throttling.sql',
        '004_dispatch_resource_idempotency.sql',
      ],
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

test('migration blocks contaminated exact 001 data before hardening', async () => {
  const legacyDatabase = await createTestDatabase();
  try {
    const { migrate } = require('../scripts/migrate');
    await migrate({
      pool: legacyDatabase.pool,
      migrationsDir: LEGACY_MIGRATIONS_DIR,
      skipAdvisoryLock: legacyDatabase.embedded,
    });

    const driver = await legacyDatabase.pool.query(
      "INSERT INTO dispatch_drivers (name, license_no) VALUES ('Legacy Driver', 'D-LEGACY-CONTAMINATED') RETURNING id",
    );
    const vehicle = await legacyDatabase.pool.query(
      "INSERT INTO dispatch_vehicles (registration_no) VALUES ('LEGACY-CONTAMINATED') RETURNING id",
    );
    const trip = await legacyDatabase.pool.query(`
      INSERT INTO delivery_trips (trip_date, driver_id, vehicle_id)
      VALUES ('2026-08-28', $1, $2)
      RETURNING id
    `, [driver.rows[0].id, vehicle.rows[0].id]);
    const assignment = await legacyDatabase.pool.query(`
      INSERT INTO delivery_assignments
        (trip_id, company_key, invoice_id, doc_no, doc_date, invoice_header)
      VALUES ($1, 'enterprise', 'INV-LEGACY-CONTAMINATED', 'ENT-LEGACY-CONTAMINATED', '2026-08-28', '{}')
      RETURNING id
    `, [trip.rows[0].id]);
    await legacyDatabase.pool.query(`
      INSERT INTO delivery_assignment_items
        (assignment_id, line_no, item_code, description, uom, quantity)
      VALUES
        ($1, 1, 'OIL-NAN', 'Legacy NaN', 'CTN', 'NaN'::numeric),
        ($1, 2, 'OIL-INFINITY', 'Legacy Infinity', 'CTN', 'Infinity'::numeric)
    `, [assignment.rows[0].id]);

    await assert.rejects(
      () => migrate({ pool: legacyDatabase.pool, skipAdvisoryLock: legacyDatabase.embedded }),
      /DELIVERY_DISPATCH_HARDENING_BLOCKED.*non-finite.*item_ids=.*assignment_ids=.*preflight/i,
    );

    const applied = await legacyDatabase.pool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    assert.deepEqual(applied.rows.map((row) => row.filename), ['001_delivery_dispatch.sql']);
    const hardeningConstraint = await legacyDatabase.pool.query(`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conrelid = 'delivery_assignment_items'::regclass
        AND conname = 'delivery_assignment_items_positive_finite_quantity_check'
    `);
    assert.equal(hardeningConstraint.rows[0].count, 0);
    const historicalQuantities = await legacyDatabase.pool.query(`
      SELECT quantity::text AS quantity
      FROM delivery_assignment_items
      WHERE assignment_id = $1
      ORDER BY line_no
    `, [assignment.rows[0].id]);
    assert.deepEqual(historicalQuantities.rows.map((row) => row.quantity), ['NaN', 'Infinity']);
  } finally {
    await legacyDatabase.close();
  }
});

async function createContaminatedLegacyDatabase() {
  const legacyDatabase = await createTestDatabase();
  const { migrate } = require('../scripts/migrate');
  await migrate({
    pool: legacyDatabase.pool,
    migrationsDir: LEGACY_MIGRATIONS_DIR,
    skipAdvisoryLock: legacyDatabase.embedded,
  });
  const driver = await legacyDatabase.pool.query(
    "INSERT INTO dispatch_drivers (name, license_no) VALUES ('Legacy Driver', 'D-LEGACY-REMEDIATION') RETURNING id",
  );
  const vehicle = await legacyDatabase.pool.query(
    "INSERT INTO dispatch_vehicles (registration_no) VALUES ('LEGACY-REMEDIATION') RETURNING id",
  );
  const trip = await legacyDatabase.pool.query(`
    INSERT INTO delivery_trips (trip_date, driver_id, vehicle_id)
    VALUES ('2026-08-28', $1, $2)
    RETURNING id
  `, [driver.rows[0].id, vehicle.rows[0].id]);
  const assignment = await legacyDatabase.pool.query(`
    INSERT INTO delivery_assignments
      (trip_id, company_key, invoice_id, doc_no, doc_date, invoice_header)
    VALUES ($1, 'enterprise', 'INV-LEGACY-REMEDIATION', 'ENT-LEGACY-REMEDIATION', '2026-08-28', '{}')
    RETURNING id
  `, [trip.rows[0].id]);
  const items = await legacyDatabase.pool.query(`
    INSERT INTO delivery_assignment_items
      (assignment_id, line_no, item_code, description, uom, quantity)
    VALUES
      ($1, 1, 'OIL-NAN', 'Legacy NaN', 'CTN', 'NaN'::numeric),
      ($1, 2, 'OIL-INFINITY', 'Legacy Infinity', 'CTN', 'Infinity'::numeric)
    RETURNING id, assignment_id, line_no
  `, [assignment.rows[0].id]);
  return { legacyDatabase, assignmentId: assignment.rows[0].id, items: items.rows };
}

test('legacy quantity preflight reports safe affected-row findings', async () => {
  const { legacyDatabase, assignmentId, items } = await createContaminatedLegacyDatabase();
  try {
    const {
      getLegacyQuantitySummary,
      iterateLegacyQuantityContamination,
    } = require('../scripts/migrate-preflight');
    const summary = await getLegacyQuantitySummary({ pool: legacyDatabase.pool });
    const records = [];
    for await (const batch of iterateLegacyQuantityContamination({ pool: legacyDatabase.pool })) {
      records.push(...batch);
    }
    const findings = { ...summary, records };
    assert.deepEqual(findings, {
      condition: 'non_finite_delivery_assignment_item_quantities',
      count: 2,
      records: [
        { itemId: items[0].id, assignmentId, lineNo: 1, quantityClass: 'NaN' },
        { itemId: items[1].id, assignmentId, lineNo: 2, quantityClass: 'Infinity' },
      ],
    });
    assert.equal(JSON.stringify(findings).includes('invoice_header'), false);
  } finally {
    await legacyDatabase.close();
  }
});

test('explicit audited remediation archives originals and permits hardening', async () => {
  const { legacyDatabase, assignmentId, items } = await createContaminatedLegacyDatabase();
  try {
    const { migrate } = require('../scripts/migrate');
    const { remediateLegacyQuantities } = require('../scripts/remediate-legacy-quantities');
    const replacements = {
      [items[0].id]: '2.5',
      [items[1].id]: '3.75',
    };

    await assert.rejects(
      () => remediateLegacyQuantities({
        pool: legacyDatabase.pool,
        replacements,
        approvedBy: 'dispatch-operator',
        requestId: 'legacy-remediation-test',
      }),
      /LEGACY_QUANTITY_REMEDIATION_CONFIRMATION_REQUIRED/,
    );

    const remediation = await remediateLegacyQuantities({
      pool: legacyDatabase.pool,
      replacements,
      approvedBy: 'dispatch-operator',
      requestId: 'legacy-remediation-test',
      confirm: true,
    });
    assert.deepEqual(remediation.itemIds, items.map((item) => item.id));
    assert.equal(remediation.remediatedCount, 2);

    const auditRows = await legacyDatabase.pool.query(`
      SELECT original_item_id, assignment_id, line_no, original_quantity,
             replacement_quantity::text AS replacement_quantity, approved_by, request_id
      FROM delivery_assignment_item_quantity_remediations
      ORDER BY original_item_id
    `);
    assert.deepEqual(auditRows.rows, [
      {
        original_item_id: items[0].id,
        assignment_id: assignmentId,
        line_no: 1,
        original_quantity: 'NaN',
        replacement_quantity: '2.5',
        approved_by: 'dispatch-operator',
        request_id: 'legacy-remediation-test',
      },
      {
        original_item_id: items[1].id,
        assignment_id: assignmentId,
        line_no: 2,
        original_quantity: 'Infinity',
        replacement_quantity: '3.75',
        approved_by: 'dispatch-operator',
        request_id: 'legacy-remediation-test',
      },
    ]);

    await assert.rejects(
      () => legacyDatabase.pool.query(`
        UPDATE delivery_assignment_item_quantity_remediations
        SET replacement_quantity = 99
        WHERE original_item_id = $1
      `, [items[0].id]),
      /append.only|immutable/i,
    );
    await assert.rejects(
      () => legacyDatabase.pool.query(`
        DELETE FROM delivery_assignment_item_quantity_remediations
        WHERE original_item_id = $1
      `, [items[0].id]),
      /append.only|immutable/i,
    );
    await assert.rejects(
      () => legacyDatabase.pool.query('TRUNCATE TABLE delivery_assignment_item_quantity_remediations'),
      /append.only|immutable/i,
    );

    const activeRows = await legacyDatabase.pool.query(`
      SELECT id, quantity::text AS quantity
      FROM delivery_assignment_items
      WHERE assignment_id = $1
      ORDER BY id
    `, [assignmentId]);
    assert.deepEqual(activeRows.rows, [
      { id: items[0].id, quantity: '2.5' },
      { id: items[1].id, quantity: '3.75' },
    ]);

    await migrate({ pool: legacyDatabase.pool, skipAdvisoryLock: legacyDatabase.embedded });
    await assert.rejects(
      () => legacyDatabase.pool.query(`
        INSERT INTO delivery_assignment_items
          (assignment_id, line_no, item_code, description, uom, quantity)
        VALUES ($1, 3, 'OIL-INVALID', 'Invalid after hardening', 'CTN', 'NaN'::numeric)
      `, [assignmentId]),
      /check|finite|numeric/i,
    );
    const applied = await legacyDatabase.pool.query(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    assert.deepEqual(applied.rows.map((row) => row.filename), [
      '001_delivery_dispatch.sql',
      '002_delivery_dispatch_hardening.sql',
      '003_dispatch_login_throttling.sql',
      '004_dispatch_resource_idempotency.sql',
    ]);
  } finally {
    await legacyDatabase.close();
  }
});

test('remediation request IDs are single-use and preserve audit history on retry', async () => {
  const { legacyDatabase, assignmentId, items } = await createContaminatedLegacyDatabase();
  try {
    const { remediateLegacyQuantities } = require('../scripts/remediate-legacy-quantities');
    const requestId = 'legacy-remediation-single-use';
    await remediateLegacyQuantities({
      pool: legacyDatabase.pool,
      replacements: { [items[0].id]: '2.5', [items[1].id]: '3.75' },
      approvedBy: 'dispatch-operator',
      requestId,
      confirm: true,
    });

    const thirdItem = await legacyDatabase.pool.query(`
      INSERT INTO delivery_assignment_items
        (assignment_id, line_no, item_code, description, uom, quantity)
      VALUES ($1, 3, 'OIL-RETRY', 'Retry NaN', 'CTN', 'NaN'::numeric)
      RETURNING id
    `, [assignmentId]);

    await assert.rejects(
      () => remediateLegacyQuantities({
        pool: legacyDatabase.pool,
        replacements: { [thirdItem.rows[0].id]: '4.5' },
        approvedBy: 'dispatch-operator',
        requestId,
        confirm: true,
      }),
      /REQUEST_ID_ALREADY_USED/,
    );

    const auditCount = await legacyDatabase.pool.query(
      'SELECT count(*)::int AS count FROM delivery_assignment_item_quantity_remediations',
    );
    assert.equal(auditCount.rows[0].count, 2);
    const retryRow = await legacyDatabase.pool.query(`
      SELECT quantity::text AS quantity
      FROM delivery_assignment_items
      WHERE id = $1
    `, [thirdItem.rows[0].id]);
    assert.deepEqual(retryRow.rows, [{ quantity: 'NaN' }]);
  } finally {
    await legacyDatabase.close();
  }
});

test('successful no-op remediation consumes its request ID before later contamination appears', async () => {
  const cleanDatabase = await createTestDatabase();
  try {
    const { migrate } = require('../scripts/migrate');
    await migrate({
      pool: cleanDatabase.pool,
      migrationsDir: LEGACY_MIGRATIONS_DIR,
      skipAdvisoryLock: cleanDatabase.embedded,
    });
    const { remediateLegacyQuantities } = require('../scripts/remediate-legacy-quantities');
    const { createRepository } = require('../lib/dispatch/repository');
    const requestId = "legacy-remediation-no-op-'single-quote'";

    const remediation = await remediateLegacyQuantities({
      pool: cleanDatabase.pool,
      replacements: {},
      approvedBy: 'dispatch-operator',
      requestId,
      confirm: true,
    });
    assert.deepEqual(remediation, { remediatedCount: 0, itemIds: [] });

    const requestRows = await cleanDatabase.pool.query(
      'SELECT request_id, approved_by FROM delivery_quantity_remediation_requests',
    );
    const auditRows = await cleanDatabase.pool.query(
      'SELECT count(*)::int AS count FROM delivery_assignment_item_quantity_remediations',
    );
    assert.deepEqual(requestRows.rows, [{ request_id: requestId, approved_by: 'dispatch-operator' }]);
    assert.equal(auditRows.rows[0].count, 0);

    const repository = createRepository(cleanDatabase.pool);
    const driver = await repository.createDriver({ name: 'No-op Driver', licenseNo: 'D-NO-OP' });
    const vehicle = await repository.createVehicle({ registrationNo: 'NO-OP-REG' });
    const trip = await repository.createTrip({
      tripDate: '2026-08-28',
      driverId: driver.id,
      vehicleId: vehicle.id,
    });
    const assignment = await repository.assignInvoice({
      tripId: trip.id,
      ...invoiceSnapshot('INV-NO-OP'),
    });
    await cleanDatabase.pool.query(
      `INSERT INTO delivery_assignment_items
         (assignment_id, line_no, item_code, description, uom, quantity)
       VALUES ($1, 3, 'OIL-NO-OP', 'Contamination after no-op', 'CTN', 'NaN'::numeric)`,
      [assignment.id],
    );

    await assert.rejects(
      () => remediateLegacyQuantities({
        pool: cleanDatabase.pool,
        replacements: { extra: '1' },
        approvedBy: 'dispatch-operator',
        requestId,
        confirm: true,
      }),
      /REQUEST_ID_ALREADY_USED/,
    );

    const finalRequestRows = await cleanDatabase.pool.query(
      'SELECT count(*)::int AS count FROM delivery_quantity_remediation_requests',
    );
    const finalAuditRows = await cleanDatabase.pool.query(
      'SELECT count(*)::int AS count FROM delivery_assignment_item_quantity_remediations',
    );
    assert.equal(finalRequestRows.rows[0].count, 1);
    assert.equal(finalAuditRows.rows[0].count, 0);
  } finally {
    await cleanDatabase.close();
  }
});

test('remediation accepts only positive finite replacement quantities and rolls back invalid attempts', async () => {
  const { legacyDatabase, assignmentId, items } = await createContaminatedLegacyDatabase();
  try {
    const { remediateLegacyQuantities } = require('../scripts/remediate-legacy-quantities');
    for (const [index, invalidQuantity] of ['0', '-1', 'NaN', 'Infinity', '-Infinity'].entries()) {
      await assert.rejects(
        () => remediateLegacyQuantities({
          pool: legacyDatabase.pool,
          replacements: { [items[0].id]: invalidQuantity, [items[1].id]: '3.75' },
          approvedBy: 'dispatch-operator',
          requestId: `legacy-remediation-invalid-${index}`,
          confirm: true,
        }),
        /INVALID_REPLACEMENT/,
      );
    }

    const activeRows = await legacyDatabase.pool.query(`
      SELECT id, quantity::text AS quantity
      FROM delivery_assignment_items
      WHERE assignment_id = $1
      ORDER BY id
    `, [assignmentId]);
    assert.deepEqual(activeRows.rows.map((row) => row.quantity), ['NaN', 'Infinity']);
    const auditTable = await legacyDatabase.pool.query(
      "SELECT to_regclass('delivery_assignment_item_quantity_remediations') AS table_name",
    );
    assert.equal(auditTable.rows[0].table_name, null);
  } finally {
    await legacyDatabase.close();
  }
});

test('preflight emits complete deterministic keyset batches as NDJSON without an unbounded result object', async () => {
  const { legacyDatabase } = await createContaminatedLegacyDatabase();
  try {
    const {
      getLegacyQuantitySummary,
      iterateLegacyQuantityContamination,
      writeLegacyQuantityPreflight,
    } = require('../scripts/migrate-preflight');
    const summary = await getLegacyQuantitySummary({ pool: legacyDatabase.pool });
    assert.deepEqual(summary, {
      condition: 'non_finite_delivery_assignment_item_quantities',
      count: 2,
    });
    assert.equal('records' in summary, false);

    const batches = [];
    for await (const batch of iterateLegacyQuantityContamination({
      pool: legacyDatabase.pool,
      batchSize: 1,
    })) {
      batches.push(batch);
    }
    assert.deepEqual(batches.map((batch) => batch.length), [1, 1]);
    assert.deepEqual(
      batches.flat().map((record) => record.quantityClass),
      ['NaN', 'Infinity'],
    );

    const output = [];
    await writeLegacyQuantityPreflight({
      pool: legacyDatabase.pool,
      batchSize: 1,
      write: (line) => output.push(line),
    });
    const lines = output.join('').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines[0], { type: 'summary', ...summary });
    assert.deepEqual(lines.slice(1, -1).map((line) => line.type), ['record', 'record']);
    assert.deepEqual(lines.at(-1), { type: 'complete', count: 2 });
    assert.deepEqual(lines.slice(1, -1).map(({ type, ...record }) => record), batches.flat());
    assert.equal(output.join('').includes('invoice_header'), false);
    assert.equal(output.join('').includes('customer'), false);
  } finally {
    await legacyDatabase.close();
  }
});

test('preflight keyset pagination covers the complete bigint ID range', async () => {
  const { legacyDatabase, assignmentId, items } = await createContaminatedLegacyDatabase();
  try {
    await legacyDatabase.pool.query(`
      INSERT INTO delivery_assignment_items
        (id, assignment_id, line_no, item_code, description, uom, quantity)
      VALUES (-1, $1, 3, 'OIL-NEGATIVE-ID', 'Negative ID NaN', 'CTN', 'NaN'::numeric)
    `, [assignmentId]);
    const { getLegacyQuantitySummary, iterateLegacyQuantityContamination } = require('../scripts/migrate-preflight');
    const summary = await getLegacyQuantitySummary({ pool: legacyDatabase.pool });
    const records = [];
    for await (const batch of iterateLegacyQuantityContamination({ pool: legacyDatabase.pool, batchSize: 2 })) {
      records.push(...batch);
    }
    assert.equal(summary.count, 3);
    assert.deepEqual(records.map((record) => record.itemId), [-1, items[0].id, items[1].id]);
  } finally {
    await legacyDatabase.close();
  }
});

test('preflight accepts signed bigint boundary cursors as strings without JSON coercion', async () => {
  const { legacyDatabase, assignmentId, items } = await createContaminatedLegacyDatabase();
  try {
    const minId = '-9223372036854775808';
    const maxId = '9223372036854775807';
    await legacyDatabase.pool.query(`
      INSERT INTO delivery_assignment_items
        (id, assignment_id, line_no, item_code, description, uom, quantity)
      VALUES ($1, $2, 3, 'OIL-MIN-ID', 'Minimum ID NaN', 'CTN', 'NaN'::numeric),
             ($3, $2, 4, 'OIL-MAX-ID', 'Maximum ID Infinity', 'CTN', 'Infinity'::numeric)
    `, [minId, assignmentId, maxId]);

    const { LEGACY_QUANTITY_BATCH_QUERY, iterateLegacyQuantityContamination } = require('../scripts/migrate-preflight');
    const first = await legacyDatabase.pool.query(LEGACY_QUANTITY_BATCH_QUERY, [null, 1]);
    assert.equal(String(first.rows[0].itemId), minId);
    if (legacyDatabase.embedded) {
      assert.equal(typeof first.rows[0].itemId, 'bigint');
      assert.throws(() => JSON.stringify(first.rows), /BigInt/);
    } else {
      assert.equal(typeof first.rows[0].itemId, 'string');
    }

    const afterMinimum = await legacyDatabase.pool.query(
      LEGACY_QUANTITY_BATCH_QUERY,
      [minId, 100],
    );
    assert.equal(String(afterMinimum.rows.at(-1).itemId), maxId);

    const afterMaximum = await legacyDatabase.pool.query(
      LEGACY_QUANTITY_BATCH_QUERY,
      [maxId, 1],
    );
    assert.equal(afterMaximum.rows.length, 0);

    const records = [];
    for await (const batch of iterateLegacyQuantityContamination({
      pool: legacyDatabase.pool,
      batchSize: 1,
    })) {
      records.push(...batch);
    }
    assert.deepEqual(records.map((record) => String(record.itemId)), [
      minId,
      String(items[0].id),
      String(items[1].id),
      maxId,
    ]);
  } finally {
    await legacyDatabase.close();
  }
});

test('remediation rescans the complete scope inside its transaction and rolls back when it grows after preflight', async () => {
  const { legacyDatabase, assignmentId, items } = await createContaminatedLegacyDatabase();
  let injected = false;
  const racingPool = {
    query: (...args) => legacyDatabase.pool.query(...args),
    connect: async () => {
      if (!injected) {
        injected = true;
        await legacyDatabase.pool.query(`
          INSERT INTO delivery_assignment_items
            (assignment_id, line_no, item_code, description, uom, quantity)
          VALUES ($1, 3, 'OIL-RACE', 'Race NaN', 'CTN', 'NaN'::numeric)
        `, [assignmentId]);
      }
      return legacyDatabase.pool.connect();
    },
  };

  try {
    const { remediateLegacyQuantities } = require('../scripts/remediate-legacy-quantities');
    await assert.rejects(
      () => remediateLegacyQuantities({
        pool: racingPool,
        replacements: { [items[0].id]: '2.5', [items[1].id]: '3.75' },
        approvedBy: 'dispatch-operator',
        requestId: 'legacy-remediation-race',
        confirm: true,
      }),
      /REPLACEMENT_SET_MISMATCH/,
    );

    const activeRows = await legacyDatabase.pool.query(`
      SELECT id, quantity::text AS quantity
      FROM delivery_assignment_items
      WHERE assignment_id = $1
      ORDER BY id
    `, [assignmentId]);
    assert.deepEqual(activeRows.rows.map((row) => row.quantity), ['NaN', 'Infinity', 'NaN']);
    const auditTable = await legacyDatabase.pool.query(
      "SELECT to_regclass('delivery_assignment_item_quantity_remediations') AS table_name",
    );
    assert.equal(auditTable.rows[0].table_name, null);
  } finally {
    await legacyDatabase.close();
  }
});

test('hardening locks assignment then item tables in a DML-blocking mode before contamination scan', () => {
  const sql = fs.readFileSync(HARDENING_MIGRATION_PATH, 'utf8');
  const lock = 'LOCK TABLE delivery_assignments, delivery_assignment_items IN SHARE ROW EXCLUSIVE MODE;';
  assert.equal(sql.indexOf(lock), 0);
  assert.ok(sql.indexOf('delivery_assignments') < sql.indexOf('delivery_assignment_items'));
  assert.ok(sql.indexOf(lock) < sql.indexOf('SELECT count(*)'));
});

test('finite quantity classification is version-neutral and does not cast special values as numeric literals', () => {
  const migration = fs.readFileSync(HARDENING_MIGRATION_PATH, 'utf8');
  const preflight = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrate-preflight.js'), 'utf8');
  const remediation = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'remediate-legacy-quantities.js'), 'utf8');
  for (const source of [migration, preflight, remediation]) {
    assert.doesNotMatch(source, /'(?:NaN|Infinity|-Infinity)'::numeric/);
    assert.match(source, /quantity::text/);
  }
});

test('TEST_DATABASE_URL fixtures use unique temporary schemas and clean them up', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { first, second } = await createProviderTestDatabases();
  const firstSchema = first.schema;
  const secondSchema = second.schema;
  try {
    assert.ok(firstSchema);
    assert.ok(secondSchema);
    assert.notEqual(firstSchema, secondSchema);
    assert.equal((await first.pool.query('SELECT current_schema()')).rows[0].current_schema, firstSchema);
    assert.equal((await second.pool.query('SELECT current_schema()')).rows[0].current_schema, secondSchema);

    const { migrate } = require('../scripts/migrate');
    await migrate({ pool: first.pool });
    const firstTables = await first.pool.query(`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'schema_migrations'
    `);
    const secondTables = await second.pool.query(`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'schema_migrations'
    `);
    assert.equal(firstTables.rows[0].count, 1);
    assert.equal(secondTables.rows[0].count, 0);
  } finally {
    await first.close();
    await second.close();
  }

  const cleanupPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try {
    const remaining = await cleanupPool.query(`
      SELECT count(*)::int AS count
      FROM information_schema.schemata
      WHERE schema_name IN ($1, $2)
    `, [firstSchema, secondSchema]);
    assert.equal(remaining.rows[0].count, 0);
  } finally {
    await cleanupPool.end();
  }
});

test('provider fixture setup closes the first database when the second setup fails', async () => {
  let attempts = 0;
  let closeCount = 0;
  await assert.rejects(
    () => createProviderTestDatabases(async () => {
      attempts += 1;
      if (attempts === 2) throw new Error('second schema setup failed');
      return { close: async () => { closeCount += 1; } };
    }),
    /second schema setup failed/,
  );
  assert.equal(closeCount, 1);
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

test('idempotent driver mutations replay one durable resource and event for the same actor and request', async () => {
  const requestId = 'repository-idempotent-driver-001';
  const first = await repository.createDriver({
    name: 'Repository Idempotent Driver',
    licenseNo: 'D-REPOSITORY-IDEMPOTENT-001',
    actor: 'clerk-aiman',
    requestId,
  });
  const second = await repository.createDriver({
    name: 'Repository Idempotent Driver',
    licenseNo: 'D-REPOSITORY-IDEMPOTENT-001',
    actor: 'clerk-aiman',
    requestId,
  });
  assert.deepEqual(second, first);

  const events = (await repository.listEvents()).filter((event) => event.requestId === requestId);
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'clerk-aiman');

  await assert.rejects(
    () => repository.createDriver({
      name: 'Conflicting Repository Driver',
      licenseNo: 'D-REPOSITORY-IDEMPOTENT-002',
      actor: 'clerk-aiman',
      requestId,
    }),
    (error) => error.code === 'idempotency_conflict',
  );
});

test('idempotent resource update records no event for a no-op and derives active transitions from persisted state', async () => {
  const driver = await repository.createDriver({
    name: 'State Aware Driver',
    licenseNo: 'D-STATE-AWARE-001',
    actor: 'clerk-aiman',
    requestId: 'repository-state-create-001',
  });
  const before = await repository.listEvents();

  const noOp = await repository.updateDriver(driver.id, {
    active: true,
    actor: 'clerk-aiman',
    requestId: 'repository-state-noop-001',
  });
  assert.deepEqual(noOp, driver);
  assert.equal((await repository.listEvents()).length, before.length);

  const deactivated = await repository.updateDriver(driver.id, {
    active: false,
    actor: 'clerk-aiman',
    requestId: 'repository-state-deactivate-001',
  });
  const reactivated = await repository.updateDriver(driver.id, {
    active: true,
    actor: 'clerk-aiman',
    requestId: 'repository-state-reactivate-001',
  });
  assert.equal(deactivated.active, false);
  assert.equal(reactivated.active, true);

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

test('resource mutation rolls back the row, idempotency record, and audit event together', async () => {
  const failingRepository = createRepository(pool);
  failingRepository._appendEvent = async () => {
    const error = new Error('audit insert failed');
    error.code = 'audit_write_failed';
    throw error;
  };

  await assert.rejects(
    () => failingRepository.createDriver({
      name: 'Rolled Back Resource',
      licenseNo: 'D-RESOURCE-ROLLBACK-001',
      actor: 'clerk-aiman',
      requestId: 'repository-resource-rollback-001',
    }),
    (error) => error.code === 'audit_write_failed',
  );

  const resourceRows = await pool.query(
    "SELECT count(*)::int AS count FROM dispatch_drivers WHERE license_no = 'D-RESOURCE-ROLLBACK-001'",
  );
  const idempotencyRows = await pool.query(
    "SELECT count(*)::int AS count FROM dispatch_resource_idempotency WHERE request_id = 'repository-resource-rollback-001'",
  );
  const eventRows = await pool.query(
    "SELECT count(*)::int AS count FROM delivery_events WHERE request_id = 'repository-resource-rollback-001'",
  );
  assert.equal(resourceRows.rows[0].count, 0);
  assert.equal(idempotencyRows.rows[0].count, 0);
  assert.equal(eventRows.rows[0].count, 0);
});

test('project and lockfile declare the Node 20 runtime required by Vercel Functions', () => {
  const packageJson = require('../package.json');
  const packageLock = require('../package-lock.json');
  assert.equal(packageJson.engines.node, '>=20.0.0');
  assert.equal(packageLock.packages[''].engines.node, '>=20.0.0');
});
