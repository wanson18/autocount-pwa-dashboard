const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateBySKU, getLocalToday, normalizeInvoices, parseOutstandingAmount } = require('./sales.js');

test('aggregateBySKU groups quantity sold per customer, sorted descending', () => {
  const invoices = [
    {
      customerName: 'ABC Trading Sdn Bhd',
      grandTotal: 6250,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 50, unitPrice: 125, total: 6250 }
      ]
    },
    {
      customerName: 'XYZ Industries Ltd',
      grandTotal: 3750,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 30, unitPrice: 125, total: 3750 }
      ]
    },
    {
      customerName: 'ABC Trading Sdn Bhd',
      grandTotal: 1250,
      lineItems: [
        { sku: 'OIL-PKO-20L', description: 'Palm Kernel Oil 20L Drum', quantity: 10, unitPrice: 125, total: 1250 }
      ]
    }
  ];

  const [result] = aggregateBySKU(invoices);

  assert.equal(result.sku, 'OIL-PKO-20L');
  assert.deepEqual(result.customers, [
    { name: 'ABC Trading Sdn Bhd', quantity: 60 },
    { name: 'XYZ Industries Ltd', quantity: 30 }
  ]);
});

test('getLocalToday returns the UTC+8 date, not the UTC date, after 16:00 UTC', () => {
  // 2026-08-12 16:30 UTC is already 2026-08-13 00:30 in Kuala Lumpur.
  const now = new Date('2026-08-12T16:30:00Z');

  assert.equal(now.toISOString().slice(0, 10), '2026-08-12', 'sanity: UTC date is the previous day');
  assert.equal(getLocalToday('Asia/Kuala_Lumpur', now), '2026-08-13');
});

test('getLocalToday matches the UTC date during Malaysian business hours', () => {
  // 2026-08-12 04:00 UTC is 12:00 noon in Kuala Lumpur — same calendar day.
  const now = new Date('2026-08-12T04:00:00Z');

  assert.equal(getLocalToday('Asia/Kuala_Lumpur', now), '2026-08-12');
});

test('getLocalToday handles month and year rollover in local time', () => {
  const newYearEve = new Date('2026-12-31T16:00:00Z');
  assert.equal(getLocalToday('Asia/Kuala_Lumpur', newYearEve), '2027-01-01');

  const monthEnd = new Date('2026-08-31T17:00:00Z');
  assert.equal(getLocalToday('Asia/Kuala_Lumpur', monthEnd), '2026-09-01');
});

test('getLocalToday always emits a zero-padded YYYY-MM-DD string', () => {
  const earlyMonth = new Date('2026-01-05T02:00:00Z');
  const result = getLocalToday('Asia/Kuala_Lumpur', earlyMonth);

  assert.equal(result, '2026-01-05');
  assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
});

test('getLocalToday respects a different reporting timezone', () => {
  const now = new Date('2026-08-12T16:30:00Z');

  assert.equal(getLocalToday('UTC', now), '2026-08-12');
  assert.equal(getLocalToday('America/New_York', now), '2026-08-12');
});

test('getLocalToday falls back to the UTC date when the timezone is invalid', () => {
  const now = new Date('2026-08-12T16:30:00Z');

  assert.equal(getLocalToday('Not/AZone', now), '2026-08-12');
});

test('parseOutstandingAmount parses a numeric string and rounds to 2 decimals', () => {
  assert.equal(parseOutstandingAmount('1234.5678'), 1234.57);
});

test('parseOutstandingAmount returns null when the value is missing', () => {
  assert.equal(parseOutstandingAmount(undefined), null);
  assert.equal(parseOutstandingAmount(null), null);
});

test('parseOutstandingAmount returns null for a non-numeric value', () => {
  assert.equal(parseOutstandingAmount('not-a-number'), null);
});

test('normalizeInvoices reads outstandingAmount from the raw invoice master record', () => {
  const rawInvoices = [
    {
      master: {
        docNo: 'SI-001',
        docDate: '2026-08-14',
        debtorName: 'ABC Trading Sdn Bhd',
        finalTotal: '1000.00',
        outstandingAmount: '250.00'
      },
      details: []
    }
  ];

  const [result] = normalizeInvoices(rawInvoices);

  assert.equal(result.grandTotal, 1000);
  assert.equal(result.outstandingAmount, 250);
});

test('normalizeInvoices sets outstandingAmount to null when AutoCount does not return the field', () => {
  const rawInvoices = [
    {
      master: {
        docNo: 'SI-002',
        docDate: '2026-08-14',
        debtorName: 'XYZ Industries Ltd',
        finalTotal: '500.00'
      },
      details: []
    }
  ];

  const [result] = normalizeInvoices(rawInvoices);

  assert.equal(result.outstandingAmount, null);
});
