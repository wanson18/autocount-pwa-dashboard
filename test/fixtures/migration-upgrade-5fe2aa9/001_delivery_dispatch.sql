CREATE TABLE IF NOT EXISTS dispatch_drivers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (name <> ''),
  license_no TEXT NOT NULL UNIQUE CHECK (license_no <> ''),
  phone TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dispatch_vehicles (
  id BIGSERIAL PRIMARY KEY,
  registration_no TEXT NOT NULL UNIQUE CHECK (registration_no <> ''),
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_trips (
  id BIGSERIAL PRIMARY KEY,
  trip_date DATE NOT NULL,
  driver_id BIGINT NOT NULL REFERENCES dispatch_drivers (id),
  vehicle_id BIGINT NOT NULL REFERENCES dispatch_vehicles (id),
  route_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'loading', 'dispatched', 'completed', 'cancelled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS delivery_assignments (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT NOT NULL REFERENCES delivery_trips (id),
  company_key TEXT NOT NULL CHECK (company_key IN ('enterprise', 'sdn_bhd')),
  invoice_id TEXT NOT NULL CHECK (invoice_id <> ''),
  doc_no TEXT NOT NULL CHECK (doc_no <> ''),
  doc_date DATE NOT NULL,
  invoice_header JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'loaded', 'out_for_delivery', 'delivered', 'failed', 'returned', 'removed')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS delivery_assignments_active_invoice_idx
  ON delivery_assignments (company_key, invoice_id)
  WHERE status NOT IN ('removed', 'failed', 'returned');

CREATE TABLE IF NOT EXISTS delivery_assignment_items (
  id BIGSERIAL PRIMARY KEY,
  assignment_id BIGINT NOT NULL REFERENCES delivery_assignments (id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_code TEXT NOT NULL CHECK (item_code <> ''),
  description TEXT NOT NULL,
  uom TEXT NOT NULL CHECK (uom <> ''),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  UNIQUE (assignment_id, line_no)
);

CREATE TABLE IF NOT EXISTS delivery_events (
  id BIGSERIAL PRIMARY KEY,
  trip_id BIGINT REFERENCES delivery_trips (id),
  assignment_id BIGINT REFERENCES delivery_assignments (id),
  event_type TEXT NOT NULL CHECK (event_type <> ''),
  payload JSONB NOT NULL DEFAULT '{}',
  actor TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS delivery_events_assignment_idx
  ON delivery_events (assignment_id, id);

CREATE OR REPLACE FUNCTION prevent_delivery_assignment_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.invoice_header IS DISTINCT FROM OLD.invoice_header
  THEN
    RAISE EXCEPTION 'delivery assignment invoice snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_assignment_snapshot_immutable
  ON delivery_assignments;
CREATE TRIGGER delivery_assignment_snapshot_immutable
  BEFORE UPDATE OR DELETE ON delivery_assignments
  FOR EACH ROW EXECUTE FUNCTION prevent_delivery_assignment_snapshot_mutation();

CREATE OR REPLACE FUNCTION prevent_delivery_assignment_item_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delivery assignment item snapshot is immutable';
END;
$$;

DROP TRIGGER IF EXISTS delivery_assignment_item_snapshot_immutable
  ON delivery_assignment_items;
CREATE TRIGGER delivery_assignment_item_snapshot_immutable
  BEFORE UPDATE OR DELETE ON delivery_assignment_items
  FOR EACH ROW EXECUTE FUNCTION prevent_delivery_assignment_item_snapshot_mutation();

CREATE OR REPLACE FUNCTION prevent_delivery_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'delivery event history is append-only';
END;
$$;

DROP TRIGGER IF EXISTS delivery_event_append_only
  ON delivery_events;
CREATE TRIGGER delivery_event_append_only
  BEFORE UPDATE OR DELETE ON delivery_events
  FOR EACH ROW EXECUTE FUNCTION prevent_delivery_event_mutation();
