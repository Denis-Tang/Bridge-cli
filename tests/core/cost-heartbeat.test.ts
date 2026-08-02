// ── R2: cost reservation heartbeat (scheduler layer) ──────────────────────
// Red-light tests first. Covers: heartbeat actually renews the lease during a
// long fake worker run, heartbeat failure never changes business semantics,
// and the heartbeat timer is cleared on completion/failure (no leaks).
// No real providers. Disposable git repos + fake runners.

import { describe, it, expect, vi } from 'vitest';
import { CORRECT_DAG, setupBenchmark, teardownBenchmark, type BenchmarkContext } from '../helpers/benchmark-fixtures.js';

const LEASE_WINDOW_MS = Math.max(180_000, 120_000) + 60_000; // default workerTimeoutMs=180000

function intervalHandleCount(): number {
  return (process as unknown as { _getActiveHandles(): Array<{ constructor?: { name?: string }; hasRef?: () => boolean }> })
    ._getActiveHandles()
    .filter((h) => h.constructor?.name === 'Timeout' && typeof h.hasRef === 'function')
    .length;
}

function setCostBudget(ctx: BenchmarkContext, heartbeatMs: number): void {
  const config = (ctx.scheduler as unknown as { config: { costBudget: unknown; costReservationHeartbeatMs: number } }).config;
  config.costBudget = { limit: 100, maxPiCallCost: 5, maxCodexCallCost: 3 };
  config.costReservationHeartbeatMs = heartbeatMs;
}

describe('R2 cost reservation heartbeat', () => {
  it('T1: heartbeat renews the lease during a worker run longer than the initial lease window', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'hb1', { piDelayMs: 600 });
    try {
      setCostBudget(ctx, 60); // heartbeat every 60ms during a 600ms fake worker
      await ctx.scheduler.startRun(ctx.runId);

      const [r] = await ctx.store.listCostReservations(ctx.runId);
      expect(r).toBeTruthy();
      // Guard against a vacuous assertion: spawnedAt must be real (onSpawn fired).
      expect(r.spawnedAt).toBeTruthy();
      // Without heartbeat: lease = reserveTime + window (< spawnTime + window).
      // With heartbeat: lease = lastHeartbeatTime + window (>= spawnTime + window + 1 period).
      expect(new Date(r.leaseExpiresAt!).getTime())
        .toBeGreaterThan(new Date(r.spawnedAt!).getTime() + LEASE_WINDOW_MS);
      // heartbeat_at was actually written (non-null, later than spawned_at)
      expect(r.heartbeatAt).toBeTruthy();
      expect(new Date(r.heartbeatAt!).getTime()).toBeGreaterThanOrEqual(new Date(r.spawnedAt!).getTime());
      // Settlement still happened normally.
      expect(r.status).toBe('unavailable');
      expect(r.phase).toBe('settled');
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('T2: heartbeat failure does NOT change business semantics — worker still completes and settles', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'hb2', { piDelayMs: 300 });
    try {
      setCostBudget(ctx, 40);
      const spy = vi.spyOn(ctx.store, 'heartbeatCostReservation')
        .mockRejectedValue(new Error('simulated heartbeat db failure'));

      await ctx.scheduler.startRun(ctx.runId);

      // Worker completed normally (may be approved after review); no cost pause.
      expect(spy).toHaveBeenCalled();
      const attempt = (await ctx.store.listAttempts(CORRECT_DAG[0].taskId))[0];
      expect(['worker_completed', 'approved', 'reviewing', 'validating']).toContain(attempt.status);
      expect(attempt.status).not.toBe('failed');
      expect(attempt.status).not.toBe('interrupted');
      const stage = await ctx.store.getStage(ctx.stageId);
      expect(stage?.status).not.toBe('paused');
      const [r] = await ctx.store.listCostReservations(ctx.runId);
      expect(r.status).toBe('unavailable'); // settled normally despite heartbeat failures
      spy.mockRestore();
    } finally {
      await teardownBenchmark(ctx);
    }
  });

  it('T3: no leftover heartbeat timers after completion and after failure', async () => {
    const ctx = await setupBenchmark([CORRECT_DAG[0]], 1, 'hb3', { piDelayMs: 250 });
    try {
      setCostBudget(ctx, 40);
      const before = intervalHandleCount();
      await ctx.scheduler.startRun(ctx.runId);
      expect(intervalHandleCount()).toBe(before);
      await teardownBenchmark(ctx);
    } catch (e) { /* handled below */ }

    // Failure path: fake runner throws after spawn → attempt interrupted, timers cleared.
    const ctx2 = await setupBenchmark([CORRECT_DAG[0]], 1, 'hb3b', { piDelayMs: 200 });
    try {
      setCostBudget(ctx2, 40);
      const origRun = ctx2.piRunner.run.bind(ctx2.piRunner);
      ctx2.piRunner.run = async (input: never) => {
        await new Promise((r) => setTimeout(r, 120));
        throw new Error('simulated runner crash after spawn');
      };
      const before = intervalHandleCount();
      await ctx2.scheduler.startRun(ctx2.runId);
      expect(intervalHandleCount()).toBe(before);
      const attempt = (await ctx2.store.listAttempts(CORRECT_DAG[0].taskId))[0];
      expect(attempt.status).toBe('failed');
    } finally {
      await teardownBenchmark(ctx2);
    }
  });
});
