import test from 'node:test';
import assert from 'node:assert/strict';

import { createDispatchState } from '../public/dispatch-state.mjs';
import { renderDispatchBoard, renderInvoiceCard } from '../public/dispatch.js';

const invoice = {
  companyKey: 'enterprise',
  invoiceId: 'enterprise-doc-001',
  docKey: 'enterprise-doc-001',
  docNo: 'ENT-001',
  docDate: '2026-08-28',
  customer: { name: 'Enterprise Customer' },
  deliveryAddress: 'Enterprise Address',
  cancelled: false,
  eligibility: 'eligible',
  items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
};
const driver = { id: 1, name: 'Aiman Driver', licenseNo: 'D-1001', active: true };
const lorry = { id: 2, registrationNo: 'WXY 1001', description: '10-ton lorry', active: true };
const trip = {
  id: 101, tripDate: '2026-08-28', driverId: 1, vehicleId: 2, driver, lorry,
  routeNotes: 'North route', status: 'planned', revision: 1, invoiceKeys: [],
};
const resources = { drivers: [driver], lorries: [lorry] };

const BOARD_IDS = [
  'unassignedList', 'unassignedCount', 'companyFilter', 'queueKey', 'invoiceSearch', 'lorryBoard',
  'boardDateLabel', 'sourceStatus', 'boardState', 'statusMessage', 'newTripButton', 'refreshBoard',
  'selectionSummary',
];
const PLAN_IDS = ['boardLayout', 'loadingPlan', 'queueHelp'];

function createBoardRoot(ids = [...BOARD_IDS, ...PLAN_IDS]) {
  const elements = new Map(ids.map((id) => [id, {
    id, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '',
    dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
  }]));
  return {
    elements,
    root: { querySelector: (selector) => (selector.startsWith('#') ? elements.get(selector.slice(1)) ?? null : null) },
  };
}

test('Board hides the loading plan and drops assignment controls while no trip exists', () => {
  const { elements, root } = createBoardRoot();
  const state = createDispatchState({ invoices: [invoice], trips: [] });

  renderDispatchBoard(root, state, { writesEnabled: true, resources });

  assert.equal(elements.get('loadingPlan').hidden, true);
  assert.equal(elements.get('boardLayout').dataset.hasTrips, 'false');
  assert.match(elements.get('queueHelp').textContent, /Add a trip to open the loading plan/);
  const queue = elements.get('unassignedList').innerHTML;
  assert.match(queue, /data-select-invoice=/);
  assert.doesNotMatch(queue, /data-assign-invoice=/);
  assert.doesNotMatch(queue, /Drag \/ select/);
  assert.match(queue, /draggable="false"/);
  assert.equal(elements.get('newTripButton').disabled, false);
});

test('Board shows the loading plan and assignment controls once a trip exists', () => {
  const { elements, root } = createBoardRoot();
  const state = createDispatchState({ invoices: [invoice], trips: [trip] });

  renderDispatchBoard(root, state, { writesEnabled: true, resources });

  assert.equal(elements.get('loadingPlan').hidden, false);
  assert.equal(elements.get('boardLayout').dataset.hasTrips, 'true');
  assert.match(elements.get('queueHelp').textContent, /Drag on desktop/);
  const queue = elements.get('unassignedList').innerHTML;
  assert.match(queue, /data-assign-invoice=/);
  assert.match(queue, /Drag \/ select/);
  assert.match(queue, /draggable="true"/);
  assert.match(elements.get('lorryBoard').innerHTML, /data-trip-id="101"/);
});

test('Board hides the loading plan again when the trips disappear', () => {
  const { elements, root } = createBoardRoot();

  renderDispatchBoard(root, createDispatchState({ invoices: [invoice], trips: [trip] }), { writesEnabled: true, resources });
  assert.equal(elements.get('loadingPlan').hidden, false);

  renderDispatchBoard(root, createDispatchState({ invoices: [invoice], trips: [] }), { writesEnabled: true, resources });
  assert.equal(elements.get('loadingPlan').hidden, true);
  assert.equal(elements.get('boardLayout').dataset.hasTrips, 'false');
});

test('Board render tolerates a shell without the loading-plan hooks', () => {
  const { elements, root } = createBoardRoot(BOARD_IDS);
  const state = createDispatchState({ invoices: [invoice], trips: [trip] });

  assert.doesNotThrow(() => renderDispatchBoard(root, state, { writesEnabled: true, resources }));
  assert.match(elements.get('unassignedList').innerHTML, /data-assign-invoice=/);
});

test('invoice card omits assignment controls when assignable is false and keeps them by default', () => {
  const unassigned = createDispatchState({ invoices: [invoice] }).invoices[0];

  const locked = renderInvoiceCard(unassigned, { rail: true, assignable: false });
  assert.doesNotMatch(locked, /data-assign-invoice=/);
  assert.doesNotMatch(locked, /Drag \/ select/);
  assert.match(locked, /draggable="false"/);
  assert.match(locked, /data-select-invoice=/);

  const open = renderInvoiceCard(unassigned, { rail: true });
  assert.match(open, /data-assign-invoice=/);
  assert.match(open, /Drag \/ select/);
  assert.match(open, /draggable="true"/);
});

test('assigned invoice cards stay removable regardless of assignable', () => {
  const state = createDispatchState({
    invoices: [invoice],
    trips: [trip],
    assignments: [{
      id: 40, tripId: 101, companyKey: 'enterprise', invoiceId: 'enterprise-doc-001',
      docNo: 'ENT-001', docDate: '2026-08-28', status: 'assigned',
      header: { customer: invoice.customer, deliveryAddress: invoice.deliveryAddress }, items: invoice.items,
    }],
  });

  const markup = renderInvoiceCard(state.invoices[0], { inTrip: true, assignable: false, tripId: 101 });

  assert.match(markup, /data-remove-assignment=/);
  assert.match(markup, /Drag \/ select/);
  assert.match(markup, /draggable="true"/);
});
