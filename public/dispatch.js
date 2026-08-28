import {
  COMPANY_NAMES,
  DISPATCH_FIXTURE,
  createDispatchState,
  createFixtureTransport,
  getCompanyFilterLabel,
  getInvoiceKey,
  getTripInvoices,
  getTabNavigationIndex,
  reloadDispatchState,
  selectInvoice,
  selectTrip,
  setCompanyFilter,
  visibleUnassignedInvoices,
} from './dispatch-state.mjs';

const COMPANY_BADGES = {
  enterprise: 'Enterprise',
  sdn_bhd: 'Sdn Bhd',
};

const $ = (root, selector) => root.querySelector(selector);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function companyKeyOf(invoice) {
  return invoice.companyKey ?? invoice.company_key;
}

export function resolveDispatchClickTarget(target) {
  if (target?.closest?.('button:disabled')) return null;
  const invoiceSelect = target?.closest?.('[data-select-invoice]');
  if (invoiceSelect?.dataset?.selectInvoice) {
    return { kind: 'invoice', key: invoiceSelect.dataset.selectInvoice };
  }
  const tripSelect = target?.closest?.('[data-select-trip]');
  if (tripSelect?.dataset?.selectTrip) {
    return { kind: 'trip', id: tripSelect.dataset.selectTrip };
  }
  return null;
}

function companyBadge(invoice) {
  const companyKey = companyKeyOf(invoice);
  const className = companyKey === 'enterprise' ? 'enterprise' : 'sdn-bhd';
  return `<span class="company-badge ${className}">${escapeHtml(COMPANY_BADGES[companyKey] || companyKey)}</span>`;
}

function itemSummary(invoice) {
  return (invoice.items || []).map((item) => (
    `<strong>${escapeHtml(item.quantity)} ${escapeHtml(item.uom || 'UOM review')}</strong> ${escapeHtml(item.itemCode)}`
  )).join(' · ') || 'No item lines';
}

export function renderInvoiceCard(invoice, { inTrip = false, selected = false } = {}) {
  const key = getInvoiceKey(invoice);
  const selectedClass = selected ? ' is-selected' : '';
  const action = inTrip ? '' : `
      <button class="assign-button" type="button" disabled aria-describedby="assignmentExplanation" title="Assignment is not active until Task 6">
        Assign to trip <span class="button-note">Available in Task 6</span>
      </button>`;
  return `
    <article class="invoice-card${selectedClass}" data-invoice-key="${escapeHtml(key)}">
      <div class="invoice-heading">
        <span><span class="invoice-number">${escapeHtml(invoice.docNo)}</span>${companyBadge(invoice)}</span>
        <span class="drag-affordance" aria-label="Drag assignment available in Task 6">↔ Drag / select</span>
      </div>
      <div class="invoice-customer">${escapeHtml(invoice.customer?.name || invoice.customerName || 'Customer review')}</div>
      <div class="invoice-address">${escapeHtml(invoice.deliveryAddress || 'Delivery address review')}</div>
      <div class="invoice-footer">
        <span class="invoice-items">${itemSummary(invoice)}</span>
        <span class="invoice-date">${escapeHtml(invoice.docDate)}</span>
      </div>
      <button class="invoice-select-button" type="button" data-select-invoice="${escapeHtml(key)}" aria-pressed="${String(selected)}" aria-label="Select invoice ${escapeHtml(invoice.docNo)} from ${escapeHtml(COMPANY_BADGES[companyKeyOf(invoice)] || companyKeyOf(invoice))}">Select invoice</button>${action}
    </article>`;
}

export function renderTripCard(state, trip) {
  const tripInvoices = getTripInvoices(state, trip.id);
  const driverName = trip.driver?.name || trip.driverName || 'Driver not set';
  const lorryNumber = trip.lorry?.registrationNo || trip.registrationNo || 'Lorry not set';
  const invoiceCount = tripInvoices.length;
  return `
    <article class="trip-card${String(state.selectedTripId) === String(trip.id) ? ' is-selected' : ''}" data-trip-id="${escapeHtml(trip.id)}">
      <div class="trip-card-header">
        <div>
          <p class="eyebrow">Trip ${escapeHtml(trip.id)}</p>
          <h3>${escapeHtml(trip.tripDate)}</h3>
          <div class="trip-meta"><span>Driver <strong>${escapeHtml(driverName)}</strong></span><span>Lorry <strong>${escapeHtml(lorryNumber)}</strong></span></div>
        </div>
        <span class="status-badge">${escapeHtml(trip.status || 'planned')}</span>
      </div>
      <p class="trip-route">${escapeHtml(trip.routeNotes || 'Route notes not set')}</p>
      <button class="trip-select-button" type="button" data-select-trip="${escapeHtml(trip.id)}" aria-pressed="${String(String(state.selectedTripId) === String(trip.id))}" aria-label="Select trip ${escapeHtml(trip.id)} with ${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}">Select trip</button>
      <div class="trip-invoices" aria-label="Invoices assigned to trip ${escapeHtml(trip.id)}">
        ${tripInvoices.length ? tripInvoices.map((invoice) => renderInvoiceCard(invoice, { inTrip: true, selected: state.selectedInvoiceKey === invoice.key })).join('') : '<div class="empty-dropzone">Drop or select an invoice here<br /><span>Assignment available in Task 6</span></div>'}
      </div>
      <div class="trip-actions">
        <span class="trip-subtotal">${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} · mixed-company trip</span>
        <button class="future-print-button" type="button" disabled aria-label="Print Items for trip ${escapeHtml(trip.id)}" title="Print Items will be added in Task 7">Print Items <span class="button-note">Task 7</span></button>
      </div>
    </article>`;
}

function selectedSummary(state) {
  const invoice = state.invoices.find((candidate) => candidate.key === state.selectedInvoiceKey);
  if (invoice) {
    const company = COMPANY_NAMES[companyKeyOf(invoice)] || companyKeyOf(invoice);
    const trip = state.trips.find((candidate) => String(candidate.id) === String(invoice.tripId));
    return `${invoice.docNo} · ${company} · ${trip ? `currently on ${trip.id}` : 'unassigned'}. Quantity strings are kept exactly as received.`;
  }
  if (state.selectedTripId) {
    const trip = state.trips.find((candidate) => String(candidate.id) === String(state.selectedTripId));
    if (trip) return `${trip.id} pairs ${trip.driver?.name || 'a driver'} with ${trip.lorry?.registrationNo || 'a lorry'} and holds ${getTripInvoices(state, trip.id).length} invoice(s) from the combined queue.`;
  }
  return 'Selected details will appear here without changing the fixture.';
}

export function renderDispatchBoard(root, state) {
  const unassigned = visibleUnassignedInvoices(state);
  const unassignedList = $(root, '#unassignedList');
  const tripList = $(root, '#tripList');
  const companyFilter = $(root, '#companyFilter');
  const queueKey = $(root, '#queueKey');
  $(root, '#unassignedCount').textContent = String(unassigned.length);
  if (companyFilter) companyFilter.value = state.companyFilter;
  if (queueKey) {
    queueKey.textContent = getCompanyFilterLabel(state.companyFilter);
    queueKey.setAttribute('aria-label', `${getCompanyFilterLabel(state.companyFilter)} company queue`);
  }
  unassignedList.innerHTML = unassigned.length
    ? unassigned.map((invoice) => renderInvoiceCard(invoice, { selected: state.selectedInvoiceKey === invoice.key })).join('')
    : '<div class="empty-dropzone">No unassigned invoices in this company view.</div>';
  tripList.innerHTML = state.trips.map((trip) => renderTripCard(state, trip)).join('');
  $(root, '#selectionSummary').textContent = selectedSummary(state);
  $(root, '#statusMessage').textContent = state.statusMessage || 'Assignment controls are shown for review and will be enabled in Task 6.';
}

export function createFetchTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async loadBoard({ startDate, endDate, company = 'all' } = {}) {
      const query = new URLSearchParams({
        startDate: startDate || DISPATCH_FIXTURE.dateRange.startDate,
        endDate: endDate || DISPATCH_FIXTURE.dateRange.endDate,
        company,
      });
      const response = await fetchImpl(`/api/dispatch/invoices?${query.toString()}`);
      if (!response.ok) throw new Error(`Dispatch feed failed with status ${response.status}`);
      return response.json();
    },
  };
}

export function createDispatchApp({ documentRef = globalThis.document, transport = createFixtureTransport() } = {}) {
  if (!documentRef) throw new Error('a document is required');
  const root = documentRef.querySelector('#dispatchApp');
  if (!root) throw new Error('dispatch app root is required');
  let state = createDispatchState();
  let boardRequestSequence = 0;

  function render() {
    renderDispatchBoard(root, state);
  }

  function setState(nextState) {
    state = nextState;
    render();
  }

  async function loadBoard() {
    $(root, '#statusMessage').textContent = 'Loading fixture board…';
    const requestSequence = ++boardRequestSequence;
    const requestedCompany = state.companyFilter;
    try {
      const board = await transport.loadBoard({ company: requestedCompany });
      if (requestSequence !== boardRequestSequence || state.companyFilter !== requestedCompany) return state;
      state = reloadDispatchState(state, board);
      render();
      return state;
    } catch (error) {
      if (requestSequence !== boardRequestSequence || state.companyFilter !== requestedCompany) return state;
      $(root, '#statusMessage').textContent = 'The board could not be loaded. Review the fixture transport before retrying.';
      throw error;
    }
  }

  function activateTab(tabName, { focus = false } = {}) {
    root.querySelectorAll('[role="tab"]').forEach((tab) => {
      const active = tab.dataset.tab === tabName;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
      if (active && focus) tab.focus();
    });
    root.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
      panel.hidden = panel.id !== `${tabName}View`;
    });
  }

  root.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
  $(root, '#companyFilter').addEventListener('change', (event) => setState(setCompanyFilter(state, event.target.value)));
  $(root, '#refreshBoard').addEventListener('click', () => loadBoard().catch(() => {}));

  root.addEventListener('click', (event) => {
    const selection = resolveDispatchClickTarget(event.target);
    if (!selection) return;
    if (selection.kind === 'invoice') {
      setState(selectInvoice(state, selection.key));
      return;
    }
    if (selection.kind === 'trip') {
      setState(selectTrip(state, selection.id));
    }
  });

  root.addEventListener('keydown', (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (tab) {
      const tabs = [...root.querySelectorAll('[role="tab"]')];
      const nextIndex = getTabNavigationIndex(tabs.indexOf(tab), event.key, tabs.length);
      if (nextIndex !== null) {
        event.preventDefault();
        activateTab(tabs[nextIndex].dataset.tab, { focus: true });
      }
      return;
    }
  });

  activateTab('board');
  render();
  return { getState: () => state, loadBoard, render, activateTab };
}

if (typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const app = createDispatchApp();
    window.dispatchApp = app;
    app.loadBoard().catch(() => {});
  }, { once: true });
}
