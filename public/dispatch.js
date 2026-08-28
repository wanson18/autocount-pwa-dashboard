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
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

const $ = (root, selector) => root.querySelector(selector);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function createRequestId() {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    const value = randomUUID.call(globalThis.crypto);
    if (REQUEST_ID_PATTERN.test(value)) return value;
  }
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (typeof getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    getRandomValues.call(globalThis.crypto, bytes);
    return `dispatch-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `dispatch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function mutationBody(resource) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new Error('a resource payload is required');
  }
  const {
    actor,
    actor_id,
    assigned_by,
    request_id: suppliedRequestId,
    ...serverOwnedFields
  } = resource;
  void actor;
  void actor_id;
  void assigned_by;
  const request_id = suppliedRequestId === undefined ? createRequestId() : suppliedRequestId;
  if (typeof request_id !== 'string' || !REQUEST_ID_PATTERN.test(request_id)) {
    throw new Error('a valid request_id is required');
  }
  return { ...serverOwnedFields, request_id };
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
      const response = await fetchImpl(`/api/dispatch/invoices?${query.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
      if (!response.ok) throw new Error(`Dispatch feed failed with status ${response.status}`);
      return response.json();
    },
  };
}

async function parseApiResponse(response, fallbackMessage) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The client only exposes a generic message when the server response is not JSON.
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.code === 'invalid_credentials'
      ? 'Invalid clerk ID or PIN.'
      : fallbackMessage);
    error.code = payload?.error?.code || 'request_failed';
    throw error;
  }
  return payload;
}

function createJsonRequest(method, body) {
  return {
    method,
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function createSessionTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async getSession() {
      const response = await fetchImpl('/api/dispatch/session', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
      return parseApiResponse(response, 'The session could not be checked.');
    },
    async login({ clerkId, pin }) {
      const response = await fetchImpl('/api/dispatch/session', createJsonRequest('POST', { clerkId, pin }));
      return parseApiResponse(response, 'Sign-in could not be completed.');
    },
    async logout() {
      const response = await fetchImpl('/api/dispatch/session', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
      return parseApiResponse(response, 'Sign-out could not be completed.');
    },
  };
}

export function createResourceTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async loadResources({ active = 'true' } = {}) {
      const query = new URLSearchParams({ active: String(active) });
      const response = await fetchImpl(`/api/dispatch/resources?${query.toString()}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
      return parseApiResponse(response, 'Resources could not be loaded.');
    },
    async createResource(resource) {
      const response = await fetchImpl('/api/dispatch/resources', createJsonRequest('POST', mutationBody(resource)));
      return parseApiResponse(response, 'The resource could not be added.');
    },
    async updateResource(resource) {
      const response = await fetchImpl('/api/dispatch/resources', createJsonRequest('PATCH', mutationBody(resource)));
      return parseApiResponse(response, 'The resource could not be updated.');
    },
  };
}

function resourceStatusLabel(resource) {
  return resource.active ? 'Active' : 'Inactive';
}

function renderResource(resource, type) {
  const identity = type === 'driver' ? resource.licenseNo : resource.registrationNo;
  const title = type === 'driver' ? resource.name : identity;
  const detail = type === 'driver' ? (resource.phone || 'No phone recorded') : (resource.description || 'No description recorded');
  const nextActive = !resource.active;
  const actionLabel = `${nextActive ? 'Reactivate' : 'Deactivate'} ${type} ${title}`;
  return `
    <article class="resource-card${resource.active ? '' : ' is-inactive'}">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <span class="resource-identity">${escapeHtml(identity)}</span>
        <span class="resource-detail">${escapeHtml(detail)}</span>
      </div>
      <div class="resource-card-actions">
        <span class="status-badge">${resourceStatusLabel(resource)}</span>
        <button class="secondary-button resource-toggle-button" type="button" data-resource-type="${type}" data-resource-id="${escapeHtml(resource.id)}" data-resource-active="${String(nextActive)}" aria-label="${escapeHtml(actionLabel)}">${nextActive ? 'Reactivate' : 'Deactivate'}</button>
      </div>
    </article>`;
}

export function renderResources(root, resources) {
  const driverList = $(root, '#driverList');
  const lorryList = $(root, '#lorryList');
  if (driverList) {
    driverList.innerHTML = (resources.drivers || []).map((resource) => renderResource(resource, 'driver')).join('')
      || '<p class="empty-resource-list">No drivers in this view.</p>';
  }
  if (lorryList) {
    lorryList.innerHTML = (resources.lorries || []).map((resource) => renderResource(resource, 'lorry')).join('')
      || '<p class="empty-resource-list">No lorries in this view.</p>';
  }
}

export function createDispatchApp({
  documentRef = globalThis.document,
  transport = createFixtureTransport(),
  sessionTransport = createSessionTransport(),
  resourcesTransport = createResourceTransport(),
} = {}) {
  if (!documentRef) throw new Error('a document is required');
  const root = documentRef.querySelector('#dispatchApp');
  if (!root) throw new Error('dispatch app root is required');
  let state = createDispatchState();
  let boardRequestSequence = 0;
  let resourceRequestSequence = 0;
  let authenticated = !$(root, '#loginView') || !$(root, '#authenticatedView');
  let session = null;

  const loginView = $(root, '#loginView');
  const authenticatedView = $(root, '#authenticatedView');
  const loginForm = $(root, '#dispatchLoginForm');
  const loginMessage = $(root, '#loginMessage');
  const loginSubmit = $(root, '#loginSubmit');
  const clerkIdInput = $(root, '#clerkId');
  const clerkPinInput = $(root, '#clerkPin');
  const resourceForm = $(root, '#resourceForm');
  const resourceType = $(root, '#resourceType');
  const resourceStatus = $(root, '#resourceStatus');
  const resourceSubmit = $(root, '#resourceSubmit');
  const showInactiveResources = $(root, '#showInactiveResources');

  function setAuthenticated(nextAuthenticated, nextSession = null) {
    authenticated = nextAuthenticated;
    session = nextAuthenticated ? nextSession : null;
    if (loginView) loginView.hidden = nextAuthenticated;
    if (authenticatedView) authenticatedView.hidden = !nextAuthenticated;
    root.dataset.authenticated = String(nextAuthenticated);
  }

  function setLoginMessage(message) {
    if (loginMessage) loginMessage.textContent = message;
  }

  function setResourceMessage(message) {
    if (resourceStatus) resourceStatus.textContent = message;
  }

  function clearSensitiveState() {
    boardRequestSequence += 1;
    resourceRequestSequence += 1;
    state = createDispatchState();
    setAuthenticated(false);
    render();
    for (const id of ['driverList', 'lorryList']) {
      const list = $(root, `#${id}`);
      if (list) list.innerHTML = '';
    }
    resourceForm?.reset?.();
    updateResourceTypeFields();
  }

  function handleSessionLoss() {
    clearSensitiveState();
    setLoginMessage('Your session has expired. Sign in again.');
    setResourceMessage('Your session has expired. Sign in again.');
  }

  function render() {
    renderDispatchBoard(root, state);
  }

  function setState(nextState) {
    state = nextState;
    render();
  }

  async function loadBoard() {
    if (!authenticated) return state;
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
      if (error.code === 'unauthorized') {
        handleSessionLoss();
        $(root, '#statusMessage').textContent = 'Your session has expired. Sign in again.';
      } else {
        $(root, '#statusMessage').textContent = 'The board could not be loaded. Review the fixture transport before retrying.';
      }
      throw error;
    }
  }

  async function loadResources() {
    if (!authenticated || !$(root, '#driverList')) return null;
    const requestSequence = ++resourceRequestSequence;
    const active = showInactiveResources?.checked ? 'all' : 'true';
    setResourceMessage('Loading resources…');
    try {
      const resources = await resourcesTransport.loadResources({ active });
      if (requestSequence !== resourceRequestSequence || !authenticated) return resources;
      renderResources(root, resources);
      setResourceMessage('Resources loaded.');
      return resources;
    } catch (error) {
      if (requestSequence !== resourceRequestSequence || !authenticated) return null;
      if (error.code === 'unauthorized') {
        handleSessionLoss();
      } else {
        setResourceMessage('Resources could not be loaded. Try again.');
      }
      throw error;
    }
  }

  async function updateResource(type, id, active) {
    setResourceMessage('Saving resource…');
    try {
      await resourcesTransport.updateResource({ type, id: Number(id), active });
      setResourceMessage('Resource updated.');
      await loadResources();
    } catch (error) {
      if (error.code === 'unauthorized') {
        handleSessionLoss();
      } else {
        setResourceMessage('Resource could not be updated. Try again.');
      }
      throw error;
    }
  }

  function updateResourceTypeFields() {
    const driverFields = $(root, '#driverResourceFields');
    const lorryFields = $(root, '#lorryResourceFields');
    const isDriver = resourceType?.value === 'driver';
    if (driverFields) driverFields.hidden = !isDriver;
    if (lorryFields) lorryFields.hidden = isDriver;
  }

  async function submitResource() {
    if (!resourceType) return;
    const type = resourceType.value;
    const body = type === 'driver'
      ? {
        type,
        name: $(root, '#resourceName')?.value?.trim() || '',
        licenseNo: $(root, '#resourceLicenseNo')?.value?.trim() || '',
        phone: $(root, '#resourcePhone')?.value?.trim() || null,
      }
      : {
        type,
        registrationNo: $(root, '#resourceRegistrationNo')?.value?.trim() || '',
        description: $(root, '#resourceDescription')?.value?.trim() || null,
      };
    if (resourceSubmit) resourceSubmit.disabled = true;
    setResourceMessage('Saving resource…');
    try {
      await resourcesTransport.createResource(body);
      resourceForm?.reset?.();
      updateResourceTypeFields();
      setResourceMessage('Resource added.');
      await loadResources();
    } catch (error) {
      if (error.code === 'resource_conflict') {
        setResourceMessage('A resource with that identity already exists.');
      } else if (error.code === 'unauthorized') {
        handleSessionLoss();
      } else {
        setResourceMessage('Resource could not be added. Try again.');
      }
      throw error;
    } finally {
      if (resourceSubmit) resourceSubmit.disabled = false;
    }
  }

  async function login() {
    if (!clerkIdInput || !clerkPinInput) return;
    if (loginSubmit) loginSubmit.disabled = true;
    setLoginMessage('Signing in…');
    try {
      const result = await sessionTransport.login({
        clerkId: clerkIdInput.value.trim(),
        pin: clerkPinInput.value,
      });
      if (!result?.authenticated || !result.session) throw new Error('Sign-in could not be completed.');
      setAuthenticated(true, result.session);
      setLoginMessage('');
      clerkPinInput.value = '';
      await loadBoard();
      root.querySelector('[role="tab"]')?.focus?.();
    } catch (error) {
      setAuthenticated(false);
      setLoginMessage(error.code === 'invalid_credentials'
        ? 'Invalid clerk ID or PIN.'
        : 'Sign-in could not be completed. Try again.');
      clerkPinInput.value = '';
      clerkPinInput.focus?.();
      throw error;
    } finally {
      if (loginSubmit) loginSubmit.disabled = false;
    }
  }

  async function logout() {
    try {
      const result = await sessionTransport.logout();
      if (!result || result.authenticated !== false || result.success === false) {
        const error = new Error('sign-out was not confirmed by the server');
        error.code = 'logout_not_confirmed';
        throw error;
      }
    } catch (error) {
      $(root, '#statusMessage').textContent = 'Sign-out could not be completed. Try again.';
      setResourceMessage('Sign-out could not be completed. Try again.');
      throw error;
    }
    clearSensitiveState();
    {
      setLoginMessage('You have been signed out.');
      clerkIdInput?.focus?.();
    }
  }

  async function initializeSession() {
    if (!loginView || !authenticatedView || !loginForm) return;
    setAuthenticated(false);
    setLoginMessage('Checking sign-in…');
    try {
      const result = await sessionTransport.getSession();
      if (result?.authenticated && result.session) {
        setAuthenticated(true, result.session);
        setLoginMessage('');
        await loadBoard();
      } else {
        setLoginMessage('Sign in to continue.');
      }
    } catch (error) {
      if (error.code === 'unauthorized') {
        handleSessionLoss();
      } else {
        setLoginMessage('Sign-in is temporarily unavailable. Try again.');
      }
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

  root.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener('click', () => {
    activateTab(tab.dataset.tab);
    if (tab.dataset.tab === 'resources' && authenticated) loadResources().catch(() => {});
  }));
  $(root, '#companyFilter').addEventListener('change', (event) => setState(setCompanyFilter(state, event.target.value)));
  $(root, '#refreshBoard').addEventListener('click', () => loadBoard().catch(() => {}));
  $(root, '#logoutButton')?.addEventListener('click', () => logout().catch(() => {}));
  loginForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    login().catch(() => {});
  });
  resourceForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitResource().catch(() => {});
  });
  resourceType?.addEventListener('change', updateResourceTypeFields);
  showInactiveResources?.addEventListener('change', () => loadResources().catch(() => {}));

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

  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-resource-active]');
    if (!button) return;
    updateResource(
      button.dataset.resourceType,
      button.dataset.resourceId,
      button.dataset.resourceActive === 'true',
    ).catch(() => {});
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
  updateResourceTypeFields();
  render();
  initializeSession().catch(() => {});
  return {
    getState: () => state,
    getSession: () => session,
    loadBoard,
    loadResources,
    render,
    activateTab,
    login,
    logout,
  };
}

if (typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const app = createDispatchApp();
    window.dispatchApp = app;
  }, { once: true });
}
