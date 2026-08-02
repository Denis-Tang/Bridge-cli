-- 014_pi_guard_probe_cache.sql
-- B (authorized round): persistent cache for the block-semantics inference probe.
-- Key = full Pi CLI version. A version already verified as pass is reused
-- (no money spent again) until Pi itself changes.

CREATE TABLE IF NOT EXISTS pi_guard_probe_cache (
  pi_version TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK(outcome IN ('pass', 'guard_ineffective', 'provider_unavailable', 'inconclusive', 'probe_timeout')),
  failure_category TEXT,
  checked_at TEXT NOT NULL
);

/* rollback: additive table; drop to roll back. */
