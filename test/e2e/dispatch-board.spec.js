const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

let staticServer;
test.beforeAll(async () => {
  staticServer = http.createServer((request, response) => {
    const requested = request.url === '/' ? '/dispatch.html' : request.url.split('?')[0];
    const filePath = path.join(__dirname, '..', '..', 'public', requested.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) { response.writeHead(404); response.end(); return; }
    const contentType = filePath.endsWith('.css') ? 'text/css' : (filePath.endsWith('.mjs') || filePath.endsWith('.js')) ? 'text/javascript' : 'text/html';
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => staticServer.listen(4173, '127.0.0.1', resolve));
});
test.afterAll(async () => { await new Promise((resolve) => staticServer.close(resolve)); });

const ENTERPRISE = {
  companyKey: 'enterprise', invoiceId: 'enterprise-e2e-001', docKey: 'enterprise-e2e-001',
  docNo: 'ENT-E2E-001', docDate: '2026-08-28',
  customer: { code: 'ENT-E2E-CUSTOMER', name: 'Enterprise E2E Customer' },
  deliveryAddress: 'Enterprise E2E Address', cancelled: false, eligibility: 'eligible',
  items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
};
const SDN_BHD = {
  companyKey: 'sdn_bhd', invoiceId: 'sdn-bhd-e2e-001', docKey: 'sdn-bhd-e2e-001',
  docNo: 'SDN-E2E-001', docDate: '2026-08-28',
  customer: { code: 'SDN-E2E-CUSTOMER', name: 'Sdn Bhd E2E Customer' },
  deliveryAddress: 'Sdn Bhd E2E Address', cancelled: false, eligibility: 'eligible',
  items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '3.000', uom: 'CTN' }],
};
const ENTERPRISE_TWO = {
  ...ENTERPRISE, invoiceId: 'enterprise-e2e-002', docKey: 'enterprise-e2e-002', docNo: 'ENT-E2E-002',
};

function createServerState() {
  return {
    invoices: [ENTERPRISE, SDN_BHD, ENTERPRISE_TWO],
    trips: [{ id: 101, tripDate: '2026-08-28', driverId: 1, vehicleId: 2,
      driver: { id: 1, name: 'Aiman Driver' }, lorry: { id: 2, registrationNo: 'WXY 1001' },
      routeNotes: 'North route', status: 'planned', revision: 1, assignments: [] }],
    assignments: [],
    drivers: [{ type: 'driver', id: 1, name: 'Aiman Driver', licenseNo: 'D-1001', active: true }],
    lorries: [{ type: 'lorry', id: 2, registrationNo: 'WXY 1001', description: '10-ton lorry', active: true }],
    assignmentBodies: [], tripBodies: [], counts: { trips: 0, assignments: 0, invoiceReads: 0, resources: 0 },
  };
}

function makeAssignment(invoice, id, tripId) {
  return {
    id, tripId, companyKey: invoice.companyKey, invoiceId: invoice.invoiceId,
    docNo: invoice.docNo, docDate: invoice.docDate, header: {
      companyKey: invoice.companyKey, invoiceId: invoice.invoiceId, docNo: invoice.docNo,
      docDate: invoice.docDate, customer: invoice.customer, deliveryAddress: invoice.deliveryAddress,
    }, items: invoice.items, status: 'assigned',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installFixtureApi(page, {
  partialSource = false,
  assignmentMode = 'success',
  boardError = false,
  deferInitialBoard = false,
  missingSource = false,
  unauthorizedOnRefresh = false,
  deferEnterpriseFilter = false,
  deferAssignment = false,
  deferStaleRefresh = false,
  deferResourceUpdate = false,
  idsOnlyTrip = false,
} = {}) {
  const state = createServerState();
  if (idsOnlyTrip) {
    delete state.trips[0].driver;
    delete state.trips[0].lorry;
  }
  state.boardError = boardError;
  state.initialBoardGate = deferInitialBoard ? deferred() : null;
  state.enterpriseFilterGate = deferEnterpriseFilter ? deferred() : null;
  state.assignmentGate = deferAssignment ? deferred() : null;
  state.staleRefreshGate = deferStaleRefresh ? deferred() : null;
  state.resourceUpdateGate = deferResourceUpdate ? deferred() : null;
  state.invoiceCompanies = [];
  state.resourceWrites = 0;
  await page.route('**/api/dispatch/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === '/api/dispatch/session' && request.method() === 'GET') {
      return json(route, { success: true, authenticated: true, session: { clerkId: 'clerk-e2e', role: 'clerk' } });
    }
    if (pathname === '/api/dispatch/session') return json(route, { success: true, authenticated: false, session: null });
    if (pathname === '/api/dispatch/resources' && request.method() === 'GET') {
      state.counts.resources += 1;
      return json(route, { success: true, active: 'true', drivers: state.drivers, lorries: state.lorries });
    }
    if (pathname === '/api/dispatch/resources' && request.method() === 'PATCH') {
      state.resourceWrites += 1;
      if (state.resourceUpdateGate) await state.resourceUpdateGate.promise;
      return json(route, { success: true, resource: state.drivers[0] });
    }
    if (pathname === '/api/dispatch/invoices' && request.method() === 'GET') {
      state.counts.invoiceReads += 1;
      const requestedCompany = url.searchParams.get('company') || 'all';
      state.invoiceCompanies.push(requestedCompany);
      if (state.initialBoardGate && state.counts.invoiceReads === 1) await state.initialBoardGate.promise;
      if (state.enterpriseFilterGate && requestedCompany === 'enterprise') await state.enterpriseFilterGate.promise;
      if (unauthorizedOnRefresh && state.counts.invoiceReads === 2) {
        return json(route, { success: false, error: { code: 'arbitrary_gateway_body' } }, 401);
      }
      if (state.boardError && state.counts.invoiceReads === 1) return json(route, { success: false, error: { code: 'source_unavailable' } }, 503);
      return json(route, {
        success: true, dateRange: { startDate: '2026-08-28', endDate: '2026-08-28' }, company: 'all',
        invoices: state.invoices.filter((invoice) => requestedCompany === 'all' || invoice.companyKey === requestedCompany), sources: {
          enterprise: { status: 'ok', invoiceCount: state.invoices.filter((row) => row.companyKey === 'enterprise').length },
          ...(missingSource ? {} : { sdn_bhd: partialSource ? { status: 'unavailable', errorCode: 'source_unavailable' } : { status: 'ok', invoiceCount: 1 } }),
        },
      });
    }
    if (pathname === '/api/dispatch/trips' && request.method() === 'GET') {
      state.counts.trips += 1;
      if (state.staleRefreshGate && state.counts.trips > 1) await state.staleRefreshGate.promise;
      return json(route, { success: true, trips: state.trips });
    }
    if (pathname === '/api/dispatch/trips' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      state.tripBodies.push(body);
      const trip = { id: 102, tripDate: body.trip_date, driverId: body.driver_id, vehicleId: body.vehicle_id,
        driver: state.drivers.find((row) => row.id === body.driver_id),
        lorry: state.lorries.find((row) => row.id === body.vehicle_id), routeNotes: body.route_notes,
        status: 'planned', revision: 1, assignments: [] };
      state.trips.push(trip);
      return json(route, { success: true, trip }, 201);
    }
    if (pathname === '/api/dispatch/assignments' && request.method() === 'GET') {
      return json(route, { success: true, assignments: state.assignments });
    }
    if (pathname === '/api/dispatch/assignments' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}');
      state.assignmentBodies.push(body);
      state.counts.assignments += 1;
      if (state.assignmentGate) await state.assignmentGate.promise;
      if (assignmentMode === 'rollback') return json(route, { success: false, error: { code: 'internal_error' } }, 500);
      if (assignmentMode === 'stale' && state.counts.assignments === 1) {
        state.trips[0].revision += 1;
        return json(route, { success: false, error: { code: 'stale_trip' } }, 409);
      }
      const invoice = state.invoices.find((row) => row.companyKey === body.company_key && row.invoiceId === body.invoice_id);
      const target = state.trips.find((row) => String(row.id) === String(body.trip_id));
      const created = makeAssignment(invoice, state.assignmentBodies.length + 40, target.id);
      state.assignments.push(created);
      target.assignments.push(created);
      target.revision += 1;
      return json(route, { success: true, assignment: created, trip: target }, 201);
    }
    return json(route, { success: false, error: { code: 'not_found' } }, 404);
  });
  return state;
}

async function openBoard(page, options) {
  const state = await installFixtureApi(page, options);
  await page.goto('/dispatch.html');
  await expect(page.locator('#authenticatedView')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unassigned invoices' })).toBeVisible();
  return state;
}

function invoiceCard(page, docNo) {
  return page.locator('.invoice-card').filter({ hasText: docNo });
}

async function dropInvoiceKey(page, invoiceKey, tripId = '101') {
  await page.evaluate(({ key, targetTripId }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', key);
    document.querySelector(`[data-drop-trip-id="${targetTripId}"]`).dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    }));
  }, { key: invoiceKey, targetTripId: tripId });
}

test('Board shows combined company feed and creates a mixed-company trip', async ({ page }) => {
  const state = await openBoard(page);
  await expect(page.locator('.company-badge', { hasText: 'Enterprise' })).toHaveCount(2);
  await expect(page.locator('.company-badge', { hasText: 'Sdn Bhd' })).toHaveCount(1);

  await page.getByRole('button', { name: /New trip/ }).click();
  await expect(page.getByRole('dialog', { name: 'Create trip' })).toBeVisible();
  await page.getByLabel('Route notes').fill('South route');
  await page.getByRole('button', { name: 'Create trip' }).click();
  await expect(page.locator('[data-trip-id="102"]')).toBeVisible();
  expect(state.tripBodies[0]).toEqual(expect.objectContaining({
    trip_date: '2026-08-28', driver_id: 1, vehicle_id: 2, route_notes: 'South route',
  }));
  expect(Object.keys(state.tripBodies[0]).sort()).toEqual(['driver_id', 'request_id', 'route_notes', 'trip_date', 'vehicle_id'].sort());

  await invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Select invoice/ }).click();
  await page.locator('[data-trip-id="102"]').getByRole('button', { name: /Assign selected invoice/ }).click();
  await invoiceCard(page, 'SDN-E2E-001').getByRole('button', { name: /Select invoice/ }).click();
  await page.locator('[data-trip-id="102"]').getByRole('button', { name: /Assign selected invoice/ }).click();

  const trip = page.locator('[data-trip-id="102"]');
  await expect(trip).toContainText('Enterprise 1');
  await expect(trip).toContainText('Sdn Bhd 1');
  await expect(trip).toContainText('Combined 2');
  await expect(trip.locator('.company-badge', { hasText: 'Enterprise' })).toHaveCount(1);
  await expect(trip.locator('.company-badge', { hasText: 'Sdn Bhd' })).toHaveCount(1);
});

test('authenticated Board joins an IDs-only trip from the protected resources response', async ({ page }) => {
  const state = await openBoard(page, { idsOnlyTrip: true });
  await expect.poll(() => state.counts.resources).toBe(1);

  const trip = page.locator('[data-trip-id="101"]');
  await expect(trip).toContainText('Aiman Driver');
  await expect(trip).toContainText('WXY 1001');
  await expect(trip).not.toContainText('Driver not set');
  await expect(trip).not.toContainText('Lorry not set');
});

test('click, touch, keyboard, and drag assignment paths share the Board assignment action', async ({ page }, testInfo) => {
  const state = await openBoard(page);
  const trip = page.locator('[data-trip-id="101"]');

  const firstInvoiceSelect = invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Select invoice/ });
  if (testInfo.project.name === 'mobile') await firstInvoiceSelect.tap();
  else await firstInvoiceSelect.click();
  const firstAssign = invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Assign invoice ENT-E2E-001/ });
  if (testInfo.project.name === 'mobile') await firstAssign.tap();
  else await firstAssign.click();
  await invoiceCard(page, 'SDN-E2E-001').getByRole('button', { name: /Select invoice/ }).click();
  await trip.getByRole('button', { name: /Assign selected invoice/ }).focus();
  await page.keyboard.press('Enter');
  if (testInfo.project.name === 'desktop') await invoiceCard(page, 'ENT-E2E-002').dragTo(trip);

  expect(state.assignmentBodies).toHaveLength(testInfo.project.name === 'desktop' ? 3 : 2);
  for (const body of state.assignmentBodies) {
    expect(Object.keys(body).sort()).toEqual(['company_key', 'doc_date', 'doc_no', 'expected_trip_revision', 'invoice_id', 'request_id', 'trip_id'].sort());
  }
  await expect(trip).toContainText(testInfo.project.name === 'desktop' ? 'Combined 3' : 'Combined 2');
});

test('forged and stale drag payloads cannot create an assignment', async ({ page }) => {
  const state = await openBoard(page);

  await dropInvoiceKey(page, 'enterprise:forged');
  expect(state.assignmentBodies).toHaveLength(0);

  await invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Assign invoice ENT-E2E-001/ }).click();
  await expect(page.locator('[data-trip-id="101"]')).toContainText('Combined 1');
  expect(state.assignmentBodies).toHaveLength(1);

  await dropInvoiceKey(page, 'enterprise:enterprise-e2e-001');
  await page.waitForTimeout(50);
  expect(state.assignmentBodies).toHaveLength(1);
});

test('successful assignment restores focus to the stable replacement trip control', async ({ page }) => {
  await openBoard(page);
  await invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Assign invoice ENT-E2E-001/ }).click();

  await expect(page.locator('[data-trip-id="101"]')).toContainText('Combined 1');
  await expect(page.locator('[data-assign-selected="101"]')).toBeFocused();
});

test('failed assignment rolls back exactly and announces the error', async ({ page }) => {
  const state = await openBoard(page, { assignmentMode: 'rollback' });
  const card = invoiceCard(page, 'ENT-E2E-001');
  await card.getByRole('button', { name: /Select invoice/ }).click();
  await page.locator('[data-trip-id="101"]').getByRole('button', { name: /Assign selected invoice/ }).click();
  await expect(page.locator('#statusMessage')).toContainText('could not be assigned');
  await expect(page.locator('#unassignedList')).toContainText('ENT-E2E-001');
  await expect(page.locator('[data-trip-id="101"] .invoice-card')).toHaveCount(0);
  await expect(page.locator('[data-assign-selected="101"]')).toBeEnabled();
  await expect(page.locator('[data-assign-selected="101"]')).toBeFocused();
  expect(state.assignmentBodies).toHaveLength(1);
});

test('stale trip conflict stays locked through authoritative refetch and then re-enables writes', async ({ page }) => {
  const state = await openBoard(page, { assignmentMode: 'stale', deferStaleRefresh: true });
  await invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Select invoice/ }).click();
  const trip = page.locator('[data-trip-id="101"]');
  const tripReadsBefore = state.counts.trips;
  await trip.getByRole('button', { name: /Assign selected invoice/ }).click();
  await expect(page.locator('#statusMessage')).toContainText('changed on the server');
  await expect(page.locator('#unassignedList')).toContainText('ENT-E2E-001');
  await expect.poll(() => state.counts.trips).toBeGreaterThan(tripReadsBefore);
  await expect(trip.getByRole('button', { name: /Assign selected invoice/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /New trip/ })).toBeDisabled();
  state.staleRefreshGate.resolve();
  await expect(trip.getByRole('button', { name: /Assign selected invoice/ })).toBeEnabled();
});

test('refresh cannot erase a newer pending assignment or suppress its authoritative result', async ({ page }) => {
  const state = await openBoard(page, { deferAssignment: true });
  await invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Assign invoice ENT-E2E-001/ }).click();
  await expect.poll(() => state.assignmentBodies.length).toBe(1);

  await page.locator('#refreshBoard').click();
  await page.waitForTimeout(100);
  expect(state.counts.invoiceReads).toBe(1);
  await expect(page.getByRole('button', { name: /New trip/ })).toBeDisabled();

  state.assignmentGate.resolve();
  await expect.poll(() => state.counts.invoiceReads).toBeGreaterThan(1);
  await expect(page.locator('[data-trip-id="101"]')).toContainText('Combined 1');
  await expect(page.locator('#unassignedList')).not.toContainText('ENT-E2E-001');
  await expect(page.getByRole('button', { name: /New trip/ })).toBeEnabled();
});

test('filter change queues behind a pending assignment and applies the newest company response', async ({ page }) => {
  const state = await openBoard(page, { deferAssignment: true });
  await invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Assign invoice ENT-E2E-001/ }).click();
  await expect.poll(() => state.assignmentBodies.length).toBe(1);

  await page.locator('#companyFilter').selectOption('sdn_bhd');
  await page.waitForTimeout(100);
  expect(state.invoiceCompanies).toEqual(['all']);

  state.assignmentGate.resolve();
  await expect.poll(() => state.invoiceCompanies.filter((company) => company === 'sdn_bhd').length).toBeGreaterThan(0);
  await expect(page.locator('#statusMessage')).toContainText('Assignment saved');
  await expect(page.locator('#companyFilter')).toHaveValue('sdn_bhd');
  await expect(page.locator('#unassignedList')).toContainText('SDN-E2E-001');
  await expect(page.locator('#unassignedList')).not.toContainText('ENT-E2E-001');
});

test('one shared lock disables Board and resource writes until resource read-back completes', async ({ page }) => {
  const state = await openBoard(page, { deferResourceUpdate: true });
  await page.locator('#resourcesTab').click();
  const resourceToggle = page.getByRole('button', { name: 'Deactivate driver Aiman Driver' });
  await expect(resourceToggle).toBeVisible();
  await resourceToggle.click();
  await expect.poll(() => state.resourceWrites).toBe(1);

  await expect(page.locator('#resourceSubmit')).toBeDisabled();
  await page.locator('#boardTab').click();
  await expect(page.getByRole('button', { name: /New trip/ })).toBeDisabled();
  await expect(page.locator('[data-assign-selected="101"]')).toBeDisabled();

  state.resourceUpdateGate.resolve();
  await expect(page.getByRole('button', { name: /New trip/ })).toBeEnabled();
});

test('partial source is visible and offline state disables mutations without fixture fallback', async ({ page, context }) => {
  await openBoard(page, { partialSource: true });
  await expect(page.locator('#sourceStatus')).toContainText('Sdn Bhd source unavailable');
  await context.setOffline(true);
  await expect(page.locator('#offlineStatus')).toContainText('Offline');
  await expect(page.locator('[data-assign-selected="101"]')).toBeDisabled();
  await expect(page.getByRole('button', { name: /New trip/ })).toBeDisabled();

  await context.setOffline(false);
  await expect(page.locator('#offlineStatus')).toBeHidden();
  await expect(page.locator('[data-assign-selected="101"]')).toBeEnabled();
  await expect(page.getByRole('button', { name: /New trip/ })).toBeEnabled();
});

test('a missing required source is reported as partial instead of healthy', async ({ page }) => {
  await openBoard(page, { missingSource: true });

  await expect(page.locator('#sourceStatus')).toContainText('Sdn Bhd source unavailable');
  await expect(page.locator('#sourceStatus')).not.toContainText('sources ready');
});

test('HTTP 401 with an arbitrary body clears the Board and returns to login', async ({ page }) => {
  await openBoard(page, { unauthorizedOnRefresh: true });

  await page.locator('#refreshBoard').click();

  await expect(page.locator('#loginView')).toBeVisible();
  await expect(page.locator('#authenticatedView')).toBeHidden();
  await expect(page.locator('#loginMessage')).toContainText('session has expired');
  await expect(page.locator('#unassignedList')).not.toContainText('ENT-E2E-001');
});

test('changing company during a load applies only the newest filter response and settles loading', async ({ page }) => {
  const state = await openBoard(page, { deferEnterpriseFilter: true });

  await page.locator('#companyFilter').selectOption('enterprise');
  await expect.poll(() => state.invoiceCompanies.filter((company) => company === 'enterprise').length).toBe(1);
  await page.locator('#companyFilter').selectOption('sdn_bhd');

  await expect(page.locator('#unassignedList')).toContainText('SDN-E2E-001');
  await expect(page.locator('#unassignedList')).not.toContainText('ENT-E2E-001');
  state.enterpriseFilterGate.resolve();
  await expect(page.locator('#boardState')).not.toContainText('Loading');
  await expect(page.locator('#unassignedList')).toContainText('SDN-E2E-001');
  await expect(page.locator('#unassignedList')).not.toContainText('ENT-E2E-001');
});

test('generic Board failure is visible and the retry control restores the authenticated feed', async ({ page }) => {
  const state = await installFixtureApi(page, { boardError: true });
  await page.goto('/dispatch.html');
  await expect(page.locator('#authenticatedView')).toBeVisible();
  await expect(page.locator('#boardState')).toContainText('could not be loaded');
  await expect(page.locator('#unassignedList')).not.toContainText('ENT-SI-0001');
  await expect(page.getByRole('button', { name: /New trip/ })).toBeDisabled();
  await expect(page.locator('#refreshBoard')).toHaveText('Retry board');
  await page.locator('#refreshBoard').click();
  await expect(page.getByRole('heading', { name: 'Unassigned invoices' })).toBeVisible();
  expect(state.counts.invoiceReads).toBe(2);
});

test('loading starts with an empty non-writable Board until the first authoritative response', async ({ page }) => {
  const state = await installFixtureApi(page, { deferInitialBoard: true });
  await page.goto('/dispatch.html');

  await expect(page.locator('#authenticatedView')).toBeVisible();
  await expect(page.locator('#boardState')).toContainText('Loading the authenticated Board');
  await expect(page.locator('#unassignedList')).not.toContainText('ENT-SI-0001');
  await expect(page.getByRole('button', { name: /New trip/ })).toBeDisabled();

  state.initialBoardGate.resolve();
  await expect(page.locator('#unassignedList')).toContainText('ENT-E2E-001');
  await expect(page.getByRole('button', { name: /New trip/ })).toBeEnabled();
});
