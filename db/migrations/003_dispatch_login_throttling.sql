CREATE TABLE IF NOT EXISTS dispatch_login_throttle_buckets (
  bucket_type TEXT NOT NULL CHECK (bucket_type IN ('account', 'ip')),
  bucket_key TEXT NOT NULL CHECK (bucket_key ~ '^[A-Za-z0-9_-]{43}$'),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_failure_at TIMESTAMPTZ,
  blocked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bucket_type, bucket_key)
);

CREATE INDEX IF NOT EXISTS dispatch_login_throttle_expiry_idx
  ON dispatch_login_throttle_buckets (updated_at, last_failure_at);

CREATE TABLE IF NOT EXISTS dispatch_login_throttle_meta (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO dispatch_login_throttle_meta (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
