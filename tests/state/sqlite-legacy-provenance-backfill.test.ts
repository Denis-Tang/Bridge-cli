import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { readRecoveryContextReadOnly } from '../../src/cli/commands/recover.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const cleanup: string[] = [];
const openDatabases: any[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ESM-safe directory: vitest also injects __dirname for CJS interop, but the
// project is "type": "module", so prefer import.meta.dirname (Node 24) and
// fall back only for tooling that still supplies the CJS global.
const SOURCE_MIGRATIONS = path.resolve(import.meta.dirname || __dirname, '../../src/state/migrations/sqlite');
const DIFF_BASE = 'de48b04b6e069d4f9612d6ea5c76e6074316e8df';

/**
 * Migrate a fresh database up to (and including) `throughVersion`, so a test can
 * reproduce a database that predates a later migration. Migration 012 introduced
 * attempt_provenance, so stopping at 011 yields a genuine pre-provenance schema.
 */
function migrateThrough(throughVersion: string): { db: any; dbPath: string; dir: string } {
  const dir = path.join(tmpdir(), `bridge-legacy-prov-${Date.now()}-${Math.random()}`);
  const partialDir = path.join(dir, 'migrations');
  mkdirSync(partialDir, { recursive: true });
  cleanup.push(dir);

  for (const file of readdirSync(SOURCE_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (file.slice(0, 3) > throughVersion) continue;
    copyFileSync(path.join(SOURCE_MIGRATIONS, file), path.join(partialDir, file));
  }

  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  openDatabases.push(db);
  const runner = new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, db);
  (runner as any).migrationsDir = partialDir;
  runner.applyPending();
  return { db, dbPath, dir };
}

/** Apply every real migration, including any newer than the fixture's version. */
function migrateToLatest(db: any, dbPath: string): void {
  new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, db).applyPending();
}

function seedLegacyRun(db: any, dir: string): void {
  const now = '2026-07-29T00:00:00.000Z';
  db.prepare(`INSERT INTO runs (id, project_id, project_root, request_text, status, created_at, updated_at)
    VALUES ('r', 'p', ?, 'legacy', 'running', ?, ?)`).run(dir, now, now);
  db.prepare(`INSERT INTO stages (id, run_id, stage_number, title, status, base_commit, created_at, updated_at)
    VALUES ('s', 'r', 3, 'legacy stage', 'paused', ?, ?, ?)`).run(DIFF_BASE, now, now);
  db.prepare(`INSERT INTO tasks (id, run_id, title, status, spec_json, created_at, updated_at)
    VALUES ('t', 'r', 'legacy task', 'waiting_decision', ?, ?, ?)`)
    .run(JSON.stringify({ taskId: 't', allowedPaths: ['src/'], estimatedWritePaths: ['src/a.ts'] }), now, now);

  const attempt = (id: string, num: number, branch: string | null, worktree: string | null): void => {
    db.prepare(`INSERT INTO task_attempts (id, task_id, stage_id, attempt_number, status, branch_name, worktree_path, created_at, updated_at)
      VALUES (?, 't', 's', ?, 'failed', ?, ?, ?, ?)`).run(id, num, branch, worktree, now, now);
  };
  const diffBaseEvent = (id: string, attemptId: string, value: unknown, createdAt = now): void => {
    db.prepare(`INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
      VALUES (?, 'r', 's', 't', ?, 'task_diff_base_captured', ?, ?)`)
      .run(id, attemptId, JSON.stringify({ diffBaseCommit: value }), createdAt);
  };

  // Complete evidence — the real-world case that migration 015 must recover.
  attempt('a-full', 1, 'brainctl/r/t/a1', path.join(dir, 'wt', 'a1'));
  diffBaseEvent('ev-full-old', 'a-full', 'a'.repeat(40), '2026-07-28T00:00:00.000Z');
  diffBaseEvent('ev-full', 'a-full', DIFF_BASE, '2026-07-29T00:00:01.000Z');

  // No diff-base event at all — must stay unrecoverable.
  attempt('a-no-event', 2, 'brainctl/r/t/a2', path.join(dir, 'wt', 'a2'));

  // Diff base present but not a 40-hex commit — must stay unrecoverable.
  attempt('a-bad-base', 3, 'brainctl/r/t/a3', path.join(dir, 'wt', 'a3'));
  diffBaseEvent('ev-bad', 'a-bad-base', 'base');

  // Missing branch / worktree identity — must stay unrecoverable.
  attempt('a-no-branch', 4, null, path.join(dir, 'wt', 'a4'));
  diffBaseEvent('ev-no-branch', 'a-no-branch', DIFF_BASE);
  attempt('a-blank-branch', 5, '   ', path.join(dir, 'wt', 'a5'));
  diffBaseEvent('ev-blank-branch', 'a-blank-branch', DIFF_BASE);
  attempt('a-no-worktree', 6, 'brainctl/r/t/a6', null);
  diffBaseEvent('ev-no-worktree', 'a-no-worktree', DIFF_BASE);
}

function provenanceFor(db: any, attemptId: string): Record<string, any> | undefined {
  return db.prepare('SELECT * FROM attempt_provenance WHERE attempt_id = ?').get(attemptId);
}

describe('migration 015: legacy attempt provenance backfill', () => {
  it('backfills provenance for a pre-012 attempt from evidence already in the database', () => {
    const { db, dbPath, dir } = migrateThrough('011');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attempt_provenance'").get())
      .toBeUndefined();
    seedLegacyRun(db, dir);

    migrateToLatest(db, dbPath);

    const row = provenanceFor(db, 'a-full');
    expect(row).toBeDefined();
    expect(row!.run_id).toBe('r');
    expect(row!.stage_id).toBe('s');
    expect(row!.task_id).toBe('t');
    expect(row!.expected_branch).toBe('brainctl/r/t/a1');
    expect(row!.expected_worktree).toBe(path.join(dir, 'wt', 'a1'));
    // The newest diff-base event wins, matching getAttemptDiffBase()'s latest-wins read.
    expect(row!.base_commit).toBe(DIFF_BASE);
    // Digests are not reconstructable and must not be fabricated.
    expect(row!.task_packet_hash).toBe('legacy:unavailable');
    expect(row!.implementation_prompt_hash).toBe('legacy:unavailable');
    expect(row!.worker_id).toBe('legacy:a-full');
  });

  it('leaves attempts without complete evidence unrecoverable', () => {
    const { db, dbPath, dir } = migrateThrough('011');
    seedLegacyRun(db, dir);

    migrateToLatest(db, dbPath);

    for (const attemptId of ['a-no-event', 'a-bad-base', 'a-no-branch', 'a-blank-branch', 'a-no-worktree']) {
      expect(provenanceFor(db, attemptId), `${attemptId} must not be backfilled`).toBeUndefined();
    }
    expect(db.prepare('SELECT count(*) c FROM attempt_provenance').get().c).toBe(1);
  });

  it('keeps recover fail-closed for an attempt the backfill could not justify', () => {
    const { db, dbPath, dir } = migrateThrough('011');
    seedLegacyRun(db, dir);
    migrateToLatest(db, dbPath);
    db.close();

    expect(() => readRecoveryContextReadOnly(dbPath, 'a-no-event')).toThrow(/provenance missing/);
  });

  it('flags a backfilled attempt as legacy so the caller can report the degraded check', () => {
    const { db, dbPath, dir } = migrateThrough('011');
    seedLegacyRun(db, dir);
    migrateToLatest(db, dbPath);
    // a-full must be the latest attempt for the task, otherwise the latest-attempt guard fires first.
    db.prepare("DELETE FROM task_attempts WHERE id != 'a-full'").run();
    db.close();

    const context = readRecoveryContextReadOnly(dbPath, 'a-full');
    expect(context.provenance.isLegacyBackfill).toBe(true);
    expect(context.provenance.baseCommit).toBe(DIFF_BASE);
    expect(context.provenance.expectedBranch).toBe('brainctl/r/t/a1');
  });

  it('never overwrites genuine provenance and stays idempotent across reruns', () => {
    const { db, dbPath, dir } = migrateThrough('011');
    seedLegacyRun(db, dir);
    migrateToLatest(db, dbPath);

    // Simulate an attempt that recorded real provenance through the normal path.
    db.prepare(`INSERT INTO attempt_provenance
      (attempt_id, run_id, stage_id, task_id, base_commit, expected_branch, expected_worktree,
       task_packet_hash, implementation_prompt_hash, worker_id, session_id, created_at)
      VALUES ('a-no-event', 'r', 's', 't', ?, 'real/branch', '/real/wt', ?, ?, 'bc-a-no-event', 'r:a-no-event', ?)`)
      .run(DIFF_BASE, 'a'.repeat(64), 'b'.repeat(64), '2026-07-29T00:00:00.000Z');

    // Re-running the backfill must not touch it, and must not duplicate rows.
    db.prepare("DELETE FROM schema_migrations WHERE version = '015'").run();
    migrateToLatest(db, dbPath);

    const genuine = provenanceFor(db, 'a-no-event')!;
    expect(genuine.expected_branch).toBe('real/branch');
    expect(genuine.task_packet_hash).toBe('a'.repeat(64));
    expect(genuine.worker_id).toBe('bc-a-no-event');
    expect(db.prepare('SELECT count(*) c FROM attempt_provenance').get().c).toBe(2);
  });
});
