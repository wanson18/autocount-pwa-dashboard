const { loadCompanyConfigs } = require('../autocount/company-config');
const { mutationFingerprint } = require('./repository');
const {
  assertAssignmentMovable,
  assertAssignmentTransition,
  assertTripTransition,
} = require('./status-machine');

const COMPANY_KEYS = new Set(['enterprise', 'sdn_bhd']);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(value.slice(0, 4))
    && date.getUTCMonth() + 1 === Number(value.slice(5, 7))
    && date.getUTCDate() === Number(value.slice(8, 10));
}

function requireActor(actor) {
  if (typeof actor !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(actor)) {
    throw serviceError('invalid_request');
  }
  return actor;
}

function requireRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw serviceError('invalid_request');
  }
  return requestId;
}

function requireId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  throw serviceError('invalid_request');
}

function requireRevision(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const revision = Number(value);
    if (Number.isSafeInteger(revision) && revision > 0) return revision;
  }
  throw serviceError('invalid_request');
}

function requireText(value, max = 256) {
  if (typeof value !== 'string') throw serviceError('invalid_request');
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw serviceError('invalid_request');
  return normalized;
}

function positiveDecimalString(value) {
  if (typeof value !== 'string' || value.length > 256 || !DECIMAL_RE.test(value)) return false;
  const mantissa = value.split(/[eE]/, 1)[0];
  return mantissa.replace('.', '').split('').some((digit) => digit !== '0');
}

function companyConfigOf(configs, companyKey) {
  if (!configs || !configs[companyKey]) return { companyKey };
  return configs[companyKey];
}

function sourceInvoiceFields(invoice) {
  return {
    companyKey: invoice?.companyKey ?? invoice?.company_key,
    invoiceId: invoice?.invoiceId ?? invoice?.invoice_id ?? invoice?.docKey,
    docKey: invoice?.docKey,
    docNo: invoice?.docNo ?? invoice?.doc_no,
    docDate: invoice?.docDate ?? invoice?.doc_date,
    cancelled: invoice?.cancelled,
    customer: invoice?.customer,
    deliveryAddress: invoice?.deliveryAddress ?? invoice?.delivery_address ?? '',
    items: invoice?.items,
  };
}

class DispatchService {
  constructor({ repository, invoiceAdapter, source, configs } = {}) {
    if (!repository) throw new TypeError('a dispatch repository is required');
    this.repository = repository;
    this.invoiceAdapter = invoiceAdapter || source || null;
    this.configs = configs || null;
  }

  async listTrips(filters = {}) {
    if (typeof this.repository.listTrips !== 'function') return [];
    return this.repository.listTrips(filters);
  }

  async getTrip(id) {
    const tripId = requireId(id);
    if (typeof this.repository.getTripDetails === 'function') {
      return this.repository.getTripDetails(tripId);
    }
    return this.repository.getTrip(tripId);
  }

  async _tripResponse(trip) {
    return trip;
  }

  async _idempotentResult({ actor, requestId, operation, payload }) {
    const fingerprint = mutationFingerprint(operation, payload);
    const prior = await this.repository.getDispatchMutationIdempotency({
      actor,
      requestId,
      operation,
      fingerprint,
    });
    return { fingerprint, prior };
  }

  async createTrip({ tripDate, driverId, vehicleId, routeNotes = '', actor, requestId }) {
    const normalizedActor = requireActor(actor);
    const normalizedRequestId = requireRequestId(requestId);
    if (!isValidDate(tripDate)) throw serviceError('invalid_request');
    const normalizedDriverId = requireId(driverId);
    const normalizedVehicleId = requireId(vehicleId);
    if (typeof routeNotes !== 'string' || routeNotes.trim().length > 500) {
      throw serviceError('invalid_request');
    }
    const values = {
      tripDate,
      driverId: normalizedDriverId,
      vehicleId: normalizedVehicleId,
      routeNotes: routeNotes.trim(),
    };
    const { fingerprint, prior } = await this._idempotentResult({
      actor: normalizedActor,
      requestId: normalizedRequestId,
      operation: 'trip.create',
      payload: values,
    });
    if (prior?.replayed) return this._tripResponse(prior.result);
    const trip = await this.repository.createTripMutation({
      ...values,
      actor: normalizedActor,
      requestId: normalizedRequestId,
      fingerprint,
    });
    return this._tripResponse(trip);
  }

  async updateTrip({ id, tripId, expectedRevision, expectedTripRevision, changes = {}, actor, requestId }) {
    const normalizedActor = requireActor(actor);
    const normalizedRequestId = requireRequestId(requestId);
    const normalizedId = requireId(id ?? tripId);
    const revision = requireRevision(expectedRevision ?? expectedTripRevision);
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw serviceError('invalid_request');
    }
    const normalizedChanges = {};
    if (changes.status !== undefined) {
      if (typeof changes.status !== 'string') throw serviceError('invalid_request');
      normalizedChanges.status = changes.status;
    }
    if (changes.routeNotes !== undefined) {
      if (typeof changes.routeNotes !== 'string' || changes.routeNotes.trim().length > 500) {
        throw serviceError('invalid_request');
      }
      normalizedChanges.routeNotes = changes.routeNotes.trim();
    }
    if (changes.driverId !== undefined) normalizedChanges.driverId = requireId(changes.driverId);
    if (changes.vehicleId !== undefined) normalizedChanges.vehicleId = requireId(changes.vehicleId);
    if (!Object.keys(normalizedChanges).length) throw serviceError('invalid_request');
    const values = { id: normalizedId, expectedRevision: revision, changes: normalizedChanges };
    const { fingerprint, prior } = await this._idempotentResult({
      actor: normalizedActor,
      requestId: normalizedRequestId,
      operation: 'trip.update',
      payload: values,
    });
    if (prior?.replayed) return this._tripResponse(prior.result);
    const current = await this.getTrip(normalizedId);
    if (!current) throw serviceError('resource_not_found');
    if (normalizedChanges.status !== undefined) {
      assertTripTransition(current.status, normalizedChanges.status);
    }
    const updated = await this.repository.updateTripMutation({
      ...values,
      actor: normalizedActor,
      requestId: normalizedRequestId,
      fingerprint,
    });
    return this._tripResponse(updated);
  }

  async _loadAuthoritativeInvoice(companyKey, invoiceId, docNo, docDate) {
    if (!COMPANY_KEYS.has(companyKey) || !this.invoiceAdapter) throw serviceError('source_unavailable');
    let configs = this.configs;
    if (!configs) {
      try {
        configs = loadCompanyConfigs();
      } catch {
        throw serviceError('source_unavailable');
      }
    }
    const company = companyConfigOf(configs, companyKey);
    let raw;
    try {
      if (typeof this.invoiceAdapter.getInvoice === 'function') {
        raw = await this.invoiceAdapter.getInvoice(company, invoiceId, docDate);
      } else if (typeof this.invoiceAdapter.fetchInvoice === 'function') {
        raw = await this.invoiceAdapter.fetchInvoice(company, invoiceId, docDate);
      } else if (typeof this.invoiceAdapter.listInvoices === 'function') {
        raw = await this.invoiceAdapter.listInvoices(company, docDate, docDate, { includeCancelled: true });
      } else {
        throw new Error('invoice source is not supported');
      }
    } catch (error) {
      if (error?.code === 'invoice_cancelled') throw serviceError('invoice_cancelled');
      throw serviceError('source_unavailable');
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.invoice) raw = raw.invoice;
    if (Array.isArray(raw)) {
      const matches = raw.filter((candidate) => {
        const fields = sourceInvoiceFields(candidate);
        return fields.invoiceId === invoiceId && fields.docDate === docDate;
      });
      if (matches.length !== 1) throw serviceError('source_unavailable');
      raw = matches[0];
    }
    return this._validateAuthoritativeInvoice(raw, { companyKey, invoiceId, docNo, docDate });
  }

  _validateAuthoritativeInvoice(raw, { companyKey, invoiceId, docNo, docDate }) {
    const fields = sourceInvoiceFields(raw);
    if (fields.companyKey !== companyKey
      || fields.invoiceId !== invoiceId
      || (fields.docKey !== undefined && fields.docKey !== invoiceId)
      || fields.docDate !== docDate
      || (docNo !== null && fields.docNo !== docNo)
      || typeof fields.docNo !== 'string'
      || !fields.docNo.trim()
      || !isValidDate(fields.docDate)
      || typeof fields.cancelled !== 'boolean') {
      throw serviceError('source_unavailable');
    }
    if (fields.cancelled) throw serviceError('invoice_cancelled');
    if (!fields.customer || typeof fields.customer !== 'object' || Array.isArray(fields.customer)) {
      throw serviceError('source_unavailable');
    }
    const customerCode = fields.customer.code;
    const customerName = fields.customer.name;
    if (typeof customerCode !== 'string' || !customerCode.trim()
      || typeof customerName !== 'string' || !customerName.trim()) {
      throw serviceError('source_unavailable');
    }
    if (!Array.isArray(fields.items) || fields.items.length === 0) {
      throw serviceError('source_unavailable');
    }
    const items = fields.items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw serviceError('source_unavailable');
      }
      const itemCode = item.itemCode ?? item.item_code;
      const description = item.description;
      const uom = item.uom ?? item.UOM;
      if (typeof uom !== 'string' || !uom.trim()) throw serviceError('invoice_missing_uom');
      if (typeof itemCode !== 'string' || !itemCode.trim()
        || typeof description !== 'string' || !description.trim()) {
        throw serviceError('source_unavailable');
      }
      if (!positiveDecimalString(item.quantity)) throw serviceError('source_unavailable');
      return {
        itemCode: itemCode.trim(),
        description: description.trim(),
        uom: uom.trim(),
        quantity: item.quantity,
      };
    });
    return {
      companyKey,
      invoiceId,
      docNo: fields.docNo.trim(),
      docDate: fields.docDate,
      header: {
        companyKey,
        invoiceId,
        docNo: fields.docNo.trim(),
        docDate: fields.docDate,
        customer: { code: customerCode.trim(), name: customerName.trim() },
        deliveryAddress: typeof fields.deliveryAddress === 'string' ? fields.deliveryAddress.trim() : '',
      },
      items,
    };
  }

  async assignInvoice({
    tripId,
    companyKey,
    invoiceId,
    docNo,
    docDate,
    expectedTripRevision,
    expected_revision: expectedRevision,
    actor,
    requestId,
  }) {
    const normalizedActor = requireActor(actor);
    const normalizedRequestId = requireRequestId(requestId);
    const normalizedTripId = requireId(tripId);
    const normalizedRevision = requireRevision(expectedTripRevision ?? expectedRevision);
    if (!COMPANY_KEYS.has(companyKey)) throw serviceError('invalid_request');
    const normalizedInvoiceId = requireText(invoiceId, 256);
    const normalizedDocNo = requireText(docNo, 256);
    if (!isValidDate(docDate)) throw serviceError('invalid_request');
    const values = {
      tripId: normalizedTripId,
      companyKey,
      invoiceId: normalizedInvoiceId,
      docNo: normalizedDocNo,
      docDate,
      expectedTripRevision: normalizedRevision,
    };
    const { fingerprint, prior } = await this._idempotentResult({
      actor: normalizedActor,
      requestId: normalizedRequestId,
      operation: 'assignment.create',
      payload: values,
    });
    if (prior?.replayed) return prior.result;
    const snapshot = await this._loadAuthoritativeInvoice(
      companyKey,
      normalizedInvoiceId,
      normalizedDocNo,
      docDate,
    );
    return this.repository.assignInvoiceMutation({
      ...values,
      header: snapshot.header,
      items: snapshot.items,
      actor: normalizedActor,
      requestId: normalizedRequestId,
      fingerprint,
    });
  }

  async _getAssignment(id) {
    const assignmentId = requireId(id);
    const assignment = await this.repository.getAssignment(assignmentId);
    if (!assignment) throw serviceError('resource_not_found');
    return assignment;
  }

  async _updateAssignmentStatus({ id, status, expectedTripRevision, actor, requestId }) {
    const normalizedActor = requireActor(actor);
    const normalizedRequestId = requireRequestId(requestId);
    const assignmentId = requireId(id);
    const revision = requireRevision(expectedTripRevision);
    if (typeof status !== 'string') throw serviceError('invalid_request');
    const values = { id: assignmentId, status, expectedTripRevision: revision };
    const operation = status === 'removed' ? 'assignment.remove' : 'assignment.status';
    const { fingerprint, prior } = await this._idempotentResult({
      actor: normalizedActor,
      requestId: normalizedRequestId,
      operation,
      payload: values,
    });
    if (prior?.replayed) return prior.result;
    const current = await this._getAssignment(assignmentId);
    assertAssignmentTransition(current.status, status);
    return this.repository.updateAssignmentMutation({
      ...values,
      actor: normalizedActor,
      requestId: normalizedRequestId,
      fingerprint,
    });
  }

  async removeAssignment({ id, assignmentId, expectedTripRevision, actor, requestId }) {
    return this._updateAssignmentStatus({
      id: id ?? assignmentId,
      status: 'removed',
      expectedTripRevision,
      actor,
      requestId,
    });
  }

  async updateAssignmentStatus({ id, assignmentId, status, expectedTripRevision, actor, requestId }) {
    return this._updateAssignmentStatus({
      id: id ?? assignmentId,
      status,
      expectedTripRevision,
      actor,
      requestId,
    });
  }

  async moveAssignment({ id, assignmentId, tripId, toTripId, expectedTripRevision, actor, requestId }) {
    const normalizedActor = requireActor(actor);
    const normalizedRequestId = requireRequestId(requestId);
    const assignmentIdValue = requireId(id ?? assignmentId);
    const destinationTripId = requireId(tripId ?? toTripId);
    const revision = requireRevision(expectedTripRevision);
    const values = {
      id: assignmentIdValue,
      toTripId: destinationTripId,
      expectedTripRevision: revision,
    };
    const { fingerprint, prior } = await this._idempotentResult({
      actor: normalizedActor,
      requestId: normalizedRequestId,
      operation: 'assignment.move',
      payload: values,
    });
    if (prior?.replayed) return prior.result;
    const current = await this._getAssignment(assignmentIdValue);
    assertAssignmentMovable(current.status);
    return this.repository.moveAssignmentMutation({
      ...values,
      actor: normalizedActor,
      requestId: normalizedRequestId,
      fingerprint,
    });
  }

  async getAssignment(id) {
    return this._getAssignment(id);
  }

  async listAssignments(filters = {}) {
    if (typeof this.repository.listAssignments !== 'function') return [];
    return this.repository.listAssignments(filters);
  }
}

function createDispatchService(options) {
  return new DispatchService(options);
}

module.exports = {
  COMPANY_KEYS,
  DECIMAL_RE,
  DispatchService,
  createDispatchService,
  isValidDate,
  positiveDecimalString,
};
