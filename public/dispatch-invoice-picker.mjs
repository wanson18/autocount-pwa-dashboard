import {
  filterPickerInvoices,
  filterUnassignedForDate,
  getInvoiceKey,
} from './dispatch-state.mjs';

const PICKER_DATE_FORMATTER = new Intl.DateTimeFormat('en-MY', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

export function formatPickerDate(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? String(date) : PICKER_DATE_FORMATTER.format(parsed);
}

function companyKeyOf(invoice) { return invoice.companyKey ?? invoice.company_key; }
function invoiceIdOf(invoice) { return invoice.invoiceId ?? invoice.invoice_id ?? invoice.docKey; }

export function createInvoicePickerModel({ transport, assignmentsTransport, reloadTrip, createRequestId }) {
  async function load({ date, company = 'all' }) {
    try {
      const { invoices, assignments, sources } = await transport.loadPickerInvoices({ date, company });
      return { status: 'ready', invoices: filterUnassignedForDate(invoices, assignments), sources };
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
