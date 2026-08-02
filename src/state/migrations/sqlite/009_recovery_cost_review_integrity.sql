-- 009_recovery_cost_review_integrity.sql
-- Cost reservations, recovery provenance, and review coverage metadata.

ALTER TABLE task_attempts ADD COLUMN result_source TEXT NOT NULL DEFAULT 'pi';
ALTER TABLE task_attempts ADD COLUMN adopted_commit TEXT;
ALTER TABLE task_attempts ADD COLUMN adoption_metadata_json TEXT;

ALTER TABLE reviews ADD COLUMN reviewed_through_commit TEXT;
ALTER TABLE reviews ADD COLUMN final_commit TEXT;
ALTER TABLE reviews ADD COLUMN coverage_status TEXT NOT NULL DEFAULT 'partial';
ALTER TABLE reviews ADD COLUMN reviewer_unavailable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN error_category TEXT;
ALTER TABLE reviews ADD COLUMN exit_code INTEGER;
ALTER TABLE reviews ADD COLUMN duration_ms INTEGER;
ALTER TABLE reviews ADD COLUMN stderr_hash TEXT;

ALTER TABLE integration_batches ADD COLUMN reviewed_through_commit TEXT;
ALTER TABLE integration_batches ADD COLUMN final_commit TEXT;
ALTER TABLE integration_batches ADD COLUMN review_coverage_status TEXT NOT NULL DEFAULT 'partial';
ALTER TABLE integration_batches ADD COLUMN reviewer_unavailable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integration_batches ADD COLUMN review_metadata_json TEXT;

CREATE TABLE IF NOT EXISTS cost_reservations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  call_type TEXT NOT NULL,
  call_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('CNY', 'USD')),
  budget_limit REAL NOT NULL CHECK(budget_limit > 0),
  reserved_cost REAL NOT NULL CHECK(reserved_cost > 0),
  actual_cost REAL,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'confirmed', 'unavailable', 'released')),
  pricing_version TEXT NOT NULL,
  usage_status TEXT NOT NULL CHECK(usage_status IN ('pending', 'confirmed', 'unavailable')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_cost_reservations_run ON cost_reservations(run_id, status);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_attempt ON cost_reservations(attempt_id);

/* rollback: additive migration; SQLite column removal is intentionally omitted. */
