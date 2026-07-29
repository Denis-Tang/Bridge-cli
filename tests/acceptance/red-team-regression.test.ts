// ── Acceptance & Red Team Regression Tests ────────────────────────────────
// Each test encodes a specific failure mode from CURRENT-ISSUES.md P0-5 and P1.
// These tests should currently be RED (or detect failure correctly) until
// the corresponding source fixes are implemented.
//
// DO NOT lower assertions, widen acceptable states, or mock failures to make these green.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  setupBenchmark, teardownBenchmark, makeGitRepo, makeStore, makeSpec,
  CONFLICT_DAG, CORRECT_DAG, taskContent, BenchmarkContext,
} from '../helpers/benchmark-fixtures.js';
import type { TaskDef } from '../helpers/benchmark-fixtures.js';

describe('ACCEPTANCE-RED-TEAM — Integration Conflict Detection', () => {
  it('RED-01: two tasks writing same file must NOT both reach "merged"', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'red01');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const tasks = await ctx.store.listTasks(ctx.runId);
      const t1 = tasks.find(t => t.id === 'T1');
      const t6 = tasks.find(t => t.id === 'T6');

      console.log(`[RED-01] T1: ${t1?.status}, T6: ${t6?.status}`);

      // At least one of T1/T6 should NOT be "merged" since they conflict
      const bothMerged = (t1?.status === 'merged' && t6?.status === 'merged');
      if (bothMerged) {
        console.log('[RED-01] FAIL: Both T1 and T6 merged despite writing same file!');
        console.log('  This is the P0-5 bug: "T1/T6 integration conflict后 stage paused，7/7 通过"');
      }

      expect(bothMerged, 'T1 and T6 must not both be merged — same-file conflict').toBe(false);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-02: integration conflict must produce stage=paused or stage=failed', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'red02');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);

      // When T1+T6 both modify src/a.ts, integration should conflict
      const hasConflict = stages.some(s =>
        s.status === 'paused' || s.status === 'failed' || s.status === 'integration',
      );

      // Check integration batch status
      let batchConflict = false;
      for (const stage of stages) {
        const batches = await ctx.store.listIntegrationBatches(stage.id);
        for (const b of batches) {
          if (b.status === 'conflict') {
            batchConflict = true;
          }
        }
      }

      console.log(`[RED-02] Run: ${run?.status}, Stages: ${stages.map(s => `${s.stageNumber}=${s.status}`).join(', ')}`);
      console.log(`[RED-02] Integration conflict: ${batchConflict}`);

      // For CONFLICT_DAG, integration SHOULD produce a conflict
      // The CURRENT bug is that it passes despite the conflict
      expect(
        hasConflict || batchConflict || run?.status === 'failed',
        'integration conflict must be detected (stage paused/failed/conflict batch)',
      ).toBe(true);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-03: run=completed must NOT happen with unresolved integration conflicts', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'red03');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);

      // Collect all integration batch conflicts
      let hasUnresolvedConflict = false;
      for (const stage of stages) {
        const batches = await ctx.store.listIntegrationBatches(stage.id);
        for (const b of batches) {
          if (b.status === 'conflict') {
            hasUnresolvedConflict = true;
          }
        }
      }

      if (hasUnresolvedConflict && run?.status === 'completed') {
        console.log('[RED-03] CRITICAL BUG: run completed despite unresolved integration conflict!');
        console.log('  This is P0-5: benchmark将失败链判为成功');
      }

      if (hasUnresolvedConflict) {
        expect(run?.status, 'run with unresolved conflict must not be completed').not.toBe('completed');
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

describe('ACCEPTANCE-RED-TEAM — Target Branch Verification', () => {
  it('RED-04: expected files must exist in target branch after completion', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'red04');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      if (run?.status === 'completed') {
        for (const def of CORRECT_DAG) {
          const fullPath = path.join(ctx.projectRoot, def.file);
          const exists = existsSync(fullPath);
          if (!exists) {
            console.log(`[RED-04] MISSING: ${def.file} not found in target branch`);
          }
          expect(exists, `file ${def.file} must exist in target branch`).toBe(true);
        }
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-05: expected file content must be correct after merge', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'red05');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      if (run?.status === 'completed') {
        for (const def of CORRECT_DAG) {
          const fullPath = path.join(ctx.projectRoot, def.file);
          if (existsSync(fullPath)) {
            const content = readFileSync(fullPath, 'utf-8').replaceAll('\r\n', '\n');
            const hasMarker = content.includes(taskContent(def.taskId));
            if (!hasMarker) {
              console.log(`[RED-05] WRONG CONTENT: ${def.file} missing ${def.taskId} marker`);
            }
            expect(hasMarker, `file ${def.file} content must include ${def.taskId} marker`).toBe(true);
          }
        }
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-06: single missing expected file in target branch must cause failure', { timeout: 30000 }, async () => {
    // This test documents the requirement: if any expected output file is
    // missing from the target branch, the run must fail/not complete.
    // This is currently tested via CORR-01 (target branch content check)
    // but we make it explicit here as a named red-team test.

    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'red06');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      // Verify no task completed without its output file
      const tasks = await ctx.store.listTasks(ctx.runId);
      for (const task of tasks) {
        if (task.status === 'merged') {
          const spec = task.specJson as { estimatedWritePaths?: string[] } | null;
          const file = spec?.estimatedWritePaths?.[0];
          if (file) {
            const fullPath = path.join(ctx.projectRoot, file);
            expect(existsSync(fullPath),
              `merged task ${task.id} must have file ${file} in target branch`).toBe(true);
          }
        }
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

describe('ACCEPTANCE-RED-TEAM — Stage Paused Invariants', () => {
  it('RED-07: undeclared same-path conflict pauses before worker spawn', { timeout: 30000 }, async () => {

    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'red07');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const stages = await ctx.store.listStages(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const pausedStages = stages.filter((stage) => stage.status === 'paused');

      expect(pausedStages, 'conflict DAG must pause exactly one stage').toHaveLength(1);
      const attempts = await ctx.store.listAttemptsByStage(pausedStages[0].id);
      expect(attempts, 'pre-spawn conflict must create no attempts').toHaveLength(0);
      expect(ctx.piRunner.calls, 'pre-spawn conflict must call no worker').toBe(0);
      expect(tasks.filter((task) => task.status === 'merge_blocked'), 'nothing reached integration').toHaveLength(0);
      const pausedEvents = await ctx.store.listEvents(ctx.runId, 'stage_paused');
      expect(pausedEvents.some((event) => event.eventDataJson?.includes('undeclared_same_path_conflict')))
        .toBe(true);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-08: any waiting_decision task must prevent run completion', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'red08');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const waitingTasks = tasks.filter(t => t.status === 'waiting_decision');

      console.log(`[RED-08] Waiting_decision tasks: ${waitingTasks.map(t => t.id).join(', ') || 'none'}`);

      if (waitingTasks.length > 0) {
        // A run with waiting_decision tasks must NOT be "completed"
        expect(run?.status, 'run with waiting_decision tasks must not be completed').not.toBe('completed');
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

describe('ACCEPTANCE-RED-TEAM — Ledger Integrity', () => {
  it('RED-09: duplicate callId in token ledger → fail', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'red09');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const piEntries = await ctx.store.listTokenLedgerEntries(ctx.runId, 'pi_worker');
      const reviewEntries = await ctx.store.listTokenLedgerEntries(ctx.runId, 'codex_review');

      const piDedup = new Set(piEntries.map(e => e.callId));
      const reviewDedup = new Set(reviewEntries.map(e => e.callId));

      console.log(`[RED-09] Pi entries: ${piEntries.length} (unique: ${piDedup.size})`);
      console.log(`[RED-09] Review entries: ${reviewEntries.length} (unique: ${reviewDedup.size})`);

      expect(piDedup.size, 'no duplicate Pi callIds').toBe(piEntries.length);
      expect(reviewDedup.size, 'no duplicate review callIds').toBe(reviewEntries.length);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-10: estimated entries must not persist after run completes', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'red10');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      for (const callType of ['pi_worker', 'codex_review'] as const) {
        const entries = await ctx.store.listTokenLedgerEntries(ctx.runId, callType);
        const estimated = entries.filter(e => e.status === 'estimated');
        if (estimated.length > 0) {
          console.log(`[RED-10] ${estimated.length} estimated entries persist for ${callType}`);
          // Each estimated entry is a P0-5 violation
          expect(estimated.length, `estimated ${callType} entries after run`).toBe(0);
        }
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-11: resume must not cause extra ledger entries beyond rework', { timeout: 30000 }, async () => {
    // Each task should have Pi entries = number of execution attempts (not more)
    const ctx = await setupBenchmark(CORRECT_DAG, 1, 'red11'); // sequential to avoid concurrency noise
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const tasks = await ctx.store.listTasks(ctx.runId);
      const piEntries = await ctx.store.listTokenLedgerEntries(ctx.runId, 'pi_worker');

      for (const task of tasks) {
        const attempts = await ctx.store.listAttempts(task.id);
        const execAttempts = attempts.filter(a =>
          ['running', 'worker_completed', 'validating', 'reviewing', 'approved', 'rework_required'].includes(a.status) ||
          a.piPid != null,
        );
        const taskPiEntries = piEntries.filter(e => e.taskId === task.id);

        console.log(`[RED-11] ${task.id}: ${execAttempts.length} exec attempts, ${taskPiEntries.length} Pi ledger entries`);

        // Pi ledger entries should not exceed execution attempts
        if (taskPiEntries.length > execAttempts.length) {
          console.log(`[RED-11] WARNING: ${task.id} has ${taskPiEntries.length} ledger entries but only ${execAttempts.length} attempts`);
        }
        expect(
          taskPiEntries.length,
          `${task.id}: Pi ledger entries (${taskPiEntries.length}) <= exec attempts (${execAttempts.length})`,
        ).toBeLessThanOrEqual(execAttempts.length);
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

describe('ACCEPTANCE-RED-TEAM — Dependency & Concurrency Failures', () => {
  it('RED-12: dependency using min instead of max → detect via assertion failure', { timeout: 30000 }, async () => {
    // CURRENT-ISSUES P0-5: "依赖等待使用 min 而不是所有依赖完成时间的 max"
    // BENCH-05 in the old benchmark used Math.min(t1End, t2End) instead of Math.max.
    // This test explicitly checks max-based dependency ordering.

    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'red12');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const pi = ctx.piRunner;
      // T5 depends on T1 and T2 → must start >= max(T1.end, T2.end)
      const t1End = pi.callEndTimes.get('T1');
      const t2End = pi.callEndTimes.get('T2');
      const t5Start = pi.callStartTimes.get('T5');

      if (t1End != null && t2End != null && t5Start != null) {
        const maxEnd = Math.max(t1End, t2End);
        const minEnd = Math.min(t1End, t2End);

        console.log(`[RED-12] T1 end: ${t1End}, T2 end: ${t2End}, T5 start: ${t5Start}`);
        console.log(`  Max(T1.end, T2.end): ${maxEnd}, Min: ${minEnd}`);

        // The correct check: T5 starts >= MAX of dependency ends
        const passesWithMax = t5Start >= maxEnd;
        // The INCORRECT check (former P0-5 bug): T5 starts >= MIN
        const passesWithMin = t5Start >= minEnd;

        if (passesWithMin && !passesWithMax) {
          console.log('[RED-12] CRITICAL: T5 passes min-based check but FAILS max-based check!');
          console.log('  This is the P0-5 bug: dependency ordering using min instead of max.');
        }

        // Assert the correct (max-based) condition
        expect(t5Start, `T5 start must be >= max(T1.end=${t1End}, T2.end=${t2End})`).toBeGreaterThanOrEqual(maxEnd);
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('RED-13: conflicting tasks must not execute concurrently (path-lock serialization)', { timeout: 30000 }, async () => {
    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'red13');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const pi = ctx.piRunner;
      const t1Start = pi.callStartTimes.get('T1');
      const t1End = pi.callEndTimes.get('T1');
      const t6Start = pi.callStartTimes.get('T6');
      const t6End = pi.callEndTimes.get('T6');

      console.log(`[RED-13] T1: [${t1Start}-${t1End}], T6: [${t6Start}-${t6End}]`);

      if (t1Start != null && t1End != null && t6Start != null && t6End != null) {
        const overlap = (t1Start < t6End) && (t6Start < t1End);
        if (overlap) {
          console.log('[RED-13] FAIL: T1 and T6 overlapped in execution (path lock violation)');
        }
        expect(overlap, 'T1 and T6 must not overlap (same file)').toBe(false);
      }
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

describe('ACCEPTANCE-RED-TEAM — No Mocking Failures', () => {
  it('RED-14: must not lower assertions to make conflict DAG pass', { timeout: 30000 }, async () => {
    // This is a meta-test: verifies that the benchmark infrastructure itself
    // hasn't been compromised to give a false green.
    // The CONFLICT_DAG should always fail.

    const ctx = await setupBenchmark(CONFLICT_DAG, 6, 'red14');
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);

      // If someone weakens the assertions to accept paused/approved as success...
      const weakCheck = tasks.every(t =>
        ['completed', 'approved', 'merged', 'paused', 'waiting_decision'].includes(t.status),
      );
      // ...that's the EXACT P0-5 bug.

      if (weakCheck && run?.status !== 'failed') {
        console.log('[RED-14] WARNING: weak assertions would allow conflict DAG to pass.');
        console.log('  Proper assertion: run=completed, all tasks=merged, all stages=completed.');
      }

      // Strong check: must be completed+merged, not just approved
      const strongCheck = run?.status === 'completed' &&
        tasks.every(t => t.status === 'merged');

      expect(strongCheck, 'CONFLICT_DAG must fail strong completion check').toBe(false);
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});
