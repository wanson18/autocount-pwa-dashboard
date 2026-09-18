const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

let staticServer;
test.beforeAll(async () => {
  staticServer = http.createServer((request, response) => {
    const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
    const filePath = path.join(__dirname, '..', '..', 'public', requested.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const contentType = filePath.endsWith('.css')
      ? 'text/css'
      : filePath.endsWith('.mjs') || filePath.endsWith('.js')
        ? 'text/javascript'
        : 'text/html';
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => staticServer.listen(4173, '127.0.0.1', resolve));
});
test.afterAll(async () => {
  await new Promise((resolve) => staticServer.close(resolve));
});

const SALES_PAYLOAD = {
  success: true,
  dateRange: { startDate: '2026-09-12', endDate: '2026-09-12' },
  timestamp: '2026-09-12T08:00:00Z',
  complete: true,
  companies: [
    {
      id: 'enterprise',
      name: 'Wanson Enterprise',
      accountBookId: '63750',
      status: 'ok',
      invoiceCount: 1,
      totalRevenue: 645,
    },
    { id: 'sdnBhd', name: 'Wanson Sdn Bhd', accountBookId: '63688', status: 'ok', invoiceCount: 1, totalRevenue: 700 },
  ],
  kpis: { totalRevenue: 1345, totalInvoices: 2, totalItemsSold: 9, topCustomer: { name: 'Alpha Mart' } },
  topSKUs: [
    { sku: 'TEPUNG-1KG', description: 'Tepung Beras 1KG', totalRevenue: 700, totalUnits: 7 },
    { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L', totalRevenue: 645, totalUnits: 2 },
  ],
  skuBreakdown: [
    {
      sku: 'TEPUNG-1KG',
      description: 'Tepung Beras 1KG',
      companyId: 'sdnBhd',
      companyName: 'Wanson Sdn Bhd',
      totalUnits: 7,
      totalRevenue: 700,
      customers: [{ companyId: 'sdnBhd', companyName: 'Wanson Sdn Bhd', name: 'Alpha Mart', quantity: 7 }],
    },
    {
      sku: 'OIL-PKO-20L',
      description: 'Palm Kernel Oil 20L',
      companyId: 'enterprise',
      companyName: 'Wanson Enterprise',
      totalUnits: 2,
      totalRevenue: 645,
      customers: [{ companyId: 'enterprise', companyName: 'Wanson Enterprise', name: 'Alpha Mart', quantity: 2 }],
    },
  ],
  paymentSummary: {
    paid: { count: 1, total: 700 },
    partial: { count: 1, outstanding: 50 },
    unpaid: { count: 0, total: 0 },
    unknown: { count: 0, total: 0 },
    stillUnpaidTotal: 50,
  },
  invoices: [
    {
      docNo: 'SI-ENT-001',
      companyId: 'enterprise',
      companyName: 'Wanson Enterprise',
      customerName: 'Alpha Mart',
      grandTotal: 645,
      outstandingAmount: 50,
      paymentStatus: 'partial',
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L', quantity: 2, unitPrice: 322.5, total: 645 },
      ],
    },
    {
      docNo: 'SI-SDN-001',
      companyId: 'sdnBhd',
      companyName: 'Wanson Sdn Bhd',
      customerName: 'Beta Store',
      grandTotal: 700,
      outstandingAmount: 0,
      paymentStatus: 'paid',
      lineItems: [{ sku: 'TEPUNG-1KG', description: 'Tepung Beras 1KG', quantity: 7, unitPrice: 100, total: 700 }],
    },
  ],
};

async function openDashboard(page) {
  // Stub the Tailwind and Chart.js CDNs so the page renders without network access.
  await page.route('https://cdn.tailwindcss.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.route('**/api/sales**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(SALES_PAYLOAD) }),
  );
  await page.goto('/');
  await expect(page.locator('#skuTableBody tr[data-row]')).toHaveCount(2);
}

async function detailRowFor(page, skuCode) {
  const skuRow = page.locator('tr.sku-row', { hasText: skuCode });
  await expect(skuRow).toHaveCount(1);
  await skuRow.click();
  const detailRow = page.locator(`#detail-${await skuRow.getAttribute('data-row')}`);
  await expect(detailRow).not.toHaveClass(/\bhidden\b/);
  return detailRow;
}

test('product row drills into the customer item list without collapsing the row', async ({ page }) => {
  await openDashboard(page);
  const detailRow = await detailRowFor(page, 'OIL-PKO-20L');

  const toggle = detailRow.locator('[data-customer-toggle]');
  const items = detailRow.locator('[data-customer-detail]');
  await expect(toggle).toContainText('Alpha Mart');
  await expect(toggle).toContainText('Wanson Enterprise');
  await expect(items).toHaveClass(/\bhidden\b/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle.locator('[data-customer-chevron]')).toHaveClass(/rotate-90/);
  await expect(items).not.toHaveClass(/\bhidden\b/);
  await expect(items).toContainText('Palm Kernel Oil 20L · OIL-PKO-20L');
  await expect(items).toContainText(/\b2\b/);
  await expect(items).not.toContainText('Tepung Beras 1KG');
  // Clicking a nested customer toggle must not bubble up and collapse the product row.
  await expect(detailRow).not.toHaveClass(/\bhidden\b/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(items).toHaveClass(/\bhidden\b/);
  await expect(detailRow).not.toHaveClass(/\bhidden\b/);
});

test('the same customer and item code stay scoped to their own company book', async ({ page }) => {
  await openDashboard(page);
  const detailRow = await detailRowFor(page, 'TEPUNG-1KG');

  const toggle = detailRow.locator('[data-customer-toggle]');
  await expect(toggle).toContainText('Alpha Mart');
  await toggle.click();

  const items = detailRow.locator('[data-customer-detail]');
  await expect(items).not.toHaveClass(/\bhidden\b/);
  await expect(items).toContainText('Tepung Beras 1KG · TEPUNG-1KG');
  await expect(items).toContainText(/\b7\b/);
  await expect(items).not.toContainText('Palm Kernel Oil 20L');
});

test("today's invoice dropdown reveals payment status and its line items", async ({ page }) => {
  await openDashboard(page);
  await page.locator('#toggleInvoiceListBtn').click();

  const list = page.locator('#paymentInvoiceList');
  await expect(list).not.toHaveClass(/\bhidden\b/);

  const entry = list.locator('[data-invoice-entry]', { hasText: 'SI-ENT-001' });
  const toggle = entry.locator('[data-invoice-toggle]');
  const detail = entry.locator('[data-invoice-detail]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(detail).toHaveClass(/\bhidden\b/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle.locator('[data-invoice-chevron]')).toHaveClass(/rotate-90/);
  await expect(detail).not.toHaveClass(/\bhidden\b/);
  await expect(detail).toContainText('Payment status');
  await expect(detail).toContainText('Palm Kernel Oil 20L · OIL-PKO-20L');
  await expect(detail).toContainText('2 · RM 645.00');
  await expect(detail).not.toContainText('Tepung Beras 1KG');

  const otherEntry = list.locator('[data-invoice-entry]', { hasText: 'SI-SDN-001' });
  await expect(otherEntry.locator('[data-invoice-detail]')).toHaveClass(/\bhidden\b/);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(detail).toHaveClass(/\bhidden\b/);
});
