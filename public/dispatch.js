import {
  COMPANY_NAMES,
  COMPANY_FILTERS,
  createDispatchState,
  beginOptimisticMove,
  beginOptimisticRemoval,
  getCompanyFilterLabel,
  getDefaultDateRange,
  getInvoiceKey,
  getSourceMessage,
  isCurrentEligibleUnassignedInvoice,
  getTripCompanyCounts,
  getTripInvoices,
  getTabNavigationIndex,
  getLorryLanes,
  lorryIdOf,
  reloadDispatchState,
  rejectMoveResponse,
  selectInvoice,
  selectTrip,
  setCompanyFilter,
  setSearchQuery,
  settleMoveResponse,
  visibleUnassignedInvoices,
} from './dispatch-state.mjs';

const COMPANY_BADGES = { enterprise: 'Enterprise', sdn_bhd: 'Sdn Bhd' };
const REMOVABLE_ASSIGNMENT_STATUSES = new Set(['assigned', 'loaded']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const $ = (root, selector) => root.querySelector(selector);
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function isPositiveResourceId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
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

function approvedMutationBody(fields) {
  if (fields && typeof fields.request_id === 'string' && fields.request_id) return { ...fields };
  return { ...fields, request_id: createRequestId() };
}

function companyKeyOf(invoice) {
  return invoice?.companyKey ?? invoice?.company_key;
}

function normalizeResources(result) {
  return { drivers: result?.drivers || [], lorries: result?.lorries || [] };
}

export function resourceValidationMessage(resource) {
  if (!resource || !['driver', 'lorry'].includes(resource.type)) return 'Choose Driver or Lorry.';
  if (resource.type === 'lorry') {
    const registrationNo = String(resource.registrationNo ?? '').trim();
    if (!registrationNo) return 'Enter the lorry registration number.';
    if (registrationNo.length > 64) return 'The lorry registration number must be 64 characters or fewer.';
    const description = resource.description == null ? '' : String(resource.description).trim();
    if (description.length > 160) return 'The lorry description must be 160 characters or fewer.';
    return '';
  }
  if (!String(resource.name ?? '').trim()) return 'Enter the driver name.';
  if (!String(resource.licenseNo ?? '').trim()) return 'Enter the driver license number.';
  if (String(resource.name).trim().length > 120) return 'The driver name must be 120 characters or fewer.';
  if (String(resource.licenseNo).trim().length > 64) return 'The driver license number must be 64 characters or fewer.';
  if (resource.phone != null && String(resource.phone).trim().length > 64) return 'The driver phone must be 64 characters or fewer.';
  return '';
}

function tripNeedsResourceJoin(trip) {
  return (trip?.driverId != null || trip?.driver_id != null) && !trip.driver
    || (trip?.vehicleId != null || trip?.vehicle_id != null) && !trip.lorry;
}

function tripHasResourceIdentity(trip) {
  return tripNeedsResourceJoin(trip)
    || trip?.lorry?.id != null
    || trip?.vehicleId != null
    || trip?.vehicle_id != null;
}

function boardNeedsResourceCatalog(board) {
  const trips = Array.isArray(board?.trips) ? board.trips : [];
  return trips.length === 0 || trips.some(tripHasResourceIdentity);
}

export function resolveDispatchClickTarget(target) {
  if (target?.closest?.('button:disabled')) return null;
  const invoiceSelect = target?.closest?.('[data-select-invoice]');
  if (invoiceSelect?.dataset?.selectInvoice) return { kind: 'invoice', key: invoiceSelect.dataset.selectInvoice };
  const tripSelect = target?.closest?.('[data-select-trip]');
  if (tripSelect?.dataset?.selectTrip) return { kind: 'trip', id: tripSelect.dataset.selectTrip };
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

function assignmentStatusOf(invoice) {
  return invoice?.assignmentStatus ?? invoice?.assignment_status ?? invoice?.status ?? 'assigned';
}

function canRemoveAssignment(invoice) {
  return invoice?.assignmentId != null && REMOVABLE_ASSIGNMENT_STATUSES.has(assignmentStatusOf(invoice));
}

function loadingSheetHref(tripId) {
  return `/loading-sheet.html?trip_id=${encodeURIComponent(String(tripId))}`;
}

export function renderInvoiceCard(invoice, { inTrip = false, selected = false, pending = false, writesEnabled = true, rail = false, tripId = null } = {}) {
  const key = getInvoiceKey(invoice);
  const selectedClass = selected ? ' is-selected' : '';
  const railClass = rail ? ' invoice-card--rail' : '';
  const removeAllowed = inTrip && canRemoveAssignment(invoice);
  const draggable = inTrip ? removeAllowed && writesEnabled && !pending : writesEnabled && !pending;
  const removeLabel = tripId == null ? `Remove invoice ${invoice.docNo} from trip` : `Remove invoice ${invoice.docNo} from trip ${tripId}`;
  const action = inTrip ? (removeAllowed ? `
      <button class="remove-assignment-button" type="button" data-remove-assignment="${escapeHtml(key)}" ${!writesEnabled || pending ? 'disabled' : ''} aria-label="${escapeHtml(removeLabel)}">Remove</button>` : '') : `
      <button class="assign-button" type="button" data-assign-invoice="${escapeHtml(key)}" ${!writesEnabled || pending ? 'disabled' : ''} aria-describedby="assignmentExplanation" aria-label="Assign invoice ${escapeHtml(invoice.docNo)} to selected trip">Assign to selected trip</button>`;
  return `
    <article class="invoice-card${selectedClass}${railClass}" data-invoice-key="${escapeHtml(key)}" draggable="${String(draggable)}">
      <div class="invoice-heading">
        <span><span class="invoice-number">${escapeHtml(invoice.docNo)}</span>${companyBadge(invoice)}</span>
        <span class="drag-affordance" aria-label="Drag invoice to a lorry">↔ Drag / select</span>
      </div>
      <div class="invoice-customer">${escapeHtml(invoice.customer?.name || invoice.customerName || 'Customer review')}</div>
      <div class="invoice-address">${escapeHtml(invoice.deliveryAddress || 'Delivery address review')}</div>
      <div class="invoice-footer"><span class="invoice-items">${itemSummary(invoice)}</span><span class="invoice-date">${escapeHtml(invoice.docDate)}</span></div>
      <button class="invoice-select-button" type="button" data-select-invoice="${escapeHtml(key)}" aria-pressed="${String(selected)}" aria-label="Select invoice ${escapeHtml(invoice.docNo)} from ${escapeHtml(COMPANY_BADGES[companyKeyOf(invoice)] || companyKeyOf(invoice))}">Select invoice</button>${action}
    </article>`;
}

export function renderTripCard(state, trip, { writesEnabled = true, drivers = null } = {}) {
  const tripInvoices = getTripInvoices(state, trip.id);
  const driverName = trip.driver?.name || trip.driverName || 'Driver not set';
  const lorryNumber = trip.lorry?.registrationNo || trip.registrationNo || 'Lorry not set';
  const counts = getTripCompanyCounts(state, trip.id);
  const selected = String(state.selectedTripId) === String(trip.id);
  const pending = Boolean(state.pendingMove);
  const activeDrivers = Array.isArray(drivers) ? drivers.filter((driver) => driver.active !== false) : [];
  const selectedDriverId = trip.driverId ?? trip.driver_id ?? trip.driver?.id;
  const tripDriverControl = Array.isArray(drivers)
    ? `<label class="trip-driver-field"><span>Driver</span><select class="field-control" data-trip-driver="${escapeHtml(String(trip.id))}" aria-label="Driver for trip ${escapeHtml(trip.id)}" ${writesEnabled && activeDrivers.length ? '' : 'disabled'}>${activeDrivers.map((driver) => {
      const selectedDriver = selectedDriverId != null && String(selectedDriverId) === String(driver.id) ? ' selected' : '';
      return `<option value="${escapeHtml(driver.id)}"${selectedDriver}>${escapeHtml(driver.name)} · ${escapeHtml(driver.licenseNo || '')}</option>`;
    }).join('') || '<option value="">No active drivers</option>'}</select></label>`
    : '';
  return `
    <article class="trip-card${selected ? ' is-selected' : ''}" data-trip-id="${escapeHtml(trip.id)}" data-drop-trip-id="${escapeHtml(trip.id)}">
      <div class="trip-card-header"><div><p class="eyebrow">Trip ${escapeHtml(trip.id)}</p><h3>${escapeHtml(trip.tripDate)}</h3>
        <div class="trip-meta"><span>Driver <strong>${escapeHtml(driverName)}</strong></span><span>Lorry <strong>${escapeHtml(lorryNumber)}</strong></span>${tripDriverControl}</div></div>
        <span class="status-badge">${escapeHtml(trip.status || 'planned')}</span></div>
      <p class="trip-route">${escapeHtml(trip.routeNotes || 'Route notes not set')}</p>
      <button class="trip-select-button" type="button" data-select-trip="${escapeHtml(trip.id)}" aria-pressed="${String(selected)}" aria-label="Select trip ${escapeHtml(trip.id)} with ${counts.total} invoice${counts.total === 1 ? '' : 's'}">Select trip</button>
      <div class="trip-invoices" data-drop-trip-id="${escapeHtml(trip.id)}" aria-label="Invoices assigned to trip ${escapeHtml(trip.id)}">
        ${tripInvoices.length ? tripInvoices.map((invoice) => renderInvoiceCard(invoice, { inTrip: true, selected: state.selectedInvoiceKey === invoice.key, pending, writesEnabled, tripId: trip.id })).join('') : '<div class="empty-dropzone">Select an invoice above, then assign it here.</div>'}
      </div>
      <div class="trip-actions"><span class="trip-subtotal"><strong>Enterprise ${counts.enterprise}</strong> · <strong>Sdn Bhd ${counts.sdn_bhd}</strong> · Combined ${counts.total}</span>
        <span class="trip-action-buttons"><a class="future-print-button" data-print-items-trip="${escapeHtml(trip.id)}" href="${escapeHtml(loadingSheetHref(trip.id))}">Print Items</a><button class="assign-selected-button" type="button" data-assign-selected="${escapeHtml(trip.id)}" ${writesEnabled && !pending ? '' : 'disabled'} aria-label="Assign selected invoice to trip ${escapeHtml(trip.id)}">Assign selected invoice</button></span></div>
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
  return 'Select an invoice or trip to see its operational details.';
}

export function renderLorryLane(state, lane, { resources = { drivers: [], lorries: [] }, writesEnabled = true } = {}) {
  const lorry = lane.lorry || {};
  const reg = lorry.registrationNo || 'Lorry';
  const hasTrip = lane.trips.length > 0;
  const hasSingleTrip = lane.trips.length === 1;
  const primaryTrip = lane.trips[0];
  const hasPersistedLorryId = isPositiveResourceId(lorry.id);
  const driverOptions = (resources.drivers || [])
    .filter((driver) => driver.active !== false)
    .map((driver) => {
      const selectedDriverId = primaryTrip?.driverId ?? primaryTrip?.driver_id ?? primaryTrip?.driver?.id;
      const selected = primaryTrip && selectedDriverId != null && String(selectedDriverId) === String(driver.id) ? ' selected' : '';
      return `<option value="${escapeHtml(driver.id)}"${selected}>${escapeHtml(driver.name)} · ${escapeHtml(driver.licenseNo || '')}</option>`;
    }).join('');
  const driverSelect = hasTrip && hasSingleTrip && hasPersistedLorryId
    ? `<label class="lorry-driver-field"><span>Driver</span><select class="field-control" data-lorry-driver="${escapeHtml(String(lorry.id))}" data-trip-driver="${escapeHtml(String(primaryTrip.id))}" aria-label="Driver for lorry ${escapeHtml(reg)}" ${writesEnabled ? '' : 'disabled'}>${driverOptions || '<option value="">No active drivers</option>'}</select></label>`
    : hasTrip && hasSingleTrip
      ? '<span class="lorry-driver-note">Driver details shown on this trip.</span>'
      : `<label class="lorry-driver-field"><span>Driver</span><select class="field-control" data-lorry-driver="${escapeHtml(String(lorry.id))}" aria-label="Driver for lorry ${escapeHtml(reg)}" disabled><option value="">Plan a trip first</option></select></label>`;
  const multiTripDriverNote = hasTrip && !hasSingleTrip
    ? '<span class="lorry-driver-note">Choose a driver on each trip below.</span>'
    : '';
  const effectiveDriverControl = hasTrip && !hasSingleTrip ? multiTripDriverNote : driverSelect;
  const tripsArea = hasTrip
    ? lane.trips.map((trip) => renderTripCard(state, trip, { writesEnabled, drivers: hasSingleTrip ? null : resources.drivers || [] })).join('')
    : `<div class="empty-lane" data-drop-lorry-id="${escapeHtml(String(lorry.id))}" aria-label="Drop an invoice here to start a trip for lorry ${escapeHtml(reg)}"><p class="section-help">No trip planned for this lorry yet.</p><button class="secondary-button" type="button" data-start-trip="${escapeHtml(String(lorry.id))}" ${writesEnabled ? '' : 'disabled'} aria-label="Start a trip for lorry ${escapeHtml(reg)}">Start trip for this lorry</button></div>`;
  return `<section class="lorry-lane panel" data-lorry-id="${escapeHtml(String(lorry.id))}" aria-label="Lorry ${escapeHtml(reg)} lane">
    <div class="lorry-lane-header">
      <div class="lorry-lane-title"><p class="eyebrow">Lorry lane</p><h3>${escapeHtml(reg)}</h3></div>
      ${effectiveDriverControl}
    </div>
    <div class="lorry-trips">${tripsArea}</div>
  </section>`;
}

export function renderLorryBoard(root, state, { resources = { drivers: [], lorries: [] }, writesEnabled = true } = {}) {
  const board = $(root, '#lorryBoard');
  if (!board) return;
  const lanes = getLorryLanes(state, resources);
  board.innerHTML = lanes.length
    ? lanes.map((lane) => renderLorryLane(state, lane, { resources, writesEnabled })).join('')
    : '<div class="empty-dropzone">No active lorries registered. Add a lorry in Resources to start planning trips.</div>';
}

export function renderDispatchBoard(root, state, { writesEnabled = true, resources = { drivers: [], lorries: [] } } = {}) {
  const unassigned = visibleUnassignedInvoices(state);
  const unassignedList = $(root, '#unassignedList');
  const companyFilter = $(root, '#companyFilter');
  const queueKey = $(root, '#queueKey');
  $(root, '#unassignedCount').textContent = String(unassigned.length);
  if (companyFilter) companyFilter.value = state.companyFilter;
  if (queueKey) {
    queueKey.textContent = getCompanyFilterLabel(state.companyFilter);
    queueKey.setAttribute('aria-label', `${getCompanyFilterLabel(state.companyFilter)} company queue`);
  }
  if (unassignedList) {
    unassignedList.setAttribute('data-drop-unassigned', 'true');
    unassignedList.setAttribute('aria-label', 'Unassigned invoices drop zone');
    unassignedList.innerHTML = unassigned.length
      ? unassigned.map((invoice) => renderInvoiceCard(invoice, { selected: state.selectedInvoiceKey === invoice.key, pending: Boolean(state.pendingMove), writesEnabled, rail: true })).join('')
      : (state.searchQuery || '').trim()
        ? '<div class="empty-dropzone">No invoices match this search.</div>'
        : '<div class="empty-dropzone">No unassigned invoices in this company view.</div>';
  }
  const searchInput = $(root, '#invoiceSearch');
  if (searchInput && searchInput.value !== (state.searchQuery || '')) {
    searchInput.value = state.searchQuery || '';
  }
  renderLorryBoard(root, state, { resources, writesEnabled });
  const boardDateLabel = $(root, '#boardDateLabel');
  if (boardDateLabel && state.dateRange?.startDate) {
    boardDateLabel.textContent = formatKualaLumpurDate(state.dateRange.startDate) || state.dateRange.startDate;
  }
  const sourceStatus = $(root, '#sourceStatus');
  if (sourceStatus) {
    const base = getSourceMessage(state.sources);
    const quarantined = Number(state.quarantinedCount) || 0;
    sourceStatus.textContent = quarantined > 0
      ? `${base} ${quarantined} invoice row${quarantined === 1 ? '' : 's'} need${quarantined === 1 ? 's' : ''} review.`
      : base;
  }
  const boardState = $(root, '#boardState');
  if (boardState) {
    boardState.textContent = state.boardStatus === 'loading' ? 'Loading the authenticated Board…'
      : state.boardStatus === 'error' ? 'The Board could not be loaded. Use Refresh board to retry.'
        : !state.invoices.length && !state.trips.length ? 'No invoices or trips for this date.' : '';
  }
  const statusMessage = $(root, '#statusMessage');
  if (statusMessage) statusMessage.textContent = state.statusMessage || 'Select an invoice and trip to assign it.';
  const newTripButton = $(root, '#newTripButton');
  if (newTripButton) newTripButton.disabled = !writesEnabled || Boolean(state.pendingMove);
  const refresh = $(root, '#refreshBoard');
  if (refresh) refresh.textContent = state.boardStatus === 'error' ? 'Retry board' : 'Refresh board';
  const selection = $(root, '#selectionSummary');
  if (selection) selection.textContent = selectedSummary(state);
}

async function parseApiResponse(response, fallbackMessage) {
  let payload = null;
  try { payload = await response.json(); } catch { /* Generic error below is intentional. */ }
  if (!response.ok) {
    const code = response.status === 401 ? 'unauthorized' : (payload?.error?.code || 'request_failed');
    const error = new Error(payload?.error?.message || (code === 'invalid_credentials' ? 'Invalid clerk ID or PIN.' : fallbackMessage));
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function createJsonRequest(method, body) {
  return { method, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getJson(fetchImpl, url, fallbackMessage) {
  return parseApiResponse(await fetchImpl(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } }), fallbackMessage);
}

function businessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date('invalid');
  return new Date(`${value}T00:00:00+08:00`);
}

const REPORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
});
const REPORT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function formatKualaLumpurDate(value) {
  const date = businessDate(value);
  return Number.isNaN(date.getTime()) ? '' : REPORT_DATE_FORMATTER.format(date);
}

export function formatKualaLumpurDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : REPORT_DATE_TIME_FORMATTER.format(date);
}

function reportQuery(filters, format) {
  const params = new URLSearchParams({
    startDate: filters.startDate,
    endDate: filters.endDate,
    company: filters.company || 'all',
    format,
  });
  if (filters.driverId !== undefined && filters.driverId !== null && filters.driverId !== '') params.set('driver_id', String(filters.driverId));
  if (filters.vehicleId !== undefined && filters.vehicleId !== null && filters.vehicleId !== '') params.set('lorry_id', String(filters.vehicleId));
  if (filters.status) params.set('status', filters.status);
  return params;
}

async function getCsv(fetchImpl, url, fallbackMessage) {
  const response = await fetchImpl(url, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'text/csv' } });
  if (!response.ok) {
    let payload = null;
    try { payload = await response.json(); } catch { /* Generic error below is intentional. */ }
    const code = response.status === 401 ? 'unauthorized' : (payload?.error?.code || 'request_failed');
    const error = new Error(payload?.error?.message || fallbackMessage);
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return {
    csv: await response.text(),
    filename: response.headers?.get?.('Content-Disposition')?.match(/filename="?([^";]+)"?/i)?.[1] || 'dispatch-report.csv',
  };
}

export function createFetchTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async loadBoard(options = {}) {
      const defaultDateRange = getDefaultDateRange();
      const {
        startDate = defaultDateRange.startDate,
        endDate = defaultDateRange.endDate,
        company = 'all',
      } = options;
      if (!COMPANY_FILTERS.includes(company)) throw new Error(`invalid company filter: ${company}`);
      const invoiceQuery = new URLSearchParams({ startDate, endDate, company });
      const tripQuery = new URLSearchParams({ startDate, endDate });
      const [invoicePayload, tripPayload, assignmentPayload] = await Promise.all([
        getJson(fetchImpl, `/api/dispatch/invoices?${invoiceQuery.toString()}`, 'The board could not be loaded.'),
        getJson(fetchImpl, `/api/dispatch/trips?${tripQuery.toString()}`, 'The trips could not be loaded.'),
        getJson(fetchImpl, '/api/dispatch/assignments?limit=100', 'The assignments could not be loaded.'),
      ]);
      return {
        invoices: invoicePayload?.invoices || [], trips: tripPayload?.trips || [],
        assignments: assignmentPayload?.assignments || [], sources: invoicePayload?.sources || {},
        quarantinedCount: Number(invoicePayload?.quarantinedCount) || 0,
        dateRange: invoicePayload?.dateRange || { startDate, endDate },
      };
    },
  };
}

export function createSessionTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async getSession() { return parseApiResponse(await fetchImpl('/api/dispatch/session', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } }), 'The session could not be checked.'); },
    async login({ clerkId, pin }) { return parseApiResponse(await fetchImpl('/api/dispatch/session', createJsonRequest('POST', { clerkId, pin })), 'Sign-in could not be completed.'); },
    async logout() { return parseApiResponse(await fetchImpl('/api/dispatch/session', { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json' } }), 'Sign-out could not be completed.'); },
  };
}

export function createResourceTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async loadResources({ active = 'true' } = {}) { return getJson(fetchImpl, `/api/dispatch/resources?${new URLSearchParams({ active: String(active) })}`, 'Resources could not be loaded.'); },
    async createResource(resource) {
      const allowed = resource.type === 'driver'
        ? { type: 'driver', name: resource.name, licenseNo: resource.licenseNo, phone: resource.phone ?? null, active: resource.active }
        : { type: 'lorry', registrationNo: resource.registrationNo, description: resource.description ?? null, active: resource.active };
      return parseApiResponse(await fetchImpl('/api/dispatch/resources', createJsonRequest('POST', approvedMutationBody(allowed))), 'The resource could not be added.');
    },
    async updateResource(resource) {
      const allowed = resource.type === 'driver'
        ? { type: 'driver', id: Number(resource.id), ...(resource.name === undefined ? {} : { name: resource.name }), ...(resource.licenseNo === undefined ? {} : { licenseNo: resource.licenseNo }), ...(resource.phone === undefined ? {} : { phone: resource.phone }), active: resource.active }
        : { type: 'lorry', id: Number(resource.id), ...(resource.registrationNo === undefined ? {} : { registrationNo: resource.registrationNo }), ...(resource.description === undefined ? {} : { description: resource.description }), active: resource.active };
      return parseApiResponse(await fetchImpl('/api/dispatch/resources', createJsonRequest('PATCH', approvedMutationBody(allowed))), 'The resource could not be updated.');
    },
  };
}

export function createTripsTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async createTrip({ trip_date, driver_id, vehicle_id, route_notes, request_id }) {
      const body = approvedMutationBody({ trip_date, driver_id: Number(driver_id), vehicle_id: Number(vehicle_id), route_notes: route_notes || '', ...(request_id ? { request_id } : {}) });
      return parseApiResponse(await fetchImpl('/api/dispatch/trips', createJsonRequest('POST', body)), 'The trip could not be created.');
    },
    async updateTrip({ trip_id, driver_id, vehicle_id, route_notes, status, expected_revision, request_id }) {
      const body = approvedMutationBody({
        trip_id: Number(trip_id),
        ...(driver_id !== undefined ? { driver_id: Number(driver_id) } : {}),
        ...(vehicle_id !== undefined ? { vehicle_id: Number(vehicle_id) } : {}),
        ...(route_notes !== undefined ? { route_notes } : {}),
        ...(status !== undefined ? { status } : {}),
        expected_revision: Number(expected_revision),
        ...(request_id ? { request_id } : {}),
      });
      return parseApiResponse(await fetchImpl('/api/dispatch/trips', createJsonRequest('PATCH', body)), 'The trip could not be updated.');
    },
  };
}

export function createAssignmentsTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async assignInvoice({ trip_id, company_key, invoice_id, doc_no, doc_date, expected_trip_revision, request_id }) {
      const body = approvedMutationBody({ trip_id: Number(trip_id), company_key, invoice_id, doc_no, doc_date, expected_trip_revision: Number(expected_trip_revision), ...(request_id ? { request_id } : {}) });
      return parseApiResponse(await fetchImpl('/api/dispatch/assignments', createJsonRequest('POST', body)), 'The invoice could not be assigned.');
    },
    async removeAssignment({ assignment_id, expected_trip_revision, request_id }) {
      const body = approvedMutationBody({ assignment_id: Number(assignment_id), operation: 'remove', expected_trip_revision: Number(expected_trip_revision), ...(request_id ? { request_id } : {}) });
      return parseApiResponse(await fetchImpl('/api/dispatch/assignments', createJsonRequest('PATCH', body)), 'The invoice could not be returned to the queue.');
    },
  };
}

export function createReportsTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  return {
    async loadReport(filters) {
      const params = reportQuery(filters, 'json');
      return getJson(fetchImpl, `/api/dispatch/reports?${params.toString()}`, 'The report could not be loaded.');
    },
    async exportReport(filters) {
      const params = reportQuery(filters, 'csv');
      return getCsv(fetchImpl, `/api/dispatch/reports?${params.toString()}`, 'The report could not be exported.');
    },
  };
}

function resourceStatusLabel(resource) { return resource.active ? 'Active' : 'Inactive'; }

function renderResource(resource, type) {
  const identity = type === 'driver' ? resource.licenseNo : resource.registrationNo;
  const title = type === 'driver' ? resource.name : identity;
  const detail = type === 'driver' ? (resource.phone || 'No phone recorded') : (resource.description || 'No description recorded');
  const nextActive = !resource.active;
  const actionLabel = `${nextActive ? 'Reactivate' : 'Deactivate'} ${type} ${title}`;
  return `<article class="resource-card${resource.active ? '' : ' is-inactive'}"><div><strong>${escapeHtml(title)}</strong><span class="resource-identity">${escapeHtml(identity)}</span><span class="resource-detail">${escapeHtml(detail)}</span></div><div class="resource-card-actions"><span class="status-badge">${resourceStatusLabel(resource)}</span><button class="secondary-button resource-toggle-button" type="button" data-resource-type="${type}" data-resource-id="${escapeHtml(resource.id)}" data-resource-active="${String(nextActive)}" aria-label="${escapeHtml(actionLabel)}">${nextActive ? 'Reactivate' : 'Deactivate'}</button></div></article>`;
}

export function renderResources(root, resources) {
  const driverList = $(root, '#driverList');
  const lorryList = $(root, '#lorryList');
  if (driverList) driverList.innerHTML = (resources.drivers || []).map((resource) => renderResource(resource, 'driver')).join('') || '<p class="empty-resource-list">No drivers in this view.</p>';
  if (lorryList) lorryList.innerHTML = (resources.lorries || []).map((resource) => renderResource(resource, 'lorry')).join('') || '<p class="empty-resource-list">No lorries in this view.</p>';
}

function renderTripOverview(root, state) {
  const list = $(root, '#tripsOverviewList');
  if (!list) return;
  list.innerHTML = state.trips.length ? state.trips.map((trip) => {
    const counts = getTripCompanyCounts(state, trip.id);
    const driverName = trip.driver?.name || trip.driverName || 'Driver not set';
    const lorryNumber = trip.lorry?.registrationNo || trip.registrationNo || 'Lorry not set';
    return `<article class="trip-detail-card" data-trip-detail-id="${escapeHtml(trip.id)}">
      <div class="trip-detail-heading"><div><p class="eyebrow">Trip ${escapeHtml(trip.id)}</p><h3>${escapeHtml(formatKualaLumpurDate(trip.tripDate) || trip.tripDate || 'Date not set')}</h3></div><span class="status-badge">${escapeHtml(trip.status || 'planned')}</span></div>
      <dl class="trip-detail-meta"><div><dt>Driver</dt><dd>${escapeHtml(driverName)}</dd></div><div><dt>Lorry</dt><dd>${escapeHtml(lorryNumber)}</dd></div><div><dt>Invoices</dt><dd>Enterprise ${counts.enterprise} · Sdn Bhd ${counts.sdn_bhd} · Combined ${counts.total}</dd></div></dl>
      <p class="trip-route">${escapeHtml(trip.routeNotes || 'Route notes not set')}</p>
      <a class="future-print-button" data-print-items-trip="${escapeHtml(trip.id)}" href="${escapeHtml(loadingSheetHref(trip.id))}">Print Items</a>
    </article>`;
  }).join('') : '<div class="empty-dropzone">No persisted trips in this date view.</div>';
}

function reportCompanyBadge(companyKey) {
  const className = companyKey === 'enterprise' ? 'enterprise' : 'sdn-bhd';
  return `<span class="company-badge ${className}">${escapeHtml(COMPANY_BADGES[companyKey] || companyKey)}</span>`;
}

export function renderReportTable(root, reportRecords = []) {
  const table = $(root, '#reportTable');
  if (!table) return;
  const body = table.querySelector('tbody');
  if (!body) return;
  body.innerHTML = reportRecords.length ? reportRecords.map((record) => `<tr>
    <td><strong>Trip ${escapeHtml(record.tripId)}</strong><span class="report-secondary">${escapeHtml(record.tripStatus)}</span></td>
    <td>${escapeHtml(formatKualaLumpurDate(record.tripDate) || record.tripDate)}</td>
    <td>${reportCompanyBadge(record.companyKey)}</td>
    <td><strong>${escapeHtml(record.docNo)}</strong><span class="report-secondary">${escapeHtml(record.invoiceId)}</span></td>
    <td><strong>${escapeHtml(record.customer?.name)}</strong><span class="report-secondary">${escapeHtml(record.customer?.code)}</span></td>
    <td>${escapeHtml(record.driver?.name)}<span class="report-secondary">${escapeHtml(record.lorry?.registrationNo)}</span></td>
    <td><strong>${escapeHtml(record.assignmentStatus)}</strong><span class="report-secondary">Updated ${escapeHtml(formatKualaLumpurDateTime(record.updatedAt))}</span></td>
  </tr>`).join('') : '<tr><td colspan="7">No persisted records match these filters.</td></tr>';
}

function renderReportView(root, reportState) {
  const state = $(root, '#reportState');
  if (state) {
    state.textContent = reportState.status === 'loading' ? 'Loading persisted report records…'
      : reportState.status === 'error' ? 'The report could not be loaded. Check the filters and retry.'
        : reportState.status === 'ready' ? `${reportState.records.length} persisted record${reportState.records.length === 1 ? '' : 's'} loaded.`
          : 'Choose filters and load a report.';
  }
  renderReportTable(root, reportState.records);
  const loadButton = $(root, '#loadReportButton');
  const exportButton = $(root, '#exportReportButton');
  if (loadButton) loadButton.disabled = reportState.status === 'loading';
  if (exportButton) exportButton.disabled = reportState.status === 'loading';
}

function syncDefaultDateControls(root, dateRange = getDefaultDateRange()) {
  const formattedDate = formatKualaLumpurDate(dateRange.startDate) || dateRange.startDate;
  const updatedAt = $(root, '#updatedAt');
  if (updatedAt) {
    updatedAt.setAttribute('datetime', dateRange.startDate);
    updatedAt.textContent = formattedDate;
  }
  const reportStartDate = $(root, '#reportStartDate');
  const reportEndDate = $(root, '#reportEndDate');
  if (reportStartDate) reportStartDate.value = dateRange.startDate;
  if (reportEndDate) reportEndDate.value = dateRange.endDate;
  const tripDialogHelp = $(root, '#tripDialogHelp');
  if (tripDialogHelp) tripDialogHelp.textContent = `Choose an active driver and lorry for ${formattedDate}.`;
}

export function createDispatchApp({
  documentRef = globalThis.document,
  transport = createFetchTransport(),
  sessionTransport = createSessionTransport(),
  resourcesTransport = createResourceTransport(),
  tripsTransport = createTripsTransport(),
  assignmentsTransport = createAssignmentsTransport(),
  reportsTransport = createReportsTransport(),
} = {}) {
  if (!documentRef) throw new Error('a document is required');
  const root = documentRef.querySelector('#dispatchApp');
  if (!root) throw new Error('dispatch app root is required');
  const initialDateRange = getDefaultDateRange();
  let state = createDispatchState({ dateRange: initialDateRange });
  let resources = { drivers: [], lorries: [] };
  let boardRequestSequence = 0;
  let resourceRequestSequence = 0;
  let boardAuthoritative = false;
  let mutationInFlight = false;
  let boardLoadQueued = false;
  let reportRequestSequence = 0;
  let reportState = { status: 'idle', records: [] };
  let authenticated = !$(root, '#loginView') || !$(root, '#authenticatedView');
  let session = null;
  let dialogInvoker = null;
  let stagedInvoiceKey = null;

  const loginView = $(root, '#loginView'); const authenticatedView = $(root, '#authenticatedView');
  const loginForm = $(root, '#dispatchLoginForm'); const loginMessage = $(root, '#loginMessage');
  const loginSubmit = $(root, '#loginSubmit'); const clerkIdInput = $(root, '#clerkId'); const clerkPinInput = $(root, '#clerkPin');
  const resourceForm = $(root, '#resourceForm'); const resourceType = $(root, '#resourceType'); const resourceStatus = $(root, '#resourceStatus');
  const resourceSubmit = $(root, '#resourceSubmit'); const showInactiveResources = $(root, '#showInactiveResources');
  const tripDialogBackdrop = $(root, '#tripDialogBackdrop'); const tripForm = $(root, '#tripForm');
  const reportForm = $(root, '#reportForm'); const exportReportButton = $(root, '#exportReportButton');

  function online() { return globalThis.navigator?.onLine !== false; }
  function writesEnabled() { return authenticated && online() && boardAuthoritative && !mutationInFlight && !state.pendingMove; }
  function resourceWritesEnabled() { return authenticated && online() && !mutationInFlight && !state.pendingMove; }
  function setAuthenticated(next, nextSession = null) { authenticated = next; session = next ? nextSession : null; if (loginView) loginView.hidden = next; if (authenticatedView) authenticatedView.hidden = !next; root.dataset.authenticated = String(next); }
  function setLoginMessage(message) { if (loginMessage) loginMessage.textContent = message; }
  function setResourceMessage(message) { if (resourceStatus) resourceStatus.textContent = message; }
  function render() { renderDispatchBoard(root, state, { writesEnabled: writesEnabled(), resources }); renderTripOverview(root, state); renderReportView(root, reportState); updateWriteControls(); updateOfflineStatus(); }
  function updateWriteControls() { const enabled = resourceWritesEnabled(); if (resourceSubmit) resourceSubmit.disabled = !enabled; root.querySelectorAll?.('[data-resource-active]')?.forEach((button) => { button.disabled = !enabled; }); }
  function updateOfflineStatus() { const element = $(root, '#offlineStatus'); if (element) { element.hidden = online(); } }
  function setState(nextState) { state = nextState; render(); }
  function clearSensitiveState() { boardRequestSequence += 1; resourceRequestSequence += 1; reportRequestSequence += 1; boardAuthoritative = false; state = createDispatchState({ boardStatus: 'empty' }); reportState = { status: 'idle', records: [] }; resources = { drivers: [], lorries: [] }; stagedInvoiceKey = null; setAuthenticated(false); render(); for (const id of ['driverList', 'lorryList']) { const list = $(root, `#${id}`); if (list) list.innerHTML = ''; } resourceForm?.reset?.(); updateResourceTypeFields(); }
  function handleSessionLoss() { clearSensitiveState(); setLoginMessage('Your session has expired. Sign in again.'); setResourceMessage('Your session has expired. Sign in again.'); }

  async function runMutation(operation, canWrite = writesEnabled) {
    if (!canWrite()) return false;
    mutationInFlight = true;
    render();
    try {
      return await operation();
    } finally {
      if (boardLoadQueued && authenticated) {
        try { await loadBoard({ allowDuringMutation: true }); } catch { /* loadBoard renders the applied failure. */ }
      }
      mutationInFlight = false;
      render();
    }
  }

  async function loadBoard({ preserveMessage = false, allowDuringMutation = false } = {}) {
    if (!authenticated) return state;
    if (mutationInFlight && !allowDuringMutation) { boardLoadQueued = true; return state; }
    if (allowDuringMutation) boardLoadQueued = false;
    const requestSequence = ++boardRequestSequence; const requestedCompany = state.companyFilter; const previousMessage = state.statusMessage;
    boardAuthoritative = false;
    state = { ...state, boardStatus: 'loading', statusMessage: preserveMessage ? previousMessage : 'Loading the authenticated Board…' }; render();
    try {
      const dateRange = getDefaultDateRange();
      const board = await transport.loadBoard({ startDate: dateRange.startDate, endDate: dateRange.endDate, company: requestedCompany });
      if (requestSequence !== boardRequestSequence || state.companyFilter !== requestedCompany) return state;
      let boardResources = resources;
      if (authenticated && $(root, '#driverList') && boardNeedsResourceCatalog(board)) {
        const loadedResources = await loadResources({ boardSequence: requestSequence });
        boardResources = loadedResources ? normalizeResources(loadedResources) : resources;
      }
      if (requestSequence !== boardRequestSequence || state.companyFilter !== requestedCompany) return state;
      state = reloadDispatchState(state, { ...board, resources: boardResources, boardStatus: board.invoices?.length || board.trips?.length ? 'ready' : 'empty' });
      boardAuthoritative = true;
      if (preserveMessage) state.statusMessage = previousMessage;
      render();
      return state;
    } catch (error) {
      if (requestSequence !== boardRequestSequence || state.companyFilter !== requestedCompany) return state;
      if (error.code === 'unauthorized') { handleSessionLoss(); $(root, '#statusMessage').textContent = 'Your session has expired. Sign in again.'; }
      else { boardAuthoritative = false; state = createDispatchState({ companyFilter: requestedCompany, boardStatus: 'error' }); state.statusMessage = 'The Board could not be loaded. Use Retry board to try again.'; render(); }
      throw error;
    }
  }

  async function loadResources({ boardSequence = null } = {}) {
    if (!authenticated || !$(root, '#driverList')) return null;
    const requestSequence = ++resourceRequestSequence; const active = showInactiveResources?.checked ? 'all' : 'true'; setResourceMessage('Loading resources…');
    try {
      const result = await resourcesTransport.loadResources({ active });
      if (requestSequence !== resourceRequestSequence || !authenticated || (boardSequence !== null && boardSequence !== boardRequestSequence)) return null;
      resources = normalizeResources(result);
      state = { ...state, trips: state.trips.map((trip) => ({ ...trip, driver: trip.driver || resources.drivers.find((row) => String(row.id) === String(trip.driverId)), lorry: trip.lorry || resources.lorries.find((row) => String(row.id) === String(trip.vehicleId)) })) };
      renderResources(root, resources); renderTripFormOptions(); renderReportFilterOptions(); render(); setResourceMessage('Resources loaded.'); return result;
    } catch (error) {
      if (requestSequence !== resourceRequestSequence || !authenticated || (boardSequence !== null && boardSequence !== boardRequestSequence)) return null;
      if (error.code === 'unauthorized') handleSessionLoss(); else setResourceMessage('Resources could not be loaded. Try again.'); throw error;
    }
  }

  async function updateResource(type, id, active) {
    if (!resourceWritesEnabled()) return false;
    return runMutation(async () => {
      setResourceMessage('Saving resource…');
      try { await resourcesTransport.updateResource({ type, id: Number(id), active }); setResourceMessage('Resource updated.'); await loadResources(); return true; }
      catch (error) { if (error.code === 'unauthorized') handleSessionLoss(); else setResourceMessage('Resource could not be updated. Try again.'); throw error; }
    }, resourceWritesEnabled);
  }
  function updateResourceTypeFields() { const driverFields = $(root, '#driverResourceFields'); const lorryFields = $(root, '#lorryResourceFields'); const isDriver = resourceType?.value === 'driver'; if (driverFields) driverFields.hidden = !isDriver; if (lorryFields) lorryFields.hidden = isDriver; if (resourceSubmit) resourceSubmit.textContent = isDriver ? 'Add driver' : 'Add lorry'; }
  async function submitResource() {
    if (!resourceType || !resourceWritesEnabled()) return;
    const type = resourceType.value; const body = type === 'driver' ? { type, name: $(root, '#resourceName')?.value?.trim() || '', licenseNo: $(root, '#resourceLicenseNo')?.value?.trim() || '', phone: $(root, '#resourcePhone')?.value?.trim() || null } : { type, registrationNo: $(root, '#resourceRegistrationNo')?.value?.trim() || '', description: $(root, '#resourceDescription')?.value?.trim() || null };
    const validationMessage = resourceValidationMessage(body);
    if (validationMessage) { setResourceMessage(validationMessage); return false; }
    return runMutation(async () => {
      setResourceMessage('Saving resource…');
      try { await resourcesTransport.createResource(body); resourceForm?.reset?.(); updateResourceTypeFields(); setResourceMessage('Resource added.'); await loadResources(); return true; }
      catch (error) { if (error.code === 'resource_conflict') setResourceMessage('A resource with that identity already exists.'); else if (error.code === 'unauthorized') handleSessionLoss(); else setResourceMessage('Resource could not be added. Try again.'); throw error; }
    }, resourceWritesEnabled);
  }

  function renderTripFormOptions() {
    const driverSelect = $(root, '#tripDriver'); const vehicleSelect = $(root, '#tripVehicle');
    if (driverSelect) driverSelect.innerHTML = resources.drivers.filter((row) => row.active !== false).map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)} · ${escapeHtml(row.licenseNo)}</option>`).join('');
    if (vehicleSelect) vehicleSelect.innerHTML = resources.lorries.filter((row) => row.active !== false).map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.registrationNo)}</option>`).join('');
  }
  function renderReportFilterOptions() {
    const driverSelect = $(root, '#reportDriver'); const lorrySelect = $(root, '#reportLorry');
    if (driverSelect) {
      const selected = driverSelect.value;
      driverSelect.innerHTML = `<option value="">All drivers</option>${resources.drivers.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)} · ${escapeHtml(row.licenseNo)}</option>`).join('')}`;
      driverSelect.value = selected;
    }
    if (lorrySelect) {
      const selected = lorrySelect.value;
      lorrySelect.innerHTML = `<option value="">All lorries</option>${resources.lorries.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.registrationNo)}</option>`).join('')}`;
      lorrySelect.value = selected;
    }
  }
  async function openTripDialog(button, { lorryId = null } = {}) {
    if (!writesEnabled()) return;
    dialogInvoker = button;
    if (!resources.drivers.length || !resources.lorries.length) await loadResources();
    renderTripFormOptions();
    const vehicleSelect = $(root, '#tripVehicle');
    if (vehicleSelect && lorryId != null) vehicleSelect.value = String(lorryId);
    $(root, '#tripDialogMessage').textContent = '';
    if (tripDialogBackdrop) tripDialogBackdrop.hidden = false;
    $(root, '#tripDriver')?.focus?.();
  }
  async function updateTripDriver(tripId, driverId) {
    if (!writesEnabled()) return false;
    const trip = state.trips.find((candidate) => String(candidate.id) === String(tripId));
    if (!trip) return false;
    return runMutation(async () => {
      try {
        await tripsTransport.updateTrip({ trip_id: trip.id, driver_id: driverId, expected_revision: trip.revision, request_id: createRequestId() });
        state.statusMessage = 'Driver updated for the trip.';
        await loadBoard({ preserveMessage: true, allowDuringMutation: true });
        return true;
      } catch (error) {
        if (error.code === 'unauthorized') handleSessionLoss();
        else if (error.code === 'stale_trip') {
          state.statusMessage = 'Trip changed on the server. Board refreshed — please re-apply the driver change.';
          try { await loadBoard({ preserveMessage: true, allowDuringMutation: true }); } catch { /* loadBoard renders the authoritative refresh failure. */ }
        } else state.statusMessage = 'The driver could not be updated. Try again.';
        render();
        return false;
      }
    });
  }
  function closeTripDialog() { if (tripDialogBackdrop) tripDialogBackdrop.hidden = true; dialogInvoker?.focus?.(); dialogInvoker = null; stagedInvoiceKey = null; }
  async function stageInvoiceForLorry(invoiceKey, lorryId) {
    if (!writesEnabled()) return;
    if (!isCurrentEligibleUnassignedInvoice(state, invoiceKey)) return;
    stagedInvoiceKey = invoiceKey;
    const invoice = state.invoices.find((candidate) => candidate.key === invoiceKey);
    try {
      await openTripDialog(null, { lorryId });
    } catch (error) {
      if (stagedInvoiceKey === invoiceKey) stagedInvoiceKey = null;
      if (error.code !== 'unauthorized') $(root, '#statusMessage').textContent = 'Resources could not be loaded. Try again.';
      return;
    }
    const message = $(root, '#tripDialogMessage');
    if (message) message.textContent = invoice ? `${invoice.docNo} will be assigned to the new trip for lorry ${lorryId}.` : '';
  }
  async function createTrip() {
    if (!writesEnabled()) return;
    return runMutation(async () => {
      const body = { trip_date: getDefaultDateRange().startDate, driver_id: Number($(root, '#tripDriver')?.value), vehicle_id: Number($(root, '#tripVehicle')?.value), route_notes: $(root, '#tripRouteNotes')?.value?.trim() || '' };
      const submit = $(root, '#createTripSubmit'); if (submit) submit.disabled = true; $(root, '#tripDialogMessage').textContent = 'Creating trip…';
      const stagedKey = stagedInvoiceKey;
      try {
        const created = await tripsTransport.createTrip(body);
        const newTripId = created?.trip?.id ?? created?.id;
        stagedInvoiceKey = null;
        closeTripDialog();
        state.statusMessage = 'Trip created.';
        if (stagedKey && newTripId != null) {
          await loadBoard({ preserveMessage: true, allowDuringMutation: true });
          const newTrip = state.trips.find((trip) => String(trip.id) === String(newTripId));
          if (isCurrentEligibleUnassignedInvoice(state, stagedKey) && newTrip) {
            const invoice = state.invoices.find((candidate) => candidate.key === stagedKey);
            const requestId = createRequestId();
            setState(beginOptimisticMove(state, { invoiceKey: stagedKey, tripId: newTripId, requestId }));
            try {
              await assignmentsTransport.assignInvoice({ trip_id: Number(newTripId), company_key: companyKeyOf(invoice), invoice_id: invoice.invoiceId, doc_no: invoice.docNo, doc_date: invoice.docDate, expected_trip_revision: newTrip.revision ?? 1, request_id: requestId });
              state = settleMoveResponse(state, { requestId, accepted: true, message: 'Trip created. Invoice assigned.' });
            } catch (assignError) {
              state = rejectMoveResponse(state, { requestId, message: 'Trip created but the invoice could not be assigned. Try again.' });
              if (assignError.code === 'unauthorized') handleSessionLoss();
            }
            render();
          }
        }
        await loadBoard({ preserveMessage: true, allowDuringMutation: true });
        return true;
      } catch (error) { if (error.code === 'unauthorized') handleSessionLoss(); else $(root, '#tripDialogMessage').textContent = 'The trip could not be created. Try again.'; throw error; }
      finally { if (submit) submit.disabled = false; }
    });
  }

  function currentReportFilters() {
    return {
      startDate: $(root, '#reportStartDate')?.value || '',
      endDate: $(root, '#reportEndDate')?.value || '',
      company: $(root, '#reportCompany')?.value || 'all',
      driverId: $(root, '#reportDriver')?.value || null,
      vehicleId: $(root, '#reportLorry')?.value || null,
      status: $(root, '#reportStatus')?.value || null,
    };
  }

  async function loadReports() {
    if (!authenticated || typeof reportsTransport?.loadReport !== 'function') return null;
    const requestSequence = ++reportRequestSequence;
    const filters = currentReportFilters();
    const filterKey = JSON.stringify(filters);
    reportState = { status: 'loading', records: [], filters, filterKey };
    render();
    try {
      const result = await reportsTransport.loadReport(filters);
      if (requestSequence !== reportRequestSequence || !authenticated) return null;
      const records = Array.isArray(result?.records) ? result.records : [];
      reportState = { status: 'ready', records, filters, filterKey };
      render();
      return result;
    } catch (error) {
      if (requestSequence !== reportRequestSequence || !authenticated) return null;
      if (error.code === 'unauthorized') handleSessionLoss();
      else { reportState = { status: 'error', records: [], filters, filterKey }; render(); }
      throw error;
    }
  }

  async function openReports() {
    if (!authenticated) return null;
    try {
      if (!resources.drivers.length && !resources.lorries.length) {
        try { await loadResources(); } catch (error) { if (error.code === 'unauthorized') throw error; }
      }
      return await loadReports();
    } catch (error) {
      if (error.code !== 'unauthorized') {
        reportState = { status: 'error', records: [], filters: currentReportFilters(), filterKey: '' };
        render();
      }
      throw error;
    }
  }

  async function exportReport() {
    if (!authenticated || typeof reportsTransport?.exportReport !== 'function') return null;
    const filters = currentReportFilters();
    const filterKey = JSON.stringify(filters);
    if (reportState.status !== 'ready' || reportState.filterKey !== filterKey) await loadReports();
    const result = await reportsTransport.exportReport(filters);
    const BlobConstructor = globalThis.Blob;
    const URLConstructor = globalThis.URL;
    if (!BlobConstructor || !URLConstructor?.createObjectURL || !documentRef.createElement) return result;
    const url = URLConstructor.createObjectURL(new BlobConstructor([result.csv], { type: 'text/csv;charset=utf-8' }));
    const link = documentRef.createElement('a');
    link.href = url;
    link.download = result.filename || 'dispatch-report.csv';
    link.className = 'report-download-link';
    link.hidden = true;
    documentRef.body?.appendChild?.(link);
    link.click();
    link.remove?.();
    globalThis.setTimeout?.(() => URLConstructor.revokeObjectURL?.(url), 0);
    return result;
  }

  function focusAssignmentReplacement({ invoiceKey, tripId, preferTrip }) {
    const currentInvoiceControl = [...(root.querySelectorAll?.('[data-assign-invoice]') || [])]
      .find((candidate) => candidate.dataset.assignInvoice === invoiceKey);
    const currentTripControl = [...(root.querySelectorAll?.('[data-assign-selected]') || [])]
      .find((candidate) => String(candidate.dataset.assignSelected) === String(tripId));
    (preferTrip ? currentTripControl || currentInvoiceControl : currentInvoiceControl || currentTripControl)?.focus?.();
  }

  async function assignInvoice(invoiceKey, tripId, control = null) {
    if (!writesEnabled()) return false;
    if (!isCurrentEligibleUnassignedInvoice(state, invoiceKey)) {
      const rejected = state.invoices.find((candidate) => candidate.key === invoiceKey);
      state.statusMessage = rejected && rejected.tripId !== null
        ? 'Moving invoices between trips is not available yet. Remove it to the queue first.'
        : 'That invoice cannot be assigned in its current state.';
      render();
      return false;
    }
    const invoice = state.invoices.find((candidate) => candidate.key === invoiceKey); const trip = state.trips.find((candidate) => String(candidate.id) === String(tripId));
    if (!invoice || !trip) return false;
    const preferTripFocus = Boolean(control?.dataset?.assignSelected || control?.dataset?.dropTripId);
    const accepted = await runMutation(async () => {
      const requestId = createRequestId(); setState(beginOptimisticMove(state, { invoiceKey, tripId, requestId }));
      try {
        await assignmentsTransport.assignInvoice({ trip_id: trip.id, company_key: companyKeyOf(invoice), invoice_id: invoice.invoiceId, doc_no: invoice.docNo, doc_date: invoice.docDate, expected_trip_revision: trip.revision, request_id: requestId });
        if (state.pendingMove?.requestId !== requestId) return false;
        state = settleMoveResponse(state, { requestId, accepted: true, message: 'Assignment saved.' }); render();
        await loadBoard({ preserveMessage: true, allowDuringMutation: true });
        state.statusMessage = 'Assignment saved.'; render();
        return true;
      } catch (error) {
        if (state.pendingMove?.requestId !== requestId) return false;
        state = rejectMoveResponse(state, { requestId, message: error.code === 'stale_trip' ? 'Trip changed on the server. Assignment rolled back; Board refreshed.' : 'The invoice could not be assigned. It was returned to the queue.' }); render();
        if (error.code === 'stale_trip') { try { await loadBoard({ preserveMessage: true, allowDuringMutation: true }); state.statusMessage = 'Trip changed on the server. Assignment rolled back; Board refreshed.'; render(); } catch { /* loadBoard reports the authoritative refresh failure. */ } }
        if (error.code === 'unauthorized') handleSessionLoss();
        return false;
      }
    });
    focusAssignmentReplacement({ invoiceKey, tripId, preferTrip: accepted || preferTripFocus });
    return accepted;
  }

  async function removeAssignedInvoice(invoiceKey) {
    if (!writesEnabled()) return false;
    const invoice = state.invoices.find((candidate) => candidate.key === invoiceKey);
    const trip = state.trips.find((candidate) => String(candidate.id) === String(invoice?.tripId));
    if (!invoice || !trip || !canRemoveAssignment(invoice)) return false;
    const accepted = await runMutation(async () => {
      const requestId = createRequestId();
      setState(beginOptimisticRemoval(state, { invoiceKey, requestId }));
      try {
        await assignmentsTransport.removeAssignment({ assignment_id: invoice.assignmentId, expected_trip_revision: trip.revision, request_id: requestId });
        if (state.pendingMove?.requestId !== requestId) return false;
        state = settleMoveResponse(state, { requestId, accepted: true, message: 'Invoice returned to the unassigned queue.' }); render();
        await loadBoard({ preserveMessage: true, allowDuringMutation: true });
        state.statusMessage = 'Invoice returned to the unassigned queue.'; render();
        return true;
      } catch (error) {
        if (state.pendingMove?.requestId !== requestId) return false;
        state = rejectMoveResponse(state, { requestId, message: error.code === 'stale_trip' ? 'Trip changed on the server. Invoice removal rolled back; Board refreshed.' : 'The invoice could not be removed. It stayed on the lorry.' }); render();
        if (error.code === 'stale_trip') { try { await loadBoard({ preserveMessage: true, allowDuringMutation: true }); state.statusMessage = 'Trip changed on the server. Invoice removal rolled back; Board refreshed.'; render(); } catch { /* loadBoard reports the authoritative refresh failure. */ } }
        if (error.code === 'unauthorized') handleSessionLoss();
        return false;
      }
    });
    focusAssignmentReplacement({ invoiceKey, tripId: trip.id, preferTrip: !accepted });
    return accepted;
  }

  async function login() { if (!clerkIdInput || !clerkPinInput) return; if (loginSubmit) loginSubmit.disabled = true; setLoginMessage('Signing in…'); try { const result = await sessionTransport.login({ clerkId: clerkIdInput.value.trim(), pin: clerkPinInput.value }); if (!result?.authenticated || !result.session) throw new Error('Sign-in could not be completed.'); setAuthenticated(true, result.session); setLoginMessage(''); clerkPinInput.value = ''; await loadBoard(); root.querySelector('[role="tab"]')?.focus?.(); } catch (error) { setAuthenticated(false); setLoginMessage(error.code === 'invalid_credentials' ? 'Invalid clerk ID or PIN.' : 'Sign-in could not be completed. Try again.'); clerkPinInput.value = ''; clerkPinInput.focus?.(); throw error; } finally { if (loginSubmit) loginSubmit.disabled = false; } }
  async function logout() { try { const result = await sessionTransport.logout(); if (!result || result.authenticated !== false || result.success === false) { const error = new Error('sign-out was not confirmed by the server'); error.code = 'logout_not_confirmed'; throw error; } } catch (error) { $(root, '#statusMessage').textContent = 'Sign-out could not be completed. Try again.'; setResourceMessage('Sign-out could not be completed. Try again.'); throw error; } clearSensitiveState(); setLoginMessage('You have been signed out.'); clerkIdInput?.focus?.(); }
  async function initializeSession() { if (!loginView || !authenticatedView || !loginForm) return; setAuthenticated(false); setLoginMessage('Checking sign-in…'); try { const result = await sessionTransport.getSession(); if (result?.authenticated && result.session) { setAuthenticated(true, result.session); setLoginMessage(''); await loadBoard(); } else setLoginMessage('Sign in to continue.'); } catch (error) { if (error.code === 'unauthorized') handleSessionLoss(); else setLoginMessage('Sign-in is temporarily unavailable. Try again.'); } }
  function activateTab(tabName, { focus = false } = {}) { root.querySelectorAll('[role="tab"]').forEach((tab) => { const active = tab.dataset.tab === tabName; tab.classList.toggle('is-active', active); tab.setAttribute('aria-selected', String(active)); tab.setAttribute('tabindex', active ? '0' : '-1'); if (active && focus) tab.focus(); }); root.querySelectorAll('[role="tabpanel"]').forEach((panel) => { panel.hidden = panel.id !== `${tabName}View`; }); }

  root.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener('click', () => { activateTab(tab.dataset.tab); if (tab.dataset.tab === 'resources' && authenticated) loadResources().catch(() => {}); if (tab.dataset.tab === 'reports' && authenticated) openReports().catch(() => {}); }));
  $(root, '#companyFilter')?.addEventListener('change', (event) => { setState(setCompanyFilter(state, event.target.value)); loadBoard().catch(() => {}); });
  $(root, '#invoiceSearch')?.addEventListener('input', (event) => { setState(setSearchQuery(state, event.target.value)); });
  $(root, '#refreshBoard')?.addEventListener('click', () => loadBoard().catch(() => {}));
  $(root, '#refreshTrips')?.addEventListener('click', () => loadBoard().catch(() => {}));
  $(root, '#logoutButton')?.addEventListener('click', () => logout().catch(() => {}));
  $(root, '#newTripButton')?.addEventListener('click', (event) => openTripDialog(event.currentTarget).catch((error) => { if (error.code !== 'unauthorized') $(root, '#statusMessage').textContent = 'Resources could not be loaded. Try again.'; }));
  $(root, '#closeTripDialog')?.addEventListener('click', closeTripDialog);
  tripDialogBackdrop?.addEventListener('click', (event) => { if (event.target === tripDialogBackdrop) closeTripDialog(); });
  loginForm?.addEventListener('submit', (event) => { event.preventDefault(); login().catch(() => {}); });
  resourceForm?.addEventListener('submit', (event) => { event.preventDefault(); submitResource().catch(() => {}); });
  tripForm?.addEventListener('submit', (event) => { event.preventDefault(); createTrip().catch(() => {}); });
  reportForm?.addEventListener('submit', (event) => { event.preventDefault(); loadReports().catch(() => {}); });
  exportReportButton?.addEventListener('click', () => exportReport().catch((error) => { if (error.code === 'unauthorized') handleSessionLoss(); else { const status = $(root, '#reportState'); if (status) status.textContent = 'The report could not be exported. Try again.'; } }));
  resourceType?.addEventListener('change', updateResourceTypeFields); showInactiveResources?.addEventListener('change', () => loadResources().catch(() => {}));

  root.addEventListener('click', (event) => {
    const remove = event.target.closest?.('[data-remove-assignment]'); if (remove) { removeAssignedInvoice(remove.dataset.removeAssignment).catch(() => {}); return; }
    const assign = event.target.closest?.('[data-assign-invoice]'); if (assign) { const tripId = state.selectedTripId || state.trips[0]?.id; if (tripId !== undefined) assignInvoice(assign.dataset.assignInvoice, tripId, assign).catch(() => {}); return; }
    const assignSelected = event.target.closest?.('[data-assign-selected]'); if (assignSelected) { if (state.selectedInvoiceKey) assignInvoice(state.selectedInvoiceKey, assignSelected.dataset.assignSelected, assignSelected).catch(() => {}); return; }
    const startTrip = event.target.closest?.('[data-start-trip]'); if (startTrip) { const lorryId = startTrip.dataset.startTrip; if (state.selectedInvoiceKey) stageInvoiceForLorry(state.selectedInvoiceKey, lorryId); else openTripDialog(startTrip, { lorryId }).catch((error) => { if (error.code !== 'unauthorized') $(root, '#statusMessage').textContent = 'Resources could not be loaded. Try again.'; }); return; }
    if (state.selectedInvoiceKey) {
      const lorryLane = event.target.closest?.('[data-lorry-id]');
      const onControl = event.target.closest?.('button, select, a, [data-select-invoice], [data-assign-invoice], [data-assign-selected], [data-select-trip]');
      if (lorryLane && !onControl) {
        const tripEls = [...(lorryLane.querySelectorAll?.('[data-trip-id]') || [])];
        if (tripEls.length === 0) { stageInvoiceForLorry(state.selectedInvoiceKey, lorryLane.dataset.lorryId); return; }
        if (tripEls.length === 1) { assignInvoice(state.selectedInvoiceKey, tripEls[0].dataset.tripId, lorryLane).catch(() => {}); return; }
      }
    }
    const selection = resolveDispatchClickTarget(event.target); if (!selection) return; if (selection.kind === 'invoice') setState(selectInvoice(state, selection.key)); else setState(selectTrip(state, selection.id));
  });
  root.addEventListener('change', (event) => {
    const tripDriverSelect = event.target.closest?.('[data-trip-driver]');
    if (tripDriverSelect) {
      const tripId = tripDriverSelect.dataset.tripDriver;
      const driverId = tripDriverSelect.value;
      if (tripId != null && driverId) updateTripDriver(tripId, driverId).catch(() => {});
      return;
    }
    const driverSelect = event.target.closest?.('[data-lorry-driver]');
    if (driverSelect) {
      const lorryId = driverSelect.dataset.lorryDriver;
      const driverId = driverSelect.value;
      const matchingTrips = state.trips.filter((trip) => String(lorryIdOf(trip)) === String(lorryId));
      if (matchingTrips.length === 1 && driverId) updateTripDriver(matchingTrips[0].id, driverId).catch(() => {});
    }
  });
  root.addEventListener('click', (event) => { const button = event.target.closest?.('[data-resource-active]'); if (button) updateResource(button.dataset.resourceType, button.dataset.resourceId, button.dataset.resourceActive === 'true').catch(() => {}); });
  root.addEventListener('dragstart', (event) => { const card = event.target.closest?.('[data-invoice-key][draggable="true"]'); if (card && event.dataTransfer) event.dataTransfer.setData('text/plain', card.dataset.invoiceKey); });
  root.addEventListener('dragover', (event) => { if (event.target.closest?.('[data-drop-unassigned], [data-drop-lorry-id], [data-drop-trip-id], [data-trip-id]')) event.preventDefault(); });
  root.addEventListener('drop', (event) => {
    const unassignedZone = event.target.closest?.('[data-drop-unassigned]');
    const lorryZone = event.target.closest?.('[data-drop-lorry-id]');
    const tripZone = event.target.closest?.('[data-drop-trip-id], [data-trip-id]');
    if (!unassignedZone && !lorryZone && !tripZone) return;
    event.preventDefault();
    const invoiceKey = event.dataTransfer?.getData('text/plain');
    if (!invoiceKey) return;
    if (unassignedZone) removeAssignedInvoice(invoiceKey).catch(() => {});
    else if (lorryZone) stageInvoiceForLorry(invoiceKey, lorryZone.dataset.dropLorryId);
    else assignInvoice(invoiceKey, tripZone.dataset.dropTripId ?? tripZone.dataset.tripId, tripZone).catch(() => {});
  });
  root.addEventListener('keydown', (event) => { const tab = event.target.closest?.('[role="tab"]'); if (tab) { const tabs = [...root.querySelectorAll('[role="tab"]')]; const nextIndex = getTabNavigationIndex(tabs.indexOf(tab), event.key, tabs.length); if (nextIndex !== null) { event.preventDefault(); activateTab(tabs[nextIndex].dataset.tab, { focus: true }); } return; } const assign = event.target.closest?.('[data-assign-selected], [data-assign-invoice]'); if (assign && event.key === 'Enter') { event.preventDefault(); assign.click(); } });
  globalThis.addEventListener?.('online', render); globalThis.addEventListener?.('offline', render);
  syncDefaultDateControls(root, initialDateRange); activateTab('board'); updateResourceTypeFields(); render(); initializeSession().catch(() => {});
  return { getState: () => state, getSession: () => session, loadBoard, loadResources, loadReports, exportReport, assignInvoice, removeAssignedInvoice, render, activateTab, login, logout };
}

if (typeof document !== 'undefined') window.addEventListener('DOMContentLoaded', () => { window.dispatchApp = createDispatchApp(); }, { once: true });
