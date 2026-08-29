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
    assignmentBodies: [], tripBodies: [], counts: { trips: 0, assignments: 0, invoiceReads: 0 },
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

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installFixtureApi(page, { partialSource = false, assignmentMode = 'success', boardError = false } = {}) {
  const state = createServerState();
  state.boardError = boardError;
  await page.route('**/api/dispatch/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === '/api/dispatch/session' && request.method() === 'GET') {
      return json(route, { success: true, authenticated: true, session: { clerkId: 'clerk-e2e', role: 'clerk' } });
    }
    if (pathname === '/api/dispatch/session') return json(route, { success: true, authenticated: false, session: null });
    if (pathname === '/api/dispatch/resources' && request.method() === 'GET') {
      return json(route, { success: true, active: 'true', drivers: state.drivers, lorries: state.lorries });
    }
    if (pathname === '/api/dispatch/invoices' && request.method() === 'GET') {
      state.counts.invoiceReads += 1;
      if (state.boardError && state.counts.invoiceReads === 1) return json(route, { success: false, error: { code: 'source_unavailable' } }, 503);
      return json(route, {
        success: true, dateRange: { startDate: '2026-08-28', endDate: '2026-08-28' }, company: 'all',
        invoices: state.invoices, sources: {
          enterprise: { status: 'ok', invoiceCount: state.invoices.filter((row) => row.companyKey === 'enterprise').length },
          sdn_bhd: partialSource ? { status: 'unavailable', errorCode: 'source_unavailable' } : { status: 'ok', invoiceCount: 1 },
        },
      });
    }
    if (pathname === '/api/dispatch/trips' && request.method() === 'GET') {
      state.counts.trips += 1;
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

test('failed assignment rolls back exactly and announces the error', async ({ page }) => {
  const state = await openBoard(page, { assignmentMode: 'rollback' });
  const card = invoiceCard(page, 'ENT-E2E-001');
  await card.getByRole('button', { name: /Select invoice/ }).click();
  await page.locator('[data-trip-id="101"]').getByRole('button', { name: /Assign selected invoice/ }).click();
  await expect(page.locator('#statusMessage')).toContainText('could not be assigned');
  await expect(page.locator('#unassignedList')).toContainText('ENT-E2E-001');
  await expect(page.locator('[data-trip-id="101"] .invoice-card')).toHaveCount(0);
  await expect(page.locator('[data-assign-selected="101"]')).toBeEnabled();
  expect(state.assignmentBodies).toHaveLength(1);
});

test('stale trip conflict rolls back, refreshes authoritative trips, and then re-enables writes', async ({ page }) => {
  const state = await openBoard(page, { assignmentMode: 'stale' });
  await invoiceCard(page, 'ENT-E2E-001').getByRole('button', { name: /Select invoice/ }).click();
  const trip = page.locator('[data-trip-id="101"]');
  const tripReadsBefore = state.counts.trips;
  await trip.getByRole('button', { name: /Assign selected invoice/ }).click();
  await expect(page.locator('#statusMessage')).toContainText('changed on the server');
  await expect(page.locator('#unassignedList')).toContainText('ENT-E2E-001');
  await expect.poll(() => state.counts.trips).toBeGreaterThan(tripReadsBefore);
  await expect(trip.getByRole('button', { name: /Assign selected invoice/ })).toBeEnabled();
});

test('partial source is visible and offline state disables mutations without fixture fallback', async ({ page, context }) => {
  await openBoard(page, { partialSource: true });
  await expect(page.locator('#sourceStatus')).toContainText('Sdn Bhd source unavailable');
  await context.setOffline(true);
  await expect(page.locator('#offlineStatus')).toContainText('Offline');
  await expect(page.locator('[data-assign-selected="101"]')).toBeDisabled();
  await expect(page.getByRole('button', { name: /New trip/ })).toBeDisabled();
});

test('generic Board failure is visible and the retry control restores the authenticated feed', async ({ page }) => {
  const state = await installFixtureApi(page, { boardError: true });
  await page.goto('/dispatch.html');
  await expect(page.locator('#authenticatedView')).toBeVisible();
  await expect(page.locator('#boardState')).toContainText('could not be loaded');
  await expect(page.locator('#refreshBoard')).toHaveText('Retry board');
  await page.locator('#refreshBoard').click();
  await expect(page.getByRole('heading', { name: 'Unassigned invoices' })).toBeVisible();
  expect(state.counts.invoiceReads).toBe(2);
});
