import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { FakeResourceSampler } from '../../src/core/resource-sampler.js';
import { buildStatusSnapshot } from '../../src/core/status-snapshot.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('StatusSnapshot', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-snapshot-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'test-snapshot.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('builds snapshot with empty runs', async () => {
    const sampler = new FakeResourceSampler({ cpuUsagePercent: 25, piCount: 1 });
    const snapshot = await buildStatusSnapshot({ store, sampler, userMaxParallel: 4 });

    expect(snapshot.timestamp).toBeDefined();
    expect(snapshot.system.cpu.usagePercent).toBe(25);
    expect(snapshot.system.cpu.cores).toBe(8);
    expect(snapshot.system.memory.usagePercent).toBe(25); // from fake: usedMb proportional
    expect(snapshot.system.piProcesses.activeCount).toBe(1);
    expect(snapshot.system.budget.current).toBeGreaterThanOrEqual(1);
    expect(snapshot.system.sampled).toBe(true);
    expect(snapshot.system.degraded).toBe(false);
    expect(snapshot.runs).toEqual([]);
  });

  it('builds snapshot with a single run', async () => {
    // Create a run with stage and task
    const runId = 'snap-run-1';
    await store.createRun({
      id: runId, projectId: 'proj-1', projectRoot: '/tmp/p1',
      requestText: 'Test request for snapshot',
      status: 'planning',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    await store.createStage({ id: 'snap-stage-1', runId, stageNumber: 1, title: 'Stage One' });
    await store.createTask({
      id: 'snap-task-1', runId, title: 'Task One',
      status: 'pending', specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/a.txt'] },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    await store.createEvent({
      id: 'snap-ev-1', runId, eventType: 'plan_created', eventData: { source: 'test' },
    });

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 30 });
    const snapshot = await buildStatusSnapshot({ store, sampler, userMaxParallel: 4 }, runId);

    expect(snapshot.runs.length).toBe(1);
    const runSnap = snapshot.runs[0];
    expect(runSnap.id).toBe(runId);
    expect(runSnap.status).toBe('planning');
    expect(runSnap.requestText).toBe('Test request for snapshot');
    expect(runSnap.stages.length).toBe(1);
    expect(runSnap.stages[0].stageNumber).toBe(1);
    expect(runSnap.stages[0].title).toBe('Stage One');
    expect(runSnap.stages[0].tasks.length).toBe(1);
    expect(runSnap.stages[0].tasks[0].title).toBe('Task One');
    expect(runSnap.stages[0].tasks[0].dependencies).toEqual([]);
    expect(runSnap.stages[0].tasks[0].estimatedWritePaths).toEqual(['src/a.txt']);
    expect(runSnap.events.length).toBe(1);
    expect(runSnap.events[0].type).toBe('plan_created');
  });

  it('handles degraded sampler gracefully', async () => {
    const sampler = new FakeResourceSampler({ degraded: true, degradeReason: 'test_degradation' });
    const snapshot = await buildStatusSnapshot({ store, sampler, userMaxParallel: 4 });

    expect(snapshot.system.degraded).toBe(true);
    expect(snapshot.system.degradeReason).toBe('test_degradation');
    // Budget should still be computed (degraded → budget=1)
    expect(snapshot.system.budget.current).toBe(1);
  });

  it('handles sampler exception gracefully', async () => {
    const brokenSampler = {
      async sample() { throw new Error('Boom'); },
    };
    const snapshot = await buildStatusSnapshot({ store, sampler: brokenSampler, userMaxParallel: 4 });

    expect(snapshot.system.sampled).toBe(false);
    expect(snapshot.system.degraded).toBe(true);
    expect(snapshot.system.degradeReason).toBe('sampling_exception');
    expect(snapshot.system.budget.current).toBe(1);
    expect(snapshot.runs).toBeDefined(); // runs should still work
  });

  it('snapshot includes budget from computeBudget', async () => {
    const sampler = new FakeResourceSampler({
      cpuUsagePercent: 92, // should trigger high CPU pressure
      piCount: 2,
    });
    const snapshot = await buildStatusSnapshot({ store, sampler, userMaxParallel: 4 });

    expect(snapshot.system.cpu.usagePercent).toBe(92);
    // Budget should be reduced due to CPU pressure
    expect(snapshot.system.budget.current).toBeLessThan(4);
  });

  it('reads an integration target branch from the persisted stage event', async () => {
    const runId = 'snap-target-branch';
    const stageId = 'snap-target-stage';
    await store.createRun({
      id: runId, projectId: 'proj-target', projectRoot: '/tmp/p-target', requestText: 'target branch',
      status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'Target stage' });
    await store.createIntegrationBatch({
      id: 'snap-target-batch', stageId, runId, integrationBranch: 'brainctl/int/target/stage-1',
    });
    await store.createEvent({
      id: 'snap-target-event', runId, stageId, eventType: 'integration_completed',
      eventData: { integrationBranch: 'brainctl/int/target/stage-1', targetBranch: 'release/2026.07' },
    });

    const snapshot = await buildStatusSnapshot({
      store, sampler: new FakeResourceSampler({ cpuUsagePercent: 30 }), userMaxParallel: 4,
    }, runId);
    expect(snapshot.runs[0].stages[0].integration!.targetBranch).toBe('release/2026.07');
  });
});
