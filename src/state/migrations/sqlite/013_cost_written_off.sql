-- 013_cost_written_off.sql
-- R2: add 'written_off' terminal status to cost_reservations.
-- SQLite cannot ALTER a CHECK constraint, so rebuild the table inside a single
-- file-level transaction (sqlite-migration-runner wraps each file in one
-- BEGIN IMMEDIATE/COMMIT/ROLLBACK). All data is preserved column-for-column.

CREATE TABLE IF NOT EXISTS cost_reservations_new (
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
  status TEXT NOT NULL CHECK(status IN ('reserved', 'confirmed', 'unavailable', 'released', 'written_off')),
  pricing_version TEXT NOT NULL,
  usage_status TEXT NOT NULL CHECK(usage_status IN ('pending', 'confirmed', 'unavailable')),
  phase TEXT NOT NULL DEFAULT 'reserved',
  spawned_at TEXT,
  owner_id TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  termination_evidence TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

INSERT INTO cost_reservations_new (
  id, run_id, stage_id, task_id, attempt_id, call_type, call_id, currency,
  budget_limit, reserved_cost, actual_cost, status, pricing_version, usage_status,
  phase, spawned_at, owner_id, lease_expires_at, heartbeat_at, termination_evidence, settled_at,
  created_at, updated_at
)
SELECT
  id, run_id, stage_id, task_id, attempt_id, call_type, call_id, currency,
  budget_limit, reserved_cost, actual_cost, status, pricing_version, usage_status,
  COALESCE(phase, 'reserved'), spawned_at, owner_id, lease_expires_at, heartbeat_at, termination_evidence, settled_at,
  created_at, updated_at
FROM cost_reservations;

DROP TABLE cost_reservations;
ALTER TABLE cost_reservations_new RENAME TO cost_reservations;

CREATE INDEX IF NOT EXISTS idx_cost_reservations_run ON cost_reservations(run_id, status);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_attempt ON cost_reservations(attempt_id);
CREATE INDEX IF NOT EXISTS idx_cost_reservations_lifecycle
  ON cost_reservations(status, phase, lease_expires_at);

/* rollback: this migration is one-way (status values are additive; rebuilding
   the table is intentionally not reversible by a later migration). */
