CREATE TABLE IF NOT EXISTS dispatch_resource_idempotency (
  actor TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 128),
  request_id TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  operation TEXT NOT NULL CHECK (operation IN ('driver.create', 'driver.update', 'lorry.create', 'lorry.update')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('driver', 'lorry')),
  resource_id BIGINT,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  status_code INTEGER NOT NULL CHECK (status_code IN (200, 201)),
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
  PRIMARY KEY (actor, request_id)
);

CREATE INDEX IF NOT EXISTS dispatch_resource_idempotency_expiry_idx
  ON dispatch_resource_idempotency (expires_at);
