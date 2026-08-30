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

const sheet = {
  trip: {
    id: 77, tripDate: '2026-08-28', status: 'loading', routeNotes: 'North route',
    driver: { name: 'Aiman Driver' }, lorry: { registrationNo: 'WXY 1001' },
  },
  counts: { enterprise: 1, sdn_bhd: 1, total: 2 },
  items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil', uom: 'CTN', enterprise: '0.30', sdn_bhd: '3.000', total: '3.300' }],
  invoices: [
    { companyKey: 'enterprise', invoiceId: 'e-1', docNo: 'ENT-001', docDate: '2026-08-28', customer: { code: 'E-1', name: 'Enterprise Customer' }, status: 'assigned' },
    { companyKey: 'sdn_bhd', invoiceId: 's-1', docNo: 'SDN-001', docDate: '2026-08-28', customer: { code: 'S-1', name: 'Sdn Customer' }, status: 'returned' },
  ],
};

const report = {
  records: [
    { tripId: 77, tripDate: '2026-08-28', tripStatus: 'completed', driver: { name: 'Aiman Driver' }, lorry: { registrationNo: 'WXY 1001' }, route: 'North route', companyKey: 'enterprise', invoiceId: 'e-1', docNo: 'ENT-001', docDate: '2026-08-28', customer: { name: 'Enterprise Customer' }, assignmentStatus: 'delivered', assignedAt: '2026-08-27T16:00:00.000Z', updatedAt: '2026-08-28T02:00:00.000Z' },
    { tripId: 77, tripDate: '2026-08-28', tripStatus: 'completed', driver: { name: 'Aiman Driver' }, lorry: { registrationNo: 'WXY 1001' }, route: 'North route', companyKey: 'sdn_bhd', invoiceId: 's-1', docNo: 'SDN-001', docDate: '2026-08-28', customer: { name: 'Sdn Customer' }, assignmentStatus: 'returned', assignedAt: '2026-08-27T17:00:00.000Z', updatedAt: '2026-08-28T03:00:00.000Z' },
  ],
};

async function json(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installApi(page, { loadingFailures = 0 } = {}) {
  const state = { loadingReads: 0, reportQueries: [] };
  await page.route('**/api/dispatch/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/dispatch/session' && request.method() === 'GET') {
      return json(route, { success: true, authenticated: true, session: { clerkId: 'clerk-e2e', role: 'clerk' } });
    }
    if (url.pathname === '/api/dispatch/loading-sheet' && request.method() === 'GET') {
      state.loadingReads += 1;
      if (state.loadingReads <= loadingFailures) return json(route, { success: false, error: { code: 'source_unavailable' } }, 503);
      return json(route, { success: true, sheet });
    }
    if (url.pathname === '/api/dispatch/reports' && request.method() === 'GET') {
      state.reportQueries.push(Object.fromEntries(url.searchParams.entries()));
      if (url.searchParams.get('format') === 'csv') {
        return route.fulfill({ status: 200, contentType: 'text/csv', body: 'trip_id,company\r\n77,enterprise\r\n' });
      }
      return json(route, { success: true, startDate: '2026-08-28', endDate: '2026-08-28', records: report.records });
    }
    if (url.pathname === '/api/dispatch/invoices' && request.method() === 'GET') {
      return json(route, { success: true, dateRange: { startDate: '2026-08-28', endDate: '2026-08-28' }, invoices: [], sources: { enterprise: { status: 'ok' }, sdn_bhd: { status: 'ok' } } });
    }
    if (url.pathname === '/api/dispatch/trips' && request.method() === 'GET') {
      return json(route, { success: true, trips: [{ id: 77, tripDate: '2026-08-28', driver: { name: 'Aiman Driver' }, lorry: { registrationNo: 'WXY 1001' }, status: 'loading', revision: 1, assignments: [] }] });
    }
    if (url.pathname === '/api/dispatch/assignments' && request.method() === 'GET') {
      return json(route, { success: true, assignments: [] });
    }
    if (url.pathname === '/api/dispatch/resources' && request.method() === 'GET') {
      return json(route, { success: true, active: 'true', drivers: [{ id: 4, name: 'Aiman Driver', licenseNo: 'D-004', active: true }], lorries: [{ id: 8, registrationNo: 'WXY 1001', active: true }] });
    }
    return json(route, { success: false, error: { code: 'not_found' } }, 404);
  });
  return state;
}

test('Board gives every trip a same-origin Print Items link and the loading page renders mixed-company snapshots', async ({ page }) => {
  const state = await installApi(page);
  await page.goto('/dispatch.html');
  await expect(page.locator('[data-trip-id="77"]')).toBeVisible();
  const printLink = page.locator('[data-trip-id="77"] [data-print-items-trip]');
  await expect(printLink).toHaveAttribute('href', '/loading-sheet.html?trip_id=77');

  await page.goto('/loading-sheet.html?trip_id=77');
  await expect(page.getByRole('heading', { name: 'Trip 77 loading sheet' })).toBeVisible();
  await expect(page.locator('#sheetContent')).toContainText('Enterprise');
  await expect(page.locator('#sheetContent')).toContainText('Sdn Bhd');
  await expect(page.locator('#sheetContent')).toContainText('3.300');
  await expect(page.locator('#printButton')).toBeEnabled();
  expect(state.loadingReads).toBe(1);
});

test('loading page exposes error and retry states and only enables Print after authoritative reload', async ({ page }) => {
  const state = await installApi(page, { loadingFailures: 1 });
  await page.goto('/loading-sheet.html?trip_id=77');
  await expect(page.locator('#loadingState')).toContainText('could not be loaded');
  await expect(page.locator('#retryButton')).toBeVisible();
  await expect(page.locator('#printButton')).toBeDisabled();
  await page.locator('#retryButton').click();
  await expect(page.locator('#sheetContent')).toBeVisible();
  await expect(page.locator('#printButton')).toBeEnabled();
  expect(state.loadingReads).toBe(2);
});

test('Reports tab loads inclusive filters, displays company tags, and exports CSV without leaving the session boundary', async ({ page }) => {
  const state = await installApi(page);
  await page.goto('/dispatch.html');
  await page.getByRole('tab', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Delivery reports' })).toBeVisible();
  await expect(page.locator('#reportTable')).toContainText('Enterprise');
  await expect(page.locator('#reportTable')).toContainText('Sdn Bhd');
  await page.locator('#reportCompany').selectOption('sdn_bhd');
  await page.locator('#reportStartDate').fill('2026-08-28');
  await page.locator('#reportEndDate').fill('2026-08-28');
  await page.getByRole('button', { name: 'Load report' }).click();
  await expect.poll(() => state.reportQueries.length).toBeGreaterThan(1);
  expect(state.reportQueries.at(-1)).toEqual(expect.objectContaining({ startDate: '2026-08-28', endDate: '2026-08-28', company: 'sdn_bhd', format: 'json' }));
  await expect(page.locator('#reportTable')).toContainText('Sdn Bhd');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await download;
  expect(state.reportQueries.at(-1).format).toBe('csv');
});

test('loading print stylesheet is A4 portrait, hides controls, and repeats item headers', async ({ page }) => {
  await installApi(page);
  await page.goto('/loading-sheet.html?trip_id=77');
  const css = await page.evaluate(async () => fetch('/loading-sheet.css').then((response) => response.text()));
  expect(css).toMatch(/@page\s*\{[^}]*size:\s*A4\s+portrait/i);
  expect(css).toMatch(/@media\s+print/i);
  expect(css).toMatch(/display:\s*none/);
  expect(css).toMatch(/table-header-group/);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#printButton')).toBeHidden();
  await expect(page.locator('.items-table thead')).toBeVisible();
});
