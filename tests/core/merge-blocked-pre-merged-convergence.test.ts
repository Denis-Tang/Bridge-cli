// A `merge_blocked` stage whose target branch already contains EXACTLY the
// reviewed integration tree must converge through the REAL scheduler entry
// point — not just through the coordinator helper.
//
// Reproduces the production leftover state exactly: Run running, Stage running,
// Task merge_blocked, batch conflict, claims unreleased, no active PauseRecord.
//
// Hard assertions: no Reviewer is invoked (review row count frozen), no new cost
// reservation appears, and every rejection path leaves a PauseRecord behind so
// the stage can never sit in a `running` half-state with nothing to act on.

import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';

const cleanup: string[] = [];
const stores: SqliteStateStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) { try { await store.close(); } catch { /* closed */ } }
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, command: string): string {
  return execSync(`git ${command}`, { cwd: root, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

interface Fixture {
  root: string; store: SqliteStateStore; runId: string; stageId: string; taskId: string;
  batchId: string; base: string; reviewed: string; targetHead: string;
}

/**
 * Build the exact production shape: task branch off the stage base, an
 * integration branch merging it, then main merged --no-ff so the reviewed tree
 * is already present on the target.
 */
async function setup(options: { advanceTargetAfterReview?: boolean; coverage?: 'complete' | 'partial' } = {}): Promise<Fixture> {
  const dir = path.join(tmpdir(), `bridge-mbconv-${Date.now()}-${Math.random()}`);
  const root = path.join(dir, 'project');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  cleanup.push(dir);
  git(root, 'init -b main');
  git(root, 'config user.email test@test');
  git(root, 'config user.name test');
  writeFileSync(path.join(root, '.gitignore'), '*.db\n*.db-wal\n*.db-shm\n', 'utf-8');
  writeFileSync(path.join(root, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf-8');
  git(root, 'add -A');
  git(root, 'commit -m init');
  const base = git(root, 'rev-parse HEAD');

  const runId = 'run-mbconv';
  const taskId = `${runId}-task-1`;
  const taskBranch = `brainctl/${runId}/${taskId}/a1`;
  git(root, `checkout -b ${taskBranch}`);
  writeFileSync(path.join(root, 'src', 'feature.ts'), 'export const feature = true;\n', 'utf-8');
  git(root, 'add -A');
  git(root, 'commit -m task-work');
  git(root, "rev-parse HEAD");

  const integrationBranch = `brainctl/int/${runId}/stage-1/a1`;
  git(root, `checkout -b ${integrationBranch} ${base}`);
  git(root, `merge --no-ff --no-edit -- ${taskBranch}`);
  const reviewed = git(root, 'rev-parse HEAD');

  git(root, 'checkout main');
  git(root, `merge --no-ff --no-edit -- ${integrationBranch}`);
  if (options.advanceTargetAfterReview) {
    writeFileSync(path.join(root, 'src', 'unreviewed.ts'), 'export const extra = 1;\n', 'utf-8');
    git(root, 'add -A');
    git(root, 'commit -m unreviewed-after-review');
  }
  const targetHead = git(root, 'rev-parse main');

  const dbPath = path.join(dir, 'state.db');
  const store = SqliteStateStore.create(dbPath);
  stores.push(store);
  new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();

  const now = new Date().toISOString();
  const stageId = `${runId}-stage-1`;
  const batchId = `${runId}-batch-1`;
  await store.createRun({ id: runId, projectId: 'p', projectRoot: root, requestText: 'x', status: 'running', createdAt: now, updatedAt: now });
  await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });
  await store.createTask({
    id: taskId, runId, title: 'T1', status: 'pending',
    specJson: { taskId, stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/feature.ts'], allowedPaths: ['src/'], forbiddenPaths: [] },
    createdAt: now, updatedAt: now,
  });
  await store.createAttempt({ id: `${taskId}-a1`, taskId, stageId, attemptNumber: 1, status: 'pending' });
  await store.updateAttemptResult(`${taskId}-a1`, { branchName: taskBranch, worktreePath: root });
  await store.createIntegrationBatch({ id: batchId, stageId, runId, integrationBranch, status: 'pending' } as never);

  // Drive to the exact post-failure state with raw SQL: the state machine would
  // reject some of these as illegal transitions, which is precisely the leftover
  // shape a real blocked merge leaves behind.
  const db = store.getDatabase();
  db.prepare('UPDATE stages SET status = ? WHERE id = ?').run('running', stageId);
  db.prepare('UPDATE task_attempts SET status = ? WHERE id = ?').run('approved', `${taskId}-a1`);
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('merge_blocked', taskId);
  db.prepare(`UPDATE integration_batches SET status = 'conflict', merge_commit_hash = ?, base_commit = ?,
    reviewed_through_commit = ?, review_coverage_status = ?, reviewer_unavailable = 0,
    review_metadata_json = '{"reviewer":"codex-cli"}',
    conflicts_json = '{"reason":"target_advanced_after_final_review"}' WHERE id = ?`)
    .run(reviewed, base, reviewed, options.coverage ?? 'complete', batchId);
  // Unreleased claims, exactly as the production leftover had.
  db.prepare(`INSERT INTO actual_path_claims (id, run_id, stage_id, task_id, attempt_id, file_path, normalized_path, created_at)
    VALUES (?, ?, ?, ?, ?, 'src/feature.ts', 'src/feature.ts', ?)`)
    .run(`${runId}-claim-1`, runId, stageId, taskId, `${taskId}-a1`, now);

  return { root, store, runId, stageId, taskId, batchId, base, reviewed, targetHead };
}

function schedulerFor(fixture: Fixture): StageScheduler {
  return new StageScheduler(fixture.store, {
    projectRoot: fixture.root, sessionDir: '.brainctl-dev/sessions', logDir: '.brainctl-dev/logs',
    worktreeBaseDir: '.brainctl-dev/worktrees', defaultLockedPaths: [], targetBranch: 'main',
    maxParallelTasks: 1, governanceEnabled: false,
    // No provider runners are supplied: if any Reviewer call were attempted the
    // test would fail loudly rather than silently spending a real call.
    allowRealWorker: false, allowRealReviewer: false, cleanupMergedWorktrees: false,
    qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
  } as never);
}

async function counts(store: SqliteStateStore): Promise<{ reviews: number; costs: number; activeClaims: number; activePauses: number }> {
  const db = store.getDatabase();
  const one = (sql: string): number => Number((db.prepare(sql).get() as { c: number }).c);
  return {
    reviews: one('SELECT count(*) c FROM reviews'),
    costs: one('SELECT count(*) c FROM cost_reservations'),
    activeClaims: one('SELECT count(*) c FROM actual_path_claims WHERE released_at IS NULL'),
    activePauses: one('SELECT count(*) c FROM pause_records WHERE resolved_at IS NULL'),
  };
}

describe('merge_blocked stage convergence when target already holds the reviewed tree', () => {
  it('converges through the real scheduler entry point without re-reviewing', async () => {
    const fixture = await setup();
    const before = await counts(fixture.store);
    expect(before.activeClaims).toBe(1);

    await schedulerFor(fixture).startRun(fixture.runId);

    const stage = (await fixture.store.listStages(fixture.runId))[0];
    const task = await fixture.store.getTask(fixture.taskId);
    const batch = (await fixture.store.listIntegrationBatches(fixture.stageId))[0];
    expect(stage.status).toBe('completed');
    expect(task?.status).toBe('merged');
    expect(batch.status).toBe('completed');
    // The pre-existing target tip is adopted; no second merge commit is created.
    expect(batch.targetMergeCommit).toBe(fixture.targetHead);
    expect(git(fixture.root, 'rev-parse main')).toBe(fixture.targetHead);

    const after = await counts(fixture.store);
    expect(after.reviews, 'no Reviewer may be invoked').toBe(before.reviews);
    expect(after.costs, 'no new cost reservation may appear').toBe(before.costs);
    expect(after.activeClaims, 'claims must be released').toBe(0);

    const events = await fixture.store.listEvents(fixture.runId, 'integration_completed');
    const converged = events.find((event) => (event.eventDataJson || '').includes('merge_blocked_converged'));
    expect(converged, 'convergence must be audited').toBeDefined();
    expect(converged!.eventDataJson).toContain('"reviewerReused":true');
  });

  it('refuses to converge and records a PauseRecord when unreviewed work landed after the review', async () => {
    const fixture = await setup({ advanceTargetAfterReview: true });
    const before = await counts(fixture.store);

    await schedulerFor(fixture).startRun(fixture.runId);

    const stage = (await fixture.store.listStages(fixture.runId))[0];
    const task = await fixture.store.getTask(fixture.taskId);
    expect(stage.status).not.toBe('completed');
    expect(task?.status).toBe('merge_blocked');

    const after = await counts(fixture.store);
    expect(after.reviews).toBe(before.reviews);
    // The core regression: a rejection must never leave a running half-state
    // with nothing for the operator to act on.
    expect(after.activePauses, 'a rejection must leave an actionable PauseRecord').toBeGreaterThan(0);

    const db = fixture.store.getDatabase();
    const pause = db.prepare("SELECT reason_code FROM pause_records WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 1").get() as { reason_code: string };
    expect(pause.reason_code).toBe('merge_blocked_tasks_block_integration');
  });

  it('refuses to converge when the batch review coverage is only partial', async () => {
    const fixture = await setup({ coverage: 'partial' });
    const before = await counts(fixture.store);

    await schedulerFor(fixture).startRun(fixture.runId);

    const task = await fixture.store.getTask(fixture.taskId);
    expect(task?.status).toBe('merge_blocked');
    const after = await counts(fixture.store);
    expect(after.reviews).toBe(before.reviews);
    expect(after.activePauses).toBeGreaterThan(0);
  });
});
