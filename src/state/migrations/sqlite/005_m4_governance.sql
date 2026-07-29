-- 005_m4_governance: M4 governance — decision gate, risk gate, token budget
-- Creates 4 new tables and adds 8 backward-compatible columns to existing tables.
-- All new columns have safe defaults; empty-db migration runs without errors.
-- M4 governance is off by default; enable via brainctl config set governance.enabled true

-- ══════════════════════════════════════════════════════════════
-- 1. approval_decisions: decision gate approval/denial audit trail
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS approval_decisions (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  gate          TEXT NOT NULL CHECK(gate IN ('G1','G2','G3')),
  decision_type TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK(scope IN ('run','stage','task','single_action')),
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','approved','denied','revoked','expired')),
  approved_by   TEXT NOT NULL DEFAULT 'user'
                CHECK(approved_by IN ('user','auto')),
  approved_at   TEXT,
  expires_at    TEXT,
  revoked_at    TEXT,
  revoke_reason TEXT,
  metadata_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_approval_decisions_run ON approval_decisions(run_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_decisions_scope ON approval_decisions(run_id, scope, status);

-- ══════════════════════════════════════════════════════════════
-- 2. token_ledger: sanitized token usage ledger (NO raw prompts/logs)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS token_ledger (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  stage_id          TEXT,
  task_id           TEXT,
  attempt_id        TEXT,
  call_type         TEXT NOT NULL,  -- 'codex_plan' | 'codex_review' | 'pi_worker'
  call_id           TEXT NOT NULL,  -- brain call ID or Pi session ID
  estimated_total   INTEGER,
  estimated_input   INTEGER,
  estimated_output  INTEGER,
  actual_total      INTEGER,
  actual_input      INTEGER,
  actual_output     INTEGER,
  actual_cache_hit  INTEGER,
  prompt_hash       TEXT,           -- SHA256 of prompt text (NOT the prompt itself)
  model             TEXT,
  duration_ms       INTEGER,
  status            TEXT NOT NULL,  -- 'estimated' | 'confirmed' | 'unavailable'
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_run ON token_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_stage ON token_ledger(stage_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_task ON token_ledger(task_id);

-- ══════════════════════════════════════════════════════════════
-- 3. budget_policies: global and per-run budget configuration
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS budget_policies (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,         -- NULL = global default
  scope           TEXT NOT NULL, -- 'global' | 'run' | 'stage'
  policy_type     TEXT NOT NULL, -- 'codex_plan' | 'codex_review_stage' | 'pi_run' | 'pi_task' | 'pi_attempt'
  token_limit     INTEGER NOT NULL,
  action_on_exceed TEXT NOT NULL DEFAULT 'pause', -- 'pause' | 'warn' | 'reject'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_budget_policies_run ON budget_policies(run_id);
CREATE INDEX IF NOT EXISTS idx_budget_policies_scope_type ON budget_policies(scope, policy_type);

-- ══════════════════════════════════════════════════════════════
-- 4. risk_assessments: risk snapshots at key decision points
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS risk_assessments (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  stage_id        TEXT,
  assessment_type TEXT NOT NULL CHECK(assessment_type IN ('plan','pre_stage','pre_merge','scope_expansion')),
  risk_level      TEXT NOT NULL CHECK(risk_level IN ('low','medium','high','critical')),
  findings_json   TEXT,       -- sanitized findings, no raw paths
  trigger         TEXT NOT NULL,  -- 'auto' | 'user_request' | 'scope_drift'
  resolved        INTEGER NOT NULL DEFAULT 0,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_assessments_run ON risk_assessments(run_id);

-- ══════════════════════════════════════════════════════════════
-- 5. ALTER existing tables: backward-compatible column additions
-- All use safe defaults; idempotent (skip if column exists)
-- ══════════════════════════════════════════════════════════════

-- 5a. runs: budget override and risk level
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
-- so these are wrapped in error-tolerant execution (handler in migration runner).
ALTER TABLE runs ADD COLUMN budget_config_json TEXT;
ALTER TABLE runs ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'low';

-- 5b. task_attempts: token tracking and scope expansion
ALTER TABLE task_attempts ADD COLUMN token_estimated INTEGER;
ALTER TABLE task_attempts ADD COLUMN token_actual INTEGER;
ALTER TABLE task_attempts ADD COLUMN scope_expansion_allowed INTEGER NOT NULL DEFAULT 0;

-- 5c. reviews: token tracking
ALTER TABLE reviews ADD COLUMN token_estimated INTEGER;
ALTER TABLE reviews ADD COLUMN token_actual INTEGER;

/* ── Rollback ────────────────────────────────────────────────────────────
   To rollback this migration:
     DROP TABLE IF EXISTS risk_assessments;
     DROP TABLE IF EXISTS budget_policies;
     DROP TABLE IF EXISTS token_ledger;
     DROP TABLE IF EXISTS approval_decisions;
     -- ALTER columns are NOT removed (SQLite can't drop columns directly).
     -- Revert by restoring from backup or recreating schema.
   ──────────────────────────────────────────────────────────────────────── */
