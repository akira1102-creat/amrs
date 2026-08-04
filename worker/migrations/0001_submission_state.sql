CREATE TABLE IF NOT EXISTS submission_batches (
  batch_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  expected_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  repaired_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_items (
  submission_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  company TEXT NOT NULL,
  status TEXT NOT NULL,
  row_number INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS submission_items_batch_idx
  ON submission_items (batch_id, status);

CREATE TABLE IF NOT EXISTS write_locks (
  scope TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

