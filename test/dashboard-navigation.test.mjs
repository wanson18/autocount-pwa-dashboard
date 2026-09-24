import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('dashboard exposes Delivery Dispatch only when its destination page is present', () => {
  const dashboard = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(dashboard, /href=["']\/dispatch\.html["']/);
  assert.equal(existsSync(new URL('../public/dispatch.html', import.meta.url)), true);
});

test('dashboard quantities carry the resolved item unit', () => {
  const dashboard = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(dashboard, /function formatQuantity\(value, unit\)/);
  assert.match(dashboard, /formatQuantity\(s\.totalUnits, s\.unit\)/);
  assert.match(dashboard, /formatQuantity\(c\.quantity, unit\)/);
  assert.match(dashboard, /formatQuantity\(item\.quantity, item\.unit\)/);
});

test("today invoice dropdown renders every today's invoice with its payment status", () => {
  const dashboard = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(dashboard, /function getTodayInvoices\(data\)/);
  assert.match(dashboard, /Array\.isArray\(data\?\.invoices\) \? data\.invoices : \[\]/);
  assert.match(dashboard, /renderTodayPayments\(getTodayInvoices\(todayResult\.value\), todayResult\.value\.paymentSummary\)/);
  assert.match(dashboard, /Show today's invoices/);
  assert.match(dashboard, /Outstanding balance today/);
  assert.match(dashboard, /Payment status/);
});
