-- 001_initial.sql: Initial schema for brainctl orchestrator
-- SQLite migration

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  codex_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  spec_json TEXT NOT NULL,
  branch_name TEXT,
  worktree_path TEXT,
  worker_id TEXT,
  commit_hash TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'idle',
  session_path TEXT NOT NULL,
  started_at TEXT,
  last_heartbeat_at TEXT,
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS quality_checks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command_json TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout_tail TEXT,
  stderr_tail TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  request_json TEXT NOT NULL,
  answer_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS merges (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  commit_hash TEXT,
  merge_commit_hash TEXT,
  conflicts_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  actor TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_workers_run_id ON workers(run_id);
CREATE INDEX IF NOT EXISTS idx_decisions_run_id ON decisions(run_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_run_id ON token_usage(run_id);
