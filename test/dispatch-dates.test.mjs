import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampToDispatchWindow,
  createDispatchState,
  filterPickerInvoices,
  filterUnassignedForDate,
  getDispatchWindow,
  getInvoiceDateTag,
  shiftDate,
} from '../public/dispatch-state.mjs';
import { createFetchTransport, renderInvoiceCard, renderTripCard } from '../public/dispatch.js';

const KL_NOON_14_OCT = new Date('2026-10-14T04:00:00Z');
const KL_JUST_AFTER_MIDNIGHT_15_OCT = new Date('2026-10-14T16:05:00Z');

test('shiftDate moves across month and year boundaries', () => {
  assert.equal(shiftDate('2026-10-14', -1), '2026-10-13');
  assert.equal(shiftDate('2026-10-01', -1), '2026-09-30');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
});

test('dispatch window is today ± 7 in Kuala Lumpur time', () => {
  assert.deepEqual(getDispatchWindow(KL_NOON_14_OCT), { today: '2026-10-14', minDate: '2026-10-07', maxDate: '2026-10-21' });
  assert.deepEqual(getDispatchWindow(KL_JUST_AFTER_MIDNIGHT_15_OCT), { today: '2026-10-15', minDate: '2026-10-08', maxDate: '2026-10-22' });
});

test('clampToDispatchWindow keeps dates inside the window and repairs bad input', () => {
  assert.equal(clampToDispatchWindow('2026-10-10', KL_NOON_14_OCT), '2026-10-10');
  assert.equal(clampToDispatchWindow('2026-10-01', KL_NOON_14_OCT), '2026-10-07');
  assert.equal(clampToDispatchWindow('2026-11-30', KL_NOON_14_OCT), '2026-10-21');
  assert.equal(clampToDispatchWindow('not-a-date', KL_NOON_14_OCT), '2026-10-14');
});

const pickerInvoices = [
  { companyKey: 'enterprise', invoiceId: 'E1', docNo: 'IV-1001', docDate: '2026-10-13', customer: { name: 'Kedai Ah Seng' }, cancelled: false, eligibility: 'eligible' },
  { companyKey: 'sdn_bhd', invoiceId: 'S1', docNo: 'IV-2001', docDate: '2026-10-13', customer: { name: 'Mini Market Ipoh' }, cancelled: false, eligibility: 'eligible' },
  { companyKey: 'enterprise', invoiceId: 'E2', docNo: 'IV-1002', docDate: '2026-10-13', customer: { name: 'Cancelled Co' }, cancelled: true, eligibility: 'eligible' },
  { companyKey: 'enterprise', invoiceId: 'E3', docNo: 'IV-1003', docDate: '2026-10-13', customer: { name: 'No UOM Sdn' }, cancelled: false, eligibility: 'blocked_missing_uom' },
];

test('filterUnassignedForDate drops assigned, cancelled, and blocked invoices', () => {
  const assignments = [{ companyKey: 'enterprise', invoiceId: 'E1', status: 'assigned' }];
  assert.deepEqual(filterUnassignedForDate(pickerInvoices, assignments).map((row) => row.invoiceId), ['S1']);
});

test('filterUnassignedForDate keys by company so the same invoice ID in the other book stays available', () => {
  const assignments = [{ companyKey: 'sdn_bhd', invoiceId: 'E1', status: 'assigned' }];
  assert.deepEqual(filterUnassignedForDate(pickerInvoices, assignments).map((row) => row.invoiceId), ['E1', 'S1']);
});

test('filterPickerInvoices matches doc no. or customer name, case-insensitive', () => {
  assert.deepEqual(filterPickerInvoices(pickerInvoices, 'iv-200').map((row) => row.invoiceId), ['S1']);
  assert.deepEqual(filterPickerInvoices(pickerInvoices, 'ah seng').map((row) => row.invoiceId), ['E1']);
  assert.equal(filterPickerInvoices(pickerInvoices, '  ').length, pickerInvoices.length);
});

test('getInvoiceDateTag labels older and later invoice dates against the trip date', () => {
  assert.equal(getInvoiceDateTag('2026-10-14', '2026-10-14'), null);
  assert.equal(getInvoiceDateTag('', '2026-10-14'), null);
  const older = getInvoiceDateTag('2026-10-12', '2026-10-14');
  assert.equal(older.kind, 'older');
  assert.match(older.label, /^Older · 12 Oct$/);
  const newer = getInvoiceDateTag('2026-10-15', '2026-10-14');
  assert.equal(newer.kind, 'newer');
  assert.match(newer.label, /^Dated · 15 Oct$/);
});

function recordingFetch(payloadFor) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, async json() { return payloadFor(url); } };
  };
  return { calls, fetchImpl };
}

test('board transport asks for assignments by the board date instead of the latest 100', async () => {
  const { calls, fetchImpl } = recordingFetch((url) => (
    url.includes('/invoices?') ? { success: true, invoices: [], sources: {}, dateRange: { startDate: '2026-10-13', endDate: '2026-10-13' } }
      : url.includes('/trips?') ? { success: true, trips: [] }
        : { success: true, assignments: [] }));
  await createFetchTransport({ fetchImpl }).loadBoard({ startDate: '2026-10-13', endDate: '2026-10-13', company: 'all' });
  const assignmentUrl = calls.find((url) => url.startsWith('/api/dispatch/assignments'));
  assert.equal(assignmentUrl, '/api/dispatch/assignments?doc_date=2026-10-13&limit=1000');
});

test('picker transport reads one date of invoices and that date’s active assignments', async () => {
  const invoices = [{ companyKey: 'enterprise', invoiceId: 'E1', docNo: 'IV-1' }];
  const assignments = [{ companyKey: 'enterprise', invoiceId: 'E9', status: 'assigned' }];
  const { calls, fetchImpl } = recordingFetch((url) => (
    url.includes('/invoices?') ? { success: true, invoices, sources: { enterprise: { status: 'ok' } } } : { success: true, assignments }));
  const result = await createFetchTransport({ fetchImpl }).loadPickerInvoices({ date: '2026-10-12', company: 'enterprise' });
  assert.deepEqual(calls.sort(), [
    '/api/dispatch/assignments?doc_date=2026-10-12&limit=1000',
    '/api/dispatch/invoices?startDate=2026-10-12&endDate=2026-10-12&company=enterprise',
  ]);
  assert.deepEqual(result, { invoices, assignments, sources: { enterprise: { status: 'ok' } } });
});

const OLD_INVOICE = {
  companyKey: 'enterprise', invoiceId: 'OLD-1', docKey: 'OLD-1', docNo: 'IV-OLD-1', docDate: '2026-10-12',
  customer: { name: 'Kedai Lama' }, deliveryAddress: 'Ipoh', cancelled: false, eligibility: 'eligible',
  items: [{ itemCode: 'OIL', description: 'Oil', quantity: '1', uom: 'CTN' }],
};

test('invoice card shows an Older tag when its date is before the reference date', () => {
  const html = renderInvoiceCard(OLD_INVOICE, { inTrip: true, referenceDate: '2026-10-14' });
  assert.match(html, /class="invoice-date-tag invoice-date-tag-older">Older · 12 Oct</);
  assert.doesNotMatch(renderInvoiceCard(OLD_INVOICE, { inTrip: true, referenceDate: '2026-10-12' }), /invoice-date-tag/);
  assert.doesNotMatch(renderInvoiceCard(OLD_INVOICE, { inTrip: true }), /invoice-date-tag/);
});

test('trip card tags an older invoice against the trip date', () => {
  const state = createDispatchState({
    invoices: [],
    trips: [{ id: 5, tripDate: '2026-10-14', driverId: 1, vehicleId: 2, revision: 2, status: 'planned',
      assignments: [{ id: 9, tripId: 5, companyKey: 'enterprise', invoiceId: 'OLD-1', docNo: 'IV-OLD-1', docDate: '2026-10-12', status: 'assigned',
        header: { customer: { name: 'Kedai Lama' } }, items: OLD_INVOICE.items }] }],
    dateRange: { startDate: '2026-10-14', endDate: '2026-10-14' },
  });
  assert.match(renderTripCard(state, state.trips[0]), /Older · 12 Oct/);
});

test('a failed invoice re-added to another trip shows only on the new trip, with the new assignment', () => {
  const header = { customer: { name: 'Kedai Ulang' } };
  const state = createDispatchState({
    trips: [
      { id: 1, tripDate: '2026-10-14', driverId: 1, vehicleId: 2, revision: 3, status: 'completed',
        assignments: [{ id: 10, tripId: 1, companyKey: 'enterprise', invoiceId: 'E1', docNo: 'IV-E1', docDate: '2026-10-13', status: 'failed', header, items: [] }] },
      { id: 2, tripDate: '2026-10-14', driverId: 1, vehicleId: 2, revision: 2, status: 'planned',
        assignments: [{ id: 20, tripId: 2, companyKey: 'enterprise', invoiceId: 'E1', docNo: 'IV-E1', docDate: '2026-10-13', status: 'assigned', header, items: [] }] },
    ],
    dateRange: { startDate: '2026-10-14', endDate: '2026-10-14' },
  });
  const key = 'enterprise:E1';
  assert.deepEqual(state.trips.map((trip) => [trip.id, trip.invoiceKeys.includes(key)]), [[1, false], [2, true]]);
  const invoice = state.invoices.find((row) => row.key === key);
  assert.equal(invoice.assignmentId, 20);
  assert.equal(invoice.assignmentStatus, 'assigned');
  assert.equal(String(invoice.tripId), '2');
});

test('a failed invoice that was not re-added still shows on its original trip', () => {
  const state = createDispatchState({
    trips: [{ id: 1, tripDate: '2026-10-14', driverId: 1, vehicleId: 2, revision: 3, status: 'completed',
      assignments: [{ id: 10, tripId: 1, companyKey: 'enterprise', invoiceId: 'E1', docNo: 'IV-E1', docDate: '2026-10-13', status: 'failed', header: {}, items: [] }] }],
    dateRange: { startDate: '2026-10-14', endDate: '2026-10-14' },
  });
  assert.ok(state.trips[0].invoiceKeys.includes('enterprise:E1'));
  assert.equal(state.invoices.find((row) => row.key === 'enterprise:E1').assignmentStatus, 'failed');
});
