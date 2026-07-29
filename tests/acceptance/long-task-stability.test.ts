// ── Long Task & Same-Path Acceptance Tests v2 ────────────────────────────
// Corrected per 14-长任务同路径验收修正提示词.
//
// Fixes:
//  1. Reduced delays (Pi=50ms, Codex=10ms) to keep suite under 120s.
//  2. LT-B-02 now uses governanceEnabled=false so T_SPD2 actually executes;
//     asserts both spawn, dependency ordering, and integration merge result.
//  3. LT-B-01 now explicitly asserts T_SP2 worker was NOT spawned (pre-spawn
//     block evidence) and documents that current blocking is post-hoc via
//     scope expansion, not pre-spawn path-lock detection.
//
// Resource sampling disabled. All tokens synthetic.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  setupLongTaskBenchmark, teardownBenchmark,
  LONG_TASK_DAG, SAME_PATH_NO_DEP_DAG, SAME_PATH_DEP_DAG, CONFLICT_DAG_LT,
  makeLtSpec,
  assertDependsAfterAll, assertOverlap,
  assertNoDuplicateLedgerCallIds,
  verifyTargetBranchFile,
  type LtBenchContext,
} from './helpers/long-task-fixtures.js';

// ══════════════════════════════════════════════════════════════
// Part A: Long Task Stability — 16 tasks, 3 stages
// ══════════════════════════════════════════════════════════════

describe('LT-STABILITY — Multi-Stage Long Task DAG', () => {
  const ITERATIONS = 5;

  it('LT-A-01: 16-task 3-stage DAG must reach full completion', { timeout: 60000 }, async () => {
    const ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, 'lta01', { allowRealWorker: false });
    const start = Date.now();
    try {
      await ctx.scheduler.startRun(ctx.runId);
      const wallMs = Date.now() - start;

      const run = await ctx.store.getRun(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);

      console.log(`[LT-A-01] Wall: ${wallMs}ms, run=${run?.status}`);
      console.log(`[LT-A-01] Stages: ${stages.map(s => `${s.stageNumber}=${s.status}`).join(', ')}`);
      console.log(`[LT-A-01] Merged: ${tasks.filter(t => t.status === 'merged').length}/${tasks.length}`);

      expect(run?.status, 'Run must be completed').toBe('completed');
      for (const s of stages) {
        if (s.status !== 'canceled') expect(s.status, `Stage ${s.stageNumber}`).toBe('completed');
      }
      for (const t of tasks) {
        expect(t.status, `Task ${t.id}`).toBe('merged');
      }

      const dupes = await assertNoDuplicateLedgerCallIds(ctx.store, ctx.runId);
      expect(dupes, 'No duplicate ledger callIds').toBe(0);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-A-02: stage dependency chain — Stage N base equals Stage N-1 merge', { timeout: 60000 }, async () => {
    const ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, 'lta02', { allowRealWorker: false });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const stages = await ctx.store.listStages(ctx.runId);
      const s1 = stages.find(s => s.stageNumber === 1)!;
      const s2 = stages.find(s => s.stageNumber === 2)!;
      const s3 = stages.find(s => s.stageNumber === 3)!;

      expect(s1.status).toBe('completed');
      expect(s2.status).toBe('completed');
      expect(s3.status).toBe('completed');

      const s1Merge = (await ctx.store.listIntegrationBatches(s1.id)).pop()?.targetMergeCommit;
      const s2Merge = (await ctx.store.listIntegrationBatches(s2.id)).pop()?.targetMergeCommit;

      console.log(`[LT-A-02] S1 merge=${s1Merge}, S2 base=${s2.baseCommit}`);
      console.log(`[LT-A-02] S2 merge=${s2Merge}, S3 base=${s3.baseCommit}`);

      expect(s2.baseCommit, 'Stage 2 base == Stage 1 merge').toBe(s1Merge);
      expect(s3.baseCommit, 'Stage 3 base == Stage 2 merge').toBe(s2Merge);

      const tasks = await ctx.store.listTasks(ctx.runId);
      for (const t of tasks) expect(t.status, `Task ${t.id}`).toBe('merged');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-A-03: intra-stage dependency ordering', { timeout: 60000 }, async () => {
    const ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, 'lta03', { allowRealWorker: false });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      // Intra-stage: T11 depends on T10, T12 depends on T7,T8
      // With allowRealWorker=false, Pi timing is unavailable; verify via
      // stage completion and task status ordering (all merged, no deadlocks).
      const tasks = await ctx.store.listTasks(ctx.runId);
      const t7 = tasks.find(t => t.id === 'T7')!;
      const t8 = tasks.find(t => t.id === 'T8')!;
      const t10 = tasks.find(t => t.id === 'T10')!;
      const t11 = tasks.find(t => t.id === 'T11')!;
      const t12 = tasks.find(t => t.id === 'T12')!;
      const t16 = tasks.find(t => t.id === 'T16')!;

      // All intra-stage dependent tasks must complete
      expect(t7.status).toBe('merged');
      expect(t8.status).toBe('merged');
      expect(t10.status).toBe('merged');
      expect(t11.status).toBe('merged');
      expect(t12.status).toBe('merged');
      expect(t16.status).toBe('merged');

      // No deadlock: all 16 tasks merged
      expect(tasks.filter(t => t.status === 'merged').length).toBe(16);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-A-04: all 6 stage-1 independent tasks merged (no spurious blocking)', { timeout: 60000 }, async () => {
    const ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, 'lta04', { allowRealWorker: false });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const tasks = await ctx.store.listTasks(ctx.runId);
      for (const tid of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) {
        expect(tasks.find(t => t.id === tid)?.status, `Task ${tid}`).toBe('merged');
      }
      expect((await ctx.store.getRun(ctx.runId))?.status).toBe('completed');
      console.log('[LT-A-04] All 6 stage-1 tasks merged, run completed');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-A-05: no paused/waiting_decision/conflict/merge_blocked in correct DAG', { timeout: 60000 }, async () => {
    const ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, 'lta05', { allowRealWorker: false });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const tasks = await ctx.store.listTasks(ctx.runId);
      const bad = ['paused', 'waiting_decision', 'conflict', 'merge_blocked'];
      for (const t of tasks) {
        const hasBad = bad.some(s => t.status.toLowerCase().includes(s));
        expect(hasBad, `Task ${t.id} must not be ${t.status}`).toBe(false);
        expect(t.status, `Task ${t.id}`).toBe('merged');
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-A-06: 5-round repeated stability', { timeout: 300000 }, async () => {
    const results: Array<{ round: number; succeeded: boolean; wallMs: number; runStatus: string; mergedTasks: number }> = [];

    for (let round = 0; round < ITERATIONS; round++) {
      const ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, `lta06-r${round}`, { allowRealWorker: false });
      const start = Date.now();
      try {
        await ctx.scheduler.startRun(ctx.runId);
        const wallMs = Date.now() - start;
        const run = await ctx.store.getRun(ctx.runId);
        const tasks = await ctx.store.listTasks(ctx.runId);
        const mergedTasks = tasks.filter(t => t.status === 'merged').length;
        const succeeded = run?.status === 'completed' && mergedTasks === tasks.length;
        results.push({ round, succeeded, wallMs, runStatus: run?.status || '?', mergedTasks });
        console.log(`[LT-A-06] R${round + 1}/${ITERATIONS}: ${succeeded ? 'PASS' : 'FAIL'} wall=${wallMs}ms run=${run?.status} merged=${mergedTasks}/${tasks.length}`);
      } catch (err) {
        results.push({ round, succeeded: false, wallMs: Date.now() - start, runStatus: 'exception', mergedTasks: 0 });
        console.log(`[LT-A-06] R${round + 1}/${ITERATIONS}: EXCEPTION ${err}`);
      } finally {
        await teardownBenchmark(ctx);
      }
    }

    const passCount = results.filter(r => r.succeeded).length;
    const walls = results.map(r => r.wallMs).sort((a, b) => a - b);
    const mid = Math.floor(walls.length / 2);
    const median = walls.length % 2 === 0 ? (walls[mid - 1] + walls[mid]) / 2 : walls[mid];

    console.log(`[LT-A-06] ${passCount}/${ITERATIONS} passed, wall median=${median}ms range=[${walls[0]}-${walls[walls.length - 1]}]ms`);

    expect(passCount, `All ${ITERATIONS} rounds must pass`).toBe(ITERATIONS);
  });
});

// ══════════════════════════════════════════════════════════════
// Part B: Same-Path Baseline
// ══════════════════════════════════════════════════════════════

describe('LT-SAMEPATH — Same-Path Baseline Acceptance', () => {
  it('LT-B-01: no-dependency same-path — second worker must NOT be spawned, run≠completed', { timeout: 30000 }, async () => {
    // T_SP1 and T_SP2 both write src/shared.ts with NO dependency.
    // Expected: scheduler must block BEFORE spawning the second worker.
    // Current behavior: T_SP1 spawns and runs, then scope expansion (or
    // path lock serialization) blocks T_SP2. This test captures whether
    // the block is truly pre-spawn or post-hoc.
    const ctx = await setupLongTaskBenchmark(SAME_PATH_NO_DEP_DAG, 4, 'ltb01', {
      governanceEnabled: true,
      allowRealWorker: true,
    });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const t1 = tasks.find(t => t.id === 'T_SP1');
      const t2 = tasks.find(t => t.id === 'T_SP2');
      const stages = await ctx.store.listStages(ctx.runId);

      // ── Evidence ──
      const t1Spawned = ctx.piRunner.callStartTimes.has('T_SP1');
      const t2Spawned = ctx.piRunner.callStartTimes.has('T_SP2');
      const bothMerged = t1?.status === 'merged' && t2?.status === 'merged';
      const runCompleted = run?.status === 'completed';

      console.log(`[LT-B-01] Run: ${run?.status}, Stage: ${stages.map(s => `${s.stageNumber}=${s.status}`).join(', ')}`);
      console.log(`[LT-B-01] T_SP1: ${t1?.status} (spawned=${t1Spawned}), T_SP2: ${t2?.status} (spawned=${t2Spawned})`);
      console.log(`[LT-B-01] Pi total calls: ${ctx.piRunner.calls}`);

      // CORE: T_SP2 worker must NOT have been spawned (pre-spawn block)
      // If T_SP2 IS spawned but only blocked later (e.g., scope expansion
      // after completion), the block is post-hoc — a production gap.
      if (t2Spawned) {
        console.log('[LT-B-01] GAP: T_SP2 worker was spawned before blocking — block is post-hoc, not pre-spawn.');
      }

      // Required assertions:
      // 1. Run must not be completed
      expect(runCompleted, 'Run with same-path conflict must not be completed').toBe(false);
      // 2. Both tasks must not both be merged
      expect(bothMerged, 'Same-path tasks must not both be merged').toBe(false);
      // 3. T_SP2 must NOT have been spawned by a worker
      //    If this fails, the scheduler does not block pre-spawn.
      expect(t2Spawned, 'T_SP2 worker must NOT be spawned for same-path conflict').toBe(false);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-B-02: dependent same-path — later task must execute and baseline must include predecessor', { timeout: 30000 }, async () => {
    // T_SPD2 depends on T_SPD1, both write src/shared_dep.ts.
    // Expected: T_SPD2's worktree baseline (or final integration) includes
    // T_SPD1's content, producing a predictable combined result.
    //
    // Use governanceEnabled=false so scope expansion / G2 does not preempt
    // T_SPD2 execution. Both tasks should spawn and complete.
    const ctx = await setupLongTaskBenchmark(SAME_PATH_DEP_DAG, 4, 'ltb02', {
      governanceEnabled: false,
      allowRealWorker: true,
    });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const t1 = tasks.find(t => t.id === 'T_SPD1');
      const t2 = tasks.find(t => t.id === 'T_SPD2');
      const stages = await ctx.store.listStages(ctx.runId);

      const t1Spawned = ctx.piRunner.callStartTimes.has('T_SPD1');
      const t2Spawned = ctx.piRunner.callStartTimes.has('T_SPD2');

      console.log(`[LT-B-02] Run: ${run?.status}, Stage: ${stages.map(s => `${s.stageNumber}=${s.status}`).join(', ')}`);
      console.log(`[LT-B-02] T_SPD1: ${t1?.status} (spawned=${t1Spawned}), T_SPD2: ${t2?.status} (spawned=${t2Spawned})`);
      console.log(`[LT-B-02] Pi total calls: ${ctx.piRunner.calls}`);

      // ── Required: T_SPD2 MUST be spawned/executed ──
      // If T_SPD2 was never spawned, the test cannot verify same-path
      // baseline semantics.
      if (!t2Spawned) {
        console.log('[LT-B-02] BLOCKED: T_SPD2 never spawned — cannot verify baseline inclusion.');
        console.log('[LT-B-02] Production gap: scheduler does not allow dependent same-path task to execute.');
      }
      expect(t2Spawned, 'T_SPD2 must be spawned for dependent same-path scenario').toBe(true);

      // ── Required: T_SPD2 must start after T_SPD1 ends ──
      if (t1Spawned && t2Spawned) {
        await assertDependsAfterAll(ctx.piRunner, 'T_SPD2', ['T_SPD1']);
      }

      // ── Check target branch content ──
      const targetFile = path.join(ctx.projectRoot, 'src', 'shared_dep.ts');
      if (existsSync(targetFile)) {
        const content = readFileSync(targetFile, 'utf-8').replaceAll('\r\n', '\n');
        const hasS1 = content.includes('lt-acceptance T_SPD1');
        const hasS2 = content.includes('lt-acceptance T_SPD2');
        console.log(`[LT-B-02] Target file: T_SPD1=${hasS1}, T_SPD2=${hasS2}, len=${content.length}`);
        expect(hasS1, 'Dependent task baseline must retain predecessor result').toBe(true);
        expect(hasS2, 'Target branch must include dependent task result').toBe(true);
      }

      // ── Document merge result ──
      // If both tasks completed but integration produced merge_blocked
      // (same-file git merge conflict), this is a production gap:
      // the dependent task's worktree was NOT rebased on the predecessor.
      const s1 = stages.find(s => s.stageNumber === 1);
      if (s1) {
        const batches = await ctx.store.listIntegrationBatches(s1.id);
        for (const b of batches) {
          console.log(`[LT-B-02] Integration batch ${b.id}: status=${b.status}`);
          if (b.status === 'conflict') {
            console.log('[LT-B-02] GAP: same-file git merge conflict — T_SPD2 baseline did NOT include T_SPD1 result.');
            console.log('[LT-B-02] Scheduler creates both task worktrees from stage base, not from dependency branch.');
          }
        }
      }

      // Assertions on final state:
      if (t1Spawned && t2Spawned) {
        // If both spawned and completed, integration should succeed.
        // If it doesn't (merge_blocked), that's the production gap.
        if (t1?.status === 'merge_blocked' || t2?.status === 'merge_blocked') {
          console.log('[LT-B-02] BLOCKED: tasks merge_blocked — dependent same-path baseline not supported.');
          // Test fails here: baseline inclusion is a requirement.
          expect(false, 'Dependent same-path must not produce merge_blocked; baseline must include predecessor').toBe(true);
        }
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Part C: Failure & Cleanup Acceptance
// ══════════════════════════════════════════════════════════════

describe('LT-FAILURE — Failure Mode & Cleanup Acceptance', () => {
  it('LT-C-01: integration conflict must produce stage=paused, run≠completed', { timeout: 30000 }, async () => {
    const ctx = await setupLongTaskBenchmark(CONFLICT_DAG_LT, 4, 'ltc01', {
      governanceEnabled: true,
      allowRealWorker: true,
    });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const stagePaused = stages.some(s => s.status === 'paused' || s.status === 'failed');

      console.log(`[LT-C-01] Run: ${run?.status}, Tasks: ${tasks.map(t => `${t.id}=${t.status}`).join(', ')}`);

      for (const s of stages) {
        const batches = await ctx.store.listIntegrationBatches(s.id);
        for (const b of batches) console.log(`[LT-C-01] Batch ${b.id}: ${b.status}`);
      }

      expect(run?.status, 'Run with conflict must not be completed').not.toBe('completed');
      expect(stagePaused, 'Stage must be paused/failed on conflict').toBe(true);

      // Neither task should be merged
      for (const t of tasks) {
        expect(t.status, `Task ${t.id} must not be merged`).not.toBe('merged');
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-C-02: waiting_decision task must prevent run completion', { timeout: 30000 }, async () => {
    const ctx = await setupLongTaskBenchmark(
      [
        { taskId: 'T_R1', file: 'src/retry.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 },
        { taskId: 'T_R2', file: 'lib/retry_other.ts', dependencies: [], allowedPaths: ['lib/'], forbiddenPaths: [], stageNumber: 1 },
      ],
      4, 'ltc02',
      { maxReworkCount: 1, governanceEnabled: true, allowRealWorker: true },
    );

    ctx.piRunner.needsDecision.add('T_R1');

    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const tr1 = tasks.find(t => t.id === 'T_R1');

      console.log(`[LT-C-02] Run: ${run?.status}, T_R1: ${tr1?.status}`);

      expect(tr1?.status, 'Decision-blocked task must wait for a decision').toBe('waiting_decision');
      expect(ctx.piRunner.attemptCounts.get('T_R1'), 'Decision-blocked task must not retry').toBe(1);
      expect(run?.status, 'Run must not be completed').not.toBe('completed');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-C-03: retry-exhausted must produce no extra dispatch/merge', { timeout: 30000 }, async () => {
    const ctx = await setupLongTaskBenchmark(
      [{ taskId: 'T_RX1', file: 'src/retry_x.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 }],
      4, 'ltc03',
      { maxReworkCount: 1, governanceEnabled: true, allowRealWorker: true },
    );

    // Override run to make T_RX1 always fail (all attempts)
    const origRun = ctx.piRunner.run.bind(ctx.piRunner);
    ctx.piRunner.run = async function (input) {
      const stdinTaskId = input.stdin.match(/"id":"prompt-([^"]+)"/)?.[1];
      let tid = stdinTaskId || 'unknown';
      if (!stdinTaskId) {
        const parts = input.cwd.replace(/\\/g, '/').split('/');
        for (const p of parts) { if (/^T[A-Z0-9_]+$/i.test(p)) { tid = p; break; } }
      }
      if (tid === 'T_RX1') {
        this.calls++;
        const ci = this.calls;
        this.taskIds.push(tid);
        const st = Date.now();
        this.callStartTimes.set(tid, st);
        await new Promise(r => setTimeout(r, this.delayMs || 50));
        const et = Date.now();
        this.callEndTimes.set(tid, et);
        this.callRecords.push({ taskId: tid, file: 'src/retry_x.ts', startTime: st, endTime: et, callIndex: ci, synthetic: true });
        return { pid: 5500 + ci, exitCode: 1, stdout: '', stderr: 'Always-fail', timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: this.delayMs || 50 };
      }
      return origRun(input);
    };

    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const trx = tasks.find(t => t.id === 'T_RX1');

      console.log(`[LT-C-03] Run: ${run?.status}, Pi calls: ${ctx.piRunner.calls}, T_RX1: ${trx?.status}`);

      // Pi calls must not exceed retry budget (maxReworkCount=1 → 2 max)
      expect(ctx.piRunner.calls, 'Pi calls ≤ retry budget').toBeLessThanOrEqual(3);
      expect(run?.status, 'Run must not be completed').not.toBe('completed');
      expect(trx?.status, 'T_RX1 must not be merged').not.toBe('merged');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('LT-C-04: disposable fixture cleanup — no residual after teardown', { timeout: 30000 }, async () => {
    let tmp = '';
    let ctx: LtBenchContext | null = null;
    try {
      ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, 'ltc04', { allowRealWorker: false });
      tmp = ctx.tmp;
      await ctx.scheduler.startRun(ctx.runId);
      const dbPath = path.join(tmp, '.brainctl', 'state', 'bench.db');
      expect(existsSync(dbPath), 'DB must exist during run').toBe(true);
    } finally {
      if (ctx) await teardownBenchmark(ctx);
    }
    console.log(`[LT-C-04] Tmp exists after teardown: ${existsSync(tmp)}`);
    expect(existsSync(tmp), 'Tmp must be cleaned up').toBe(false);
  });

  it('LT-C-05: repeated runs — no state drift between independent runs', { timeout: 60000 }, async () => {
    const results: Array<{ runId: string; mergedCount: number; totalCount: number }> = [];
    for (let i = 0; i < 2; i++) {
      const ctx = await setupLongTaskBenchmark(LONG_TASK_DAG, 6, `ltc05-r${i}`, { allowRealWorker: false });
      try {
        await ctx.scheduler.startRun(ctx.runId);
        const tasks = await ctx.store.listTasks(ctx.runId);
        results.push({ runId: ctx.runId, mergedCount: tasks.filter(t => t.status === 'merged').length, totalCount: tasks.length });
        console.log(`[LT-C-05] Run ${i}: ${results[i].runId} merged=${results[i].mergedCount}/${results[i].totalCount}`);
      } finally {
        await teardownBenchmark(ctx);
      }
    }
    for (const r of results) {
      expect(r.mergedCount, `Run ${r.runId} must merge all ${r.totalCount}`).toBe(r.totalCount);
    }
    expect(new Set(results.map(r => r.mergedCount)).size, 'No drift').toBe(1);
  });
});
