// ── R1 GC Service: orphan worktree/branch inventory & constrained recycling ──
// Red-light tests first (TDD). Uses disposable temporary Git repos + SQLite.
// Never touches the formal repository. No real providers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { GcService } from '../../src/core/gc-service.js';

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch (err: any) {
    if (err.stdout) return err.stdout.toString().trim();
    if (err.stderr) return err.stderr.toString().trim();
    throw err;
  }
}

interface Fixture {
  tmp: string;
  projectRoot: string;
  wtRoot: string;
  dbPath: string;
  store: SqliteStateStore;
  runId: string;
  stageId: string;
  taskId: string;
}

let fixtures: Fixture[] = [];

async function makeFixture(seed: string): Promise<Fixture> {
  const tmp = path.join(tmpdir(), `bridge-gc-${seed}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectRoot = path.join(tmp, 'project');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  git(['init'], projectRoot);
  git(['config', 'user.email', 'test@test'], projectRoot);
  git(['config', 'user.name', 'test'], projectRoot);
  git(['config', 'core.autocrlf', 'false'], projectRoot);
  writeFileSync(path.join(projectRoot, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf-8');
  git(['add', '-A'], projectRoot);
  git(['commit', '-m', 'init'], projectRoot);
  git(['branch', '-M', 'main'], projectRoot);
  const wtRoot = path.join(projectRoot, '.brainctl-dev', 'worktrees');
  mkdirSync(wtRoot, { recursive: true });
  const dbPath = path.join(tmp, 'state.db');
  const store = SqliteStateStore.create(dbPath);
  new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
  const now = new Date().toISOString();
  const runId = `run-${seed}`;
  const stageId = `stage-${seed}`;
  const taskId = `task-${seed}`;
  // The run's frozen target branch lives in execution_config_snapshot (JSON),
  // NOT a target_branch column on runs. GC reads it from here.
  const snapshot = JSON.stringify({ snapshotVersion: 1, createdAt: now, config: { targetBranch: 'main' } });
  await store.createRun({ id: runId, projectId: 'p', projectRoot, requestText: 'x', status: 'paused', executionConfigSnapshot: snapshot, createdAt: now, updatedAt: now });
  await store.createStage({ id: stageId, runId, stageNumber: 1, title: 's', status: 'paused' });
  await store.createTask({ id: taskId, runId, title: 't', status: 'running', specJson: {}, createdAt: now, updatedAt: now });
  const fx: Fixture = { tmp, projectRoot, wtRoot, dbPath, store, runId, stageId, taskId };
  fixtures.push(fx);
  return fx;
}

/**
 * Create a real git worktree + brainctl branch + SQLite attempt record.
 * withCommit: branch gets a unique commit NOT in main (unmerged, paid-work guard).
 * dirty: worktree gets an uncommitted tracked change.
 * outside: worktree path lives OUTSIDE the worktrees root.
 */
async function addAttempt(
  fx: Fixture,
  opts: { attemptId: string; status: 'failed' | 'running' | 'interrupted'; withCommit?: boolean; dirty?: boolean; outside?: boolean },
): Promise<{ wtPath: string; branch: string }> {
  const { attemptId, status } = opts;
  const branch = `brainctl/${fx.runId}/${fx.taskId}/a1`;
  const wtPath = opts.outside
    ? path.join(fx.tmp, `outside-${attemptId}`)
    : path.join(fx.wtRoot, fx.runId, fx.taskId, 'a1');
  if (opts.outside) {
    mkdirSync(wtPath, { recursive: true });
  } else {
    git(['branch', branch, 'main'], fx.projectRoot);
    git(['worktree', 'add', wtPath, branch], fx.projectRoot);
  }
  if (opts.withCommit) {
    writeFileSync(path.join(wtPath, 'src', 'payload.ts'), 'export const p = 1;\n', 'utf-8');
    git(['add', '-A'], wtPath);
    git(['commit', '-m', 'payload'], wtPath);
  }
  if (opts.dirty) {
    writeFileSync(path.join(wtPath, 'src', 'seed.ts'), 'export const seed = 999;\n', 'utf-8');
  }
  await fx.store.createAttempt({ id: attemptId, taskId: fx.taskId, stageId: fx.stageId, attemptNumber: 1, status });
  await fx.store.updateAttemptResult(attemptId, { worktreePath: wtPath, branchName: branch });
  return { wtPath, branch };
}

async function closeAll(): Promise<void> {
  for (const fx of fixtures) {
    try { await fx.store.close(); } catch { /* ignore */ }
    try { rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* ignore */ }
  }
  fixtures = [];
}

beforeEach(() => { fixtures = []; });
afterEach(closeAll);

describe('R1 brainctl gc — inventory is read-only', () => {
  it('T1: gc without --apply lists recyclable worktrees but deletes nothing (hard assertion: dirs still exist)', async () => {
    const fx = await makeFixture('t1');
    await addAttempt(fx, { attemptId: 'a1', status: 'failed' });
    await addAttempt(fx, { attemptId: 'a2', status: 'failed' });
    await addAttempt(fx, { attemptId: 'a3', status: 'failed' });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();

    const safe = inv.entries.filter((e) => e.category === 'safe_to_recycle');
    expect(safe).toHaveLength(3);
    for (const e of safe) {
      expect(existsSync(e.path)).toBe(true);
    }
    // No deletion happened by inventory itself: every listed path still exists.
    for (const e of inv.entries.filter((x) => x.dirExists)) {
      expect(existsSync(e.path)).toBe(true);
    }
  });

  it('T2: paused Stage leftovers are inventoried (per attempt status: running→manual_review, failed→safe_to_recycle), never zero entries', async () => {
    const fx = await makeFixture('t2');
    await addAttempt(fx, { attemptId: 'a-running', status: 'running' });
    await addAttempt(fx, { attemptId: 'a-failed', status: 'failed' });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();

    const relevant = inv.entries.filter((e) => e.attemptId === 'a-running' || e.attemptId === 'a-failed');
    expect(relevant.length).toBeGreaterThan(0);
    const running = relevant.find((e) => e.attemptId === 'a-running');
    const failed = relevant.find((e) => e.attemptId === 'a-failed');
    expect(running?.category).toBe('manual_review');
    expect(failed?.category).toBe('safe_to_recycle');
  });
});

describe('R1 brainctl gc --apply — constrained recycling', () => {
  it('T3: refuses out-of-root paths (do_not_touch); --apply never touches them (hard assertion)', async () => {
    const fx = await makeFixture('t3');
    const outsideDir = path.join(fx.tmp, 'outside-wt');
    mkdirSync(outsideDir, { recursive: true });
    await fx.store.createAttempt({ id: 'a-x', taskId: fx.taskId, stageId: fx.stageId, attemptNumber: 1, status: 'failed' });
    await fx.store.updateAttemptResult('a-x', { worktreePath: outsideDir, branchName: 'brainctl/x/a1' });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    const e = inv.entries.find((x) => x.path === outsideDir);
    expect(e?.category).toBe('do_not_touch');

    await svc.apply(inv, { decisionNote: 't3 test', projectRoot: fx.projectRoot });
    expect(existsSync(outsideDir)).toBe(true);
  });

  it('T4: --apply skips a dirty worktree (uncommitted tracked change) (hard assertion)', async () => {
    const fx = await makeFixture('t4');
    const { wtPath } = await addAttempt(fx, { attemptId: 'a1', status: 'failed', dirty: true });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    expect(inv.entries.find((e) => e.attemptId === 'a1')?.category).toBe('manual_review');

    await svc.apply(inv, { decisionNote: 't4 test', projectRoot: fx.projectRoot });
    expect(existsSync(wtPath)).toBe(true);
  });

  it('T5: --apply without --decision-note fails closed (throws, deletes nothing)', async () => {
    const fx = await makeFixture('t5');
    await addAttempt(fx, { attemptId: 'a1', status: 'failed' });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    await expect(svc.apply(inv, { decisionNote: '', projectRoot: fx.projectRoot }))
      .rejects.toThrow(/decision-note/i);
    const safe = inv.entries.filter((e) => e.category === 'safe_to_recycle');
    for (const e of safe) {
      expect(existsSync(e.path)).toBe(true);
    }
  });

  it('T6: second-check at apply time — entry re-verified on site; if it turned dirty, it is skipped (hard assertion)', async () => {
    const fx = await makeFixture('t6');
    const { wtPath } = await addAttempt(fx, { attemptId: 'a1', status: 'failed' });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    expect(inv.entries.find((e) => e.attemptId === 'a1')?.category).toBe('safe_to_recycle');

    // Condition changes AFTER inventory: new uncommitted tracked change.
    writeFileSync(path.join(wtPath, 'src', 'seed.ts'), 'export const seed = 777;\n', 'utf-8');

    const result = await svc.apply(inv, { decisionNote: 't6 test', projectRoot: fx.projectRoot });
    const applied = result.results.find((e) => e.attemptId === 'a1');
    expect(applied?.deleted).toBe(false);
    expect(existsSync(wtPath)).toBe(true);
  });

  it('T7 (hard guard): failed attempt whose branch contains an unmerged commit is NEVER recycled — branch and worktree both survive --apply', async () => {
    const fx = await makeFixture('t7');
    const { wtPath, branch } = await addAttempt(fx, { attemptId: 'a1', status: 'failed', withCommit: true });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    const e = inv.entries.find((x) => x.attemptId === 'a1');
    expect(e?.category).toBe('manual_review');
    expect(e?.unmerged).toBe(true);

    await svc.apply(inv, { decisionNote: 't7 test', projectRoot: fx.projectRoot });
    expect(existsSync(wtPath)).toBe(true);
    expect(git(['branch', '--list', branch], fx.projectRoot)).toContain('a1');
  });

  it('T8: registered worktree whose directory is gone → stale_registration category, --apply prunes the stale registration', async () => {
    const fx = await makeFixture('t8');
    const { wtPath } = await addAttempt(fx, { attemptId: 'a1', status: 'failed' });
    rmSync(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    const e = inv.entries.find((x) => x.attemptId === 'a1');
    expect(e?.category).toBe('stale_registration');

    const result = await svc.apply(inv, { decisionNote: 't8 test', projectRoot: fx.projectRoot });
    expect(result.pruned).toBe(true);
    const list = git(['worktree', 'list', '--porcelain'], fx.projectRoot);
    expect(list.toLowerCase()).not.toContain(wtPath.replace(/\\/g, '/').toLowerCase());
  });

  it('T9: --apply actually recycles a clean, terminal, merged-into-HEAD worktree and records an event', async () => {
    const fx = await makeFixture('t9');
    const { wtPath } = await addAttempt(fx, { attemptId: 'a1', status: 'failed' });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    const safe = inv.entries.filter((e) => e.category === 'safe_to_recycle');
    expect(safe).toHaveLength(1);

    const result = await svc.apply(inv, { decisionNote: 't9 test', projectRoot: fx.projectRoot });
    const applied = result.results.find((e) => e.attemptId === 'a1');
    expect(applied?.deleted).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    const events = await fx.store.listEvents(fx.runId);
    expect(events.some((ev) => ev.eventType === 'gc_recycled')).toBe(true);
  });

  it('T10: deregistered leftover directory (git fully abandoned it) is recycled via deletion fallback; directory disappears', async () => {
    const fx = await makeFixture('t10');
    const { wtPath } = await addAttempt(fx, { attemptId: 'a1', status: 'failed' });

    // Simulate the Windows leftover: git deregisters the worktree (metadata
    // removed) but the directory (and its dangling .git file) stays on disk.
    const metaDir = path.join(fx.projectRoot, '.git', 'worktrees');
    let targetMeta: string | null = null;
    for (const name of readdirSync(metaDir)) {
      const candidate = path.join(metaDir, name);
      try {
        const gitdirContent = readFileSync(path.join(candidate, 'gitdir'), 'utf-8').trim();
        if (path.resolve(gitdirContent) === path.resolve(wtPath, '.git')) targetMeta = candidate;
      } catch { /* ignore */ }
    }
    expect(targetMeta).toBeTruthy();
    rmSync(targetMeta!, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    expect(existsSync(wtPath)).toBe(true);

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    const e = inv.entries.find((x) => x.attemptId === 'a1');
    expect(e?.category).toBe('safe_to_recycle');
    expect(e?.registered).toBe(false);

    const prev = process.env.GC_RECYCLE_BIN;
    process.env.GC_RECYCLE_BIN = '0'; // deterministic permanent-delete fallback path
    try {
      await svc.apply(inv, { decisionNote: 't10 test', projectRoot: fx.projectRoot });
    } finally {
      if (prev === undefined) delete process.env.GC_RECYCLE_BIN; else process.env.GC_RECYCLE_BIN = prev;
    }
    expect(existsSync(wtPath)).toBe(false);
  });

  it('T11 (guard regression): paid-work guard compares against the run TARGET branch, not HEAD — HEAD on a branch that already contains the attempt commit must NOT make it recyclable', async () => {
    const fx = await makeFixture('t11');
    const { wtPath, branch } = await addAttempt(fx, { attemptId: 'a1', status: 'failed', withCommit: true });

    // HEAD moves to a branch that CONTAINS the attempt commit (e.g. the user is
    // sitting on the integration branch). If gc compared against HEAD, the entry
    // would look merged and be wrongly classified safe_to_recycle → real data loss.
    git(['branch', 'integration-x', branch], fx.projectRoot);
    git(['checkout', 'integration-x'], fx.projectRoot);
    try {
      const svc = new GcService(fx.store);
      const inv = await svc.inventory();
      const e = inv.entries.find((x) => x.attemptId === 'a1');
      expect(e?.unmerged).toBe(true); // commit is NOT in target branch main
      expect(e?.category).toBe('manual_review');

      await svc.apply(inv, { decisionNote: 't11 test', projectRoot: fx.projectRoot });
      expect(existsSync(wtPath)).toBe(true);
      expect(git(['branch', '--list', branch], fx.projectRoot)).toContain('a1');
    } finally {
      git(['checkout', 'main'], fx.projectRoot);
    }
  });

  it('T12: missing/unparseable run target snapshot fails closed → manual_review (never falls back to HEAD)', async () => {
    const fx = await makeFixture('t12');
    // Overwrite the run so its execution snapshot is NULL (target unknown).
    const now = new Date().toISOString();
    fx.store.getDatabase().prepare('UPDATE runs SET execution_config_snapshot = NULL WHERE id = ?').run(fx.runId);
    const { wtPath } = await addAttempt(fx, { attemptId: 'a1', status: 'failed' });

    const svc = new GcService(fx.store);
    const inv = await svc.inventory();
    const e = inv.entries.find((x) => x.attemptId === 'a1');
    expect(e?.unmerged).toBe(null);
    expect(e?.category).toBe('manual_review');

    await svc.apply(inv, { decisionNote: 't12 test', projectRoot: fx.projectRoot });
    expect(existsSync(wtPath)).toBe(true);
  });
});
