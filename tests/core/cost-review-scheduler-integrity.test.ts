import { describe, expect, it } from 'vitest';
import {
  CORRECT_DAG,
  setupBenchmark,
  teardownBenchmark,
} from '../helpers/benchmark-fixtures.js';

describe('cost and final-review scheduler integrity', () => {
  it('blocks a non-injected real worker before spawn when costBudget is missing', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'cost-missing');
    try {
      const config = (ctx.scheduler as any).config;
      config.piProcessRunner = undefined;
      config.costBudget = null;

      await ctx.scheduler.startRun(ctx.runId);

      expect(ctx.piRunner.calls).toBe(0);
      expect((await ctx.store.listAttempts(CORRECT_DAG[0].taskId))[0]).toMatchObject({
        status: 'interrupted',
        exitReason: 'cost_budget_missing',
      });
      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('paused');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('blocks a non-injected real worker before spawn when worst-case cost exceeds the remaining budget', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'cost-insufficient');
    try {
      const config = (ctx.scheduler as any).config;
      config.piProcessRunner = undefined;
      config.costBudget = {
        limit: 1, maxPiCallCost: 2, maxCodexCallCost: 1,
      };

      await ctx.scheduler.startRun(ctx.runId);

      expect(ctx.piRunner.calls).toBe(0);
      expect((await ctx.store.listAttempts(CORRECT_DAG[0].taskId))[0]?.exitReason).toContain('cost_budget_exceeded');
      expect(await ctx.store.listCostReservations(ctx.runId)).toHaveLength(0);
      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('paused');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('requires a real Codex reviewer before a non-injected real worker can start', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'real-review-required');
    try {
      const config = (ctx.scheduler as any).config;
      config.piProcessRunner = undefined;
      config.allowRealReviewer = false;
      config.reviewerConfig = { type: 'local-rule' };

      await ctx.scheduler.startRun(ctx.runId);

      expect(ctx.piRunner.calls).toBe(0);
      expect(await ctx.store.listAttempts(CORRECT_DAG[0].taskId)).toHaveLength(0);
      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('paused');
      const events = await ctx.store.listEvents(ctx.runId, 'stage_paused');
      expect(events.some((event) => event.eventDataJson?.includes('real_worker_requires_real_codex_reviewer'))).toBe(true);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('keeps worker_completed and pauses instead of creating rework when the reviewer process fails', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'reviewer-unavailable');
    try {
      ctx.codexRunner.run = async () => ({
        stdout: '', stderr: 'test-only reviewer failure', exitCode: 9, durationMs: 2,
      });

      await ctx.scheduler.startRun(ctx.runId);

      const [attempt] = await ctx.store.listAttempts(CORRECT_DAG[0].taskId);
      expect(attempt.status).toBe('worker_completed');
      expect((await ctx.store.getTask(CORRECT_DAG[0].taskId))?.status).toBe('worker_completed');
      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('paused');
      const [review] = await ctx.store.listReviewsByAttempt(attempt.id);
      expect(review).toMatchObject({ status: 'failed', reviewerUnavailable: true, errorCategory: 'nonzero_exit', exitCode: 9 });
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('records complete coverage from the reviewed integration commit through the final merge tree', async () => {
    const ctx = await setupBenchmark(CORRECT_DAG.slice(0, 2), 2, 'final-review-coverage', { executionMode: 'token-efficient' });
    try {
      await ctx.scheduler.startRun(ctx.runId);

      const [batch] = await ctx.store.listIntegrationBatches(ctx.stageId);
      expect(batch).toMatchObject({ status: 'completed', reviewCoverageStatus: 'complete', reviewerUnavailable: false });
      expect(batch.reviewedThroughCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(batch.finalCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(ctx.codexRunner.calls).toBe(1);
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('pauses with partial coverage and does not call the reviewer when full input exceeds proxy ceilings', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'final-review-input-limit', { executionMode: 'token-efficient' });
    try {
      const config = (ctx.scheduler as unknown as { config: { stageReviewInputLimits?: { maxBytes: number; maxLines: number } } }).config;
      config.stageReviewInputLimits = { maxBytes: 64, maxLines: 2 };

      await ctx.scheduler.startRun(ctx.runId);

      const [batch] = await ctx.store.listIntegrationBatches(ctx.stageId);
      expect(batch).toMatchObject({ status: 'failed', reviewCoverageStatus: 'partial', reviewerUnavailable: false });
      expect(batch.reviewMetadataJson).toContain('review_input_limit_exceeded');
      expect(batch.reviewMetadataJson).toContain('proxy_not_token');
      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('paused');
      expect((await ctx.store.getRun(ctx.runId))?.status).toBe('running');
      expect((await ctx.store.getTask(CORRECT_DAG[0].taskId))?.status).toBe('review_skipped');
      expect(ctx.codexRunner.calls).toBe(0);
      const events = await ctx.store.listEvents(ctx.runId, 'stage_review_input_limit_exceeded');
      expect(events).toHaveLength(1);
      const convergenceFailures = await ctx.store.listEvents(ctx.runId, 'run_convergence_failed');
      expect(convergenceFailures).toHaveLength(0);
    } finally {
      await teardownBenchmark(ctx);
    }
  });
});
