-- 002_m2_staged_scheduler.sql: M2 staged concurrency scheduler schema
-- SQLite migration

CREATE TABLE IF NOT EXISTS stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  base_commit TEXT,
  integration_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pi_pid INTEGER,
  started_at TEXT,
  stopped_at TEXT,
  worktree_path TEXT,
  branch_name TEXT,
  prompt_hash TEXT,
  worker_result_json TEXT,
  exit_reason TEXT,
  log_path TEXT,
  raw_log_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (stage_id) REFERENCES stages(id)
);

CREATE TABLE IF NOT EXISTS path_locks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  lock_type TEXT NOT NULL DEFAULT 'exclusive',
  status TEXT NOT NULL DEFAULT 'locked',
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reviewer_type TEXT NOT NULL,
  status TEXT NOT NULL,
  review_json TEXT,
  findings_json TEXT,
  required_rework_json TEXT,
  rework_count INTEGER NOT NULL DEFAULT 0,
  merge_allowed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES task_attempts(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS integration_batches (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  integration_branch TEXT NOT NULL,
  base_commit TEXT,
  merge_commit_hash TEXT,
  conflicts_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (stage_id) REFERENCES stages(id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  task_id TEXT,
  attempt_id TEXT,
  event_type TEXT NOT NULL,
  event_data_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS idx_stages_run_id ON stages(run_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task_id ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_stage_id ON task_attempts(stage_id);
CREATE INDEX IF NOT EXISTS idx_path_locks_run_id ON path_locks(run_id);
CREATE INDEX IF NOT EXISTS idx_path_locks_file_path ON path_locks(file_path);
CREATE INDEX IF NOT EXISTS idx_reviews_attempt_id ON reviews(attempt_id);
CREATE INDEX IF NOT EXISTS idx_integration_batches_stage_id ON integration_batches(stage_id);
CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
