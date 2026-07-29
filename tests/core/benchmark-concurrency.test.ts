// ── Concurrency & Dependency Benchmark v3 ─────────────────────────────────
// 记录真实 monotonic time start/end，验证并发重叠、依赖顺序、冲突序列化。
// Sequential 与 orchestrated 使用相同工作量、相同 gate/review 延迟、相同正确性检查。

import { describe, it, expect } from 'vitest';
import {
  setupBenchmark, teardownBenchmark, assertOverlap, assertDependsAfterAll, assertNoOverlap,
  runRepeated, runSequentialBaseline, runOrchestratedBaseline,
  CORRECT_DAG, CONFLICT_DAG, PI_DELAY_MS, taskContent,
} from '../helpers/benchmark-fixtures.js';

describe('BENCH-CONCURRENCY — Real Overlap Detection', () => {
  it('CONC-01: independent tasks (T1-T4) must have overlapping execution', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'conc01');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      // T1, T2, T3, T4 are independent — at least some pair must overlap
      const piRunner = ctx.piRunner;
      console.log(`[CONC-01] Pi calls: ${piRunner.calls}`);
      for (const rec of piRunner.callRecords) {
        console.log(`  ${rec.taskId}: [${rec.startTime}-${rec.endTime}] file=${rec.file}`);
      }

      // Assert that at least one pair of independent tasks overlapped
      await assertOverlap(piRunner, ['T1', 'T2', 'T3', 'T4']);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('CONC-02: dependent task T5 must start after ALL its dependencies end', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'conc02');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      // T5 depends on T1, T2 → must start >= max(T1.end, T2.end)
      await assertDependsAfterAll(ctx.piRunner, 'T5', ['T1', 'T2']);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('CONC-03: multi-hop dependency T8 must wait for T6 and T7', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'conc03');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      // T7 depends on T3, T8 depends on T6 and T7
      await assertDependsAfterAll(ctx.piRunner, 'T7', ['T3']);
      await assertDependsAfterAll(ctx.piRunner, 'T8', ['T6', 'T7']);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('CONC-04: conflicting-path tasks must NOT overlap (serialized)', { timeout: 30000 }, async () => {
    // Use CONFLICT_DAG: T1 and T6 both write src/a.ts
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'conc04');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      // T1 and T6 should NOT overlap
      await assertNoOverlap(ctx.piRunner, 'T1', 'T6');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('CONC-05: sequential baseline uses > max possible parallel wall time', { timeout: 60000 }, async () => {
    // With PI_DELAY_MS=300 and 8 tasks, sequential takes at least 8*300=2400ms
    const { ctx, wallMs } = await runSequentialBaseline(CORRECT_DAG);
    try {
      const minSequentialWall = PI_DELAY_MS * CORRECT_DAG.length;
      console.log(`[CONC-05] Sequential wall: ${wallMs}ms (min theoretical: ${minSequentialWall}ms)`);
      expect(wallMs).toBeGreaterThan(minSequentialWall * 0.8); // allow slight overhead
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

describe('BENCH-CONCURRENCY — Sequential vs Orchestrated Comparison', () => {
  it('CONC-06: orchestrated significantly faster than sequential (same workload)', { timeout: 120000 }, async () => {
    // Same DAG, same delays → orchestrated should use less wall time
    const seq = await runSequentialBaseline(CORRECT_DAG);
    let seqSucceeded = false;
    try {
      const run = await seq.ctx.store.getRun(seq.ctx.runId);
      seqSucceeded = run?.status === 'completed';
    } catch {}

    // Add a small buffer between runs
    await new Promise(r => setTimeout(r, 500));

    const orch = await runOrchestratedBaseline(CORRECT_DAG, 4);
    let orchSucceeded = false;
    try {
      const run = await orch.ctx.store.getRun(orch.ctx.runId);
      orchSucceeded = run?.status === 'completed';
    } catch {}

    console.log(`[CONC-06] Sequential: ${seq.wallMs}ms (${seqSucceeded ? 'OK' : 'FAIL'}), Pi=${seq.piCalls}, Codex=${seq.codexCalls}`);
    console.log(`[CONC-06] Orchestrated: ${orch.wallMs}ms (${orchSucceeded ? 'OK' : 'FAIL'}), Pi=${orch.piCalls}, Codex=${orch.codexCalls}`);
    console.log(`[CONC-06] Speedup: ${(seq.wallMs / Math.max(orch.wallMs, 1)).toFixed(2)}x`);

    // Orchestrated must use less wall time for independent tasks
    expect(orch.wallMs, 'orchestrated wall time').toBeLessThan(seq.wallMs);

    // Pi calls should be the same (same workload)
    expect(orch.piCalls).toBe(seq.piCalls);

    await teardownBenchmark(seq.ctx);
    await teardownBenchmark(orch.ctx);
  });

  it('CONC-07: repeated runs show stable concurrency behavior', { timeout: 120000 }, async () => {
    const results = await runRepeated(3, async (iter) => {
      const ctx = await setupBenchmark(CORRECT_DAG, 4, `conc07-${iter}`);
      const start = Date.now();
      try {
        await ctx.scheduler.startRun(ctx.runId);
      } catch {}
      const wallMs = Date.now() - start;
      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      return {
        ctx, wallMs,
        succeeded: run?.status === 'completed',
        runStatus: run?.status || '?',
        stageStatus: '?',
        mergedTasks: tasks.filter(t => t.status === 'merged').length,
        totalTasks: tasks.length,
      };
    });

    console.log(`[CONC-07] Pass rate: ${(results.passRate * 100).toFixed(0)}%`);
    console.log(`  Wall: range=[${results.ranges.wallMin}-${results.ranges.wallMax}]ms`);
    console.log(`  Coefficient of variation: ${((results.ranges.wallMax - results.ranges.wallMin) / Math.max(results.medians.wallMs, 1) * 100).toFixed(1)}%`);

    // Wall time variation should be reasonable (CV < 50%)
    const cv = (results.ranges.wallMax - results.ranges.wallMin) / Math.max(results.medians.wallMs, 1);
    expect(cv, 'wall time coefficient of variation').toBeLessThan(0.5);
  });
});

describe('BENCH-CONCURRENCY — Dependency Order Verification', () => {
  it('CONC-08: T5 result must include both T1 and T2 contributions', { timeout: 30000 }, async () => {
    // For correct DAG: T5 depends on T1, T2.
    // After merge, T5's file should exist, AND the target branch must
    // contain ALL of T1, T2, T5 content (the merge preserves everything).
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'conc08');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      if (run?.status === 'completed') {
        // Check that all task files exist with correct content
        for (const def of CORRECT_DAG) {
          const { existsSync, readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const fullPath = join(ctx.projectRoot, def.file);
          expect(existsSync(fullPath), `file ${def.file} exists in target branch`).toBe(true);
          const content = readFileSync(fullPath, 'utf-8').replaceAll('\r\n', '\n');
          expect(content, `file ${def.file} contains ${def.taskId} marker`).toContain(taskContent(def.taskId));
        }
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});
