import test from 'node:test';
import assert from 'node:assert/strict';

import { createInvoicePickerModel } from '../public/dispatch-invoice-picker.mjs';

const A = { companyKey: 'enterprise', invoiceId: 'A', docNo: 'IV-A', docDate: '2026-10-12', customer: { name: 'Alpha' }, cancelled: false, eligibility: 'eligible' };
const B = { companyKey: 'enterprise', invoiceId: 'B', docNo: 'IV-B', docDate: '2026-10-12', customer: { name: 'Beta' }, cancelled: false, eligibility: 'eligible' };
const C = { companyKey: 'sdn_bhd', invoiceId: 'C', docNo: 'IV-C', docDate: '2026-10-12', customer: { name: 'Gamma' }, cancelled: false, eligibility: 'eligible' };

function error(code) { const value = new Error(code); value.code = code; return value; }
let requestCounter = 0;
const createRequestId = () => `picker-request-${String(++requestCounter).padStart(4, '0')}`;

test('load returns only invoices not already on a trip', async () => {
  const model = createInvoicePickerModel({
    transport: { loadPickerInvoices: async () => ({ invoices: [A, B, C], assignments: [{ companyKey: 'enterprise', invoiceId: 'B', status: 'assigned' }], sources: {} }) },
    assignmentsTransport: {}, reloadTrip: async () => null, createRequestId,
  });
  const result = await model.load({ date: '2026-10-12', company: 'all' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.invoices.map((row) => row.invoiceId), ['A', 'C']);
});

test('load failure returns a friendly message with the formatted date', async () => {
  const model = createInvoicePickerModel({
    transport: { loadPickerInvoices: async () => { throw error('source_unavailable'); } },
    assignmentsTransport: {}, reloadTrip: async () => null, createRequestId,
  });
  const result = await model.load({ date: '2026-10-12', company: 'all' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /^Couldn't load invoices for .*2026.*\. Try again\.$/);
});

test('load rethrows unauthorized so the app can handle session loss', async () => {
  const model = createInvoicePickerModel({
    transport: { loadPickerInvoices: async () => { throw error('unauthorized'); } },
    assignmentsTransport: {}, reloadTrip: async () => null, createRequestId,
  });
  await assert.rejects(model.load({ date: '2026-10-12', company: 'all' }), (value) => value.code === 'unauthorized');
});

test('assign adds invoices one by one, carrying the trip revision forward', async () => {
  const bodies = [];
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async (body) => { bodies.push(body); return { tripRevision: body.expected_trip_revision + 1 }; } },
    reloadTrip: async () => null, createRequestId,
  });
  const outcome = await model.assign({ invoices: [A, C], trip: { id: 7, revision: 3 } });
  assert.deepEqual(bodies.map((body) => [body.invoice_id, body.company_key, body.doc_date, body.expected_trip_revision, body.trip_id]), [
    ['A', 'enterprise', '2026-10-12', 3, 7],
    ['C', 'sdn_bhd', '2026-10-12', 4, 7],
  ]);
  assert.deepEqual(outcome.results.map((row) => row.ok), [true, true]);
  assert.equal(outcome.tripRevision, 5);
});

test('assign keeps going after an already-assigned invoice and reports it', async () => {
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async (body) => { if (body.invoice_id === 'A') throw error('invoice_already_assigned'); return { tripRevision: body.expected_trip_revision + 1 }; } },
    reloadTrip: async () => null, createRequestId,
  });
  const outcome = await model.assign({ invoices: [A, B], trip: { id: 7, revision: 3 } });
  assert.deepEqual(outcome.results, [
    { key: 'enterprise:A', ok: false, message: 'Already on another trip.' },
    { key: 'enterprise:B', ok: true },
  ]);
});

test('assign retries once after a stale trip using the reloaded revision', async () => {
  const revisions = [];
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async (body) => { revisions.push(body.expected_trip_revision); if (body.expected_trip_revision === 3) throw error('stale_trip'); return { tripRevision: body.expected_trip_revision + 1 }; } },
    reloadTrip: async () => ({ id: 7, revision: 6 }), createRequestId,
  });
  const outcome = await model.assign({ invoices: [A], trip: { id: 7, revision: 3 } });
  assert.deepEqual(revisions, [3, 6]);
  assert.deepEqual(outcome.results, [{ key: 'enterprise:A', ok: true }]);
  assert.equal(outcome.tripRevision, 7);
});

test('assign gives up after a second stale trip', async () => {
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async () => { throw error('stale_trip'); } },
    reloadTrip: async () => ({ id: 7, revision: 6 }), createRequestId,
  });
  const outcome = await model.assign({ invoices: [A], trip: { id: 7, revision: 3 } });
  assert.deepEqual(outcome.results, [{ key: 'enterprise:A', ok: false, message: 'Trip changed — reopen and try again.' }]);
});

test('assign rethrows unauthorized immediately', async () => {
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async () => { throw error('unauthorized'); } },
    reloadTrip: async () => null, createRequestId,
  });
  await assert.rejects(model.assign({ invoices: [A, B], trip: { id: 7, revision: 3 } }), (value) => value.code === 'unauthorized');
});

test('load warns when a requested company book could not be read', async () => {
  const model = createInvoicePickerModel({
    transport: { loadPickerInvoices: async () => ({ invoices: [A], assignments: [], sources: { enterprise: { status: 'ok' }, sdn_bhd: { status: 'unavailable' } } }) },
    assignmentsTransport: {}, reloadTrip: async () => null, createRequestId,
  });
  const all = await model.load({ date: '2026-10-12', company: 'all' });
  assert.equal(all.status, 'ready');
  assert.equal(all.warning, "Sdn Bhd invoices couldn't be loaded, so this list may be incomplete.");
  const enterpriseOnly = await model.load({ date: '2026-10-12', company: 'enterprise' });
  assert.equal(enterpriseOnly.warning, '');
});

test('assign explains when the trip stopped taking invoices', async () => {
  const model = createInvoicePickerModel({
    transport: {},
    assignmentsTransport: { assignInvoice: async () => { throw error('invalid_transition'); } },
    reloadTrip: async () => null, createRequestId,
  });
  const outcome = await model.assign({ invoices: [A], trip: { id: 7, revision: 3 } });
  assert.deepEqual(outcome.results, [{ key: 'enterprise:A', ok: false, message: 'This trip is no longer taking invoices.' }]);
});
