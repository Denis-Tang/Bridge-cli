-- Stage 6: stage-scoped actual path claims and immutable attempt provenance.

CREATE TABLE IF NOT EXISTS actual_path_claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (stage_id) REFERENCES stages(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (attempt_id) REFERENCES task_attempts(id),
  UNIQUE(stage_id, attempt_id, normalized_path)
);

CREATE INDEX IF NOT EXISTS idx_actual_path_claims_stage_active
  ON actual_path_claims(stage_id, released_at, normalized_path);
CREATE INDEX IF NOT EXISTS idx_actual_path_claims_attempt
  ON actual_path_claims(attempt_id);

CREATE TABLE IF NOT EXISTS attempt_provenance (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  expected_branch TEXT NOT NULL,
  expected_worktree TEXT NOT NULL,
  task_packet_hash TEXT NOT NULL,
  implementation_prompt_hash TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES task_attempts(id),
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (stage_id) REFERENCES stages(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
