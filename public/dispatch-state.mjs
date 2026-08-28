export const COMPANY_KEYS = ['enterprise', 'sdn_bhd'];
export const COMPANY_FILTERS = ['all', ...COMPANY_KEYS];
export const COMPANY_FILTER_LABELS = {
  all: 'ALL',
  enterprise: 'ENTERPRISE',
  sdn_bhd: 'SDN BHD',
};
export const TAB_NAMES = ['board', 'trips', 'reports', 'resources'];

export const COMPANY_NAMES = {
  enterprise: 'Wanson Enterprise',
  sdn_bhd: 'Wanson Enterprise (M) Sdn Bhd',
};

export const DISPATCH_FIXTURE = {
  dateRange: { startDate: '2026-08-28', endDate: '2026-08-28' },
  sources: {
    enterprise: { status: 'ok', invoiceCount: 2 },
    sdn_bhd: { status: 'ok', invoiceCount: 2 },
  },
  invoices: [
    {
      companyKey: 'enterprise',
      invoiceId: 'enterprise-doc-001',
      docKey: 'enterprise-doc-001',
      docNo: 'ENT-SI-0001',
      docDate: '2026-08-28',
      customer: { code: 'ENT-CUST-001', name: 'Sanitized Enterprise Customer' },
      deliveryAddress: 'Sanitized Enterprise Delivery Address',
      cancelled: false,
      eligibility: 'eligible',
      items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
    },
    {
      companyKey: 'sdn_bhd',
      invoiceId: 'sdn-bhd-doc-001',
      docKey: 'sdn-bhd-doc-001',
      docNo: 'SDN-SI-0001',
      docDate: '2026-08-28',
      customer: { code: 'SDN-CUST-001', name: 'Sanitized Sdn Bhd Customer' },
      deliveryAddress: 'Sanitized Sdn Bhd Delivery Address',
      cancelled: false,
      eligibility: 'eligible',
      items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '3.000', uom: 'CTN' }],
    },
    {
      companyKey: 'enterprise',
      invoiceId: 'enterprise-doc-002',
      docKey: 'enterprise-doc-002',
      docNo: 'ENT-SI-0002',
      docDate: '2026-08-28',
      customer: { code: 'ENT-CUST-002', name: 'Second Enterprise Customer' },
      deliveryAddress: 'Second Enterprise Delivery Address',
      cancelled: false,
      eligibility: 'eligible',
      items: [{ itemCode: 'AJINOMOTO', description: 'AJINOMOTO', quantity: '1', uom: 'CTN' }],
    },
    {
      companyKey: 'sdn_bhd',
      invoiceId: 'sdn-bhd-doc-002',
      docKey: 'sdn-bhd-doc-002',
      docNo: 'SDN-SI-0002',
      docDate: '2026-08-28',
      customer: { code: 'SDN-CUST-002', name: 'Second Sdn Bhd Customer' },
      deliveryAddress: 'Second Sdn Bhd Delivery Address',
      cancelled: false,
      eligibility: 'eligible',
      items: [{ itemCode: 'AJINOMOTO', description: 'AJINOMOTO', quantity: '2', uom: 'CTN' }],
    },
  ],
  trips: [
    {
      id: 'trip-001',
      tripDate: '2026-08-28',
      driver: { name: 'Aiman Driver' },
      lorry: { registrationNo: 'WXY 1001' },
      routeNotes: 'North route',
      status: 'planned',
      revision: 1,
      invoiceKeys: ['enterprise:enterprise-doc-001', 'sdn_bhd:sdn-bhd-doc-001'],
    },
  ],
};

function copy(value) {
  return structuredClone(value);
}

function companyKeyOf(invoice) {
  return invoice?.companyKey ?? invoice?.company_key;
}

function invoiceIdOf(invoice) {
  return invoice?.invoiceId ?? invoice?.invoice_id;
}

export function getInvoiceKey(invoiceOrCompanyKey, maybeInvoiceId) {
  const companyKey = typeof invoiceOrCompanyKey === 'object'
    ? companyKeyOf(invoiceOrCompanyKey)
    : invoiceOrCompanyKey;
  const invoiceId = typeof invoiceOrCompanyKey === 'object'
    ? invoiceIdOf(invoiceOrCompanyKey)
    : maybeInvoiceId;
  if (!COMPANY_KEYS.includes(companyKey) || !invoiceId) return null;
  return `${companyKey}:${invoiceId}`;
}

function normalizeTrip(trip) {
  const invoiceKeys = trip.invoiceKeys || (trip.invoices || []).map(getInvoiceKey).filter(Boolean);
  return { ...copy(trip), invoiceKeys: [...invoiceKeys] };
}

function normalizeInvoice(invoice, trips) {
  const key = getInvoiceKey(invoice);
  const owningTrip = trips.find((trip) => trip.invoiceKeys.includes(key));
  return { ...copy(invoice), key, tripId: invoice.tripId ?? owningTrip?.id ?? null };
}

export function createDispatchState({ invoices = DISPATCH_FIXTURE.invoices, trips = DISPATCH_FIXTURE.trips, companyFilter = 'all' } = {}) {
  if (!COMPANY_FILTERS.includes(companyFilter)) throw new Error(`invalid company filter: ${companyFilter}`);
  const normalizedTrips = trips.map(normalizeTrip);
  return {
    companyFilter,
    invoices: invoices.map((invoice) => normalizeInvoice(invoice, normalizedTrips)),
    trips: normalizedTrips,
    selectedInvoiceKey: null,
    selectedTripId: null,
    pendingMove: null,
    lastMove: null,
    statusMessage: '',
  };
}

export function setCompanyFilter(state, companyFilter) {
  if (!COMPANY_FILTERS.includes(companyFilter)) throw new Error(`invalid company filter: ${companyFilter}`);
  return { ...copy(state), companyFilter };
}

export function getCompanyFilterLabel(companyFilter) {
  return COMPANY_FILTER_LABELS[companyFilter] || '';
}

export function reloadDispatchState(previousState, board) {
  return createDispatchState({ ...board, companyFilter: previousState.companyFilter });
}

export function getTabNavigationIndex(currentIndex, key, tabCount = TAB_NAMES.length) {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(tabCount) || tabCount < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return tabCount - 1;
  if (key === 'ArrowLeft') return (currentIndex - 1 + tabCount) % tabCount;
  if (key === 'ArrowRight') return (currentIndex + 1) % tabCount;
  return null;
}

export function visibleUnassignedInvoices(state) {
  return state.invoices.filter((invoice) => (
    invoice.tripId === null
    && (state.companyFilter === 'all' || invoice.companyKey === state.companyFilter || invoice.company_key === state.companyFilter)
  ));
}

export function getTripInvoices(state, tripId) {
  const trip = state.trips.find((candidate) => String(candidate.id) === String(tripId));
  if (!trip) return [];
  return trip.invoiceKeys
    .map((key) => state.invoices.find((invoice) => invoice.key === key))
    .filter(Boolean);
}

export function selectInvoice(state, invoiceKey) {
  const next = copy(state);
  next.selectedInvoiceKey = next.invoices.some((invoice) => invoice.key === invoiceKey) ? invoiceKey : null;
  return next;
}

export function selectTrip(state, tripId) {
  const next = copy(state);
  next.selectedTripId = next.trips.some((trip) => String(trip.id) === String(tripId)) ? tripId : null;
  return next;
}

function moveSnapshot(state, invoiceKey) {
  const invoice = state.invoices.find((candidate) => candidate.key === invoiceKey);
  return {
    invoiceTripId: invoice?.tripId ?? null,
    trips: state.trips.map((trip) => ({ id: trip.id, invoiceKeys: [...trip.invoiceKeys] })),
  };
}

export function beginOptimisticMove(state, { invoiceKey, tripId, requestId }) {
  if (!requestId) throw new Error('requestId is required');
  if (!state.invoices.some((invoice) => invoice.key === invoiceKey)) throw new Error('invoice is not in state');
  if (!state.trips.some((trip) => String(trip.id) === String(tripId))) throw new Error('trip is not in state');

  const next = copy(state);
  const previous = moveSnapshot(state, invoiceKey);
  next.invoices.forEach((invoice) => {
    if (invoice.key === invoiceKey) invoice.tripId = tripId;
  });
  next.trips.forEach((trip) => {
    trip.invoiceKeys = trip.invoiceKeys.filter((key) => key !== invoiceKey);
    if (String(trip.id) === String(tripId)) trip.invoiceKeys.push(invoiceKey);
  });
  next.pendingMove = { invoiceKey, tripId, requestId, previous };
  next.lastMove = { status: 'pending', requestId };
  next.statusMessage = 'Assignment is being saved.';
  return next;
}

function staleResponse(state, requestId) {
  const next = copy(state);
  next.lastMove = { status: 'stale_rejected', requestId };
  next.statusMessage = 'Ignored an older assignment response.';
  return next;
}

export function settleMoveResponse(state, { requestId, accepted, message = '' }) {
  if (!state.pendingMove || state.pendingMove.requestId !== requestId) return staleResponse(state, requestId);
  const next = copy(state);
  next.pendingMove = null;
  next.lastMove = { status: accepted ? 'accepted' : 'rejected', requestId };
  next.statusMessage = message || (accepted ? 'Assignment saved.' : 'Assignment was not saved.');
  return next;
}

export function rejectMoveResponse(state, { requestId, message }) {
  if (!state.pendingMove || state.pendingMove.requestId !== requestId) return staleResponse(state, requestId);
  const next = copy(state);
  const { previous } = next.pendingMove;
  const invoice = next.invoices.find((candidate) => candidate.key === next.pendingMove.invoiceKey);
  if (invoice) invoice.tripId = previous.invoiceTripId;
  next.trips.forEach((trip) => {
    const prior = previous.trips.find((candidate) => String(candidate.id) === String(trip.id));
    if (prior) trip.invoiceKeys = [...prior.invoiceKeys];
  });
  next.pendingMove = null;
  next.lastMove = { status: 'rejected', requestId };
  next.statusMessage = message || 'Assignment was not saved.';
  return next;
}

export function createFixtureTransport({ fixture = DISPATCH_FIXTURE } = {}) {
  return {
    async loadBoard({ company = 'all' } = {}) {
      if (!COMPANY_FILTERS.includes(company)) throw new Error(`invalid company filter: ${company}`);
      return copy(fixture);
    },
  };
}
