-- 006_m5_reconciliation: M5 crash recovery & state convergence audit
-- Creates 2 new tables: reconciliation_reports and reconciliation_findings.
-- No modifications to existing tables.
-- Only the explicit "reconcile --apply" command persists records.
-- Dry-run, preflight, and status NEVER write to these tables.

-- ══════════════════════════════════════════════════════════════
-- 1. reconciliation_reports: each explicit reconcile --apply audit record
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  phase           TEXT NOT NULL CHECK(phase IN ('applied')),
  initiated_by    TEXT NOT NULL CHECK(initiated_by IN ('user_direct')),
  total_findings  INTEGER NOT NULL DEFAULT 0,
  blocking_count  INTEGER NOT NULL DEFAULT 0,
  applied_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  summary_json    TEXT NOT NULL,       -- top-level summary (no paths, no secrets)
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_run ON reconciliation_reports(run_id, created_at);

-- ══════════════════════════════════════════════════════════════
-- 2. reconciliation_findings: per-entity finding with evidence
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id              TEXT PRIMARY KEY,
  report_id       TEXT NOT NULL REFERENCES reconciliation_reports(id),
  run_id          TEXT NOT NULL,
  entity_type     TEXT NOT NULL CHECK(entity_type IN (
                    'attempt','stage','run','lock','worktree','branch',
                    'integration','approval','budget','git_head','conflict'
                  )),
  entity_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,       -- e.g. 'pid_missing','lock_orphaned','worktree_missing',...
  severity        TEXT NOT NULL CHECK(severity IN ('info','warning','blocking')),
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK(status IN ('open','applied','skipped','superseded')),
  proposal        TEXT NOT NULL,       -- human-readable fix proposal
  applied_action  TEXT,                -- what was applied (null if no safe action was applicable)
  evidence_hash   TEXT NOT NULL,       -- SHA256 of sanitized evidence snippet (NO raw paths/secrets)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_findings_report ON reconciliation_findings(report_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_findings_run ON reconciliation_findings(run_id, status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_findings_entity ON reconciliation_findings(run_id, entity_type, entity_id);

/* ── Rollback ────────────────────────────────────────────────────────────
   To rollback this migration:
     DROP TABLE IF EXISTS reconciliation_findings;
     DROP TABLE IF EXISTS reconciliation_reports;
   ──────────────────────────────────────────────────────────────────────── */
