const TRIP_STATUSES = Object.freeze([
  'planned',
  'loading',
  'dispatched',
  'completed',
  'cancelled',
]);

const ASSIGNMENT_STATUSES = Object.freeze([
  'assigned',
  'loaded',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned',
  'removed',
]);

const TRIP_TRANSITIONS = Object.freeze({
  planned: Object.freeze(new Set(['loading', 'cancelled'])),
  loading: Object.freeze(new Set(['dispatched', 'cancelled'])),
  dispatched: Object.freeze(new Set(['completed'])),
  completed: Object.freeze(new Set()),
  cancelled: Object.freeze(new Set()),
});

const ASSIGNMENT_TRANSITIONS = Object.freeze({
  assigned: Object.freeze(new Set(['loaded', 'removed'])),
  loaded: Object.freeze(new Set(['out_for_delivery', 'removed'])),
  out_for_delivery: Object.freeze(new Set(['delivered', 'failed', 'returned'])),
  delivered: Object.freeze(new Set()),
  failed: Object.freeze(new Set()),
  returned: Object.freeze(new Set()),
  removed: Object.freeze(new Set()),
});

function invalidTransition(resource, from, to) {
  const error = new Error(`invalid ${resource} transition`);
  error.code = 'invalid_transition';
  error.resource = resource;
  error.from = from;
  error.to = to;
  return error;
}

function canTransition(transitions, from, to) {
  return typeof from === 'string'
    && typeof to === 'string'
    && transitions[from] instanceof Set
    && transitions[from].has(to);
}

function canTransitionTrip(from, to) {
  return canTransition(TRIP_TRANSITIONS, from, to);
}

function canTransitionAssignment(from, to) {
  return canTransition(ASSIGNMENT_TRANSITIONS, from, to);
}

function assertTripTransition(from, to) {
  if (!canTransitionTrip(from, to)) throw invalidTransition('trip', from, to);
  return to;
}

function assertAssignmentTransition(from, to) {
  if (!canTransitionAssignment(from, to)) throw invalidTransition('assignment', from, to);
  return to;
}

function canMoveAssignment(status) {
  return status === 'assigned' || status === 'loaded';
}

function assertAssignmentMovable(status) {
  if (!canMoveAssignment(status)) {
    throw invalidTransition('assignment', status, 'moved');
  }
  return status;
}

module.exports = {
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_TRANSITIONS,
  TRIP_STATUSES,
  TRIP_TRANSITIONS,
  assertAssignmentMovable,
  assertAssignmentTransition,
  assertTripTransition,
  canMoveAssignment,
  canTransitionAssignment,
  canTransitionTrip,
};
