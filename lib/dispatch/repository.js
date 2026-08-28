const TRIP_STATUSES = new Set(['planned', 'loading', 'dispatched', 'completed', 'cancelled']);
const ASSIGNMENT_STATUSES = new Set([
  'assigned', 'loaded', 'out_for_delivery', 'delivered', 'failed', 'returned', 'removed',
]);

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

function queryableRepository(pool, queryable) {
  return new DispatchRepository(pool, queryable || pool);
}

function asJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
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
    tripDate: row.trip_date,
    driverId: Number(row.driver_id),
    vehicleId: Number(row.vehicle_id),
    routeNotes: row.route_notes,
    status: row.status,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  async createDriver({ name, licenseNo, phone = null, active = true }) {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`
        INSERT INTO dispatch_drivers (name, license_no, phone, active)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [name, licenseNo, phone, active]);
      return mapDriver(result.rows[0]);
    });
  }

  async createVehicle({ registrationNo, description = null, active = true }) {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(`
        INSERT INTO dispatch_vehicles (registration_no, description, active)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [registrationNo, description, active]);
      return mapVehicle(result.rows[0]);
    });
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
      docDate: row.doc_date,
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
  DispatchRepository,
  TRIP_STATUSES,
  createRepository,
  withTransaction,
};
