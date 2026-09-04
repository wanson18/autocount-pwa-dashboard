import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDispatchState,
  getInvoiceKey,
  getLorryLanes,
  getTripInvoices,
  lorryIdOf,
} from '../public/dispatch-state.mjs';
import {
  createTripsTransport,
  renderInvoiceCard,
  renderLorryBoard,
  renderLorryLane,
} from '../public/dispatch.js';

const drivers = [{ id: 1, name: 'Aiman Driver', licenseNo: 'D-1001', active: true }];
const lorries = [
  { id: 2, registrationNo: 'WXY 1001', description: '10-ton lorry', active: true },
  { id: 3, registrationNo: 'WXY 1002', description: '5-ton lorry', active: true },
];

const enterpriseInvoice = {
  companyKey: 'enterprise',
  invoiceId: 'enterprise-doc-001',
  docKey: 'enterprise-doc-001',
  docNo: 'ENT-001',
  customer: { name: 'Enterprise Customer' },
  items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
};
const sdnBhdInvoice = {
  companyKey: 'sdn_bhd',
  invoiceId: 'sdn-bhd-doc-001',
  docKey: 'sdn-bhd-doc-001',
  docNo: 'SDN-001',
  customer: { name: 'Sdn Bhd Customer' },
  items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '3.000', uom: 'CTN' }],
};

const tripWithLorry = {
  id: 101,
  tripDate: '2026-08-28',
  driverId: 1,
  vehicleId: 2,
  driver: drivers[0],
  lorry: lorries[0],
  routeNotes: 'North route',
  status: 'planned',
  revision: 1,
  invoiceKeys: [],
};

test('getLorryLanes keeps every active lorry as a permanent lane, even with no trip', () => {
  const state = createDispatchState({ trips: [] });

  const lanes = getLorryLanes(state, { drivers, lorries });

  assert.deepEqual(lanes.map((lane) => lane.lorry.id), [2, 3]);
  assert.equal(lanes[0].trips.length, 0);
  assert.equal(lanes[1].trips.length, 0);
});

test('getLorryLanes groups trips under their lorry and keeps mixed-company identity', () => {
  const state = createDispatchState({
    invoices: [enterpriseInvoice, sdnBhdInvoice],
    trips: [{
      ...tripWithLorry,
      invoiceKeys: [getInvoiceKey(enterpriseInvoice), getInvoiceKey(sdnBhdInvoice)],
    }],
  });

  const lanes = getLorryLanes(state, { drivers, lorries });
  const lane = lanes.find((candidate) => candidate.lorry.id === 2);

  assert.ok(lane, 'lorry 2 lane is present');
  assert.equal(lane.trips.length, 1);
  assert.equal(lane.trips[0].id, 101);
  assert.deepEqual(
    getTripInvoices(state, 101).map(getInvoiceKey),
    [getInvoiceKey(enterpriseInvoice), getInvoiceKey(sdnBhdInvoice)],
  );
  assert.equal(getTripInvoices(state, 101)[0].companyKey, 'enterprise');
  assert.equal(getTripInvoices(state, 101)[1].companyKey, 'sdn_bhd');
});

test('lorryIdOf resolves a joined lorry object and a bare vehicle id', () => {
  assert.equal(lorryIdOf({ lorry: { id: 2 } }), 2);
  assert.equal(lorryIdOf({ vehicleId: 7 }), 7);
  assert.equal(lorryIdOf({}), null);
});

test('renderLorryLane shows the driver select inside the permanent box when a trip exists', () => {
  const state = createDispatchState({ trips: [tripWithLorry] });
  const lane = getLorryLanes(state, { drivers, lorries }).find((candidate) => candidate.lorry.id === 2);

  const markup = renderLorryLane(state, lane, { resources: { drivers, lorries }, writesEnabled: true });

  assert.match(markup, /data-lorry-id="2"/);
  assert.match(markup, /data-lorry-driver="2"/);
  assert.match(markup, /Driver for lorry WXY 1001/);
  assert.match(markup, /data-trip-id="101"/);
  assert.match(markup, /<option value="1"[^>]*selected>Aiman Driver/);
  assert.doesNotMatch(markup, /data-start-trip=/);
});

test('renderLorryLane uses exact trip driver controls when a lorry has multiple trips', () => {
  const secondTrip = {
    ...tripWithLorry,
    id: 102,
    routeNotes: 'South route',
  };
  const state = createDispatchState({ trips: [tripWithLorry, secondTrip] });
  const lane = getLorryLanes(state, { drivers, lorries }).find((candidate) => candidate.lorry.id === 2);

  const markup = renderLorryLane(state, lane, { resources: { drivers, lorries }, writesEnabled: true });

  assert.doesNotMatch(markup, /data-lorry-driver=/);
  assert.match(markup, /data-trip-driver="101"/);
  assert.match(markup, /data-trip-driver="102"/);
  assert.match(markup, /Choose a driver on each trip below/);
});

test('renderLorryLane offers a start-trip control for an empty permanent lorry lane', () => {
  const state = createDispatchState({ trips: [] });
  const lane = getLorryLanes(state, { drivers, lorries }).find((candidate) => candidate.lorry.id === 3);

  const markup = renderLorryLane(state, lane, { resources: { drivers, lorries }, writesEnabled: true });

  assert.match(markup, /data-lorry-id="3"/);
  assert.match(markup, /data-start-trip="3"/);
  assert.match(markup, /Start trip for this lorry/);
  assert.doesNotMatch(markup, /data-trip-id=/);
});

test('renderLorryBoard writes permanent lanes into the board container', () => {
  const state = createDispatchState({ trips: [tripWithLorry] });
  const board = { innerHTML: '' };
  const root = { querySelector: (selector) => (selector === '#lorryBoard' ? board : null) };

  renderLorryBoard(root, state, { resources: { drivers, lorries }, writesEnabled: true });

  assert.match(board.innerHTML, /data-lorry-id="2"/);
  assert.match(board.innerHTML, /data-trip-id="101"/);
});

test('rail invoice card keeps every Board assignment hook and the company badge', () => {
  const state = createDispatchState({ invoices: [enterpriseInvoice] });
  const invoice = state.invoices[0];

  const markup = renderInvoiceCard(invoice, { rail: true });

  assert.match(markup, /class="invoice-card[^"]*invoice-card--rail/);
  assert.match(markup, new RegExp(`data-invoice-key="${getInvoiceKey(invoice).replace(/:/g, '\\:')}"`));
  assert.match(markup, /data-select-invoice=/);
  assert.match(markup, /data-assign-invoice=/);
  assert.match(markup, /class="company-badge enterprise"/);
  assert.match(markup, /Assign to selected trip/);
});

test('trips transport updateTrip sends only the approved driver mutation fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, async json() { return { success: true, trip: {} }; } };
  };
  const transport = createTripsTransport({ fetchImpl });

  await transport.updateTrip({ trip_id: 9, driver_id: 4, expected_revision: 2, ignored: 'must not cross the boundary' });

  const body = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].url, '/api/dispatch/trips');
  assert.deepEqual(
    Object.keys(body).sort(),
    ['driver_id', 'expected_revision', 'request_id', 'trip_id'].sort(),
  );
  assert.equal(body.ignored, undefined);
  assert.equal(body.driver_id, 4);
  assert.equal(body.expected_revision, 2);
});
