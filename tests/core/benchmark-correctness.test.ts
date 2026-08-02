// ── Correctness Benchmark v3 — Red Team Edition ──────────────────────────
// Every integration conflict, paused stage, waiting_decision, or incomplete
// task MUST fail. No tolerance for "mostly green but paused" = PASS.
// This benchmark intentionally uses the CONFLICT_DAG (T1 + T6 both write src/a.ts)
// to prove the scheduler currently CANNOT handle same-file conflicts safely.
//
// 正确性标准:
//   run='completed' && 所有 stage='completed' && 所有 task='merged' && 目标分支内容逐个正确
//   任何 paused / waiting_decision / conflict / failed / 残留 merge state → FAIL

import { describe, it, expect } from 'vitest';
import {
  setupBenchmark, teardownBenchmark, assertRunFullyCompleted, assertRunPausedOrFailed,
  verifyTargetBranchFile, assertOverlap, assertDependsAfterAll, assertNoOverlap,
  runRepeated, runSequentialBaseline,
  CONFLICT_DAG, CORRECT_DAG, STRESS_DAG, PI_DELAY_MS, taskContent,
} from '../helpers/benchmark-fixtures.js';

describe('BENCH-CORRECTNESS — Conflict-Free DAG (6-10 tasks)', () => {
  const ITERATIONS = 3;

  it('CORR-01: conflict-free 8-task DAG must reach full completion', { timeout: 60000 }, async () => {
    const results = await runRepeated(ITERATIONS, async (iter) => {
      const ctx = await setupBenchmark(CORRECT_DAG, 4, `corr01-${iter}`);
      const start = Date.now();
      try {
        await ctx.scheduler.startRun(ctx.runId);
      } catch { /* scheduler may throw — that's also a failure signal */ }
      const wallMs = Date.now() - start;

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const merged = tasks.filter(t => t.status === 'merged').length;

      // Must be fully completed
      const succeeded = run?.status === 'completed' &&
        tasks.every(t => t.status === 'merged');

      if (succeeded) {
        // Verify target branch content for every task
        for (const t of tasks) {
          const spec = t.specJson as { estimatedWritePaths?: string[] } | null;
          const file = spec?.estimatedWritePaths?.[0];
          if (file) {
            const ok = verifyTargetBranchFile(ctx.projectRoot, file, t.id);
            expect(ok, `target branch content for ${t.id} (${file})`).toBe(true);
          }
        }
      }

      return { ctx, wallMs, succeeded, runStatus: run?.status || '?', stageStatus: '?', mergedTasks: merged, totalTasks: tasks.length };
    });

    console.log(`[CORR-01] Pass rate: ${(results.passRate * 100).toFixed(0)}% over ${ITERATIONS} runs`);
    console.log(`  Wall: median=${results.medians.wallMs}ms, range=[${results.ranges.wallMin}-${results.ranges.wallMax}]ms`);
    console.log(`  Merged: median=${results.medians.mergedTasks}, range=[${results.ranges.mergedMin}-${results.ranges.mergedMax}]`);

    // For a correct DAG, pass rate should be 1.0
    expect(results.passRate, 'correct DAG must pass all iterations').toBe(1.0);

    // All results should've merged all 8 tasks
    expect(results.medians.mergedTasks).toBe(8);
  });

  it('CORR-02: 10-task stress DAG must reach full completion', { timeout: 90000 }, async () => {
    let succeeded = false;
    const ctx = await setupBenchmark(STRESS_DAG, 6, `corr02`);
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const merged = tasks.filter(t => t.status === 'merged').length;

      succeeded = run?.status === 'completed' && tasks.every(t => t.status === 'merged');

      if (succeeded) {
        for (const t of tasks) {
          const spec = t.specJson as { estimatedWritePaths?: string[] } | null;
          const file = spec?.estimatedWritePaths?.[0];
          if (file) {
            expect(verifyTargetBranchFile(ctx.projectRoot, file, t.id),
              `target content for ${t.id}`).toBe(true);
          }
        }
      }

      console.log(`[CORR-02] Succeeded: ${succeeded}, Pi calls: ${ctx.piRunner.calls}, Codex calls: ${ctx.codexRunner.calls}, Merged: ${merged}/${tasks.length}`);
    } finally {
      await teardownBenchmark(ctx);
    }

    expect(succeeded, '10-task DAG must complete').toBe(true);
  });
});

describe('BENCH-CORRECTNESS — Conflict DAG Must FAIL', () => {
  it('CORR-03: T1+T6 same-file conflict MUST prevent full completion', { timeout: 60000 }, async () => {
    // This is the KEY assertion from P0-5: the conflict DAG must NOT pass.
    const results = await runRepeated(3, async (iter) => {
      const ctx = await setupBenchmark(CONFLICT_DAG, 6, `corr03-${iter}`);
      const start = Date.now();
      try {
        await ctx.scheduler.startRun(ctx.runId);
      } catch { /* scheduler may throw */ }
      const wallMs = Date.now() - start;

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const merged = tasks.filter(t => t.status === 'merged').length;

      // KEY: run must NOT be completed when conflict DAG exists
      const correctlyFailed = run?.status !== 'completed';

      return {
        ctx, wallMs,
        succeeded: correctlyFailed, // "succeeded" = benchmark correctly detected failure
        runStatus: run?.status || '?',
        stageStatus: '?',
        mergedTasks: merged,
        totalTasks: tasks.length,
      };
    });

    console.log(`[CORR-03] Conflict detection: ${(results.passRate * 100).toFixed(0)}% correctly failed`);
    console.log(`  Run statuses: ${results.allResults.map(r => r.runStatus).join(', ')}`);
    console.log(`  Merged tasks median: ${results.medians.mergedTasks} (should NOT be ${CONFLICT_DAG.length})`);

    // The benchmark should ALWAYS detect that conflict DAG fails
    expect(results.passRate, 'conflict DAG must NOT complete — every iteration should detect failure').toBe(1.0);

    // Not all tasks should be merged
    expect(results.medians.mergedTasks).toBeLessThan(CONFLICT_DAG.length);
  });

  it('CORR-04: T1+T6 serialized but integration should detect conflict', { timeout: 60000 }, async () => {
    // Even though T1 and T6 might serialize due to path locks,
    // the integration phase should detect the same-file merge conflict.
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'corr04');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);

      // T1 and T6 both write src/a.ts → integration MUST conflict
      const t1 = tasks.find(t => t.id === 'T1');
      const t6 = tasks.find(t => t.id === 'T6');

      // At minimum, the run should not be completed
      const notCompleted = run?.status !== 'completed';
      // And at least one stage should be paused or failed
      const hasNonCompletedStage = stages.some(s =>
        s.status === 'paused' || s.status === 'failed' || s.status === 'integration',
      );

      console.log(`[CORR-04] Run: ${run?.status}, Stage: ${stages.map(s => `${s.stageNumber}=${s.status}`).join(', ')}`);
      console.log(`  T1: ${t1?.status}, T6: ${t6?.status}`);

      // If the run completed, that's the P0-5 bug — all 7/7 benchmarks passing despite conflict
      expect(run?.status, 'RUN MUST NOT BE COMPLETED when T1+T6 write same file').not.toBe('completed');

      // At least one stage should show the problem
      expect(hasNonCompletedStage, 'at least one stage must be paused/failed/integration').toBe(true);
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

describe('BENCH-CORRECTNESS — Completion Invariants', () => {
  it('CORR-05: all tasks must be "merged" (not just "approved") before run=completed', { timeout: 60000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'corr05');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      if (run?.status === 'completed') {
        const tasks = await ctx.store.listTasks(ctx.runId);
        for (const task of tasks) {
          expect(
            task.status,
            `task ${task.id} must be 'merged' when run is 'completed', got '${task.status}'`,
          ).toBe('merged');
        }
      }

      // Additionally: no task should be stuck in 'approved' without 'merged'
      const approvedButNotMerged = (await ctx.store.listTasks(ctx.runId))
        .filter(t => t.status === 'approved');
      expect(approvedButNotMerged.length, 'no tasks should be approved but not merged at completion').toBe(0);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('CORR-06: run must not be "completed" if any stage is "paused"', { timeout: 60000 }, async () => {
    // Use CONFLICT_DAG which is expected to produce a paused stage.
    // Verify the invariant: a run with any paused stage must NOT be marked "completed".
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'corr06');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);

      const pausedStages = stages.filter(s => s.status === 'paused');
      console.log(`[CORR-06] Paused stages: ${pausedStages.length}, Run status: ${run?.status}`);

      expect(pausedStages, 'conflict DAG must pause its stage').toHaveLength(1);
      expect(run?.status, 'run with paused stages must not be completed').not.toBe('completed');

      // The corrected scheduler rejects undeclared same-path tasks before any
      // worker spawn. A zero-attempt pause is valid only with that explicit evidence.
      const allAttempts = await ctx.store.listAttemptsByStage(pausedStages[0].id);
      expect(allAttempts, 'pre-spawn conflict must create no attempts').toHaveLength(0);
      expect(ctx.piRunner.calls, 'pre-spawn conflict must call no worker').toBe(0);
      expect(await ctx.store.getActivePauseForStage(pausedStages[0].id)).toMatchObject({
        reasonCode: 'declared_write_conflict_missing_dependency',
      });
      const pausedEvents = await ctx.store.listEvents(ctx.runId, 'stage_paused');
      expect(pausedEvents.some((event) => event.eventDataJson?.includes('declared_preventable')))
        .toBe(true);

      // If run IS completed (shouldn't happen with CONFLICT_DAG), then ALL non-canceled stages must be completed
      if (run?.status === 'completed') {
        for (const stage of stages) {
          if (stage.status !== 'canceled') {
            expect(stage.status, `stage ${stage.stageNumber} status`).toBe('completed');
          }
        }
        // Also verify no paused stage exists if run completed
        expect(pausedStages.length, 'completed run must have zero paused stages').toBe(0);
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});
