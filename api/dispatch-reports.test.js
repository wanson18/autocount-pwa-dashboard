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

const report = optionalRequire('../lib/dispatch/report');
const reportsApi = optionalRequire('./dispatch-reports');

function requireReport() {
  assert.ok(report, 'report domain module should exist');
  return report;
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

function recordsFixture() {
  return [
    {
      assignmentId: 9,
      tripId: 77,
      tripDate: '2026-08-28',
      tripStatus: 'completed',
      routeNotes: 'Route, "North"\nreview',
      driver: { id: 4, name: 'Aiman Driver', licenseNo: 'D-004' },
      lorry: { id: 8, registrationNo: 'WXY 1001', description: '10 tonne' },
      companyKey: 'enterprise',
      invoiceId: '=FORMULA-001',
      docNo: 'ENT,001',
      docDate: '2026-08-28',
      header: { customer: { code: 'E-001', name: 'Enterprise Customer' }, price: '100.00' },
      assignmentStatus: 'delivered',
      assignedAt: '2026-08-27T16:00:00.000Z',
      updatedAt: '2026-08-28T02:00:00.000Z',
    },
    {
      assignmentId: 10,
      tripId: 77,
      tripDate: '2026-08-28',
      tripStatus: 'completed',
      routeNotes: 'South route',
      driver: { id: 4, name: 'Aiman Driver', licenseNo: 'D-004' },
      lorry: { id: 8, registrationNo: 'WXY 1001', description: '10 tonne' },
      companyKey: 'sdn_bhd',
      invoiceId: 'shared-invoice',
      docNo: 'SDN-001',
      docDate: '2026-08-28',
      header: { customer: { code: 'S-001', name: 'Sdn Customer' } },
      assignmentStatus: 'returned',
      assignedAt: '2026-08-27T17:00:00.000Z',
      updatedAt: '2026-08-28T03:00:00.000Z',
    },
  ];
}

test('report records retain company-scoped identity, statuses, route, resources, customer, and audit timestamps without prices', () => {
  const { buildReport } = requireReport();
  const result = buildReport(recordsFixture(), { startDate: '2026-08-28', endDate: '2026-08-28' });

  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((row) => [row.companyKey, row.invoiceId]), [
    ['enterprise', '=FORMULA-001'],
    ['sdn_bhd', 'shared-invoice'],
  ]);
  assert.equal(result.records[0].assignmentStatus, 'delivered');
  assert.equal(result.records[0].tripStatus, 'completed');
  assert.equal(result.records[0].route, 'Route, "North"\nreview');
  assert.equal(result.records[0].customer.name, 'Enterprise Customer');
  assert.equal(JSON.stringify(result).includes('100.00'), false);
});

test('report CSV uses deterministic RFC 4180 quoting and neutralizes spreadsheet formulas', () => {
  const { buildReport, reportToCsv } = requireReport();
  const result = buildReport(recordsFixture(), { startDate: '2026-08-28', endDate: '2026-08-28' });
  const csv = reportToCsv(result.records);
  const lines = csv.split('\r\n');

  assert.equal(lines[0], 'trip_id,trip_date,trip_status,driver_id,driver_name,lorry_id,lorry_registration,route,company,invoice_id,invoice_no,invoice_date,customer_code,customer_name,assignment_status,assigned_at,updated_at');
  assert.match(lines[1], /77,2026-08-28,completed,4,Aiman Driver,8,WXY 1001,"Route, ""North""\nreview",enterprise,'=FORMULA-001,"ENT,001",2026-08-28,E-001,Enterprise Customer,delivered,/);
  assert.equal(lines.filter((line) => line.includes('100.00')).length, 0);
  assert.equal(csv.endsWith('\r\n'), true);
});

test('report date formatting uses Asia/Kuala_Lumpur for UTC boundary timestamps', () => {
  const { formatKualaLumpurDateTime, formatKualaLumpurDate } = requireReport();
  assert.equal(formatKualaLumpurDate('2026-08-28'), '28 Aug 2026');
  assert.match(formatKualaLumpurDateTime('2026-08-27T16:00:00.000Z'), /28 Aug 2026/);
  assert.match(formatKualaLumpurDateTime('2026-08-27T16:00:00.000Z'), /12:00 AM|00:00/);
});

test('reports API validates inclusive dates, filters, repeated fields, format, and safe repository arguments', async () => {
  assert.ok(reportsApi, 'reports API should exist');
  assert.equal(typeof reportsApi.createDispatchReportsHandler, 'function');
  const calls = [];
  const handler = reportsApi.createDispatchReportsHandler({
    repository: {
      async listReportRecords(filters) {
        calls.push(filters);
        return recordsFixture();
      },
    },
    getSession: async () => ({ clerkId: 'clerk-1' }),
  });
  const response = responseRecorder();
  await handler({
    method: 'GET',
    query: {
      startDate: '2026-08-28',
      endDate: '2026-08-28',
      company: 'enterprise',
      driver_id: '4',
      lorry_id: '8',
      status: 'delivered',
      format: 'json',
    },
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    startDate: '2026-08-28',
    endDate: '2026-08-28',
    company: 'enterprise',
    driverId: 4,
    vehicleId: 8,
    status: 'delivered',
    limit: 1000,
  });
  assert.deepEqual(response.body.records.map((row) => row.companyKey), ['enterprise']);

  for (const query of [
    { startDate: '2026-08-29', endDate: '2026-08-28' },
    { startDate: '2026-02-30', endDate: '2026-03-01' },
    { startDate: '2026-08-28', endDate: '2026-08-28', status: 'not-a-status' },
    { startDate: '2026-08-28', endDate: '2026-08-28', unknown: 'reject-me' },
    { startDate: ['2026-08-28', '2026-08-28'], endDate: '2026-08-28' },
  ]) {
    const invalid = responseRecorder();
    await handler({ method: 'GET', query }, invalid);
    assert.equal(invalid.statusCode, 400);
  }
  assert.equal(calls.length, 1, 'invalid queries must be rejected before data access');
});

test('reports API supports explicit CSV, requires authentication, and only allows GET/OPTIONS', async () => {
  assert.ok(reportsApi, 'reports API should exist');
  const repository = { async listReportRecords() { return recordsFixture(); } };
  const handler = reportsApi.createDispatchReportsHandler({ repository, getSession: async () => ({ clerkId: 'clerk-1' }) });
  const csv = responseRecorder();
  await handler({ method: 'GET', query: { startDate: '2026-08-28', endDate: '2026-08-28', format: 'csv' } }, csv);
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['Content-Type'], /^text\/csv/);
  assert.equal(csv.headers['Cache-Control'], 'no-store');
  assert.match(csv.body, /^trip_id,trip_date/);

  const post = responseRecorder();
  await handler({ method: 'POST', query: {} }, post);
  assert.equal(post.statusCode, 405);

  const unauthenticated = responseRecorder();
  const protectedHandler = reportsApi.createDispatchReportsHandler({
    repository: { async listReportRecords() { throw new Error('must not read'); } },
    getSession: async () => null,
  });
  await protectedHandler({ method: 'GET', query: { startDate: '2026-08-28', endDate: '2026-08-28' } }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
});
