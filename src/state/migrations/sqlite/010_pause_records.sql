-- 010_pause_records.sql
-- Durable, auditable Stage pause lifecycle.

CREATE TABLE IF NOT EXISTS pause_records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  category TEXT NOT NULL,
  recoverable INTEGER NOT NULL CHECK(recoverable IN (0, 1)),
  required_approval_type TEXT,
  decision_id TEXT,
  evidence_summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_note TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (stage_id) REFERENCES stages(id),
  FOREIGN KEY (decision_id) REFERENCES approval_decisions(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pause_records_active_stage
  ON pause_records(stage_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pause_records_run_created
  ON pause_records(run_id, created_at);
