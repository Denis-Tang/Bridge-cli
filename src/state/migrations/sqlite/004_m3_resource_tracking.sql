-- 004_m3_resource_tracking: M3 resource sampling and dispatch decision persistence
-- Creates resource_samples (7-day retention) and dispatch_decisions (full retention) tables.
-- Forward compatible: all new columns have defaults; no changes to existing M2 tables.

-- ══════════════════════════════════════════════════════════════
-- Resource samples: periodic system resource snapshots
-- Retention: 7 days (cleanup handled by application logic)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS resource_samples (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,                -- NULL = system-level sample (no active run)
  timestamp       TEXT NOT NULL,
  cpu_pct         REAL NOT NULL,
  mem_total_mb    REAL,
  mem_used_mb     REAL,
  mem_pct         REAL,
  pi_active       INTEGER NOT NULL DEFAULT 0,
  budget          INTEGER NOT NULL DEFAULT 1,
  dispatch_paused INTEGER NOT NULL DEFAULT 0,
  pause_reason    TEXT,
  degraded        INTEGER NOT NULL DEFAULT 0,
  degrade_reason  TEXT,
  source          TEXT NOT NULL DEFAULT 'os',  -- 'os' | 'cim' | 'tasklist' | 'fallback'
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index on timestamp for retention cleanup and time-range queries
CREATE INDEX IF NOT EXISTS idx_resource_samples_ts ON resource_samples(timestamp);

-- Index on run_id for run-scoped queries
CREATE INDEX IF NOT EXISTS idx_resource_samples_run ON resource_samples(run_id);

-- ══════════════════════════════════════════════════════════════
-- Dispatch decisions: budget change audit trail
-- Full retention (quantity is small: one row per budget change)
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS dispatch_decisions (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,                -- NULL = system-level decision
  timestamp       TEXT NOT NULL,
  decision_type   TEXT NOT NULL,       -- 'scale_down' | 'scale_up' | 'pause' | 'resume' | 'degrade'
  reason          TEXT NOT NULL,
  previous_budget INTEGER NOT NULL,
  new_budget      INTEGER NOT NULL,
  sample_json     TEXT,                -- JSON snapshot of the resource sample that triggered the decision
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index on timestamp for audit trail queries
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_ts ON dispatch_decisions(timestamp);

-- Index on run_id for run-scoped audit
CREATE INDEX IF NOT EXISTS idx_dispatch_decisions_run ON dispatch_decisions(run_id);

/* ── Rollback ────────────────────────────────────────────────────────────
   To rollback this migration:
     DROP TABLE IF EXISTS dispatch_decisions;
     DROP TABLE IF EXISTS resource_samples;
   ──────────────────────────────────────────────────────────────────────── */
