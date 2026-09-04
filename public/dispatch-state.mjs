export const COMPANY_KEYS = ['enterprise', 'sdn_bhd'];
export const COMPANY_FILTERS = ['all', ...COMPANY_KEYS];
export const COMPANY_FILTER_LABELS = {
  all: 'ALL',
  enterprise: 'ENTERPRISE',
  sdn_bhd: 'SDN BHD',
};
export const TAB_NAMES = ['board', 'trips', 'reports', 'resources'];

const KUALA_LUMPUR_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatDateParts(parts) {
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getDefaultDateRange(now = new Date()) {
  const date = formatDateParts(KUALA_LUMPUR_DATE_FORMATTER.formatToParts(now));
  return { startDate: date, endDate: date };
}

export const DEFAULT_DATE_RANGE = getDefaultDateRange();

export const COMPANY_NAMES = {
  enterprise: 'Wanson Enterprise',
  sdn_bhd: 'Wanson Enterprise (M) Sdn Bhd',
};

const SOURCE_LABELS = { enterprise: 'Enterprise', sdn_bhd: 'Sdn Bhd' };
const NON_ACTIVE_ASSIGNMENT_STATUSES = new Set(['removed']);

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

function assignmentStatusOf(assignment) {
  return assignment?.status ?? assignment?.assignmentStatus ?? assignment?.assignment_status;
}

function isActiveAssignment(assignment) {
  return !NON_ACTIVE_ASSIGNMENT_STATUSES.has(assignmentStatusOf(assignment));
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
    ...(trip.assignments || []).filter(isActiveAssignment).map(getInvoiceKey),
    ...tripAssignments.map(getInvoiceKey),
  ].filter(Boolean);
  const driver = trip.driver || resources.drivers?.find((candidate) => String(candidate.id) === String(trip.driverId ?? trip.driver_id));
  const lorry = trip.lorry || resources.lorries?.find((candidate) => String(candidate.id) === String(trip.vehicleId ?? trip.vehicle_id));
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
  quarantinedCount = 0,
  dateRange = DEFAULT_DATE_RANGE,
  resources = {},
  companyFilter = 'all',
  searchQuery = '',
  boardStatus = 'ready',
} = {}) {
  if (!COMPANY_FILTERS.includes(companyFilter)) throw new Error(`invalid company filter: ${companyFilter}`);
  const nestedAssignments = trips.flatMap((trip) => trip.assignments || []).map(normalizeAssignment);
  const allAssignments = [...assignments.map(normalizeAssignment), ...nestedAssignments];
  const activeAssignments = allAssignments.filter(isActiveAssignment);
  const activeAssignmentKeys = new Set(activeAssignments.map(getInvoiceKey).filter(Boolean));
  const removedAssignmentKeys = new Set(allAssignments
    .filter((assignment) => !isActiveAssignment(assignment))
    .map(getInvoiceKey)
    .filter((key) => key && !activeAssignmentKeys.has(key)));
  const assignedByKey = new Map();
  activeAssignments.forEach((assignment) => {
    const key = getInvoiceKey(assignment);
    if (key) assignedByKey.set(key, assignment);
  });
  const normalizedTrips = trips.map((trip) => normalizeTrip(trip, activeAssignments, resources))
    .map((trip) => ({ ...trip, invoiceKeys: trip.invoiceKeys.filter((key) => !removedAssignmentKeys.has(key)) }));
  const normalizedInvoices = invoices.map((invoice) => normalizeInvoice(invoice, normalizedTrips, assignedByKey));
  const invoiceKeys = new Set(normalizedInvoices.map((invoice) => invoice.key));
  for (const assignment of assignedByKey.values()) {
    const invoice = assignmentInvoice(assignment);
    invoice.key = getInvoiceKey(invoice);
    if (!invoiceKeys.has(invoice.key)) normalizedInvoices.push(invoice);
  }
  return {
    companyFilter,
    searchQuery: typeof searchQuery === 'string' ? searchQuery : '',
    invoices: normalizedInvoices,
    trips: normalizedTrips,
    assignments: [...assignedByKey.values()],
    sources: copy(sources || {}),
    quarantinedCount: Number(quarantinedCount) || 0,
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

export function setSearchQuery(state, searchQuery) {
  const next = copy(state);
  next.searchQuery = typeof searchQuery === 'string' ? searchQuery : '';
  return next;
}

export function invoiceMatchesSearch(invoice, query) {
  const text = String(query ?? '').trim().toLowerCase();
  if (!text) return true;
  const haystacks = [
    invoice?.customer?.name,
    invoice?.customerName,
    invoice?.customer?.code,
    invoice?.docNo,
    invoice?.doc_no,
    invoice?.invoiceId,
    invoice?.invoice_id,
    invoice?.docKey,
  ];
  for (const item of invoice?.items || []) {
    haystacks.push(item?.itemCode, item?.item_code, item?.description);
  }
  return haystacks.some((field) => typeof field === 'string' && field.toLowerCase().includes(text));
}

export function reloadDispatchState(previousState, board) {
  return createDispatchState({
    ...board,
    companyFilter: previousState.companyFilter,
    searchQuery: previousState.searchQuery,
  });
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
    && invoice.cancelled !== true
    && invoice.eligibility !== 'blocked_missing_uom'
    && invoiceMatchesSearch(invoice, state.searchQuery)
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
    .filter(Boolean)
    .filter((invoice) => invoiceMatchesSearch(invoice, state.searchQuery));
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

export function lorryIdOf(trip) {
  if (trip?.lorry?.id != null) return trip.lorry.id;
  if (trip?.vehicleId != null) return trip.vehicleId;
  return null;
}

export function getLorryLanes(state, resources = {}) {
  const lanes = new Map();
  const lorriesByRegistration = new Map((resources.lorries || [])
    .filter((lorry) => lorry?.id != null && lorry.registrationNo)
    .map((lorry) => [String(lorry.registrationNo).trim().toLowerCase(), lorry]));
  const registerLorry = (lorry) => {
    if (!lorry || lorry.id == null) return null;
    const key = String(lorry.id);
    if (!lanes.has(key)) lanes.set(key, { lorry, trips: [] });
    return lanes.get(key);
  };
  for (const lorry of resources.lorries || []) registerLorry(lorry);
  for (const trip of state.trips) {
    const tripLorryId = lorryIdOf(trip);
    const tripRegistrationNo = trip.lorry?.registrationNo || trip.registrationNo || '';
    const matchedLorry = tripLorryId == null
      ? lorriesByRegistration.get(String(tripRegistrationNo).trim().toLowerCase())
      : null;
    const lane = registerLorry(matchedLorry || {
      id: tripLorryId ?? `trip:${trip.id}`,
      registrationNo: tripRegistrationNo || 'Lorry',
    });
    if (lane) lane.trips.push(trip);
  }
  return [...lanes.values()].sort((left, right) => {
    const leftReg = left.lorry?.registrationNo || '';
    const rightReg = right.lorry?.registrationNo || '';
    return leftReg.localeCompare(rightReg);
  });
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

function removalSnapshot(state, invoiceKey) {
  const invoice = state.invoices.find((candidate) => candidate.key === invoiceKey);
  return {
    invoice: invoice ? {
      tripId: invoice.tripId ?? null,
      eligibility: invoice.eligibility,
      assignmentStatus: invoice.assignmentStatus,
      assignmentId: invoice.assignmentId,
    } : null,
    trips: state.trips.map((trip) => ({ id: trip.id, invoiceKeys: [...trip.invoiceKeys] })),
    assignments: copy(state.assignments),
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

export function beginOptimisticRemoval(state, { invoiceKey, requestId }) {
  if (!requestId) throw new Error('requestId is required');
  const invoice = state.invoices.find((candidate) => candidate.key === invoiceKey);
  if (!invoice || invoice.tripId == null || invoice.assignmentId == null) throw new Error('invoice is not assigned');
  const previous = removalSnapshot(state, invoiceKey);
  const next = copy(state);
  next.invoices.forEach((candidate) => {
    if (candidate.key === invoiceKey) {
      candidate.tripId = null;
      candidate.eligibility = 'eligible';
      candidate.assignmentStatus = 'removed';
    }
  });
  next.trips.forEach((trip) => { trip.invoiceKeys = trip.invoiceKeys.filter((key) => key !== invoiceKey); });
  next.assignments = next.assignments.map((assignment) => (
    String(assignment.id) === String(invoice.assignmentId) ? { ...assignment, status: 'removed' } : assignment
  ));
  next.pendingMove = { kind: 'remove', invoiceKey, tripId: null, requestId, previous };
  next.lastMove = { status: 'pending', requestId };
  next.statusMessage = 'Invoice is being returned to the queue.';
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
  if (invoice && next.pendingMove.kind === 'remove' && previous.invoice) Object.assign(invoice, previous.invoice);
  else if (invoice) invoice.tripId = previous.invoiceTripId;
  next.trips.forEach((trip) => {
    const prior = previous.trips.find((candidate) => String(candidate.id) === String(trip.id));
    if (prior) trip.invoiceKeys = [...prior.invoiceKeys];
  });
  if (next.pendingMove.kind === 'remove' && previous.assignments) next.assignments = copy(previous.assignments);
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
