const crypto = require('node:crypto');
const {
  assertAssignmentMovable,
  assertAssignmentTransition,
  assertTripTransition,
} = require('./status-machine');

const TRIP_STATUSES = new Set(['planned', 'loading', 'dispatched', 'completed', 'cancelled']);
const ASSIGNMENT_STATUSES = new Set([
  'assigned', 'loaded', 'out_for_delivery', 'delivered', 'failed', 'returned', 'removed',
]);
const IDEMPOTENCY_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const IDEMPOTENCY_OPERATIONS = new Set(['driver.create', 'driver.update', 'lorry.create', 'lorry.update']);
const IDEMPOTENCY_RESOURCE_TYPES = new Set(['driver', 'lorry']);
const resourceMutationLocks = new Map();
const dispatchMutationQueues = new WeakMap();
const DISPATCH_MUTATION_OPERATIONS = new Set([
  'trip.create',
  'trip.update',
  'assignment.create',
  'assignment.move',
  'assignment.remove',
  'assignment.status',
]);
const DISPATCH_MUTATION_STORAGE = Object.freeze({
  'trip.create': Object.freeze({ operation: 'trip.create', resourceType: 'trip' }),
  'trip.update': Object.freeze({ operation: 'trip.update', resourceType: 'trip' }),
  'assignment.create': Object.freeze({ operation: 'assignment.create', resourceType: 'assignment' }),
  'assignment.move': Object.freeze({ operation: 'assignment.move', resourceType: 'assignment' }),
  'assignment.remove': Object.freeze({ operation: 'assignment.remove', resourceType: 'assignment' }),
  'assignment.status': Object.freeze({ operation: 'assignment.status', resourceType: 'assignment' }),
});
const DEFAULT_DISPATCH_READ_LIMIT = 100;

function readLimit(value = DEFAULT_DISPATCH_READ_LIMIT) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_DISPATCH_READ_LIMIT) {
    throw dispatchMutationError('invalid_request');
  }
  return limit;
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original business error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function asJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mutationFingerprint(operation, payload) {
  return crypto.createHash('sha256')
    .update(stableSerialize({ operation, payload }), 'utf8')
    .digest('hex');
}

function auditState(resource, type) {
  if (type === 'driver') {
    return {
      id: resource.id,
      name: resource.name,
      licenseNo: resource.licenseNo,
      phone: resource.phone,
      active: resource.active,
    };
  }
  return {
    id: resource.id,
    registrationNo: resource.registrationNo,
    description: resource.description,
    active: resource.active,
  };
}

function idempotencyConflict() {
  const error = new Error('idempotency request conflict');
  error.code = 'idempotency_conflict';
  return error;
}

function idempotencyInputError() {
  const error = new Error('invalid idempotency input');
  error.code = 'invalid_request';
  return error;
}

function restoreResourceDates(resource) {
  if (!resource || typeof resource !== 'object') return resource;
  const restored = { ...resource };
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof restored[field] === 'string') {
      const parsed = new Date(restored[field]);
      if (!Number.isNaN(parsed.getTime())) restored[field] = parsed;
    }
  }
  return restored;
}

function resourceMutationLockKey(actor, requestId) {
  return requestId === null || requestId === undefined ? null : `${actor}\u0000${requestId}`;
}

async function withResourceMutationLock(key, callback) {
  if (!key) return callback();
  const previous = resourceMutationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  resourceMutationLocks.set(key, queued);
  try {
    await previous.catch(() => {});
    return await callback();
  } finally {
    release();
    if (resourceMutationLocks.get(key) === queued) resourceMutationLocks.delete(key);
  }
}

function withDispatchMutationTransaction(pool, callback) {
  const previous = dispatchMutationQueues.get(pool) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => withTransaction(pool, callback));
  dispatchMutationQueues.set(pool, current.catch(() => {}));
  return current;
}

function dispatchMutationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function mutationStorage(operation) {
  return DISPATCH_MUTATION_STORAGE[operation] || null;
}

function restoreMutationDates(value) {
  if (Array.isArray(value)) return value.map(restoreMutationDates);
  if (!value || typeof value !== 'object') return value;
  const restored = Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    restoreMutationDates(entry),
  ]));
  for (const field of ['createdAt', 'updatedAt', 'assignedAt']) {
    if (typeof restored[field] === 'string') {
      const parsed = new Date(restored[field]);
      if (!Number.isNaN(parsed.getTime())) restored[field] = parsed;
    }
  }
  return restored;
}

function mapSqlDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

function mapDriver(row) {
  return {
    id: Number(row.id),
    name: row.name,
    licenseNo: row.license_no,
    phone: row.phone,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVehicle(row) {
  return {
    id: Number(row.id),
    registrationNo: row.registration_no,
    description: row.description,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTrip(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    tripDate: mapSqlDate(row.trip_date),
    driverId: Number(row.driver_id),
    vehicleId: Number(row.vehicle_id),
    routeNotes: row.route_notes,
    status: row.status,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTripWithResources(row) {
  const trip = mapTrip(row);
  if (!trip) return null;
  return {
    ...trip,
    driver: row.driver_name === null || row.driver_name === undefined ? undefined : {
      id: trip.driverId,
      name: row.driver_name,
      licenseNo: row.driver_license_no,
      phone: row.driver_phone,
      active: row.driver_active,
    },
    lorry: row.vehicle_registration_no === null || row.vehicle_registration_no === undefined ? undefined : {
      id: trip.vehicleId,
      registrationNo: row.vehicle_registration_no,
      description: row.vehicle_description,
      active: row.vehicle_active,
    },
  };
}

function mapItem(row) {
  return {
    id: Number(row.id),
    lineNo: Number(row.line_no),
    itemCode: row.item_code,
    description: row.description,
    uom: row.uom,
    quantity: String(row.quantity),
  };
}

function mapEvent(row) {
  return {
    id: Number(row.id),
    tripId: row.trip_id === null ? null : Number(row.trip_id),
    assignmentId: row.assignment_id === null ? null : Number(row.assignment_id),
    eventType: row.event_type,
    payload: asJson(row.payload),
    actor: row.actor,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

class DispatchRepository {
  constructor(pool, queryable = pool) {
    this.pool = pool;
    this.db = queryable;
  }

  async createDriver({ name, licenseNo, phone = null, active = true, actor = null, requestId = null }) {
    return withResourceMutationLock(resourceMutationLockKey(actor, requestId), async () => {
      try {
        return await withTransaction(this.pool, async (client) => {
        const idempotency = requestId === null || requestId === undefined
          ? null
          : await this._beginIdempotency(client, {
            actor,
            requestId,
            operation: 'driver.create',
            resourceType: 'driver',
            fingerprint: mutationFingerprint('driver.create', { name, licenseNo, phone, active }),
          });
        if (idempotency?.replayed) return this._replayedResource(idempotency.row);
        const result = await client.query(`
          INSERT INTO dispatch_drivers (name, license_no, phone, active)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `, [name, licenseNo, phone, active]);
        const driver = mapDriver(result.rows[0]);
        await this._appendEvent(client, {
          tripId: null,
          assignmentId: null,
          eventType: 'driver_created',
          payload: { driverId: driver.id, before: null, after: auditState(driver, 'driver') },
          actor,
          requestId,
        });
        if (idempotency) await this._finishIdempotency(client, idempotency, driver, 201);
        return driver;
        });
      } catch (error) {
        if (error?.code === '23505') {
          const conflict = new Error('duplicate resource identity');
          conflict.code = 'resource_conflict';
          throw conflict;
        }
        throw error;
      }
    });
  }

  async createVehicle({ registrationNo, description = null, active = true, actor = null, requestId = null }) {
    return withResourceMutationLock(resourceMutationLockKey(actor, requestId), async () => {
      try {
        return await withTransaction(this.pool, async (client) => {
        const idempotency = requestId === null || requestId === undefined
          ? null
          : await this._beginIdempotency(client, {
            actor,
            requestId,
            operation: 'lorry.create',
            resourceType: 'lorry',
            fingerprint: mutationFingerprint('lorry.create', { registrationNo, description, active }),
          });
        if (idempotency?.replayed) return this._replayedResource(idempotency.row);
        const result = await client.query(`
          INSERT INTO dispatch_vehicles (registration_no, description, active)
          VALUES ($1, $2, $3)
          RETURNING *
        `, [registrationNo, description, active]);
        const vehicle = mapVehicle(result.rows[0]);
        await this._appendEvent(client, {
          tripId: null,
          assignmentId: null,
          eventType: 'lorry_created',
          payload: { vehicleId: vehicle.id, before: null, after: auditState(vehicle, 'lorry') },
          actor,
          requestId,
        });
        if (idempotency) await this._finishIdempotency(client, idempotency, vehicle, 201);
        return vehicle;
        });
      } catch (error) {
        if (error?.code === '23505') {
          const conflict = new Error('duplicate resource identity');
          conflict.code = 'resource_conflict';
          throw conflict;
        }
        throw error;
      }
    });
  }

  async listDrivers({ active = true } = {}) {
    const values = [];
    const where = active === null ? '' : 'WHERE active = $1';
    if (active !== null) values.push(active);
    const result = await this.db.query(
      `SELECT * FROM dispatch_drivers ${where} ORDER BY name, id`,
      values,
    );
    return result.rows.map(mapDriver);
  }

  async listVehicles({ active = true } = {}) {
    const values = [];
    const where = active === null ? '' : 'WHERE active = $1';
    if (active !== null) values.push(active);
    const result = await this.db.query(
      `SELECT * FROM dispatch_vehicles ${where} ORDER BY registration_no, id`,
      values,
    );
    return result.rows.map(mapVehicle);
  }

  async updateDriver(id, { name, licenseNo, phone, active, actor = null, requestId = null } = {}) {
    const fields = [];
    const values = [];
    const requestedValues = { name, licenseNo, phone, active };
    for (const [column, value] of Object.entries({
      name,
      license_no: licenseNo,
      phone,
      active,
    })) {
      if (value === undefined) continue;
      fields.push(`${column} = $${values.length + 1}`);
      values.push(value);
    }
    if (!fields.length) return this.getDriver(id);
    values.push(id);
    return withResourceMutationLock(resourceMutationLockKey(actor, requestId), async () => {
      try {
        return await withTransaction(this.pool, async (client) => {
        const idempotency = requestId === null || requestId === undefined
          ? null
          : await this._beginIdempotency(client, {
            actor,
            requestId,
            operation: 'driver.update',
            resourceType: 'driver',
            fingerprint: mutationFingerprint('driver.update', {
              id,
              values: Object.fromEntries(Object.entries(requestedValues).filter(([, value]) => value !== undefined)),
            }),
          });
        if (idempotency?.replayed) return this._replayedResource(idempotency.row);
        const currentResult = await client.query(
          'SELECT * FROM dispatch_drivers WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!currentResult.rows[0]) {
          if (idempotency) await this._abandonIdempotency(client, idempotency);
          return null;
        }
        const before = mapDriver(currentResult.rows[0]);
        const changed = Object.entries(requestedValues).some(([key, value]) => (
          value !== undefined && !Object.is(before[key], value)
        ));
        if (!changed) {
          if (idempotency) await this._finishIdempotency(client, idempotency, before, 200);
          return before;
        }
        const result = await client.query(`
          UPDATE dispatch_drivers
          SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${values.length}
          RETURNING *
        `, values);
        if (!result.rows[0]) return null;
        const driver = mapDriver(result.rows[0]);
        const eventType = before.active && !driver.active
          ? 'driver_deactivated'
          : !before.active && driver.active
            ? 'driver_reactivated'
            : 'driver_updated';
        await this._appendEvent(client, {
          tripId: null,
          assignmentId: null,
          eventType,
          payload: {
            driverId: driver.id,
            before: auditState(before, 'driver'),
            after: auditState(driver, 'driver'),
          },
          actor,
          requestId,
        });
        if (idempotency) await this._finishIdempotency(client, idempotency, driver, 200);
        return driver;
        });
      } catch (error) {
        if (error?.code === '23505') {
          const conflict = new Error('duplicate resource identity');
          conflict.code = 'resource_conflict';
          throw conflict;
        }
        throw error;
      }
    });
  }

  async updateVehicle(id, { registrationNo, description, active, actor = null, requestId = null } = {}) {
    const fields = [];
    const values = [];
    const requestedValues = { registrationNo, description, active };
    for (const [column, value] of Object.entries({
      registration_no: registrationNo,
      description,
      active,
    })) {
      if (value === undefined) continue;
      fields.push(`${column} = $${values.length + 1}`);
      values.push(value);
    }
    if (!fields.length) return this.getVehicle(id);
    values.push(id);
    return withResourceMutationLock(resourceMutationLockKey(actor, requestId), async () => {
      try {
        return await withTransaction(this.pool, async (client) => {
        const idempotency = requestId === null || requestId === undefined
          ? null
          : await this._beginIdempotency(client, {
            actor,
            requestId,
            operation: 'lorry.update',
            resourceType: 'lorry',
            fingerprint: mutationFingerprint('lorry.update', {
              id,
              values: Object.fromEntries(Object.entries(requestedValues).filter(([, value]) => value !== undefined)),
            }),
          });
        if (idempotency?.replayed) return this._replayedResource(idempotency.row);
        const currentResult = await client.query(
          'SELECT * FROM dispatch_vehicles WHERE id = $1 FOR UPDATE',
          [id],
        );
        if (!currentResult.rows[0]) {
          if (idempotency) await this._abandonIdempotency(client, idempotency);
          return null;
        }
        const before = mapVehicle(currentResult.rows[0]);
        const changed = Object.entries(requestedValues).some(([key, value]) => (
          value !== undefined && !Object.is(before[key], value)
        ));
        if (!changed) {
          if (idempotency) await this._finishIdempotency(client, idempotency, before, 200);
          return before;
        }
        const result = await client.query(`
          UPDATE dispatch_vehicles
          SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${values.length}
          RETURNING *
        `, values);
        if (!result.rows[0]) return null;
        const vehicle = mapVehicle(result.rows[0]);
        const eventType = before.active && !vehicle.active
          ? 'lorry_deactivated'
          : !before.active && vehicle.active
            ? 'lorry_reactivated'
            : 'lorry_updated';
        await this._appendEvent(client, {
          tripId: null,
          assignmentId: null,
          eventType,
          payload: {
            vehicleId: vehicle.id,
            before: auditState(before, 'lorry'),
            after: auditState(vehicle, 'lorry'),
          },
          actor,
          requestId,
        });
        if (idempotency) await this._finishIdempotency(client, idempotency, vehicle, 200);
        return vehicle;
        });
      } catch (error) {
        if (error?.code === '23505') {
          const conflict = new Error('duplicate resource identity');
          conflict.code = 'resource_conflict';
          throw conflict;
        }
        throw error;
      }
    });
  }

  async getDriver(id) {
    const result = await this.db.query('SELECT * FROM dispatch_drivers WHERE id = $1', [id]);
    return result.rows[0] ? mapDriver(result.rows[0]) : null;
  }

  async getVehicle(id) {
    const result = await this.db.query('SELECT * FROM dispatch_vehicles WHERE id = $1', [id]);
    return result.rows[0] ? mapVehicle(result.rows[0]) : null;
  }

  async listLorries(options) {
    return this.listVehicles(options);
  }

  async createLorry(payload) {
    return this.createVehicle(payload);
  }

  async updateLorry(id, payload) {
    return this.updateVehicle(id, payload);
  }

  async listTrips({ startDate = null, endDate = null, status = null, limit = DEFAULT_DISPATCH_READ_LIMIT } = {}) {
    const filters = [];
    const values = [];
    const boundedLimit = readLimit(limit);
    if (startDate !== null) {
      values.push(startDate);
      filters.push(`trips.trip_date >= $${values.length}`);
    }
    if (endDate !== null) {
      values.push(endDate);
      filters.push(`trips.trip_date <= $${values.length}`);
    }
    if (status !== null) {
      values.push(status);
      filters.push(`trips.status = $${values.length}`);
    }
    const result = await this.db.query(`
      SELECT
        trips.*,
        drivers.name AS driver_name,
        drivers.license_no AS driver_license_no,
        drivers.phone AS driver_phone,
        drivers.active AS driver_active,
        vehicles.registration_no AS vehicle_registration_no,
        vehicles.description AS vehicle_description,
        vehicles.active AS vehicle_active
      FROM delivery_trips trips
      JOIN dispatch_drivers drivers ON drivers.id = trips.driver_id
      JOIN dispatch_vehicles vehicles ON vehicles.id = trips.vehicle_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY trips.trip_date, trips.id
      LIMIT $${values.length + 1}
    `, [...values, boundedLimit]);
    const trips = [];
    for (const row of result.rows) {
      trips.push({
        ...mapTripWithResources(row),
        assignments: await this.listAssignments({ tripId: Number(row.id) }),
      });
    }
    return trips;
  }

  async getTripDetails(id) {
    const result = await this.db.query(`
      SELECT
        trips.*,
        drivers.name AS driver_name,
        drivers.license_no AS driver_license_no,
        drivers.phone AS driver_phone,
        drivers.active AS driver_active,
        vehicles.registration_no AS vehicle_registration_no,
        vehicles.description AS vehicle_description,
        vehicles.active AS vehicle_active
      FROM delivery_trips trips
      JOIN dispatch_drivers drivers ON drivers.id = trips.driver_id
      JOIN dispatch_vehicles vehicles ON vehicles.id = trips.vehicle_id
      WHERE trips.id = $1
    `, [id]);
    if (!result.rows[0]) return null;
    return {
      ...mapTripWithResources(result.rows[0]),
      assignments: await this.listAssignments({ tripId: id }),
    };
  }

  async listAssignments({ tripId = null, limit = DEFAULT_DISPATCH_READ_LIMIT } = {}) {
    const filters = [];
    const values = [];
    const boundedLimit = readLimit(limit);
    if (tripId !== null) {
      values.push(tripId);
      filters.push(`trip_id = $${values.length}`);
    }
    const result = await this.db.query(`
      SELECT id
      FROM delivery_assignments
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY id
      LIMIT $${values.length + 1}
    `, [...values, boundedLimit]);
    const assignments = [];
    for (const row of result.rows) assignments.push(await this._readAssignment(this.db, row.id));
    return assignments;
  }

  async getDispatchMutationIdempotency({ actor, requestId, operation, fingerprint }) {
    this._validateDispatchMutationInput({ actor, requestId, operation, fingerprint });
    const result = await this.db.query(`
      SELECT actor, request_id, operation, resource_type, request_fingerprint,
             status_code, response, resource_id
      FROM dispatch_resource_idempotency
      WHERE actor = $1 AND request_id = $2 AND expires_at > CURRENT_TIMESTAMP
    `, [actor, requestId]);
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    const response = asJson(row.response);
    const storage = mutationStorage(operation);
    if (!storage
      || row.operation !== storage.operation
      || row.resource_type !== storage.resourceType
      || row.request_fingerprint !== fingerprint
      || response?.operation !== operation
      || !response.result) {
      throw idempotencyConflict();
    }
    return {
      replayed: true,
      result: restoreMutationDates(response.result),
      statusCode: Number(row.status_code),
    };
  }

  async createTripMutation({
    tripDate,
    driverId,
    vehicleId,
    routeNotes = '',
    actor,
    requestId,
    fingerprint,
  }) {
    return withDispatchMutationTransaction(this.pool, async (client) => {
      const idempotency = await this._beginDispatchMutationIdempotency(client, {
        actor,
        requestId,
        operation: 'trip.create',
        fingerprint,
      });
      if (idempotency.replayed) return idempotency.result;

      await this._requireActiveDriver(client, driverId);
      await this._requireActiveVehicle(client, vehicleId);
      const result = await client.query(`
        INSERT INTO delivery_trips (trip_date, driver_id, vehicle_id, route_notes, status)
        VALUES ($1, $2, $3, $4, 'planned')
        RETURNING *
      `, [tripDate, driverId, vehicleId, routeNotes]);
      const trip = mapTrip(result.rows[0]);
      await this._appendEvent(client, {
        tripId: trip.id,
        assignmentId: null,
        eventType: 'trip_created',
        payload: {
          tripId: trip.id,
          tripDate: trip.tripDate,
          driverId: trip.driverId,
          vehicleId: trip.vehicleId,
          routeNotes: trip.routeNotes,
        },
        actor,
        requestId,
      });
      await this._finishDispatchMutationIdempotency(client, idempotency, trip, 201);
      return trip;
    });
  }

  async updateTripMutation({
    id,
    expectedRevision,
    changes,
    actor,
    requestId,
    fingerprint,
  }) {
    return withDispatchMutationTransaction(this.pool, async (client) => {
      const idempotency = await this._beginDispatchMutationIdempotency(client, {
        actor,
        requestId,
        operation: 'trip.update',
        fingerprint,
      });
      if (idempotency.replayed) return idempotency.result;

      const currentResult = await client.query(
        'SELECT * FROM delivery_trips WHERE id = $1 FOR UPDATE',
        [id],
      );
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw dispatchMutationError('resource_not_found');
      const current = mapTrip(currentRow);
      if (current.revision !== expectedRevision) throw dispatchMutationError('stale_trip');
      if (changes.status !== undefined) assertTripTransition(current.status, changes.status);
      if (changes.driverId !== undefined) await this._requireActiveDriver(client, changes.driverId);
      if (changes.vehicleId !== undefined) await this._requireActiveVehicle(client, changes.vehicleId);
      if (changes.status === 'dispatched') {
        await this._requireActiveDriver(client, changes.driverId ?? current.driverId);
        await this._requireActiveVehicle(client, changes.vehicleId ?? current.vehicleId);
        const assignments = await client.query(`
          SELECT 1
          FROM delivery_assignments
          WHERE trip_id = $1 AND status NOT IN ('removed', 'failed', 'returned')
          LIMIT 1
        `, [id]);
        if (!assignments.rows[0]) throw dispatchMutationError('invalid_request');
      }

      const fields = [];
      const values = [];
      for (const [column, value] of Object.entries({
        status: changes.status,
        route_notes: changes.routeNotes,
        driver_id: changes.driverId,
        vehicle_id: changes.vehicleId,
      })) {
        if (value === undefined) continue;
        fields.push(`${column} = $${values.length + 1}`);
        values.push(value);
      }
      if (!fields.length) throw dispatchMutationError('invalid_request');
      values.push(id);
      const updatedResult = await client.query(`
        UPDATE delivery_trips
        SET ${fields.join(', ')}, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${values.length}
        RETURNING *
      `, values);
      const updated = mapTrip(updatedResult.rows[0]);
      await this._appendEvent(client, {
        tripId: updated.id,
        assignmentId: null,
        eventType: changes.status === undefined ? 'trip_updated' : 'trip_status_changed',
        payload: changes.status === undefined
          ? { before: current, after: updated }
          : { fromStatus: current.status, toStatus: updated.status },
        actor,
        requestId,
      });
      await this._finishDispatchMutationIdempotency(client, idempotency, updated, 200);
      return updated;
    });
  }

  async assignInvoiceMutation({
    tripId,
    expectedTripRevision,
    companyKey,
    invoiceId,
    docNo,
    docDate,
    header,
    items,
    actor,
    requestId,
    fingerprint,
  }) {
    return withDispatchMutationTransaction(this.pool, async (client) => {
      const idempotency = await this._beginDispatchMutationIdempotency(client, {
        actor,
        requestId,
        operation: 'assignment.create',
        fingerprint,
      });
      if (idempotency.replayed) return idempotency.result;

      const tripResult = await client.query(
        'SELECT * FROM delivery_trips WHERE id = $1 FOR UPDATE',
        [tripId],
      );
      const trip = tripResult.rows[0];
      if (!trip) throw dispatchMutationError('resource_not_found');
      if (Number(trip.revision) !== expectedTripRevision) throw dispatchMutationError('stale_trip');
      if (trip.status !== 'planned' && trip.status !== 'loading') {
        throw dispatchMutationError('invalid_transition');
      }

      let assignment;
      try {
        const result = await client.query(`
          INSERT INTO delivery_assignments
            (trip_id, company_key, invoice_id, doc_no, doc_date, invoice_header)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          RETURNING *
        `, [tripId, companyKey, invoiceId, docNo, docDate, JSON.stringify(header)]);
        assignment = result.rows[0];
      } catch (error) {
        if (error?.code === '23505') throw dispatchMutationError('invoice_already_assigned');
        throw error;
      }
      for (const [index, item] of items.entries()) {
        await this.insertAssignmentItem(client, assignment.id, index + 1, item);
      }
      const revisionResult = await client.query(`
        UPDATE delivery_trips
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING revision
      `, [tripId]);
      const tripRevision = Number(revisionResult.rows[0].revision);
      await this._appendEvent(client, {
        tripId,
        assignmentId: assignment.id,
        eventType: 'assigned',
        payload: { companyKey, invoiceId, docNo, docDate, toTripId: tripId },
        actor,
        requestId,
      });
      const response = {
        assignment: await this._readAssignment(client, assignment.id),
        tripRevision,
      };
      await this._finishDispatchMutationIdempotency(client, idempotency, response, 201);
      return response;
    });
  }

  async updateAssignmentMutation({
    id,
    status,
    expectedTripRevision,
    actor,
    requestId,
    fingerprint,
  }) {
    return withDispatchMutationTransaction(this.pool, async (client) => {
      const idempotency = await this._beginDispatchMutationIdempotency(client, {
        actor,
        requestId,
        operation: status === 'removed' ? 'assignment.remove' : 'assignment.status',
        fingerprint,
      });
      if (idempotency.replayed) return idempotency.result;

      const assignmentResult = await client.query(
        'SELECT * FROM delivery_assignments WHERE id = $1 FOR UPDATE',
        [id],
      );
      const currentAssignment = assignmentResult.rows[0];
      if (!currentAssignment) throw dispatchMutationError('resource_not_found');
      const tripResult = await client.query(
        'SELECT * FROM delivery_trips WHERE id = $1 FOR UPDATE',
        [currentAssignment.trip_id],
      );
      const trip = tripResult.rows[0];
      if (!trip) throw dispatchMutationError('resource_not_found');
      if (Number(trip.revision) !== expectedTripRevision) throw dispatchMutationError('stale_trip');
      assertAssignmentTransition(currentAssignment.status, status);

      const updatedResult = await client.query(`
        UPDATE delivery_assignments
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `, [status, id]);
      const revisionResult = await client.query(`
        UPDATE delivery_trips
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING revision
      `, [currentAssignment.trip_id]);
      const assignment = await this._readAssignment(client, id);
      const response = {
        assignment,
        tripRevision: Number(revisionResult.rows[0].revision),
      };
      await this._appendEvent(client, {
        tripId: currentAssignment.trip_id,
        assignmentId: id,
        eventType: 'status_changed',
        payload: { fromStatus: currentAssignment.status, toStatus: updatedResult.rows[0].status },
        actor,
        requestId,
      });
      await this._finishDispatchMutationIdempotency(client, idempotency, response, 200);
      return response;
    });
  }

  async moveAssignmentMutation({
    id,
    toTripId,
    expectedTripRevision,
    actor,
    requestId,
    fingerprint,
  }) {
    return withDispatchMutationTransaction(this.pool, async (client) => {
      const idempotency = await this._beginDispatchMutationIdempotency(client, {
        actor,
        requestId,
        operation: 'assignment.move',
        fingerprint,
      });
      if (idempotency.replayed) return idempotency.result;

      const assignmentResult = await client.query(
        'SELECT * FROM delivery_assignments WHERE id = $1 FOR UPDATE',
        [id],
      );
      const currentAssignment = assignmentResult.rows[0];
      if (!currentAssignment) throw dispatchMutationError('resource_not_found');
      assertAssignmentMovable(currentAssignment.status);
      const fromTripId = Number(currentAssignment.trip_id);
      if (fromTripId === toTripId) throw dispatchMutationError('invalid_request');
      const tripsResult = await client.query(`
        SELECT *
        FROM delivery_trips
        WHERE id = $1 OR id = $2
        ORDER BY id
        FOR UPDATE
      `, [fromTripId, toTripId]);
      const fromTrip = tripsResult.rows.find((row) => Number(row.id) === fromTripId);
      const toTrip = tripsResult.rows.find((row) => Number(row.id) === toTripId);
      if (!fromTrip || !toTrip) throw dispatchMutationError('resource_not_found');
      if (Number(toTrip.revision) !== expectedTripRevision) throw dispatchMutationError('stale_trip');
      if (fromTrip.status === 'completed' || fromTrip.status === 'cancelled'
        || toTrip.status === 'completed' || toTrip.status === 'cancelled') {
        throw dispatchMutationError('invalid_transition');
      }
      await this._requireActiveDriver(client, Number(toTrip.driver_id));
      await this._requireActiveVehicle(client, Number(toTrip.vehicle_id));

      await client.query(`
        UPDATE delivery_assignments
        SET trip_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [toTripId, id]);
      const fromRevisionResult = await client.query(`
        UPDATE delivery_trips
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING revision
      `, [fromTripId]);
      const toRevisionResult = await client.query(`
        UPDATE delivery_trips
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING revision
      `, [toTripId]);
      const response = {
        assignment: await this._readAssignment(client, id),
        tripRevision: Number(toRevisionResult.rows[0].revision),
        fromTripRevision: Number(fromRevisionResult.rows[0].revision),
      };
      await this._appendEvent(client, {
        tripId: toTripId,
        assignmentId: id,
        eventType: 'moved',
        payload: { fromTripId, toTripId },
        actor,
        requestId,
      });
      await this._finishDispatchMutationIdempotency(client, idempotency, response, 200);
      return response;
    });
  }

  async insertAssignmentItem(client, assignmentId, lineNo, item) {
    return client.query(`
      INSERT INTO delivery_assignment_items
        (assignment_id, line_no, item_code, description, uom, quantity)
      VALUES ($1, $2, $3, $4, $5, $6::numeric)
    `, [assignmentId, lineNo, item.itemCode, item.description, item.uom, item.quantity]);
  }

  async _requireActiveDriver(client, id) {
    const result = await client.query(
      'SELECT active FROM dispatch_drivers WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!result.rows[0] || result.rows[0].active !== true) {
      throw dispatchMutationError('invalid_request');
    }
  }

  async _requireActiveVehicle(client, id) {
    const result = await client.query(
      'SELECT active FROM dispatch_vehicles WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!result.rows[0] || result.rows[0].active !== true) {
      throw dispatchMutationError('invalid_request');
    }
  }

  async createTrip({ tripDate, driverId, vehicleId, routeNotes = '', status = 'planned' }) {
    if (!TRIP_STATUSES.has(status)) throw new Error(`invalid trip status: ${status}`);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`
        INSERT INTO delivery_trips (trip_date, driver_id, vehicle_id, route_notes, status)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [tripDate, driverId, vehicleId, routeNotes, status]);
      return mapTrip(result.rows[0]);
    });
  }

  async getTrip(id) {
    const result = await this.db.query('SELECT * FROM delivery_trips WHERE id = $1', [id]);
    return mapTrip(result.rows[0]);
  }

  async updateTrip(id, expectedRevision, changes) {
    const fields = [];
    const values = [];
    for (const [column, value] of Object.entries({
      status: changes.status,
      route_notes: changes.routeNotes,
      driver_id: changes.driverId,
      vehicle_id: changes.vehicleId,
    })) {
      if (value === undefined) continue;
      if (column === 'status' && !TRIP_STATUSES.has(value)) throw new Error(`invalid trip status: ${value}`);
      fields.push(`${column} = $${values.length + 1}`);
      values.push(value);
    }
    if (!fields.length) return this.getTrip(id);
    values.push(id, expectedRevision);
    const result = await withTransaction(this.pool, async (client) => client.query(`
      UPDATE delivery_trips
      SET ${fields.join(', ')}, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${values.length - 1} AND revision = $${values.length}
      RETURNING *
    `, values));
    return mapTrip(result.rows[0]);
  }

  async assignInvoice({ tripId, companyKey, invoiceId, docNo, docDate, header, items, actor = null, requestId = null }) {
    return withTransaction(this.pool, async (client) => {
      let assignment;
      try {
        const result = await client.query(`
          INSERT INTO delivery_assignments
            (trip_id, company_key, invoice_id, doc_no, doc_date, invoice_header)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          RETURNING *
        `, [tripId, companyKey, invoiceId, docNo, docDate, JSON.stringify(header)]);
        assignment = result.rows[0];
      } catch (error) {
        if (error.code === '23505') {
          error.code = 'invoice_already_assigned';
        }
        throw error;
      }
      for (const [index, item] of items.entries()) {
        await client.query(`
          INSERT INTO delivery_assignment_items
            (assignment_id, line_no, item_code, description, uom, quantity)
          VALUES ($1, $2, $3, $4, $5, $6::numeric)
        `, [assignment.id, index + 1, item.itemCode, item.description, item.uom, item.quantity]);
      }
      await this._appendEvent(client, {
        tripId,
        assignmentId: assignment.id,
        eventType: 'assigned',
        payload: { companyKey, invoiceId },
        actor,
        requestId,
      });
      return this._readAssignment(client, assignment.id);
    });
  }

  async getAssignment(id) {
    return this._readAssignment(this.db, id);
  }

  async updateAssignment(id, { status, actor = null, requestId = null }) {
    if (!ASSIGNMENT_STATUSES.has(status)) throw new Error(`invalid assignment status: ${status}`);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE delivery_assignments
        SET status = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `, [status, id]);
      if (!result.rows[0]) return null;
      await this._appendEvent(client, {
        tripId: result.rows[0].trip_id,
        assignmentId: id,
        eventType: 'status_changed',
        payload: { status },
        actor,
        requestId,
      });
      return this._readAssignment(client, id);
    });
  }

  async moveAssignment(id, tripId, { actor = null, requestId = null } = {}) {
    return withTransaction(this.pool, async (client) => {
      const previous = await client.query(
        'SELECT trip_id FROM delivery_assignments WHERE id = $1',
        [id],
      );
      if (!previous.rows[0]) return null;
      const fromTripId = Number(previous.rows[0].trip_id);
      const result = await client.query(`
        UPDATE delivery_assignments
        SET trip_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
      `, [tripId, id]);
      if (!result.rows[0]) return null;
      await this._appendEvent(client, {
        tripId,
        assignmentId: id,
        eventType: 'moved',
        payload: { fromTripId, toTripId: tripId },
        actor,
        requestId,
      });
      return this._readAssignment(client, id);
    });
  }

  async listEvents({ assignmentId = null, tripId = null } = {}) {
    const filters = [];
    const values = [];
    if (assignmentId !== null) {
      values.push(assignmentId);
      filters.push(`assignment_id = $${values.length}`);
    }
    if (tripId !== null) {
      values.push(tripId);
      filters.push(`trip_id = $${values.length}`);
    }
    const result = await this.db.query(`
      SELECT * FROM delivery_events
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY id
    `, values);
    return result.rows.map(mapEvent);
  }

  async _appendEvent(client, event) {
    await client.query(`
      INSERT INTO delivery_events (trip_id, assignment_id, event_type, payload, actor, request_id)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    `, [event.tripId, event.assignmentId, event.eventType, JSON.stringify(event.payload || {}), event.actor, event.requestId]);
  }

  _validateDispatchMutationInput({ actor, requestId, operation, fingerprint }) {
    if (typeof actor !== 'string' || actor.length < 1 || actor.length > 128
      || !IDEMPOTENCY_REQUEST_ID_PATTERN.test(requestId || '')
      || !DISPATCH_MUTATION_OPERATIONS.has(operation)
      || !/^[a-f0-9]{64}$/.test(fingerprint || '')) {
      throw idempotencyInputError();
    }
  }

  async _beginDispatchMutationIdempotency(client, {
    actor,
    requestId,
    operation,
    fingerprint,
  }) {
    this._validateDispatchMutationInput({ actor, requestId, operation, fingerprint });
    const storage = mutationStorage(operation);
    await client.query(`
      DELETE FROM dispatch_resource_idempotency
      WHERE expires_at <= CURRENT_TIMESTAMP
    `);
    const inserted = await client.query(`
      INSERT INTO dispatch_resource_idempotency
        (actor, request_id, operation, resource_type, request_fingerprint, status_code, response)
      VALUES ($1, $2, $3, $4, $5, 200, $6::jsonb)
      ON CONFLICT (actor, request_id) DO NOTHING
      RETURNING actor, request_id
    `, [
      actor,
      requestId,
      storage.operation,
      storage.resourceType,
      fingerprint,
      JSON.stringify({ operation, result: null }),
    ]);
    if (inserted.rows[0]) return { replayed: false, actor, requestId, operation };

    const existing = await client.query(`
      SELECT operation, resource_type, request_fingerprint, status_code, response
      FROM dispatch_resource_idempotency
      WHERE actor = $1 AND request_id = $2
      FOR UPDATE
    `, [actor, requestId]);
    const row = existing.rows[0];
    const response = row ? asJson(row.response) : null;
    if (!row
      || row.operation !== storage.operation
      || row.resource_type !== storage.resourceType
      || row.request_fingerprint !== fingerprint
      || response?.operation !== operation
      || !response.result) {
      throw idempotencyConflict();
    }
    return {
      replayed: true,
      result: restoreMutationDates(response.result),
      statusCode: Number(row.status_code),
    };
  }

  async _finishDispatchMutationIdempotency(client, idempotency, result, statusCode) {
    const resourceId = result?.assignment?.id || result?.id || null;
    const updated = await client.query(`
      UPDATE dispatch_resource_idempotency
      SET resource_id = $1,
          status_code = $2,
          response = $3::jsonb
      WHERE actor = $4 AND request_id = $5
    `, [
      resourceId,
      statusCode,
      JSON.stringify({ operation: idempotency.operation, result }),
      idempotency.actor,
      idempotency.requestId,
    ]);
    if (updated.rowCount !== 1) {
      const error = new Error('idempotency result could not be persisted');
      error.code = 'idempotency_persist_failed';
      throw error;
    }
  }

  async _beginIdempotency(client, {
    actor,
    requestId,
    operation,
    resourceType,
    fingerprint,
  }) {
    if (typeof actor !== 'string' || actor.length < 1 || actor.length > 128
      || !IDEMPOTENCY_REQUEST_ID_PATTERN.test(requestId || '')
      || !IDEMPOTENCY_OPERATIONS.has(operation)
      || !IDEMPOTENCY_RESOURCE_TYPES.has(resourceType)
      || !/^[a-f0-9]{64}$/.test(fingerprint || '')) {
      throw idempotencyInputError();
    }

    await client.query(`
      WITH expired AS (
        SELECT actor, request_id
        FROM dispatch_resource_idempotency
        WHERE expires_at <= CURRENT_TIMESTAMP
        ORDER BY expires_at
        LIMIT 100
      )
      DELETE FROM dispatch_resource_idempotency stored
      USING expired
      WHERE stored.actor = expired.actor AND stored.request_id = expired.request_id
    `);

    const inserted = await client.query(`
      INSERT INTO dispatch_resource_idempotency
        (actor, request_id, operation, resource_type, request_fingerprint, status_code, response)
      VALUES ($1, $2, $3, $4, $5, 200, '{}'::jsonb)
      ON CONFLICT (actor, request_id) DO NOTHING
      RETURNING actor, request_id, operation, resource_type, request_fingerprint, status_code, response, resource_id
    `, [actor, requestId, operation, resourceType, fingerprint]);
    if (inserted.rows[0]) {
      return {
        replayed: false,
        actor,
        requestId,
        operation,
        resourceType,
      };
    }

    const existing = await client.query(`
      SELECT actor, request_id, operation, resource_type, request_fingerprint, status_code, response, resource_id
      FROM dispatch_resource_idempotency
      WHERE actor = $1 AND request_id = $2
      FOR UPDATE
    `, [actor, requestId]);
    const row = existing.rows[0];
    if (!row
      || row.operation !== operation
      || row.resource_type !== resourceType
      || row.request_fingerprint !== fingerprint) {
      throw idempotencyConflict();
    }
    return { replayed: true, row };
  }

  async _abandonIdempotency(client, idempotency) {
    await client.query(`
      DELETE FROM dispatch_resource_idempotency
      WHERE actor = $1 AND request_id = $2
    `, [idempotency.actor, idempotency.requestId]);
  }

  _replayedResource(row) {
    const response = asJson(row.response);
    if (!response || !response.resource || typeof response.resource !== 'object') {
      throw idempotencyConflict();
    }
    return restoreResourceDates(response.resource);
  }

  async _finishIdempotency(client, idempotency, resource, statusCode) {
    const result = await client.query(`
      UPDATE dispatch_resource_idempotency
      SET resource_id = $1,
          status_code = $2,
          response = $3::jsonb
      WHERE actor = $4 AND request_id = $5
    `, [resource.id, statusCode, JSON.stringify({ resource }), idempotency.actor, idempotency.requestId]);
    if (result.rowCount !== 1) {
      const error = new Error('idempotency result could not be persisted');
      error.code = 'idempotency_persist_failed';
      throw error;
    }
  }

  async _readAssignment(queryable, id) {
    const assignmentResult = await queryable.query(
      'SELECT * FROM delivery_assignments WHERE id = $1',
      [id],
    );
    const row = assignmentResult.rows[0];
    if (!row) return null;
    const itemResult = await queryable.query(
      'SELECT * FROM delivery_assignment_items WHERE assignment_id = $1 ORDER BY line_no',
      [id],
    );
    return {
      id: Number(row.id),
      tripId: Number(row.trip_id),
      companyKey: row.company_key,
      invoiceId: row.invoice_id,
      docNo: row.doc_no,
      docDate: mapSqlDate(row.doc_date),
      header: asJson(row.invoice_header),
      status: row.status,
      assignedAt: row.assigned_at,
      updatedAt: row.updated_at,
      items: itemResult.rows.map(mapItem),
    };
  }
}

function createRepository(pool) {
  if (!pool) throw new Error('a database pool is required');
  return new DispatchRepository(pool);
}

module.exports = {
  ASSIGNMENT_STATUSES,
  DISPATCH_MUTATION_OPERATIONS,
  DispatchRepository,
  TRIP_STATUSES,
  createRepository,
  mutationFingerprint,
  withTransaction,
};
