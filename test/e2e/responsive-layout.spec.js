const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

// One layout, two shapes: phones get a single column with back buttons and
// shortcut cards; screens from 960px up get the app bar with the page links.
// The desktop project runs at 1280px and the mobile project at Pixel 5 width.

const TYPES = {
  '.css': 'text/css',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

let staticServer;
test.beforeAll(async () => {
  staticServer = http.createServer((request, response) => {
    const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    const filePath = path.join(__dirname, '..', '..', 'public', requested.replace(/^\//, ''));
    if (!filePath.startsWith(path.join(__dirname, '..', '..', 'public')) || !fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'text/html' });
    response.end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => staticServer.listen(4173, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  await new Promise((resolve) => staticServer.close(resolve));
});

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const SALES = {
  success: true,
  dateRange: { startDate: '2026-10-06', endDate: '2026-10-06' },
  timestamp: '2026-10-06T02:42:00Z',
  complete: true,
  companies: [
    { id: 'enterprise', name: 'Wanson Enterprise', status: 'ok', invoiceCount: 1 },
    { id: 'sdnBhd', name: 'Wanson Enterprise (M) Sdn Bhd', status: 'ok', invoiceCount: 1 },
  ],
  kpis: { totalRevenue: 1345, totalInvoices: 2, totalItemsSold: 9, topCustomer: { name: 'Alpha Mart' } },
  topSKUs: [{ sku: 'OIL-5KG', description: 'Cooking Oil 5KG', totalRevenue: 700, totalUnits: 7 }],
  skuBreakdown: [
    { sku: 'OIL-5KG', description: 'Cooking Oil 5KG', unit: 'BTL', companyName: 'Wanson Enterprise', totalUnits: 7, totalRevenue: 700, customers: [] },
  ],
  paymentSummary: {
    paid: { count: 1, total: 700 },
    partial: { count: 0, outstanding: 0 },
    unpaid: { count: 1, total: 645 },
    unknown: { count: 0, total: 0 },
    stillUnpaidTotal: 645,
  },
  invoices: [
    { docNo: 'SI-1', companyName: 'Wanson Enterprise', customerName: 'Alpha Mart', grandTotal: 700, outstandingAmount: 0, paymentStatus: 'paid', lineItems: [] },
    { docNo: 'SI-2', companyName: 'Wanson Enterprise (M) Sdn Bhd', customerName: 'Beta Store', grandTotal: 645, outstandingAmount: 645, paymentStatus: 'unpaid', lineItems: [] },
  ],
};

async function stubShell(page) {
  await page.route('https://cdn.tailwindcss.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
}

async function expectNoSidewaysScroll(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'page must not scroll sideways').toBeLessThanOrEqual(0);
}

async function expectNavFor(page, wide, { pageName, phoneControl }) {
  const nav = page.locator('.app-nav');
  if (wide) {
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: pageName })).toHaveAttribute('aria-current', 'page');
    for (const name of ['Dashboard', "Today's Invoices", 'Delivery Dispatch', 'Price Check']) {
      await expect(nav.getByRole('link', { name })).toBeVisible();
    }
    await expect(phoneControl).toBeHidden();
  } else {
    await expect(nav).toBeHidden();
    await expect(phoneControl).toBeVisible();
  }
}

test('the self-hosted font file loads', async ({ page }) => {
  await stubShell(page);
  await page.route('**/api/dispatch/session', (route) => json(route, { success: true, authenticated: false }));
  await page.goto('/');
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('700 16px "Nunito Sans"');
    return document.fonts.check('700 16px "Nunito Sans"');
  });
  expect(loaded).toBe(true);
});

test('dashboard: app bar and grid on wide screens, shortcut cards on phones', async ({ page }, testInfo) => {
  const wide = testInfo.project.name === 'desktop';
  await stubShell(page);
  await page.route('**/api/dispatch/session', (route) =>
    json(route, { success: true, authenticated: true, session: { clerkId: 'clerk-e2e', role: 'clerk' } }),
  );
  await page.route('**/api/sales**', (route) => json(route, SALES));
  await page.goto('/');
  await expect(page.locator('#skuTableBody tr[data-row]')).toHaveCount(1);
  await expect(page.locator('#kpiRevenueValue')).toHaveText('RM 1,345.00');
  await expect(page.locator('#topProducts li')).toHaveCount(1);
  await expect(page.locator('#unitsLegend li')).toHaveCount(1);

  await expectNavFor(page, wide, { pageName: 'Dashboard', phoneControl: page.locator('.link-cards') });
  await expectNoSidewaysScroll(page);

  // Wide screens put payments and the top products side by side.
  const pay = await page.locator('.area-pay').boundingBox();
  const top = await page.locator('.area-top').boundingBox();
  if (wide) expect(Math.abs(pay.y - top.y)).toBeLessThan(4);
  else expect(top.y).toBeGreaterThan(pay.y + pay.height - 1);
});

test('signed-out dashboard shows only the sign-in card', async ({ page }) => {
  await stubShell(page);
  await page.route('**/api/dispatch/session', (route) => json(route, { success: true, authenticated: false }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(page.locator('#dashboardAppView')).toBeHidden();
  await expectNoSidewaysScroll(page);
});

test("today's invoices: table-style rows on wide screens, stacked rows on phones", async ({ page }, testInfo) => {
  const wide = testInfo.project.name === 'desktop';
  await stubShell(page);
  await page.route('**/api/sales**', (route) => json(route, SALES));
  await page.goto('/today-invoices.html');
  await expect(page.locator('.inv-row')).toHaveCount(2);
  await expectNavFor(page, wide, { pageName: "Today's Invoices", phoneControl: page.getByRole('link', { name: 'Back to dashboard' }) });
  await expectNoSidewaysScroll(page);
  if (wide) await expect(page.locator('#invoiceHead')).toBeVisible();
  else await expect(page.locator('#invoiceHead')).toBeHidden();
});

test('price check: two columns on wide screens, one column on phones', async ({ page }, testInfo) => {
  const wide = testInfo.project.name === 'desktop';
  await stubShell(page);
  await page.route('**/api/price-check*', (route) =>
    json(route, {
      status: 'PASS',
      scannedAt: '2026-10-06T02:42:00Z',
      window: { monitorFrom: '2026-10-06', historyFrom: '2026-07-08', through: '2026-10-06' },
      sources: [
        { companyKey: 'enterprise', companyName: 'Wanson Enterprise', ok: true },
        { companyKey: 'sdn_bhd', companyName: 'Wanson Enterprise (M) Sdn Bhd', ok: true },
      ],
      alerts: [],
      counts: {},
      cloudWrites: false,
    }),
  );
  await page.goto('/price-check.html');
  await expect(page.locator('#priceCheckStatus')).toContainText('PASS');
  await expectNavFor(page, wide, { pageName: 'Price Check', phoneControl: page.getByRole('link', { name: 'Back to Sales Dashboard' }) });
  await expectNoSidewaysScroll(page);
  const controls = await page.locator('.pc-layout > section').first().boundingBox();
  const result = await page.locator('#priceCheckResultView').boundingBox();
  if (wide) expect(result.x).toBeGreaterThan(controls.x + controls.width - 1);
  else expect(result.y).toBeGreaterThan(controls.y + controls.height - 1);
});

test('dispatch: app bar on wide screens; the loading plan appears beside the queue once a trip exists', async ({ page }, testInfo) => {
  const wide = testInfo.project.name === 'desktop';
  const trips = [];
  await page.route('**/api/dispatch/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/dispatch/session') return json(route, { success: true, authenticated: true, session: { clerkId: 'clerk-e2e', role: 'clerk' } });
    if (pathname === '/api/dispatch/resources') return json(route, { success: true, drivers: [{ type: 'driver', id: 1, name: 'Aiman Driver', licenseNo: 'D-1001', active: true }], lorries: [{ type: 'lorry', id: 2, registrationNo: 'WXY 1001', description: '', active: true }] });
    if (pathname === '/api/dispatch/invoices') return json(route, { success: true, dateRange: { startDate: '2026-10-06', endDate: '2026-10-06' }, company: 'all', invoices: [], sources: { enterprise: { status: 'ok', invoiceCount: 0 }, sdn_bhd: { status: 'ok', invoiceCount: 0 } } });
    if (pathname === '/api/dispatch/trips') return json(route, { success: true, trips });
    if (pathname === '/api/dispatch/assignments') return json(route, { success: true, assignments: [] });
    return json(route, { success: false, error: { code: 'not_found' } }, 404);
  });
  await page.goto('/dispatch.html');
  await expect(page.getByRole('heading', { name: 'Unassigned invoices' })).toBeVisible();
  await expectNavFor(page, wide, { pageName: 'Delivery Dispatch', phoneControl: page.getByRole('link', { name: 'Back to Sales Dashboard' }) });
  await expectNoSidewaysScroll(page);

  // No trip yet: the loading plan stays out of the way and the queue spans the whole board.
  await expect(page.locator('.lorry-board-section')).toBeHidden();
  const board = await page.locator('.board-layout').boundingBox();
  const queueAlone = await page.locator('.queue-panel').boundingBox();
  expect(queueAlone.width).toBeGreaterThanOrEqual(board.width - 1);

  // Once a trip exists the plan appears: beside the queue on wide screens, below it on phones.
  trips.push({ id: 101, tripDate: '2026-10-06', driverId: 1, vehicleId: 2, routeNotes: '', status: 'planned', revision: 1, assignments: [] });
  await page.locator('#refreshBoard').click();
  await expect(page.locator('.lorry-board-section')).toBeVisible();
  const queue = await page.locator('.queue-panel').boundingBox();
  const lanes = await page.locator('.lorry-board-section').boundingBox();
  if (wide) expect(lanes.x).toBeGreaterThan(queue.x + queue.width - 1);
  else expect(lanes.y).toBeGreaterThan(queue.y + queue.height - 1);
  await expectNoSidewaysScroll(page);
});
