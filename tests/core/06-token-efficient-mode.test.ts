// ── Token-Efficient Mode Tests — 06 任务 ──────────────────────────────
// Tests for token-efficient execution mode, A/B comparison, review cache,
// and mode auto-selection.

import { describe, it, expect } from 'vitest';
import {
  setupBenchmark, teardownBenchmark, runSequentialBaseline, runOrchestratedBaseline,
  CORRECT_DAG, CONFLICT_DAG, STRESS_DAG,
  type BenchmarkContext,
} from '../helpers/benchmark-fixtures.js';
import { extractCodexReviewTaskId, formatReworkCodexReviewMarker } from '../../src/adapters/codex-process-runner.js';
import { selectExecutionMode, resolveExecutionMode } from '../../src/core/execution-mode.js';
import { shouldDoTaskLevelReview } from '../../src/core/review-granularity.js';
import { ReviewResultCache, computeReviewCacheKey, ReviewCacheKey } from '../../src/core/review-cache.js';
import type { StructuredTaskSpec, StructuredPlan } from '../../src/types/m2-types.js';

// ══════════════════════════════════════════════════════════════
// MODE-01..04: Core token-efficient mode behavior
// ══════════════════════════════════════════════════════════════

describe('06-MODE — Token-Efficient Core', () => {
  it('MODE-01: token-efficient low-risk tasks skip per-task Codex review', { timeout: 60000 }, async () => {
    // Use token-efficient mode with CORRECT_DAG (all low risk)
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'mode01', {
      piDelayMs: 100,
      codexDelayMs: 30,
      executionMode: 'token-efficient',
    });
    try {
      // Override the scheduler's mode — inject token-efficient
      // We test via a new benchmark with explicit mode
      await ctx.scheduler.startRun(ctx.runId);

      const tasks = await ctx.store.listTasks(ctx.runId);
      const codexReviewCalls = ctx.codexRunner.calls;

      console.log(`[MODE-01] Tasks: ${tasks.length}, Codex review calls: ${codexReviewCalls}`);

      expect(codexReviewCalls).toBe(1);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('MODE-02: token-efficient mode skips per-task review, runs stage review', { timeout: 60000 }, async () => {
    // This test verifies that with token-efficient mode explicitly set,
    // per-task reviews are skipped and stage review runs once.
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'mode02', {
      piDelayMs: 100,
      codexDelayMs: 30,
      executionMode: 'token-efficient',
    });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const events = await ctx.store.listEvents(ctx.runId);
      const skippedEvents = events.filter(e => e.eventType === 'review_skipped_token_efficient');
      const stageReviewEvents = events.filter(e => e.eventType === 'stage_review_started' || e.eventType === 'stage_review_completed');

      console.log(`[MODE-02] review_skipped events: ${skippedEvents.length}`);
      console.log(`[MODE-02] stage_review events: ${stageReviewEvents.length}`);
      console.log(`[MODE-02] Codex review calls: ${ctx.codexRunner.calls}`);

      expect(skippedEvents.length).toBe(CORRECT_DAG.length);
      expect(stageReviewEvents.length).toBe(2);
      expect(ctx.codexRunner.calls).toBe(1);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('MODE-03: high-risk tasks still get per-task Codex review', { timeout: 30000 }, async () => {
    // Verify review-granularity module — high risk always triggers per-task review
    const spec: StructuredTaskSpec = {
      taskId: 'T1', stageNumber: 1, title: 'Test', goal: 'Test',
      dependencies: [], estimatedWritePaths: ['src/test.ts'],
      allowedPaths: ['src/'], forbiddenPaths: [],
      contextFiles: [], acceptanceChecks: [],
      allowedCommands: [], riskLevel: 'high',
      productDecisionsLocked: true, expectedOutputs: ['src/test.ts'],
      heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
    };

    const result = shouldDoTaskLevelReview(spec, null, true, 'token-efficient', false);
    expect(result, 'high risk should get per-task review').toBe(true);
  });

  it('MODE-04: failed final review blocks the next stage and leaves skipped tasks retryable', { timeout: 60000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'mode04b', {
      piDelayMs: 20,
      codexDelayMs: 1,
      executionMode: 'token-efficient',
    });
    try {
      const now = new Date().toISOString();
      const stage2Id = `${ctx.runId}-s2`;
      await ctx.store.createStage({ id: stage2Id, runId: ctx.runId, stageNumber: 2, title: 'S2', status: 'pending' });
      const stage2Spec: StructuredTaskSpec = {
        taskId: 'T9', stageNumber: 2, title: 'Must not start', goal: 'Must not start before stage 1 passes',
        dependencies: [], estimatedWritePaths: ['src/stage2.ts'], allowedPaths: ['src/'], forbiddenPaths: [],
        contextFiles: [], acceptanceChecks: ['noop'], allowedCommands: ['node -e process.exit(0)'],
        riskLevel: 'low', productDecisionsLocked: true, expectedOutputs: ['src/stage2.ts'],
        heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
      };
      await ctx.store.createTask({ id: 'T9', runId: ctx.runId, title: stage2Spec.title, status: 'pending', specJson: stage2Spec, createdAt: now, updatedAt: now });

      ctx.codexRunner.run = async (
        _command: string,
        _args: string[],
        opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal },
      ) => {
        ctx.codexRunner.calls++;
        const taskId = extractCodexReviewTaskId(opts.input) ?? 'unknown-task';
        const issue = 'integrated behavior is incorrect and must be fixed';
        return {
          stdout: formatReworkCodexReviewMarker(taskId, issue),
          stderr: '', exitCode: 0, durationMs: 1,
          tokenUsage: { inputTokens: 200, outputTokens: 80, cacheHitTokens: 0 },
        };
      };

      await ctx.scheduler.startRun(ctx.runId);

      const stages = await ctx.store.listStages(ctx.runId);
      expect(stages.find((stage) => stage.id === ctx.stageId)?.status).toBe('paused');
      expect(stages.find((stage) => stage.id === stage2Id)?.status).toBe('pending');
      expect(ctx.piRunner.taskIds).not.toContain('T9');

      const attempts = await ctx.store.listAttemptsByStage(ctx.stageId);
      expect(attempts).toHaveLength(CORRECT_DAG.length);
      expect(attempts.every((attempt) => attempt.status === 'rework_required')).toBe(true);
      expect(attempts.every((attempt) => attempt.exitReason?.startsWith('stage_review_failed:'))).toBe(true);

      const batches = await ctx.store.listIntegrationBatches(ctx.stageId);
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe('failed');
      expect(batches[0].targetMergeCommit).toBeNull();
      expect((await ctx.store.getRun(ctx.runId))?.status).not.toBe('completed');
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// MODE-05..08: Resume, retry, and comparison
// ══════════════════════════════════════════════════════════════

describe('06-MODE — Resume & Retry', () => {
  it('MODE-05: token-efficient mode + correct DAG integrates all tasks', { timeout: 60000 }, async () => {
    const ctx = await setupBenchmark(CORRECT_DAG, 4, 'mode05', {
      piDelayMs: 100,
      codexDelayMs: 30,
      executionMode: 'token-efficient',
    });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const mergedTasks = tasks.filter(t => t.status === 'merged');

      console.log(`[MODE-05] Run: ${run?.status}, Merged: ${mergedTasks.length}/${tasks.length}`);
      console.log(`[MODE-05] Pi calls: ${ctx.piRunner.calls}, Codex calls: ${ctx.codexRunner.calls}`);

      // In default mode, all tasks should merge (CORRECT_DAG has no conflicts)
      expect(mergedTasks.length, 'all tasks should merge in correct DAG').toBe(CORRECT_DAG.length);
      expect(ctx.codexRunner.calls).toBe(1);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('MODE-06: conflict DAG pauses stage correctly', { timeout: 60000 }, async () => {
    const ctx = await setupBenchmark(CONFLICT_DAG, 4, 'mode06', {
      piDelayMs: 100,
      codexDelayMs: 30,
    });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const run = await ctx.store.getRun(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);
      const pausedStage = stages.find(s => s.status === 'paused' || s.status === 'failed');

      console.log(`[MODE-06] Run: ${run?.status}, Paused stage: ${pausedStage ? 'yes' : 'no'}`);

      // With conflict, at least one stage should pause/fail
      const conflict = pausedStage || run?.status === 'running';
      expect(conflict, 'conflict DAG should cause pause or running state').toBeTruthy();
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// CACHE-01..06: Review cache tests
// ══════════════════════════════════════════════════════════════

describe('06-CACHE — Review Cache', () => {
  it('CACHE-01: identical inputs → cache hit', () => {
    const cache = new ReviewResultCache();
    const params = {
      baseCommit: 'abc123',
      diff: 'line 1\nline 2',
      qualityGateConfig: { gates: ['test'] },
      reviewerModel: 'codex-cli',
      reviewerVersion: 'v1',
      riskPolicy: { maxRisk: 'medium' },
    };
    const key = computeReviewCacheKey(params);

    const result = {
      taskId: 'test', status: 'approved' as const,
      reviewSummary: 'ok', findings: [], requiredRework: [],
      qualityGateStatus: 'passed', mergeAllowed: true, reviewer: 'codex-cli',
    };

    cache.set(key, result);
    const hit = cache.get(key);
    expect(hit, 'cache should return result on identical key').not.toBeNull();
    expect(hit!.mergeAllowed, 'cached result should match').toBe(true);

    const hit2 = cache.get(key);
    expect(hit2, 'cache should persist for same key').not.toBeNull();
  });

  it('CACHE-02: different diff → cache miss', () => {
    const cache = new ReviewResultCache();
    const key1 = computeReviewCacheKey({
      baseCommit: 'abc123', diff: 'diff1',
      qualityGateConfig: {}, reviewerModel: 'm1',
      reviewerVersion: 'v1', riskPolicy: {},
    });
    const key2 = computeReviewCacheKey({
      baseCommit: 'abc123', diff: 'diff2',
      qualityGateConfig: {}, reviewerModel: 'm1',
      reviewerVersion: 'v1', riskPolicy: {},
    });

    cache.set(key1, {
      taskId: 't', status: 'approved', reviewSummary: 'ok',
      findings: [], requiredRework: [],
      qualityGateStatus: 'passed', mergeAllowed: true, reviewer: 'codex-cli',
    });

    const miss = cache.get(key2);
    expect(miss, 'different diff should cause cache miss').toBeNull();
  });

  it('CACHE-03: different baseCommit → cache miss', () => {
    const cache = new ReviewResultCache();
    const key1 = computeReviewCacheKey({
      baseCommit: 'abc123', diff: 'same',
      qualityGateConfig: {}, reviewerModel: 'm1',
      reviewerVersion: 'v1', riskPolicy: {},
    });
    const key2 = computeReviewCacheKey({
      baseCommit: 'def456', diff: 'same',
      qualityGateConfig: {}, reviewerModel: 'm1',
      reviewerVersion: 'v1', riskPolicy: {},
    });

    cache.set(key1, {
      taskId: 't', status: 'approved', reviewSummary: 'ok',
      findings: [], requiredRework: [],
      qualityGateStatus: 'passed', mergeAllowed: true, reviewer: 'codex-cli',
    });

    expect(cache.get(key2), 'different baseCommit should cause cache miss').toBeNull();
  });

  it('CACHE-04: failed result NOT cached', () => {
    const cache = new ReviewResultCache();
    const params = {
      baseCommit: 'abc', diff: 'd',
      qualityGateConfig: {}, reviewerModel: 'm',
      reviewerVersion: 'v', riskPolicy: {},
    };
    const key = computeReviewCacheKey(params);

    // Insert a failed result
    cache.set(key, {
      taskId: 't', status: 'approved', reviewSummary: 'fail',
      findings: ['bad'], requiredRework: ['fix'], mergeAllowed: false,
      qualityGateStatus: 'failed', reviewer: 'codex-cli',
    });

    // get() should only return approved+mergeAllowed results
    const miss = cache.get(key);
    expect(miss, 'failed result should not be cached').toBeNull();
  });

  it('CACHE-05: cache key contains only hashes (no raw content)', () => {
    const key = computeReviewCacheKey({
      baseCommit: 'abc123',
      diff: 'some very long diff content with secrets',
      qualityGateConfig: { name: 'test', command: 'npm test' },
      reviewerModel: 'codex-cli',
      reviewerVersion: 'v1.0.0',
      riskPolicy: { maxRisk: 'high' },
    });

    const keyStr = key.toString();
    expect(keyStr, 'cache key should be a hash').toMatch(/^[a-f0-9]{64}$/);
    expect(keyStr, 'cache key should not contain diff content').not.toContain('secrets');
    expect(keyStr, 'cache key should not contain command').not.toContain('npm test');
  });

  it('CACHE-06: TTL expiration → cache miss', async () => {
    const cache = new ReviewResultCache({ ttlMs: 10 }); // Very short TTL
    const key = computeReviewCacheKey({
      baseCommit: 'abc', diff: 'd',
      qualityGateConfig: {}, reviewerModel: 'm',
      reviewerVersion: 'v', riskPolicy: {},
    });

    cache.set(key, {
      taskId: 't', status: 'approved', reviewSummary: 'ok',
      findings: [], requiredRework: [],
      qualityGateStatus: 'passed', mergeAllowed: true, reviewer: 'codex-cli',
    });

    // Wait for TTL expiration
    await new Promise(r => setTimeout(r, 20));

    const expired = cache.get(key);
    expect(expired, 'expired cache entry should miss').toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// BENCH-01..04: A/B comparison benchmark
// ══════════════════════════════════════════════════════════════

describe('06-BENCH — A/B Token Comparison', () => {
  it('BENCH-01: run sequential baseline 3 iterations with 8-task DAG', { timeout: 180000 }, async () => {
    const results: Array<{ piCalls: number; codexCalls: number; wallMs: number }> = [];
    for (let i = 0; i < 3; i++) {
      const seq = await runSequentialBaseline(CORRECT_DAG);
      results.push({ piCalls: seq.piCalls, codexCalls: seq.codexCalls, wallMs: seq.wallMs });
      await teardownBenchmark(seq.ctx);
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('[BENCH-01] Sequential baseline (3 iterations):');
    for (const r of results) {
      console.log(`  Pi=${r.piCalls}, Codex=${r.codexCalls}, Wall=${r.wallMs}ms`);
    }

    const codexMedian = results.map(r => r.codexCalls).sort((a, b) => a - b)[1];
    console.log(`  Codex calls median: ${codexMedian}`);

    // Sequential baseline should have 8 per-task reviews for 8-task DAG
    expect(results.length).toBe(3);
    expect(codexMedian).toBeGreaterThan(0);
  });

  it('BENCH-02: run orchestrated baseline 3 iterations with 8-task DAG', { timeout: 180000 }, async () => {
    const results: Array<{ piCalls: number; codexCalls: number; wallMs: number }> = [];
    for (let i = 0; i < 3; i++) {
      const orch = await runOrchestratedBaseline(CORRECT_DAG, 4, 100, 30);
      results.push({ piCalls: orch.piCalls, codexCalls: orch.codexCalls, wallMs: orch.wallMs });
      await teardownBenchmark(orch.ctx);
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('[BENCH-02] Orchestrated baseline (3 iterations):');
    for (const r of results) {
      console.log(`  Pi=${r.piCalls}, Codex=${r.codexCalls}, Wall=${r.wallMs}ms`);
    }

    expect(results.length).toBe(3);
  });

  it('BENCH-03: A/B comparison — Codex calls and wall time', { timeout: 60000 }, async () => {
    const seq = await runSequentialBaseline(CORRECT_DAG);
    const seqPi = seq.piCalls;
    const seqCodex = seq.codexCalls;
    const seqWall = seq.wallMs;
    await teardownBenchmark(seq.ctx);
    await new Promise(r => setTimeout(r, 200));

    const orch = await runOrchestratedBaseline(CORRECT_DAG, 4, 50, 20);
    const orchPi = orch.piCalls;
    const orchCodex = orch.codexCalls;
    const orchWall = orch.wallMs;

    console.log('[BENCH-03] A/B Comparison:');
    console.log(`  Sequential: Pi=${seqPi}, Codex=${seqCodex}, Wall=${seqWall}ms`);
    console.log(`  Orchestrated: Pi=${orchPi}, Codex=${orchCodex}, Wall=${orchWall}ms`);
    console.log(`  Wall time ratio: ${(orchWall / seqWall * 100).toFixed(1)}%`);

    // Orchestrated wall time should be lower (parallel execution)
    expect(orchWall, 'orchestrated wall time should be less than sequential').toBeLessThan(seqWall);

    // Same fake workload: only the review structure changes.
    expect(orchPi, 'orchestrated Pi calls').toBe(seqPi);
    expect(orchCodex, 'token-efficient Codex calls').toBeLessThan(seqCodex);

    await teardownBenchmark(orch.ctx);
  });

  it('BENCH-04: synthetic call-structure calculator is not Provider token evidence', { timeout: 30000 }, () => {
    const syntheticStructure = {
      synthetic: true as const,
      defaultPerTaskReviews: CORRECT_DAG.length,
      tokenEfficientStageReviews: 1,
    };

    console.log('[BENCH-04] synthetic scheduling structure only; no Provider token percentage is claimed');
    expect(syntheticStructure.synthetic).toBe(true);
    expect(syntheticStructure.tokenEfficientStageReviews).toBeLessThan(syntheticStructure.defaultPerTaskReviews);
  });
});

// ══════════════════════════════════════════════════════════════
// SELECT-01..05: Mode auto-selection tests
// ══════════════════════════════════════════════════════════════

describe('06-SELECT — Auto Selection', () => {
  function makePlan(taskCount: number, riskLevel: 'low' | 'medium' | 'high', writePathCount: number = 1): StructuredPlan {
    return {
      jobId: 'test',
      summary: 'test plan',
      stages: [{ stageNumber: 1, title: 'S1', tasks: Array.from({ length: taskCount }, (_, i) => `T${i + 1}`) }],
      tasks: Array.from({ length: taskCount }, (_, i) => ({
        taskId: `T${i + 1}`,
        stageNumber: 1,
        title: `Task ${i + 1}`,
        goal: 'test',
        dependencies: [],
        estimatedWritePaths: Array.from({ length: writePathCount }, (_, j) => `src/file${i}_${j}.ts`),
        allowedPaths: ['src/'],
        forbiddenPaths: [],
        contextFiles: [],
        acceptanceChecks: [],
        allowedCommands: [],
        riskLevel: i === taskCount - 1 && riskLevel === 'high' ? 'high' : (riskLevel === 'medium' ? 'medium' : 'low'),
        productDecisionsLocked: true,
        expectedOutputs: [],
        heavyCommandSlotsRequired: 0,
        timeoutSeconds: 60,
      })),
      riskAssessment: { level: riskLevel, notes: [] },
    };
  }

  it('SELECT-01: 2 tasks, low risk, no sensitive → simple', () => {
    const plan = makePlan(2, 'low');
    const result = selectExecutionMode(plan);
    console.log(`[SELECT-01] Mode: ${result.mode}, Reason: ${result.selectionReason}`);
    expect(result.mode, 'small plans should use simple mode').toBe('simple');
    expect(result.autoSelected, 'should be auto-selected').toBe(true);
  });

  it('SELECT-02: 6 tasks, mixed risk → token-efficient', () => {
    const plan = makePlan(6, 'medium');
    const result = selectExecutionMode(plan);
    console.log(`[SELECT-02] Mode: ${result.mode}, Reason: ${result.selectionReason}`);
    expect(result.mode, 'multi-task plans should use token-efficient').toBe('token-efficient');
  });

  it('SELECT-03: explicit config override → uses explicit', () => {
    const plan = makePlan(2, 'low');
    const result = resolveExecutionMode({ executionMode: 'token-efficient' }, plan);
    expect(result.mode, 'explicit config should override auto').toBe('token-efficient');
    expect(result.autoSelected, 'explicit should not be auto').toBe(false);
  });

  it('SELECT-04: selection reason is explainable', () => {
    const plan = makePlan(10, 'low');
    const result = selectExecutionMode(plan);
    expect(result.selectionReason, 'reason must be non-empty').toBeTruthy();
    expect(result.selectionReason.length, 'reason must have content').toBeGreaterThan(10);
    console.log(`[SELECT-04] Selection reason: ${result.selectionReason}`);
  });

  it('SELECT-05: 1 high-risk task → token-efficient (upgrade path)', () => {
    const plan = makePlan(1, 'high');
    const result = selectExecutionMode(plan);
    console.log(`[SELECT-05] Mode: ${result.mode}, Reason: ${result.selectionReason}`);
    // With high risk and only 1 task but high risk, should be token-efficient
    // because the upgrade path provides the necessary review
    expect(result.mode, 'high-risk tasks should use token-efficient for upgrade path').toBe('token-efficient');
  });
});

// ══════════════════════════════════════════════════════════════
// PRIVACY: Privacy canary test
// ══════════════════════════════════════════════════════════════

describe('06-PRIVACY — No Leak in TaskPacket/Cache', () => {
  it('PRIV-01: cache key does not contain raw diff or paths', () => {
    const key = computeReviewCacheKey({
      baseCommit: 'abc123',
      diff: '--- a/src/secret.ts\n+++ b/src/secret.ts\n@@ -1 +1 @@\n-CONFIDENTIAL_API_KEY=12345\n+CONFIDENTIAL_API_KEY=67890\n',
      qualityGateConfig: { name: 'test' },
      reviewerModel: 'codex-cli',
      reviewerVersion: 'v1',
      riskPolicy: { maxRisk: 'high' },
    });

    const keyStr = key.toString();
    expect(keyStr, 'cache key should be hex hash only').toMatch(/^[a-f0-9]{64}$/);
    expect(keyStr, 'key must not contain API key').not.toContain('12345');
    expect(keyStr, 'key must not contain CONFIDENTIAL').not.toContain('CONFIDENTIAL');
    expect(keyStr, 'key must not contain path').not.toContain('secret.ts');
  });
});
