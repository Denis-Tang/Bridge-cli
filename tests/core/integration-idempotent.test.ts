// ── R4: integrate() idempotent entry — no duplicate paid stage review ─────
// Simulates a crash after batch-completed but before stage-completed by
// hand-crafting the DB state, then re-running the scheduler. Fake providers +
// disposable git repos only. Hard assertions: stage-review runner call count
// stays 0 and batch count does not grow on the idempotent path.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CORRECT_DAG, setupBenchmark, teardownBenchmark, type BenchmarkContext } from '../helpers/benchmark-fixtures.js';

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch (err: any) {
    if (err.stdout) return err.stdout.toString().trim();
    if (err.stderr) return err.stderr.toString().trim();
    throw err;
  }
}

/** Commit directly on the target branch (simulates the merge already landed). */
function makeMergeCommitOnTarget(ctx: BenchmarkContext, label: string): string {
  writeFileSync(path.join(ctx.projectRoot, 'src', `r4-${label}.ts`), `export const ${label} = true;\n`, 'utf-8');
  git(['add', '-A'], ctx.projectRoot);
  git(['commit', '-m', `r4-${label}`], ctx.projectRoot);
  return git(['rev-parse', 'HEAD'], ctx.projectRoot);
}

/** Create a commit on a throwaway branch that is NOT an ancestor of main. */
function makeOrphanCommit(ctx: BenchmarkContext, label: string): string {
  git(['checkout', '-b', `r4-orphan-${label}`], ctx.projectRoot);
  writeFileSync(path.join(ctx.projectRoot, 'src', `r4-orphan-${label}.ts`), 'x\n', 'utf-8');
  git(['add', '-A'], ctx.projectRoot);
  git(['commit', '-m', `orphan-${label}`], ctx.projectRoot);
  const hash = git(['rev-parse', 'HEAD'], ctx.projectRoot);
  git(['checkout', 'main'], ctx.projectRoot);
  return hash;
}

/** Create real attempt branches (with a commit each) so the FULL integration
 *  path (stage review) can actually run — needed for the NOT-idempotent cases. */
function makeAttemptBranches(ctx: BenchmarkContext, taskCount: number): void {
  for (let i = 0; i < taskCount; i++) {
    const tid = CORRECT_DAG[i].taskId;
    const branch = `brainctl/${ctx.runId}/${tid}/a1`;
    git(['checkout', '-b', branch, 'main'], ctx.projectRoot);
    writeFileSync(path.join(ctx.projectRoot, 'src', `r4-${tid}.ts`), `export const ${tid} = 1;
`, 'utf-8');
    git(['add', '-A'], ctx.projectRoot);
    git(['commit', '-m', `r4-${tid}`], ctx.projectRoot);
    void ctx.store.updateAttemptResult(`${tid}-a1`, { branchName: branch });
  }
  git(['checkout', 'main'], ctx.projectRoot);
}

interface CrashStateOptions {
  taskCount: number;
  mergedCount: number; // tasks already merged at the crash point (step-5 mid-loop)
  targetMergeCommit: string;
  reviewCoverageStatus?: 'complete' | 'partial';
  reviewerUnavailable?: boolean;
  addResidualWorktree?: boolean;
  extraCompletedBatch?: { createdAt: string; targetMergeCommit: string } | null;
}

/** Hand-craft the post-crash DB state: stage still `integration`, batch `completed`. */
async function setupCrashState(ctx: BenchmarkContext, opts: CrashStateOptions): Promise<{ batchId: string }> {
  const now = new Date().toISOString();
  const { store, runId, stageId } = ctx;
  // Crash state is mid-flight: use raw SQL to simulate the exact DB state left
  // behind by a crash (the state machine would reject these as illegal transitions,
  // which is precisely why the crash point is dangerous).
  store.getDatabase().prepare('UPDATE stages SET status = ? WHERE id = ?').run('integration', stageId);
  for (let i = 0; i < opts.taskCount; i++) {
    const tid = CORRECT_DAG[i].taskId;
    await store.createAttempt({ id: `${tid}-a1`, taskId: tid, stageId, attemptNumber: 1, status: 'approved' });
    store.getDatabase().prepare('UPDATE tasks SET status = ? WHERE id = ?')
      .run(i < opts.mergedCount ? 'merged' : 'approved', tid);
  }
  const batch = await store.createIntegrationBatch({
    id: `${runId}-batch-${stageId}-a1`, stageId, runId,
    integrationBranch: `brainctl/int/${runId}/stage-1/a1`,
  });
  await store.updateIntegrationBatch(batch.id, {
    status: 'completed',
    targetMergeCommit: opts.targetMergeCommit,
    mergeCommitHash: opts.targetMergeCommit,
    finalCommit: opts.targetMergeCommit,
    reviewCoverageStatus: opts.reviewCoverageStatus ?? 'complete',
    reviewerUnavailable: opts.reviewerUnavailable ?? false,
  });
  if (opts.extraCompletedBatch) {
    const b2 = await store.createIntegrationBatch({
      id: `${runId}-batch-${stageId}-a2`, stageId, runId,
      integrationBranch: `brainctl/int/${runId}/stage-1/a2`,
    });
    store.getDatabase().prepare('UPDATE integration_batches SET created_at = ? WHERE id = ?')
      .run(opts.extraCompletedBatch.createdAt, b2.id);
    await store.updateIntegrationBatch(b2.id, {
      status: 'completed',
      targetMergeCommit: opts.extraCompletedBatch.targetMergeCommit,
      mergeCommitHash: opts.extraCompletedBatch.targetMergeCommit,
      finalCommit: opts.extraCompletedBatch.targetMergeCommit,
      reviewCoverageStatus: 'complete',
      reviewerUnavailable: false,
    });
  }
  if (opts.addResidualWorktree) {
    const tid = CORRECT_DAG[0].taskId;
    const branch = `brainctl/${runId}/${tid}/a1`;
    const wtPath = path.join(ctx.projectRoot, '.brainctl-dev', 'worktrees', runId, tid, 'a1');
    mkdirSync(path.dirname(wtPath), { recursive: true });
    git(['branch', branch, 'main'], ctx.projectRoot);
    git(['worktree', 'add', wtPath, branch], ctx.projectRoot);
    await store.updateAttemptResult(`${tid}-a1`, { worktreePath: wtPath, branchName: branch });
  }
  return { batchId: batch.id };
}

describe('R4 integrate() idempotent entry', () => {
  it('T1: zero tasks merged at crash — recovery completes without re-review and without a new batch', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t1');
    try {
      const commit = makeMergeCommitOnTarget(ctx, 't1');
      await setupCrashState(ctx, { taskCount: 1, mergedCount: 0, targetMergeCommit: commit });
      const batchesBefore = (await ctx.store.listIntegrationBatches(ctx.stageId)).length;

      await ctx.scheduler.startRun(ctx.runId);

      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('completed');
      const [task] = await ctx.store.listTasksByStage(ctx.stageId);
      expect(task.status).toBe('merged');
      expect(ctx.codexRunner.calls).toBe(0); // stage review must NOT re-run (paid!)
      expect((await ctx.store.listIntegrationBatches(ctx.stageId)).length).toBe(batchesBefore); // no new batch
    } finally { await teardownBenchmark(ctx); }
  });

  it('T2 (reachability trap): half tasks already merged at crash — recovery is REACHABLE and completes, review 0 calls', async () => {
    const ctx = await setupBenchmark(CORRECT_DAG.slice(0, 2), 2, 'r4-t2');
    try {
      const commit = makeMergeCommitOnTarget(ctx, 't2');
      await setupCrashState(ctx, { taskCount: 2, mergedCount: 1, targetMergeCommit: commit });

      await ctx.scheduler.startRun(ctx.runId);

      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('completed');
      const tasks = await ctx.store.listTasksByStage(ctx.stageId);
      expect(tasks.every((t) => t.status === 'merged')).toBe(true);
      expect(ctx.codexRunner.calls).toBe(0);
      expect((await ctx.store.listIntegrationBatches(ctx.stageId)).length).toBe(1);
    } finally { await teardownBenchmark(ctx); }
  });

  it('T3: no duplicate merge commit — target branch commit count unchanged by recovery', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t3');
    try {
      const commit = makeMergeCommitOnTarget(ctx, 't3');
      await setupCrashState(ctx, { taskCount: 1, mergedCount: 0, targetMergeCommit: commit });
      const commitsBefore = Number(git(['rev-list', '--count', 'main'], ctx.projectRoot));

      await ctx.scheduler.startRun(ctx.runId);

      const commitsAfter = Number(git(['rev-list', '--count', 'main'], ctx.projectRoot));
      expect(commitsAfter).toBe(commitsBefore);
    } finally { await teardownBenchmark(ctx); }
  });

  it('T4 (hard guard): git evidence fails (commit not on target) → fail closed, no re-integration, stage paused', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t4');
    try {
      const orphan = makeOrphanCommit(ctx, 't4');
      await setupCrashState(ctx, { taskCount: 1, mergedCount: 0, targetMergeCommit: orphan });

      await ctx.scheduler.startRun(ctx.runId);

      const stage = await ctx.store.getStage(ctx.stageId);
      expect(stage?.status).toBe('paused'); // not completed, not silently re-run
      const pause = await ctx.store.getActivePauseForStage(ctx.stageId);
      expect(pause?.reasonCode).toBe('integration_state_inconsistent');
      expect(ctx.codexRunner.calls).toBe(0); // integration not re-run
      expect((await ctx.store.listIntegrationBatches(ctx.stageId)).length).toBe(1);
    } finally { await teardownBenchmark(ctx); }
  });

  it('T5: reviewCoverageStatus partial → NOT idempotent, full path runs (review really happens)', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t5');
    try {
      const commit = makeMergeCommitOnTarget(ctx, 't5');
      await setupCrashState(ctx, { taskCount: 1, mergedCount: 0, targetMergeCommit: commit, reviewCoverageStatus: 'partial' });
      makeAttemptBranches(ctx, 1);

      await ctx.scheduler.startRun(ctx.runId);

      expect(ctx.codexRunner.calls).toBeGreaterThan(0); // review MUST run
    } finally { await teardownBenchmark(ctx); }
  });

  it('T6: reviewerUnavailable true → NOT idempotent, full path runs', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t6');
    try {
      const commit = makeMergeCommitOnTarget(ctx, 't6');
      await setupCrashState(ctx, { taskCount: 1, mergedCount: 0, targetMergeCommit: commit, reviewerUnavailable: true });
      makeAttemptBranches(ctx, 1);

      await ctx.scheduler.startRun(ctx.runId);

      expect(ctx.codexRunner.calls).toBeGreaterThan(0);
    } finally { await teardownBenchmark(ctx); }
  });

  it('T7: targetMergeCommit null → NOT idempotent, full path runs', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t7');
    try {
      makeMergeCommitOnTarget(ctx, 't7');
      await setupCrashState(ctx, { taskCount: 1, mergedCount: 0, targetMergeCommit: '' });
      // force the batch's targetMergeCommit to null
      ctx.store.getDatabase().prepare('UPDATE integration_batches SET target_merge_commit = NULL WHERE stage_id = ?').run(ctx.stageId);
      makeAttemptBranches(ctx, 1);

      await ctx.scheduler.startRun(ctx.runId);

      expect(ctx.codexRunner.calls).toBeGreaterThan(0);
    } finally { await teardownBenchmark(ctx); }
  });

  it('T8: idempotent path still cleans residual worktrees and brainctl/* branches', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t8');
    try {
      const commit = makeMergeCommitOnTarget(ctx, 't8');
      await setupCrashState(ctx, { taskCount: 1, mergedCount: 0, targetMergeCommit: commit, addResidualWorktree: true });
      const wtPath = path.join(ctx.projectRoot, '.brainctl-dev', 'worktrees', ctx.runId, CORRECT_DAG[0].taskId, 'a1');
      expect(existsSync(wtPath)).toBe(true);

      await ctx.scheduler.startRun(ctx.runId);

      expect(existsSync(wtPath)).toBe(false); // residual worktree cleaned
      expect(git(['branch', '--list', `brainctl/${ctx.runId}/${CORRECT_DAG[0].taskId}/a1`], ctx.projectRoot)).toBe('');
      expect(ctx.codexRunner.calls).toBe(0);
    } finally { await teardownBenchmark(ctx); }
  });

  it('T9 (regression): batch status failed/conflict/integrating → behavior unchanged (new batch, normal retry)', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t9');
    try {
      makeMergeCommitOnTarget(ctx, 't9');
      const now = new Date().toISOString();
      ctx.store.getDatabase().prepare('UPDATE stages SET status = ? WHERE id = ?').run('integration', ctx.stageId);
      await ctx.store.createAttempt({ id: 'T1-a1', taskId: CORRECT_DAG[0].taskId, stageId: ctx.stageId, attemptNumber: 1, status: 'approved' });
      ctx.store.getDatabase().prepare('UPDATE tasks SET status = ? WHERE id = ?').run('approved', CORRECT_DAG[0].taskId);
      const b1 = await ctx.store.createIntegrationBatch({
        id: `${ctx.runId}-batch-${ctx.stageId}-a1`, stageId: ctx.stageId, runId: ctx.runId,
        integrationBranch: `brainctl/int/${ctx.runId}/stage-1/a1`,
      });
      await ctx.store.updateIntegrationBatch(b1.id, { status: 'failed', conflictsJson: '{}' });

      await ctx.scheduler.startRun(ctx.runId);

      // A NEW batch was created (normal retry path), not blocked by idempotency.
      expect((await ctx.store.listIntegrationBatches(ctx.stageId)).length).toBeGreaterThanOrEqual(2);
    } finally { await teardownBenchmark(ctx); }
  });

  it('T10: multiple completed batches → the LATEST (by createdAt) drives the decision', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'r4-t10');
    try {
      const good = makeMergeCommitOnTarget(ctx, 't10a');
      const orphan = makeOrphanCommit(ctx, 't10b');
      // Latest batch (newer createdAt) has the orphan commit → must fail closed.
      await setupCrashState(ctx, {
        taskCount: 1, mergedCount: 0, targetMergeCommit: good,
        extraCompletedBatch: { createdAt: new Date(Date.now() + 10_000).toISOString(), targetMergeCommit: orphan },
      });

      await ctx.scheduler.startRun(ctx.runId);

      const stage = await ctx.store.getStage(ctx.stageId);
      expect(stage?.status).toBe('paused'); // decided by the LATEST (orphan) batch → fail closed
      expect((await ctx.store.getActivePauseForStage(ctx.stageId))?.reasonCode).toBe('integration_state_inconsistent');
    } finally { await teardownBenchmark(ctx); }
  });
});
