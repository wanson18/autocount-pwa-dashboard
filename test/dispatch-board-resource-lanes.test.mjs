import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDispatchState,
  getInvoiceKey,
  getLorryLanes,
  getTripInvoices,
  visibleUnassignedInvoices,
} from '../public/dispatch-state.mjs';
import { createDispatchApp, renderTripCard } from '../public/dispatch.js';

const startDate = '2026-08-28';

const drivers = [
  { id: 1, name: 'Aiman Driver', licenseNo: 'D-1001', active: true },
  { id: 4, name: 'Bala Driver', licenseNo: 'D-1004', active: true },
];
const lorries = [
  { id: 2, registrationNo: 'WXY 1001', description: '10-ton lorry', active: true },
  { id: 3, registrationNo: 'WXY 1002', description: '5-ton lorry', active: true },
];

const enterpriseInvoice = {
  companyKey: 'enterprise',
  invoiceId: 'enterprise-doc-001',
  docKey: 'enterprise-doc-001',
  docNo: 'ENT-001',
  docDate: startDate,
  customer: { name: 'Enterprise Customer' },
  deliveryAddress: 'Enterprise Address',
  cancelled: false,
  eligibility: 'eligible',
  items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
};

function matchesSelector(el, selector) {
  if (!el) return false;
  const sel = selector.trim();
  const pseudo = sel.match(/^([a-z]*):disabled$/i);
  if (pseudo) {
    if (pseudo[1] && el.tagName && el.tagName.toLowerCase() !== pseudo[1].toLowerCase()) return false;
    return el.disabled === true;
  }
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  const dataMatch = sel.match(/^\[data-([\w-]+)\]$/);
  if (dataMatch) {
    const key = dataMatch[1].replace(/-([a-z])/g, (group, char) => char.toUpperCase());
    return el.dataset[key] != null && el.dataset[key] !== '';
  }
  return Boolean(el.tagName) && el.tagName.toLowerCase() === sel.toLowerCase();
}

class FakeElement {
  constructor(tag = 'div', id = null) {
    this.tagName = tag;
    this.id = id;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.children = [];
    this._byId = {};
    this._innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.parentElement = null;
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }

  set innerHTML(value) { this._innerHTML = value; }
  get innerHTML() { return this._innerHTML; }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  focus() {}
  reset() {}
  setAttributeAria() {}

  querySelector(selector) {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      if (!this._byId[id]) this._byId[id] = new FakeElement('div', id);
      return this._byId[id];
    }
    return null;
  }

  querySelectorAll() { return []; }

  closest(selector) {
    let current = this;
    while (current) {
      if (matchesSelector(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
  }
}

function createFakeDocument() {
  const root = new FakeElement('div', 'dispatchApp');
  return {
    querySelector: (selector) => (selector === '#dispatchApp' ? root : root.querySelector(selector)),
    createElement: () => new FakeElement(),
    body: new FakeElement('body'),
    addEventListener() {},
  };
}

function dispatch(element, type, event) {
  const listeners = element.listeners[type] || [];
  for (const fn of listeners) fn(event);
}

function flush(times = 30) {
  return (async () => {
    for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  })();
}

function makeTarget({ tag = 'div', dataset = {}, querySelectorAll = null, parent = null } = {}) {
  const element = new FakeElement(tag);
  Object.assign(element.dataset, dataset);
  if (querySelectorAll) element.querySelectorAll = querySelectorAll;
  if (parent) element.parentElement = parent;
  return element;
}

function createAppTransports({ createdTrips = [], assignmentCalls = [], removalCalls = [], driverUpdates = [], tripIdSequence = 900, boardTrips = [], boardAssignments = [] } = {}) {
  const baseInvoices = [enterpriseInvoice];
  const baseTrips = boardTrips;
  const transport = {
    async loadBoard() {
      return {
        invoices: baseInvoices.map((invoice) => ({ ...invoice })),
        trips: [...baseTrips, ...createdTrips].map((trip) => ({ ...trip })),
        assignments: boardAssignments,
        sources: { enterprise: { status: 'ok' }, sdn_bhd: { status: 'ok' } },
        dateRange: { startDate, endDate: startDate },
      };
    },
  };
  const sessionTransport = {
    async getSession() { return { authenticated: true, session: { clerkId: 'clerk-test', role: 'clerk' } }; },
    async login() { return { authenticated: true, session: {} }; },
    async logout() { return { authenticated: false, success: true }; },
  };
  const resourcesTransport = {
    async loadResources() { return { drivers, lorries }; },
  };
  const tripsTransport = {
    async createTrip(body) {
      const id = tripIdSequence;
      tripIdSequence += 1;
      const trip = {
        id,
        tripDate: body.trip_date,
        driverId: body.driver_id,
        vehicleId: body.vehicle_id,
        driver: drivers.find((candidate) => candidate.id === Number(body.driver_id)) || { name: 'Driver' },
        lorry: lorries.find((candidate) => candidate.id === Number(body.vehicle_id)) || { registrationNo: 'Lorry' },
        routeNotes: body.route_notes,
        status: 'planned',
        revision: 1,
        invoiceKeys: [],
      };
      createdTrips.push(trip);
      return { success: true, trip: { id, revision: 1 } };
    },
    async updateTrip(body) {
      driverUpdates.push(body);
      return { success: true, trip: { id: body.trip_id, revision: 2 } };
    },
  };
  const assignmentsTransport = {
    async assignInvoice(body) { assignmentCalls.push(body); return { success: true }; },
    async removeAssignment(body) {
      removalCalls.push(body);
      const assignment = boardAssignments.find((candidate) => String(candidate.id) === String(body.assignment_id));
      if (assignment) assignment.status = 'removed';
      return { success: true, assignment: assignment ? { ...assignment } : null, tripRevision: 5 };
    },
  };
  const reportsTransport = {
    async loadReport() { return { records: [] }; },
    async exportReport() { return { csv: '', filename: 'report.csv' }; },
  };
  return { transport, sessionTransport, resourcesTransport, tripsTransport, assignmentsTransport, reportsTransport };
}

async function bootApp(transports) {
  const documentRef = createFakeDocument();
  const app = createDispatchApp({ documentRef, ...transports });
  await flush();
  await app.loadBoard();
  await flush();
  return { app, root: documentRef.querySelector('#dispatchApp') };
}

test('loadBoard loads the active resource catalog so a no-trip board shows every active lorry as a permanent lane', async () => {
  const transports = createAppTransports();
  const { app, root } = await bootApp(transports);
  const state = app.getState();

  assert.equal(state.trips.length, 0);
  const lanes = getLorryLanes(state, { drivers, lorries });
  assert.deepEqual(lanes.map((lane) => lane.lorry.id).sort(), [2, 3]);

  const board = root.querySelector('#lorryBoard');
  assert.match(board.innerHTML, /data-lorry-id="2"/);
  assert.match(board.innerHTML, /data-lorry-id="3"/);
  assert.match(board.innerHTML, /data-drop-lorry-id="2"/);
  assert.match(board.innerHTML, /data-drop-lorry-id="3"/);
  assert.match(board.innerHTML, /data-start-trip="2"/);
});

test('loadBoard keeps every active lorry lane on a joined-trip board', async () => {
  const createdTrips = [{
    id: 'trip-200',
    tripDate: startDate,
    driverId: 1,
    vehicleId: 2,
    driver: drivers[0],
    lorry: lorries[0],
    routeNotes: 'North',
    status: 'planned',
    revision: 1,
    invoiceKeys: [],
  }];
  const transports = createAppTransports({ createdTrips });
  const { app, root } = await bootApp(transports);
  const state = app.getState();

  const lanes = getLorryLanes(state, { drivers, lorries });
  assert.deepEqual(lanes.map((lane) => lane.lorry.id).sort(), [2, 3]);
  const board = root.querySelector('#lorryBoard');
  assert.match(board.innerHTML, /data-lorry-id="2"/);
  assert.match(board.innerHTML, /data-lorry-id="3"/);
  assert.match(board.innerHTML, /data-trip-id="trip-200"/);
});

test('empty-lane drop target stages the invoice and opens the create-trip dialog preselected, then assigns after create', async () => {
  const assignmentCalls = [];
  const createdTrips = [];
  const transports = createAppTransports({ createdTrips, assignmentCalls });
  const { app, root } = await bootApp(transports);
  const invoiceKey = getInvoiceKey(enterpriseInvoice);

  const dropTarget = makeTarget({ dataset: { dropLorryId: '3' } });
  dispatch(root, 'drop', {
    target: dropTarget,
    preventDefault() {},
    dataTransfer: { getData: () => invoiceKey },
  });
  await flush();

  const dialogMessage = root.querySelector('#tripDialogMessage');
  assert.match(dialogMessage.textContent, /ENT-001/);
  assert.match(dialogMessage.textContent, /lorry 3/);
  assert.equal(root.querySelector('#tripDialogBackdrop').hidden, false);
  assert.equal(root.querySelector('#tripVehicle').value, '3');

  root.querySelector('#tripDriver').value = '1';
  const tripForm = root.querySelector('#tripForm');
  dispatch(tripForm, 'submit', { preventDefault() {} });
  await flush();

  assert.equal(assignmentCalls.length, 1);
  const assignment = assignmentCalls[0];
  assert.equal(String(assignment.trip_id), String(createdTrips[0].id));
  assert.equal(assignment.company_key, 'enterprise');
  assert.equal(assignment.invoice_id, 'enterprise-doc-001');
  assert.equal(assignment.doc_no, 'ENT-001');
});

test('selecting an invoice then tapping the start control stages it and assigns after the trip is created', async () => {
  const assignmentCalls = [];
  const createdTrips = [];
  const transports = createAppTransports({ createdTrips, assignmentCalls });
  const { app, root } = await bootApp(transports);
  const invoiceKey = getInvoiceKey(enterpriseInvoice);

  const invoiceTarget = makeTarget({ dataset: { selectInvoice: invoiceKey } });
  dispatch(root, 'click', { target: invoiceTarget });
  await flush();
  assert.equal(app.getState().selectedInvoiceKey, invoiceKey);

  const startTarget = makeTarget({ tag: 'button', dataset: { startTrip: '2' } });
  dispatch(root, 'click', { target: startTarget });
  await flush();

  assert.match(root.querySelector('#tripDialogMessage').textContent, /ENT-001/);
  assert.equal(root.querySelector('#tripVehicle').value, '2');

  root.querySelector('#tripDriver').value = '4';
  dispatch(root.querySelector('#tripForm'), 'submit', { preventDefault() {} });
  await flush();

  assert.equal(assignmentCalls.length, 1);
  assert.equal(String(assignmentCalls[0].trip_id), String(createdTrips[0].id));
  assert.equal(assignmentCalls[0].doc_no, 'ENT-001');
});

test('tapping an ambiguous multi-trip lane never silently assigns to the first trip', async () => {
  const assignmentCalls = [];
  const createdTrips = [
    { id: 'trip-a', tripDate: startDate, driverId: 1, vehicleId: 2, lorry: lorries[0], status: 'planned', revision: 1, invoiceKeys: [] },
    { id: 'trip-b', tripDate: startDate, driverId: 4, vehicleId: 2, lorry: lorries[0], status: 'planned', revision: 1, invoiceKeys: [] },
  ];
  const transports = createAppTransports({ createdTrips, assignmentCalls });
  const { app, root } = await bootApp(transports);
  const invoiceKey = getInvoiceKey(enterpriseInvoice);

  const invoiceTarget = makeTarget({ dataset: { selectInvoice: invoiceKey } });
  dispatch(root, 'click', { target: invoiceTarget });
  await flush();

  const tripA = makeTarget({ dataset: { tripId: 'trip-a' } });
  const tripB = makeTarget({ dataset: { tripId: 'trip-b' } });
  const laneTarget = makeTarget({
    dataset: { lorryId: '2' },
    querySelectorAll: (selector) => (selector === '[data-trip-id]' ? [tripA, tripB] : []),
  });
  dispatch(root, 'click', { target: laneTarget });
  await flush();

  assert.equal(assignmentCalls.length, 0);
  assert.equal(app.getState().selectedInvoiceKey, invoiceKey);
});

test('multi-trip lane driver controls patch the exact selected trip', async () => {
  const driverUpdates = [];
  const createdTrips = [
    { id: 'trip-a', tripDate: startDate, driverId: 1, vehicleId: 2, lorry: lorries[0], status: 'planned', revision: 1, invoiceKeys: [] },
    { id: 'trip-b', tripDate: startDate, driverId: 4, vehicleId: 2, lorry: lorries[0], status: 'planned', revision: 1, invoiceKeys: [] },
  ];
  const transports = createAppTransports({ createdTrips, driverUpdates });
  const { root } = await bootApp(transports);

  const driverTarget = makeTarget({ tag: 'select', dataset: { tripDriver: 'trip-b' } });
  driverTarget.value = '1';
  dispatch(root, 'change', { target: driverTarget });
  await flush();

  assert.equal(driverUpdates.length, 1);
  assert.equal(driverUpdates[0].trip_id, 'trip-b');
  assert.equal(driverUpdates[0].driver_id, '1');
  assert.equal(driverUpdates[0].expected_revision, 1);
});

test('a permanent empty lorry lane keeps its driver selector disabled so it never patches a nonexistent trip', async () => {
  const transports = createAppTransports();
  const { root } = await bootApp(transports);
  const board = root.querySelector('#lorryBoard');

  assert.match(board.innerHTML, /data-lorry-id="3"/);
  assert.match(board.innerHTML, /data-lorry-driver="3"[^>]*disabled/);
});

test('assigned invoice cards can be dragged back to the queue and expose a remove control', () => {
  const assignment = {
    id: 44,
    tripId: 'trip-201',
    companyKey: 'enterprise',
    invoiceId: enterpriseInvoice.invoiceId,
    docNo: enterpriseInvoice.docNo,
    docDate: startDate,
    header: { customer: enterpriseInvoice.customer, deliveryAddress: enterpriseInvoice.deliveryAddress },
    items: enterpriseInvoice.items,
    status: 'assigned',
  };
  const state = createDispatchState({
    invoices: [enterpriseInvoice],
    trips: [{ id: 'trip-201', tripDate: startDate, driver: drivers[0], lorry: lorries[0], revision: 4, assignments: [assignment] }],
    assignments: [assignment],
  });
  const markup = renderTripCard(state, state.trips[0], { writesEnabled: true });

  assert.match(markup, /data-invoice-key="enterprise:enterprise-doc-001"[^>]*draggable="true"/);
  assert.match(markup, /data-remove-assignment="enterprise:enterprise-doc-001"/);
  assert.match(markup, /aria-label="Remove invoice ENT-001 from trip trip-201"/);
});

function assignedBoardTransports(removalCalls) {
  const assignment = {
    id: 45,
    tripId: 'trip-202',
    companyKey: 'enterprise',
    invoiceId: enterpriseInvoice.invoiceId,
    docNo: enterpriseInvoice.docNo,
    docDate: startDate,
    header: { customer: enterpriseInvoice.customer, deliveryAddress: enterpriseInvoice.deliveryAddress },
    items: enterpriseInvoice.items,
    status: 'assigned',
  };
  const boardTrip = {
    id: 'trip-202',
    tripDate: startDate,
    driverId: drivers[0].id,
    vehicleId: lorries[0].id,
    driver: drivers[0],
    lorry: lorries[0],
    revision: 4,
    status: 'planned',
    assignments: [],
  };
  return createAppTransports({ boardTrips: [boardTrip], boardAssignments: [assignment], removalCalls });
}

test('dropping an assigned invoice on the unassigned queue removes it and reloads it as available', async () => {
  const removalCalls = [];
  const transports = assignedBoardTransports(removalCalls);
  const { app, root } = await bootApp(transports);
  const invoiceKey = getInvoiceKey(enterpriseInvoice);

  const queueTarget = makeTarget({ dataset: { dropUnassigned: 'true' } });
  dispatch(root, 'drop', {
    target: queueTarget,
    preventDefault() {},
    dataTransfer: { getData: () => invoiceKey },
  });
  await flush();

  assert.equal(removalCalls.length, 1);
  assert.equal(removalCalls[0].assignment_id, 45);
  assert.equal(removalCalls[0].expected_trip_revision, 4);
  assert.equal(app.getState().invoices.find((invoice) => invoice.key === invoiceKey).tripId, null);
  assert.equal(visibleUnassignedInvoices(app.getState()).some((invoice) => invoice.key === invoiceKey), true);
  assert.deepEqual(getTripInvoices(app.getState(), 'trip-202'), []);
});

test('remove control returns an assigned invoice to the unassigned queue', async () => {
  const removalCalls = [];
  const transports = assignedBoardTransports(removalCalls);
  const { app, root } = await bootApp(transports);
  const invoiceKey = getInvoiceKey(enterpriseInvoice);

  const removeTarget = makeTarget({ tag: 'button', dataset: { removeAssignment: invoiceKey } });
  dispatch(root, 'click', { target: removeTarget });
  await flush();

  assert.equal(removalCalls.length, 1);
  assert.equal(removalCalls[0].assignment_id, 45);
  assert.equal(visibleUnassignedInvoices(app.getState()).some((invoice) => invoice.key === invoiceKey), true);
});
