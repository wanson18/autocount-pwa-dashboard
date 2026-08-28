import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beginOptimisticMove,
  createDispatchState,
  getInvoiceKey,
  getTripInvoices,
  rejectMoveResponse,
  selectInvoice,
  selectTrip,
  setCompanyFilter,
  settleMoveResponse,
  visibleUnassignedInvoices,
} from '../public/dispatch-state.mjs';

const invoices = [
  {
    companyKey: 'enterprise',
    invoiceId: 'shared-doc-001',
    docNo: 'ENT-001',
    customer: { name: 'Enterprise Customer' },
    items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
  },
  {
    companyKey: 'sdn_bhd',
    invoiceId: 'shared-doc-001',
    docNo: 'SDN-001',
    customer: { name: 'Sdn Bhd Customer' },
    items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '3.000', uom: 'CTN' }],
  },
  {
    companyKey: 'enterprise',
    invoiceId: 'enterprise-doc-002',
    docNo: 'ENT-002',
    customer: { name: 'Second Enterprise Customer' },
    items: [{ itemCode: 'AJINOMOTO', description: 'AJINOMOTO', quantity: '1', uom: 'CTN' }],
  },
];

const trips = [
  {
    id: 'trip-001',
    tripDate: '2026-08-28',
    driver: { name: 'Aiman Driver' },
    lorry: { registrationNo: 'WXY 1001' },
    invoiceKeys: [],
  },
];

test('combined filter returns unassigned invoices from both companies', () => {
  const state = createDispatchState({ invoices, trips });

  const visible = visibleUnassignedInvoices(setCompanyFilter(state, 'all'));

  assert.deepEqual(visible.map(getInvoiceKey), [
    'enterprise:shared-doc-001',
    'sdn_bhd:shared-doc-001',
    'enterprise:enterprise-doc-002',
  ]);
  assert.equal(visible[0].items[0].quantity, '2.125');
  assert.equal(visible[1].items[0].quantity, '3.000');
});

test('company filters narrow visibility without changing stable identity', () => {
  const state = createDispatchState({ invoices, trips });

  assert.equal(getInvoiceKey(invoices[0]), 'enterprise:shared-doc-001');
  assert.equal(getInvoiceKey(invoices[1]), 'sdn_bhd:shared-doc-001');
  assert.equal(visibleUnassignedInvoices(setCompanyFilter(state, 'enterprise')).length, 2);
  assert.equal(visibleUnassignedInvoices(setCompanyFilter(state, 'sdn_bhd')).length, 1);
});

test('selection keeps the chosen invoice and trip in pure state', () => {
  const state = createDispatchState({ invoices, trips });

  const selected = selectTrip(selectInvoice(state, 'sdn_bhd:shared-doc-001'), 'trip-001');

  assert.equal(selected.selectedInvoiceKey, 'sdn_bhd:shared-doc-001');
  assert.equal(selected.selectedTripId, 'trip-001');
});

test('optimistic move changes one invoice and rollback restores exact prior state', () => {
  const state = createDispatchState({ invoices, trips });
  const moved = beginOptimisticMove(state, {
    invoiceKey: 'sdn_bhd:shared-doc-001',
    tripId: 'trip-001',
    requestId: 'request-1',
  });

  assert.deepEqual(getTripInvoices(moved, 'trip-001').map(getInvoiceKey), ['sdn_bhd:shared-doc-001']);
  assert.equal(visibleUnassignedInvoices(moved).some((invoice) => getInvoiceKey(invoice) === 'sdn_bhd:shared-doc-001'), false);
  assert.equal(getTripInvoices(moved, 'trip-001')[0].items[0].quantity, '3.000');

  const rolledBack = rejectMoveResponse(moved, { requestId: 'request-1', message: 'Assignment was not saved.' });

  assert.deepEqual(getTripInvoices(rolledBack, 'trip-001'), []);
  assert.equal(visibleUnassignedInvoices(rolledBack).some((invoice) => getInvoiceKey(invoice) === 'sdn_bhd:shared-doc-001'), true);
  assert.equal(rolledBack.statusMessage, 'Assignment was not saved.');
});

test('stale move response is rejected without overwriting the newest optimistic move', () => {
  const state = createDispatchState({ invoices, trips: [...trips, { ...trips[0], id: 'trip-002', invoiceKeys: [] }] });
  const firstMove = beginOptimisticMove(state, {
    invoiceKey: 'enterprise:shared-doc-001',
    tripId: 'trip-001',
    requestId: 'request-old',
  });
  const newestMove = beginOptimisticMove(firstMove, {
    invoiceKey: 'enterprise:shared-doc-001',
    tripId: 'trip-002',
    requestId: 'request-new',
  });

  const afterStaleResponse = settleMoveResponse(newestMove, {
    requestId: 'request-old',
    accepted: false,
    message: 'Stale trip revision.',
  });

  assert.deepEqual(getTripInvoices(afterStaleResponse, 'trip-001'), []);
  assert.deepEqual(getTripInvoices(afterStaleResponse, 'trip-002').map(getInvoiceKey), ['enterprise:shared-doc-001']);
  assert.equal(afterStaleResponse.pendingMove.requestId, 'request-new');
  assert.equal(afterStaleResponse.lastMove.status, 'stale_rejected');
});
