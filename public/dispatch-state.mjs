export const COMPANY_KEYS = ['enterprise', 'sdn_bhd'];
export const COMPANY_FILTERS = ['all', ...COMPANY_KEYS];
export const COMPANY_FILTER_LABELS = {
  all: 'ALL',
  enterprise: 'ENTERPRISE',
  sdn_bhd: 'SDN BHD',
};
export const TAB_NAMES = ['board', 'trips', 'reports', 'resources'];
export const DEFAULT_DATE_RANGE = { startDate: '2026-08-28', endDate: '2026-08-28' };

export const COMPANY_NAMES = {
  enterprise: 'Wanson Enterprise',
  sdn_bhd: 'Wanson Enterprise (M) Sdn Bhd',
};

const SOURCE_LABELS = { enterprise: 'Enterprise', sdn_bhd: 'Sdn Bhd' };

export function getSourceMessage(sources = {}) {
  const unavailable = COMPANY_KEYS
    .filter((key) => sources[key]?.status !== 'ok')
    .map((key) => `${SOURCE_LABELS[key]} source unavailable`);
  return unavailable.length ? unavailable.join(' · ') : 'Enterprise and Sdn Bhd sources ready.';
}

export const DISPATCH_FIXTURE = {
  dateRange: { ...DEFAULT_DATE_RANGE },
  sources: {
    enterprise: { status: 'ok', invoiceCount: 2 },
    sdn_bhd: { status: 'ok', invoiceCount: 2 },
  },
  invoices: [
    {
      companyKey: 'enterprise', invoiceId: 'enterprise-doc-001', docKey: 'enterprise-doc-001',
      docNo: 'ENT-SI-0001', docDate: '2026-08-28',
      customer: { code: 'ENT-CUST-001', name: 'Sanitized Enterprise Customer' },
      deliveryAddress: 'Sanitized Enterprise Delivery Address', cancelled: false, eligibility: 'eligible',
      items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '2.125', uom: 'CTN' }],
    },
    {
      companyKey: 'sdn_bhd', invoiceId: 'sdn-bhd-doc-001', docKey: 'sdn-bhd-doc-001',
      docNo: 'SDN-SI-0001', docDate: '2026-08-28',
      customer: { code: 'SDN-CUST-001', name: 'Sanitized Sdn Bhd Customer' },
      deliveryAddress: 'Sanitized Sdn Bhd Delivery Address', cancelled: false, eligibility: 'eligible',
      items: [{ itemCode: 'OIL-5KG', description: 'Cooking Oil 5KG', quantity: '3.000', uom: 'CTN' }],
    },
    {
      companyKey: 'enterprise', invoiceId: 'enterprise-doc-002', docKey: 'enterprise-doc-002',
      docNo: 'ENT-SI-0002', docDate: '2026-08-28',
      customer: { code: 'ENT-CUST-002', name: 'Second Enterprise Customer' },
      deliveryAddress: 'Second Enterprise Delivery Address', cancelled: false, eligibility: 'eligible',
      items: [{ itemCode: 'AJINOMOTO', description: 'AJINOMOTO', quantity: '1', uom: 'CTN' }],
    },
    {
      companyKey: 'sdn_bhd', invoiceId: 'sdn-bhd-doc-002', docKey: 'sdn-bhd-doc-002',
      docNo: 'SDN-SI-0002', docDate: '2026-08-28',
      customer: { code: 'SDN-CUST-002', name: 'Second Sdn Bhd Customer' },
      deliveryAddress: 'Second Sdn Bhd Delivery Address', cancelled: false, eligibility: 'eligible',
      items: [{ itemCode: 'AJINOMOTO', description: 'AJINOMOTO', quantity: '2', uom: 'CTN' }],
    },
  ],
  trips: [{
    id: 'trip-001', tripDate: '2026-08-28', driver: { name: 'Aiman Driver' },
    lorry: { registrationNo: 'WXY 1001' }, routeNotes: 'North route', status: 'planned', revision: 1,
    invoiceKeys: ['enterprise:enterprise-doc-001', 'sdn_bhd:sdn-bhd-doc-001'],
  }],
};

function copy(value) {
  return structuredClone(value);
}

function companyKeyOf(value) {
  return value?.companyKey ?? value?.company_key ?? value?.header?.companyKey ?? value?.header?.company_key;
}

function invoiceIdOf(value) {
  return value?.invoiceId ?? value?.invoice_id ?? value?.docKey ?? value?.header?.invoiceId ?? value?.header?.invoice_id;
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

function assignmentInvoice(assignment) {
  const header = assignment.header || assignment.invoiceHeader || {};
  const companyKey = companyKeyOf(assignment);
  const invoiceId = invoiceIdOf(assignment);
  return {
    ...copy(header),
    companyKey,
    invoiceId,
    docKey: invoiceId,
    docNo: assignment.docNo ?? assignment.doc_no ?? header.docNo ?? header.doc_no,
    docDate: assignment.docDate ?? assignment.doc_date ?? header.docDate ?? header.doc_date,
    customer: header.customer ?? assignment.customer,
    deliveryAddress: assignment.deliveryAddress ?? assignment.delivery_address ?? header.deliveryAddress ?? header.delivery_address ?? '',
    items: copy(assignment.items ?? header.items ?? []),
    cancelled: false,
    eligibility: 'assigned',
    assignmentId: assignment.id,
    assignmentStatus: assignment.status,
    tripId: assignment.tripId ?? assignment.trip_id ?? null,
  };
}

function normalizeAssignment(assignment) {
  return {
    ...copy(assignment),
    companyKey: companyKeyOf(assignment),
    invoiceId: invoiceIdOf(assignment),
    tripId: assignment.tripId ?? assignment.trip_id,
  };
}

function normalizeTrip(trip, assignments, resources = {}) {
  const tripAssignments = assignments.filter((assignment) => String(assignment.tripId) === String(trip.id));
  const invoiceKeys = [
    ...(trip.invoiceKeys || []),
    ...(trip.invoices || []).map(getInvoiceKey),
    ...(trip.assignments || []).map(getInvoiceKey),
    ...tripAssignments.map(getInvoiceKey),
  ].filter(Boolean);
  const driver = trip.driver || resources.drivers?.find((candidate) => String(candidate.id) === String(trip.driverId));
  const lorry = trip.lorry || resources.lorries?.find((candidate) => String(candidate.id) === String(trip.vehicleId));
  return {
    ...copy(trip),
    id: trip.id,
    tripDate: trip.tripDate ?? trip.trip_date,
    driverId: trip.driverId ?? trip.driver_id,
    vehicleId: trip.vehicleId ?? trip.vehicle_id,
    driver,
    lorry,
    routeNotes: trip.routeNotes ?? trip.route_notes ?? '',
    revision: Number(trip.revision || 1),
    invoiceKeys: [...new Set(invoiceKeys)],
  };
}

function normalizeInvoice(invoice, trips, assignedByKey) {
  const key = getInvoiceKey(invoice);
  const assignment = assignedByKey.get(key);
  const owningTrip = trips.find((trip) => trip.invoiceKeys.includes(key));
  const normalized = { ...copy(invoice), key, tripId: owningTrip?.id ?? null };
  if (assignment) {
    return { ...assignmentInvoice(assignment), key, tripId: assignment.tripId ?? owningTrip?.id ?? null };
  }
  return normalized;
}

export function createDispatchState({
  invoices = [],
  trips = [],
  assignments = [],
  sources = {},
  dateRange = DEFAULT_DATE_RANGE,
  resources = {},
  companyFilter = 'all',
  boardStatus = 'ready',
} = {}) {
  if (!COMPANY_FILTERS.includes(companyFilter)) throw new Error(`invalid company filter: ${companyFilter}`);
  const nestedAssignments = trips.flatMap((trip) => trip.assignments || []).map(normalizeAssignment);
  const allAssignments = [...assignments.map(normalizeAssignment), ...nestedAssignments];
  const assignedByKey = new Map();
  allAssignments.forEach((assignment) => {
    const key = getInvoiceKey(assignment);
    if (key) assignedByKey.set(key, assignment);
  });
  const normalizedTrips = trips.map((trip) => normalizeTrip(trip, allAssignments, resources));
  const normalizedInvoices = invoices.map((invoice) => normalizeInvoice(invoice, normalizedTrips, assignedByKey));
  const invoiceKeys = new Set(normalizedInvoices.map((invoice) => invoice.key));
  for (const assignment of assignedByKey.values()) {
    const invoice = assignmentInvoice(assignment);
    invoice.key = getInvoiceKey(invoice);
    if (!invoiceKeys.has(invoice.key)) normalizedInvoices.push(invoice);
  }
  return {
    companyFilter,
    invoices: normalizedInvoices,
    trips: normalizedTrips,
    assignments: [...assignedByKey.values()],
    sources: copy(sources || {}),
    dateRange: copy(dateRange || DEFAULT_DATE_RANGE),
    boardStatus,
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
    && (state.companyFilter === 'all' || companyKeyOf(invoice) === state.companyFilter)
  ));
}

export function isCurrentEligibleUnassignedInvoice(state, invoiceKey) {
  const invoice = state.invoices.find((candidate) => candidate.key === invoiceKey);
  return Boolean(
    invoice
    && invoice.tripId === null
    && invoice.cancelled !== true
    && invoice.eligibility === 'eligible',
  );
}

export function getTripInvoices(state, tripId) {
  const trip = state.trips.find((candidate) => String(candidate.id) === String(tripId));
  if (!trip) return [];
  return trip.invoiceKeys
    .map((key) => state.invoices.find((invoice) => invoice.key === key))
    .filter(Boolean);
}

export function getTripCompanyCounts(state, tripId) {
  const counts = { enterprise: 0, sdn_bhd: 0, total: 0 };
  for (const invoice of getTripInvoices(state, tripId)) {
    const companyKey = companyKeyOf(invoice);
    if (counts[companyKey] !== undefined) counts[companyKey] += 1;
    counts.total += 1;
  }
  return counts;
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
