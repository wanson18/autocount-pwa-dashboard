const COMPANY_BADGES = Object.freeze({ enterprise: 'Enterprise', sdn_bhd: 'Sdn Bhd' });
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const $ = (root, selector) => root.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function businessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date('invalid');
  return new Date(`${value}T00:00:00+08:00`);
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
});
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-MY', {
  timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function formatKualaLumpurDate(value) {
  const date = businessDate(value);
  return Number.isNaN(date.getTime()) ? '' : DATE_FORMATTER.format(date);
}

export function formatKualaLumpurDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : DATE_TIME_FORMATTER.format(date);
}

function companyBadge(companyKey) {
  const className = companyKey === 'enterprise' ? 'enterprise' : 'sdn-bhd';
  return `<span class="company-badge ${className}">${escapeHtml(COMPANY_BADGES[companyKey] || companyKey)}</span>`;
}

function displayTripValue(value, fallback = 'Not recorded') {
  return escapeHtml(value || fallback);
}

export function getTripId(search = globalThis.location?.search || '') {
  const params = new URLSearchParams(search);
  const values = params.getAll('trip_id');
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return null;
  const id = Number(values[0]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function renderLoadingSheet(root, sheet) {
  const trip = sheet?.trip || {};
  const counts = sheet?.counts || {};
  const items = Array.isArray(sheet?.items) ? sheet.items : [];
  const invoices = Array.isArray(sheet?.invoices) ? sheet.invoices : [];
  const tripId = trip.id;
  const title = $(root, '#sheetTitle');
  if (title) title.textContent = `Trip ${tripId} loading sheet`;
  if (globalThis.document) globalThis.document.title = `Trip ${tripId} loading sheet — AutoCount Sales Dashboard`;

  const content = $(root, '#sheetContent');
  if (!content) return;
  content.innerHTML = `
    <section class="sheet-panel trip-panel" aria-labelledby="tripSummaryTitle">
      <div class="sheet-panel-heading">
        <div><p class="eyebrow">Persisted dispatch record</p><h2 id="tripSummaryTitle">Trip ${escapeHtml(tripId)}</h2></div>
        <span class="trip-status">${displayTripValue(trip.status, 'Status not recorded')}</span>
      </div>
      <dl class="summary-grid">
        <div class="summary-cell"><dt>Trip date</dt><dd>${escapeHtml(formatKualaLumpurDate(trip.tripDate))}</dd></div>
        <div class="summary-cell"><dt>Driver</dt><dd>${displayTripValue(trip.driver?.name)}</dd></div>
        <div class="summary-cell"><dt>Lorry</dt><dd>${displayTripValue(trip.lorry?.registrationNo)}</dd></div>
        <div class="summary-cell"><dt>Invoices</dt><dd>${escapeHtml(counts.total ?? 0)} · Enterprise ${escapeHtml(counts.enterprise ?? 0)} · Sdn Bhd ${escapeHtml(counts.sdn_bhd ?? 0)}</dd></div>
      </dl>
      <p class="route-notes"><strong>Route:</strong> ${displayTripValue(trip.routeNotes, 'Route notes not recorded')}</p>
    </section>

    <section class="sheet-panel" aria-labelledby="itemsTitle">
      <div class="sheet-panel-heading"><div><p class="eyebrow">Physical load</p><h2 id="itemsTitle">Item totals</h2></div></div>
      <div class="items-table-wrap">
        <table class="items-table">
          <thead><tr><th scope="col">Item code</th><th scope="col">Description</th><th scope="col">UOM</th><th scope="col">Enterprise</th><th scope="col">Sdn Bhd</th><th scope="col">Total loaded</th></tr></thead>
          <tbody>${items.length ? items.map((item) => `<tr><td>${escapeHtml(item.itemCode)}</td><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.uom)}</td><td>${escapeHtml(item.enterprise)}</td><td>${escapeHtml(item.sdn_bhd)}</td><td class="quantity-total">${escapeHtml(item.total)}</td></tr>`).join('') : '<tr><td colspan="6">No persisted item snapshots remain on this trip.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="signoff-grid" aria-label="Loading sign-off fields">
        <div class="signoff-cell">Loaded by<span class="blank-line"></span></div>
        <div class="signoff-cell">Checked by<span class="blank-line"></span></div>
        <div class="signoff-cell">Driver sign-off<span class="blank-line"></span></div>
      </div>
    </section>

    <section class="sheet-panel" aria-labelledby="checklistTitle">
      <div class="sheet-panel-heading"><div><p class="eyebrow">Verification</p><h2 id="checklistTitle">Invoice checklist</h2></div></div>
      <div class="checklist-table-wrap">
        <table class="checklist-table">
          <thead><tr><th scope="col">Company</th><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Check</th></tr></thead>
          <tbody>${invoices.length ? invoices.map((invoice) => `<tr><td>${companyBadge(invoice.companyKey)}</td><td><strong>${escapeHtml(invoice.docNo)}</strong><span class="customer-code">${escapeHtml(invoice.invoiceId)} · ${escapeHtml(formatKualaLumpurDate(invoice.docDate))}</span></td><td class="customer-cell"><span class="customer-name">${escapeHtml(invoice.customer?.name)}</span><span class="customer-code">${escapeHtml(invoice.customer?.code)}</span></td><td>${escapeHtml(invoice.status)}</td><td><span class="check-field"><span class="blank-line"></span> Checked</span><span class="audit-time">Assigned ${escapeHtml(formatKualaLumpurDateTime(invoice.assignedAt))}</span></td></tr>`).join('') : '<tr><td colspan="5">No non-removed invoice snapshots remain on this trip.</td></tr>'}</tbody>
        </table>
      </div>
    </section>`;
  content.hidden = false;
}

function setState(root, state, message) {
  const status = $(root, '#loadingState');
  const retry = $(root, '#retryButton');
  const print = $(root, '#printButton');
  if (status) {
    status.textContent = message;
    status.classList.toggle('is-error', state === 'error');
  }
  if (retry) retry.hidden = state !== 'error';
  if (print) {
    print.disabled = state !== 'loaded';
    print.hidden = state !== 'loaded';
  }
  root.dataset.state = state;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export function createLoadingSheetApp({ documentRef = globalThis.document, fetchImpl = globalThis.fetch, printImpl = () => globalThis.print?.() } = {}) {
  if (!documentRef) throw new Error('a document is required');
  const root = documentRef.querySelector('#loadingSheetApp');
  if (!root) throw new Error('loading sheet app root is required');
  let loaded = false;
  const tripId = getTripId(documentRef.defaultView?.location?.search || globalThis.location?.search || '');

  async function load() {
    loaded = false;
    $(root, '#sheetContent')?.setAttribute('hidden', '');
    setState(root, 'loading', 'Loading the persisted loading sheet…');
    if (!tripId) {
      setState(root, 'error', 'A single positive trip_id is required.');
      return null;
    }
    try {
      const response = await fetchImpl(`/api/dispatch/loading-sheet?trip_id=${encodeURIComponent(tripId)}`, {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const error = new Error(payload?.error?.message || (response.status === 401 ? 'Your session has expired. Sign in again.' : 'The loading sheet could not be loaded.'));
        error.code = response.status === 401 ? 'unauthorized' : (payload?.error?.code || 'request_failed');
        throw error;
      }
      if (!payload?.sheet) throw new Error('The loading sheet could not be loaded.');
      renderLoadingSheet(root, payload.sheet);
      loaded = true;
      setState(root, 'loaded', 'Persisted loading sheet loaded. Print is ready.');
      return payload.sheet;
    } catch (error) {
      loaded = false;
      $(root, '#sheetContent')?.setAttribute('hidden', '');
      setState(root, 'error', error.code === 'unauthorized' ? 'Your session has expired. Sign in through Dispatch and retry.' : 'The loading sheet could not be loaded. Use Retry to try again.');
      return null;
    }
  }

  $(root, '#retryButton')?.addEventListener('click', () => load());
  $(root, '#printButton')?.addEventListener('click', () => { if (loaded) printImpl(); });
  setState(root, 'loading', 'Loading the persisted loading sheet…');
  load();
  return { load, getTripId: () => tripId, isLoaded: () => loaded };
}

if (typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => { window.loadingSheetApp = createLoadingSheetApp(); }, { once: true });
}
