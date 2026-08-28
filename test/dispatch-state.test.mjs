import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  beginOptimisticMove,
  COMPANY_FILTER_LABELS,
  createDispatchState,
  DISPATCH_FIXTURE,
  getCompanyFilterLabel,
  getInvoiceKey,
  getTripInvoices,
  getTabNavigationIndex,
  reloadDispatchState,
  rejectMoveResponse,
  selectInvoice,
  selectTrip,
  setCompanyFilter,
  settleMoveResponse,
  visibleUnassignedInvoices,
} from '../public/dispatch-state.mjs';
import { createDispatchApp, renderInvoiceCard, renderTripCard } from '../public/dispatch.js';

const invoices = [
  {
    companyKey: 'enterprise',
    invoiceId: 'shared-doc-001',
    docKey: 'shared-doc-001',
    docNo: 'ENT-001',
    customer: { name: 'Enterprise Customer' },
    items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
  },
  {
    companyKey: 'sdn_bhd',
    invoiceId: 'shared-doc-001',
    docKey: 'shared-doc-001',
    docNo: 'SDN-001',
    customer: { name: 'Sdn Bhd Customer' },
    items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '3.000', uom: 'CTN' }],
  },
  {
    companyKey: 'enterprise',
    invoiceId: 'enterprise-doc-002',
    docKey: 'enterprise-doc-002',
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

test('tab navigation wraps with arrows and jumps to the first or last tab', () => {
  assert.equal(getTabNavigationIndex(0, 'ArrowLeft'), 3);
  assert.equal(getTabNavigationIndex(3, 'ArrowRight'), 0);
  assert.equal(getTabNavigationIndex(1, 'Home'), 0);
  assert.equal(getTabNavigationIndex(1, 'End'), 3);
  assert.equal(getTabNavigationIndex(1, 'PageDown'), null);
});

test('company filter labels drive the queue badge and refresh preserves the selected filter', () => {
  assert.deepEqual(COMPANY_FILTER_LABELS, {
    all: 'ALL',
    enterprise: 'ENTERPRISE',
    sdn_bhd: 'SDN BHD',
  });
  assert.equal(getCompanyFilterLabel('enterprise'), 'ENTERPRISE');

  const filtered = setCompanyFilter(createDispatchState({ invoices, trips }), 'sdn_bhd');
  const refreshed = reloadDispatchState(filtered, { invoices, trips });

  assert.equal(refreshed.companyFilter, 'sdn_bhd');
  assert.equal(getCompanyFilterLabel(refreshed.companyFilter), 'SDN BHD');
  assert.equal(visibleUnassignedInvoices(refreshed).length, 1);
});

test('dispatch fixture keeps Task 1 document keys alongside company-scoped invoice identity', () => {
  const enterpriseSource = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'test', 'fixtures', 'autocount-enterprise-invoices.json'),
  ));
  const sdnBhdSource = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'test', 'fixtures', 'autocount-sdn-bhd-invoices.json'),
  ));
  const dispatchByKey = new Map(DISPATCH_FIXTURE.invoices.map((invoice) => [getInvoiceKey(invoice), invoice]));

  for (const [companyKey, source] of [['enterprise', enterpriseSource.data[0]], ['sdn_bhd', sdnBhdSource.data[0]]]) {
    const invoice = dispatchByKey.get(`${companyKey}:${source.master.docKey}`);
    assert.ok(invoice, `${companyKey} fixture invoice is present`);
    assert.equal(invoice.docKey, source.master.docKey);
    assert.equal(invoice.invoiceId, source.master.docKey);
    assert.equal(getInvoiceKey(invoice), `${companyKey}:${invoice.invoiceId}`);
  }
  assert.equal(DISPATCH_FIXTURE.invoices.every((invoice) => invoice.docKey === invoice.invoiceId), true);
});

function findInteractiveNesting(markup) {
  const interactiveTagNames = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary']);
  const stack = [];
  const violations = [];
  const tokens = markup.match(/<\/?[a-z][^>]*>/gi) || [];

  for (const token of tokens) {
    const closing = /^<\//.test(token);
    const selfClosing = /\/\s*>$/.test(token);
    if (closing) {
      stack.pop();
      continue;
    }
    const tagName = token.match(/^<([a-z][\w-]*)/i)?.[1].toLowerCase();
    const role = token.match(/\brole\s*=\s*["']([^"']+)["']/i)?.[1];
    const tabindex = token.match(/\btabindex\s*=\s*["']([^"']+)["']/i)?.[1];
    const interactive = Boolean(
      tagName && (interactiveTagNames.has(tagName)
        || ['button', 'link', 'tab'].includes(role)
        || (tabindex !== undefined && tabindex !== '-1')),
    );
    if (interactive && stack.some(Boolean)) violations.push(token);
    if (!selfClosing) stack.push(interactive);
  }
  return violations;
}

test('invoice and trip card markup never nests an interactive element inside another', () => {
  const state = createDispatchState({ invoices, trips });
  const invoiceMarkup = renderInvoiceCard(state.invoices[0]);
  const tripMarkup = renderTripCard(state, state.trips[0]);
  const html = fs.readFileSync(path.join(process.cwd(), 'public', 'dispatch.html'), 'utf8');

  assert.deepEqual(findInteractiveNesting(invoiceMarkup), []);
  assert.deepEqual(findInteractiveNesting(tripMarkup), []);
  assert.match(invoiceMarkup, /<button[^>]*class="invoice-select-button"/);
  assert.match(tripMarkup, /<button[^>]*class="trip-select-button"/);
  assert.doesNotMatch(invoiceMarkup, /<article[^>]*(?:role|tabindex)=/);
  assert.doesNotMatch(tripMarkup, /<article[^>]*(?:role|tabindex)=/);

  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)];
  assert.deepEqual(tabs.map((match) => match[0].match(/\bid="([^"]+)"/)?.[1]), [
    'boardTab', 'tripsTab', 'reportsTab', 'resourcesTab',
  ]);
  assert.deepEqual(tabs.map((match) => match[0].match(/\btabindex="([^"]+)"/)?.[1]), ['0', '-1', '-1', '-1']);
  for (const tab of tabs) {
    const tabMarkup = tab[0];
    const tabId = tabMarkup.match(/\bid="([^"]+)"/)?.[1];
    const panelId = tabMarkup.match(/\baria-controls="([^"]+)"/)?.[1];
    assert.match(html, new RegExp(`<[^>]*id="${panelId}"[^>]*role="tabpanel"[^>]*aria-labelledby="${tabId}"`));
  }
});

class FakeElement {
  constructor({ id = '', role = '', dataset = {}, attributes = {} } = {}) {
    this.id = id;
    this.dataset = dataset;
    this.attributes = { ...(role ? { role } : {}), ...attributes };
    this.listeners = {};
    this.hidden = false;
    this.tabIndex = Number(this.attributes.tabindex ?? -1);
    this.classList = { toggle() {} };
    this.textContent = '';
    this.innerHTML = '';
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  dispatch(type, event = {}) {
    this.listeners[type]?.({ ...event, target: event.target || this, currentTarget: this });
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'tabindex') this.tabIndex = Number(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  closest(selector) {
    if (selector === '[role="tab"]' && this.getAttribute('role') === 'tab') return this;
    return null;
  }

  focus() {
    this.focused = true;
  }
}

function createFakeDispatchDocument() {
  const tabs = ['board', 'trips', 'reports', 'resources'].map((tabName, index) => new FakeElement({
    id: `${tabName}Tab`,
    role: 'tab',
    dataset: { tab: tabName },
    attributes: { 'aria-controls': `${tabName}View`, 'aria-selected': String(index === 0), tabindex: index === 0 ? '0' : '-1' },
  }));
  const panels = ['board', 'trips', 'reports', 'resources'].map((tabName) => new FakeElement({
    id: `${tabName}View`,
    role: 'tabpanel',
    attributes: { 'aria-labelledby': `${tabName}Tab` },
  }));
  const elements = new Map([
    ['dispatchApp', new FakeElement()],
    ['companyFilter', new FakeElement()],
    ['refreshBoard', new FakeElement()],
    ['queueKey', new FakeElement()],
    ['unassignedList', new FakeElement()],
    ['unassignedCount', new FakeElement()],
    ['tripList', new FakeElement()],
    ['selectionSummary', new FakeElement()],
    ['statusMessage', new FakeElement()],
    ...panels.map((panel) => [panel.id, panel]),
  ]);
  const root = elements.get('dispatchApp');
  root.querySelector = (selector) => {
    if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
    return null;
  };
  root.querySelectorAll = (selector) => {
    if (selector === '[role="tab"]') return tabs;
    if (selector === '[role="tabpanel"]') return panels;
    return [];
  };
  return {
    root,
    tabs,
    panels,
    companyFilter: elements.get('companyFilter'),
    queueKey: elements.get('queueKey'),
    documentRef: { querySelector: (selector) => selector === '#dispatchApp' ? root : null },
  };
}

test('tab activation uses roving tabindex, selects the panel, and moves focus on keyboard navigation', () => {
  const fake = createFakeDispatchDocument();
  const app = createDispatchApp({ documentRef: fake.documentRef });

  assert.deepEqual(fake.tabs.map((tab) => tab.tabIndex), [0, -1, -1, -1]);
  assert.equal(fake.panels[0].hidden, false);
  assert.equal(fake.panels[1].hidden, true);

  const rightEvent = { key: 'ArrowRight', prevented: false, preventDefault() { this.prevented = true; } };
  fake.root.listeners.keydown({ ...rightEvent, target: fake.tabs[0], preventDefault() { rightEvent.prevented = true; } });

  assert.equal(rightEvent.prevented, true);
  assert.equal(fake.tabs[1].getAttribute('aria-selected'), 'true');
  assert.deepEqual(fake.tabs.map((tab) => tab.tabIndex), [-1, 0, -1, -1]);
  assert.equal(fake.panels[0].hidden, true);
  assert.equal(fake.panels[1].hidden, false);
  assert.equal(fake.tabs[1].focused, true);

  app.activateTab('resources');
  assert.deepEqual(fake.tabs.map((tab) => tab.tabIndex), [-1, -1, -1, 0]);
  assert.equal(fake.panels[3].hidden, false);
});

test('refresh keeps the selected company in the control, badge, state, and transport request', async () => {
  const fake = createFakeDispatchDocument();
  const calls = [];
  const app = createDispatchApp({
    documentRef: fake.documentRef,
    transport: {
      async loadBoard(params) {
        calls.push(params);
        return { invoices, trips };
      },
    },
  });

  fake.companyFilter.value = 'sdn_bhd';
  fake.companyFilter.dispatch('change', { target: fake.companyFilter });
  assert.equal(app.getState().companyFilter, 'sdn_bhd');
  assert.equal(fake.companyFilter.value, 'sdn_bhd');
  assert.equal(fake.queueKey.textContent, 'SDN BHD');

  await app.loadBoard();

  assert.deepEqual(calls, [{ company: 'sdn_bhd' }]);
  assert.equal(app.getState().companyFilter, 'sdn_bhd');
  assert.equal(fake.companyFilter.value, 'sdn_bhd');
  assert.equal(fake.queueKey.textContent, 'SDN BHD');
});
