import {
  clampToDispatchWindow,
  filterPickerInvoices,
  filterUnassignedForDate,
  getDispatchWindow,
  getInvoiceKey,
  getTripNumbers,
  shiftDate,
} from './dispatch-state.mjs';

const PICKER_DATE_FORMATTER = new Intl.DateTimeFormat('en-MY', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

export function formatPickerDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? String(date) : PICKER_DATE_FORMATTER.format(parsed);
}

const SOURCE_LABELS = { enterprise: 'Enterprise', sdn_bhd: 'Sdn Bhd' };

function companyKeyOf(invoice) { return invoice.companyKey ?? invoice.company_key; }

function sourceWarning(sources = {}, company = 'all') {
  const requested = company === 'all' ? Object.keys(SOURCE_LABELS) : [company];
  const down = requested.filter((key) => sources?.[key]?.status !== 'ok').map((key) => SOURCE_LABELS[key] || key);
  return down.length ? `${down.join(' and ')} invoices couldn't be loaded, so this list may be incomplete.` : '';
}
function invoiceIdOf(invoice) { return invoice.invoiceId ?? invoice.invoice_id ?? invoice.docKey; }

export function createInvoicePickerModel({ transport, assignmentsTransport, reloadTrip, createRequestId }) {
  async function load({ date, company = 'all' }) {
    try {
      const { invoices, assignments, sources } = await transport.loadPickerInvoices({ date, company });
      return { status: 'ready', invoices: filterUnassignedForDate(invoices, assignments), sources, warning: sourceWarning(sources, company) };
    } catch (error) {
      if (error?.code === 'unauthorized') throw error;
      return { status: 'error', message: `Couldn't load invoices for ${formatPickerDate(date)}. Try again.` };
    }
  }

  async function assignOne(invoice, tripId, revision) {
    return assignmentsTransport.assignInvoice({
      trip_id: Number(tripId),
      company_key: companyKeyOf(invoice),
      invoice_id: invoiceIdOf(invoice),
      doc_no: invoice.docNo,
      doc_date: invoice.docDate,
      expected_trip_revision: revision,
      request_id: createRequestId(),
    });
  }

  async function assign({ invoices, trip }) {
    let revision = Number(trip.revision);
    const results = [];
    for (const invoice of invoices) {
      const key = getInvoiceKey(companyKeyOf(invoice), invoiceIdOf(invoice));
      try {
        let response;
        try {
          response = await assignOne(invoice, trip.id, revision);
        } catch (error) {
          if (error?.code !== 'stale_trip') throw error;
          const fresh = await reloadTrip(trip.id);
          if (!fresh) throw error;
          revision = Number(fresh.revision);
          response = await assignOne(invoice, trip.id, revision);
        }
        revision = Number(response?.tripRevision ?? revision + 1);
        results.push({ key, ok: true });
      } catch (error) {
        if (error?.code === 'unauthorized') throw error;
        const message = error?.code === 'invoice_already_assigned' ? 'Already on another trip.'
          : error?.code === 'stale_trip' ? 'Trip changed — reopen and try again.'
            : 'Could not add this invoice. Try again.';
        results.push({ key, ok: false, message });
      }
    }
    return { results, tripRevision: revision };
  }

  return { load, filter: filterPickerInvoices, assign };
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);

function tripLabel(trip, numbers) {
  const lorry = trip.lorry?.registrationNo || trip.registrationNo || `Lorry ${trip.vehicleId ?? ''}`;
  const driver = trip.driver?.name ? ` · ${trip.driver.name}` : '';
  return `Trip ${numbers.get(String(trip.id)) ?? trip.id} · ${lorry}${driver}`;
}

export function mountInvoicePicker(root, { model, getBoardDate, getTrips, canWrite, onAssigned, onSessionLoss }) {
  const $ = (selector) => root.querySelector(selector);
  const backdrop = $('#olderInvoiceBackdrop');
  if (!backdrop) return { open: async () => {}, close: () => {} };
  const dateInput = $('#olderInvoiceDate'); const companySelect = $('#olderInvoiceCompany');
  const searchInput = $('#olderInvoiceSearch'); const list = $('#olderInvoiceList');
  const tripSelect = $('#olderInvoiceTrip'); const message = $('#olderInvoiceMessage');
  const submit = $('#olderInvoiceSubmit'); const retry = $('#olderInvoiceRetry');
  let invoices = []; let ticked = new Set(); let rowMessages = new Map(); let loadSequence = 0; let invoker = null; let busy = false; let loading = false; let openSequence = 0;

  function trips() { return (getTrips() || []).filter((trip) => trip.status !== 'cancelled'); }
  function updateSubmit() { submit.disabled = busy || loading || !canWrite() || !ticked.size || !tripSelect.value; }

  function renderList() {
    if (loading) { list.innerHTML = '<p class="section-help">Loading invoices…</p>'; updateSubmit(); return; }
    const visible = filterPickerInvoices(invoices, searchInput.value);
    list.innerHTML = visible.length ? visible.map((invoice) => {
      const key = getInvoiceKey(companyKeyOf(invoice), invoiceIdOf(invoice));
      const note = rowMessages.get(key);
      return `<label class="older-invoice-row" data-older-invoice-key="${escapeHtml(key)}">
        <input type="checkbox" value="${escapeHtml(key)}"${ticked.has(key) ? ' checked' : ''} />
        <span class="older-invoice-main"><strong>${escapeHtml(invoice.docNo)}</strong> · ${escapeHtml(SOURCE_LABELS[companyKeyOf(invoice)] || companyKeyOf(invoice))}<br />${escapeHtml(invoice.customer?.name || invoice.customerName || '')}</span>
        <span class="older-invoice-date">${escapeHtml(invoice.docDate)}</span>
        ${note ? `<span class="older-invoice-error">${escapeHtml(note)}</span>` : ''}
      </label>`;
    }).join('') : '<p class="section-help">No unassigned invoices for this date.</p>';
    updateSubmit();
  }

  function renderTrips() {
    const dayTrips = trips();
    const numbers = getTripNumbers(dayTrips);
    const previous = tripSelect.value;
    tripSelect.innerHTML = dayTrips.map((trip) => `<option value="${escapeHtml(trip.id)}">${escapeHtml(tripLabel(trip, numbers))}</option>`).join('');
    if (dayTrips.some((trip) => String(trip.id) === previous)) tripSelect.value = previous;
    tripSelect.disabled = !dayTrips.length;
    if (!dayTrips.length) message.textContent = 'Create a trip for this day first.';
  }

  async function load() {
    const sequence = ++loadSequence;
    invoices = []; ticked = new Set(); rowMessages = new Map(); retry.hidden = true; loading = true;
    renderList();
    if (trips().length) message.textContent = '';
    try {
      const result = await model.load({ date: dateInput.value, company: companySelect.value });
      if (sequence !== loadSequence) return;
      loading = false;
      if (result.status === 'error') { invoices = []; list.innerHTML = ''; message.textContent = result.message; retry.hidden = false; updateSubmit(); return; }
      invoices = result.invoices;
      if (result.warning) { message.textContent = result.warning; retry.hidden = false; }
      renderList();
    } catch (error) {
      if (sequence === loadSequence) { loading = false; list.innerHTML = ''; updateSubmit(); }
      if (error?.code === 'unauthorized') { close(); onSessionLoss(); }
    }
  }

  async function open(button = null) {
    if (!canWrite()) return;
    openSequence += 1;
    invoker = button;
    const { minDate, maxDate } = getDispatchWindow();
    dateInput.min = minDate; dateInput.max = maxDate;
    dateInput.value = clampToDispatchWindow(shiftDate(getBoardDate(), -1));
    searchInput.value = '';
    message.textContent = '';
    renderTrips();
    backdrop.hidden = false;
    dateInput.focus?.();
    await load();
  }

  function close() { loadSequence += 1; loading = false; backdrop.hidden = true; invoker?.focus?.(); invoker = null; }

  async function submitPicked() {
    const trip = trips().find((candidate) => String(candidate.id) === tripSelect.value);
    const picked = invoices.filter((invoice) => ticked.has(getInvoiceKey(companyKeyOf(invoice), invoiceIdOf(invoice))));
    if (!trip || !picked.length || !canWrite()) return;
    const opening = openSequence;
    busy = true; updateSubmit(); message.textContent = `Adding ${picked.length} invoice(s)…`;
    try {
      const { results } = await model.assign({ invoices: picked, trip });
      if (opening !== openSequence || backdrop.hidden) {
        // The dialog was closed (and maybe reopened) while saving: refresh the board, leave the current dialog alone.
        if (results.some((row) => row.ok)) await onAssigned();
        return;
      }
      const added = new Set(results.filter((row) => row.ok).map((row) => row.key));
      rowMessages = new Map(results.filter((row) => !row.ok).map((row) => [row.key, row.message]));
      invoices = invoices.filter((invoice) => !added.has(getInvoiceKey(companyKeyOf(invoice), invoiceIdOf(invoice))));
      ticked = new Set([...ticked].filter((key) => !added.has(key)));
      if (added.size) await onAssigned();
      if (!rowMessages.size) { close(); return; }
      message.textContent = `${added.size} added. ${rowMessages.size} could not be added.`;
      renderTrips(); renderList();
    } catch (error) {
      if (error?.code === 'unauthorized') { close(); onSessionLoss(); return; }
      if (opening === openSequence && !backdrop.hidden) message.textContent = 'Could not add invoices. Try again.';
    } finally { busy = false; updateSubmit(); }
  }

  $('#closeOlderInvoice')?.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  dateInput.addEventListener('change', () => { dateInput.value = clampToDispatchWindow(dateInput.value); load(); });
  companySelect.addEventListener('change', load);
  retry.addEventListener('click', load);
  searchInput.addEventListener('input', renderList);
  tripSelect.addEventListener('change', updateSubmit);
  list.addEventListener('change', (event) => {
    const box = event.target.closest?.('input[type="checkbox"]'); if (!box) return;
    if (box.checked) ticked.add(box.value); else ticked.delete(box.value);
    updateSubmit();
  });
  submit.addEventListener('click', () => { submitPicked(); });

  return { open, close };
}
