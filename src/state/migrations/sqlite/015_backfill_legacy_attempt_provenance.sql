-- 015_backfill_legacy_attempt_provenance.sql
-- Migration 012 created attempt_provenance but never backfilled rows that
-- already existed. The only writer is the attempt execution path
-- (StageScheduler.recordAttemptProvenance), which a finished attempt will never
-- reach again, so every pre-012 attempt permanently lost `recover attempt`.
--
-- BACKFILL: required. Rebuilds provenance strictly from evidence already in the
-- database. base_commit comes from the task_diff_base_captured event that
-- StageScheduler itself wrote, which is the same source getAttemptDiffBase uses
-- on resume, so a backfilled base cannot drift from the resume diff base.
--
-- Fails closed: an attempt missing any of (branch, worktree, a valid 40-hex
-- diff base event, a matching task) produces no row and keeps failing the
-- provenance check in recover.ts. The gate is not widened; only attempts that
-- carry their own evidence get the record they should have had.
--
-- task_packet_hash / implementation_prompt_hash / worker_id / session_id have no
-- reader anywhere in src/ today. They are written as explicit 'legacy:unavailable'
-- sentinels rather than fabricated digests: a fake hash would silently pass a
-- future packet-integrity check, while the sentinel fails loudly.

INSERT OR IGNORE INTO attempt_provenance (
  attempt_id, run_id, stage_id, task_id, base_commit,
  expected_branch, expected_worktree, task_packet_hash,
  implementation_prompt_hash, worker_id, session_id, created_at
)
WITH valid_diff_base_events AS (
  SELECT
    e.rowid AS rowid,
    e.attempt_id AS attempt_id,
    e.created_at AS created_at,
    json_extract(e.event_data_json, '$.diffBaseCommit') AS diff_base
  FROM events e
  WHERE e.event_type = 'task_diff_base_captured'
    AND e.attempt_id IS NOT NULL
    AND json_extract(e.event_data_json, '$.diffBaseCommit') GLOB
      '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      || '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
)
SELECT
  a.id,
  t.run_id,
  a.stage_id,
  a.task_id,
  evidence.diff_base,
  a.branch_name,
  a.worktree_path,
  'legacy:unavailable',
  'legacy:unavailable',
  'legacy:' || a.id,
  t.run_id || ':' || a.id || ':legacy',
  COALESCE(evidence.captured_at, a.created_at)
FROM task_attempts a
JOIN tasks t
  ON t.id = a.task_id
JOIN stages s
  ON s.id = a.stage_id
 AND s.run_id = t.run_id
-- Latest valid diff-base event per attempt. getAttemptDiffBase() reads the
-- events in created_at ASC order and takes the last match, so "latest wins"
-- here as well; rowid breaks created_at ties toward the most recent write.
JOIN (
  SELECT
    v.attempt_id AS attempt_id,
    v.diff_base AS diff_base,
    v.created_at AS captured_at
  FROM valid_diff_base_events v
  WHERE NOT EXISTS (
    SELECT 1 FROM valid_diff_base_events later
    WHERE later.attempt_id = v.attempt_id
      AND (later.created_at > v.created_at
        OR (later.created_at = v.created_at AND later.rowid > v.rowid))
  )
) evidence
  ON evidence.attempt_id = a.id
WHERE a.branch_name IS NOT NULL
  AND TRIM(a.branch_name) != ''
  AND a.worktree_path IS NOT NULL
  AND TRIM(a.worktree_path) != ''
  AND NOT EXISTS (
    SELECT 1 FROM attempt_provenance p WHERE p.attempt_id = a.id
  );

/* rollback: additive rows only; delete rows whose worker_id starts with
   'legacy:' to roll back. Genuine provenance is never overwritten because of
   INSERT OR IGNORE plus the NOT EXISTS guard. */
