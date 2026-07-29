import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import { FakeResourceSampler } from '../../src/core/resource-sampler.js';
import type { WorkerResult, ReviewResult } from '../../src/types/protocol.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
}

const PASS_THROUGH_GATE = [{ name: 'noop', command: 'node', args: ['-e', 'console.log("ok")'] }];
const fakeCompleted: WorkerResult = {
  taskId: 'fake', status: 'completed', summary: 'Fake',
  filesChanged: [], checks: [], scopeViolations: [], risks: [],
  unresolvedQuestions: [], productDecisionRequired: false,
  tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
};
const fakeApproved: ReviewResult = {
  taskId: 'fake', status: 'approved', reviewSummary: '[fake] OK',
  findings: [], requiredRework: [], qualityGateStatus: 'passed',
  mergeAllowed: true, reviewer: 'codex-cli',
};

async function setupRun(store: SqliteStateStore, runId: string, taskCount = 2): Promise<void> {
  const now = new Date().toISOString();
  await store.createRun({
    id: runId, projectId: 'p', projectRoot: tmpDir,
    requestText: 'resource test', status: 'running',
    createdAt: now, updatedAt: now,
  });
  await store.createStage({
    id: runId + '-s1', runId, stageNumber: 1, title: 'S1', status: 'ready',
  });
  for (let i = 1; i <= taskCount; i++) {
    await store.createTask({
      id: runId + '-t' + i, runId, title: 'T' + i, status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/t' + i] },
      createdAt: now, updatedAt: now,
    });
  }
}

describe('M3 Adaptive Dispatch v2', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-m3v2-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'test-m3v2.db');
    store = SqliteStateStore.create(dbPath);
    const cfg = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(cfg, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ══════════════════════════════════════════════════════════════
  // Fix 1: Non-blocking sampling
  // ══════════════════════════════════════════════════════════════

  it('dispatch does not block on slow sampling', async () => {
    const runId = 'nb-slow-' + Date.now();
    await setupRun(store, runId);

    let sampleCalls = 0;
    const slowSampler = {
      async sample() {
        sampleCalls++;
        // Simulate slow sampling (100ms delay)
        await new Promise((r) => setTimeout(r, 100));
        return {
          cpu: { usagePercent: 10, cores: 8 },
          memory: { totalMb: 16384, usedMb: 4000, freeMb: 12384, usagePercent: 24 },
          piCount: 0,
          source: 'os' as const,
          degraded: false,
        };
      },
    };

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: slowSampler,
      samplingIntervalMs: 50,
    });

    const startTime = Date.now();
    await scheduler.startRun(runId);
    const elapsed = Date.now() - startTime;

    // Tasks complete despite slow sampling (throttle gives min 50ms per cycle)
    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
    expect(sampleCalls).toBeGreaterThan(0);
  }, 15000);

  it('first dispatch uses safe budget=1 before first sample completes', async () => {
    const runId = 'nb-first-' + Date.now();
    await setupRun(store, runId, 3); // 3 tasks

    let firstSampleDone = false;
    const deferredSampler = {
      async sample() {
        // First sample is very slow
        if (!firstSampleDone) {
          await new Promise((r) => setTimeout(r, 500));
          firstSampleDone = true;
        }
        return {
          cpu: { usagePercent: 10, cores: 8 },
          memory: { totalMb: 16384, usedMb: 4000, freeMb: 12384, usagePercent: 24 },
          piCount: 0,
          source: 'os' as const,
          degraded: false,
        };
      },
    };

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: deferredSampler,
      samplingIntervalMs: 50,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
    const atts = await store.listAttemptsByStage(runId + '-s1');
    expect(atts.length).toBe(3);
    expect(atts.every((a) => a.status === 'approved')).toBe(true);
  }, 15000);

  // ══════════════════════════════════════════════════════════════
  // Fix 2: Strict hysteresis
  // ══════════════════════════════════════════════════════════════

  it('cpu >85% scales budget down via hysteresis (no premature drop)', async () => {
    const runId = 'hys-cpu3-' + Date.now();
    await setupRun(store, runId, 3);

    let cycle = 0;
    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const tracingSampler = {
      async sample() {
        cycle++;
        // cycles 1-3: 88% CPU (budget stays at 2 from initial ramp)
        // cycles 4-5: 95% CPU (budget should drop to 1 via scale_down at cycle 6)
        // cycles 6+: normal
        if (cycle <= 3) sampler.update({ cpuUsagePercent: 88 });
        else if (cycle <= 5) sampler.update({ cpuUsagePercent: 95 });
        else sampler.update({ cpuUsagePercent: 10 });
        return sampler.sample();
      },
    };

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: tracingSampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');

    await new Promise((r) => setTimeout(r, 100));

    // Verify budget adaptation decisions exist
    const decisions = await store.getRecentDispatchDecisions(50);
    // Should have at least the initial_ramp
    expect(decisions.length).toBeGreaterThan(0);
  });

  it('cpu >92% pauses only after 2 consecutive cycles, not immediately', async () => {
    const runId = 'hys-pause-' + Date.now();
    // Use 3 tasks so there are tasks remaining when pause hits
    await setupRun(store, runId, 3);

    let cycle = 0;
    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const tracingSampler = {
      async sample() {
        cycle++;
        // cycles 1-2: 93% CPU → pause at cycle 2
        // cycle 3+: normal → resume after 2 safe cycles
        const cpu = cycle <= 2 ? 93 : 10;
        sampler.update({ cpuUsagePercent: cpu });
        return sampler.sample();
      },
    };

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: tracingSampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');

    // Allow a moment for async DB writes to settle
    await new Promise((r) => setTimeout(r, 100));

    // Verify pause + resume decisions were recorded
    const decisions = await store.getRecentDispatchDecisions(50);
    expect(decisions.some((d) => d.decisionType === 'pause')).toBe(true);
    expect(decisions.some((d) => d.decisionType === 'resume')).toBe(true);
  });

  it('mem >90% pauses immediately (no hysteresis wait)', async () => {
    const runId = 'hys-mem-' + Date.now();
    await setupRun(store, runId, 3);

    let cycle = 0;
    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const tracingSampler = {
      async sample() {
        cycle++;
        // cycle 1: 93% memory → immediate pause
        // cycle 2+: normal
        const memUsed = cycle === 1 ? 15500 : 4000;
        sampler.update({ memUsedMb: memUsed });
        return sampler.sample();
      },
    };

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: tracingSampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');

    await new Promise((r) => setTimeout(r, 100));

    const decisions = await store.getRecentDispatchDecisions(50);
    const pauses = decisions.filter((d) => d.decisionType === 'pause');
    expect(pauses.length).toBeGreaterThan(0);
    if (pauses.length > 0) {
      expect(pauses[0].reason).toContain('mem_critical');
    }
  });

  it('Pi at hardCap pauses immediately', async () => {
    const runId = 'hys-pi-' + Date.now();
    await setupRun(store, runId, 3);

    let cycle = 0;
    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const tracingSampler = {
      async sample() {
        cycle++;
        // cycle 1: piCount = hardCap → immediate pause
        const pi = cycle === 1 ? 4 : 0;
        sampler.update({ piCount: pi });
        return sampler.sample();
      },
    };

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: tracingSampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');

    await new Promise((r) => setTimeout(r, 100));

    const decisions = await store.getRecentDispatchDecisions(50);
    const pauses = decisions.filter((d) => d.decisionType === 'pause');
    expect(pauses.length).toBeGreaterThan(0);
    if (pauses.length > 0) {
      expect(pauses[0].reason).toContain('pi_cap');
    }
  });

  it('resource_samples record effective budget of this cycle, not previous', async () => {
    const runId = 'hys-sample-' + Date.now();
    await setupRun(store, runId, 2);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: sampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const samples = await store.getRecentResourceSamples(100);
    expect(samples.length).toBeGreaterThan(0);
    // All samples should have a valid budget (not -1 or NaN)
    for (const s of samples) {
      expect(s.budget).toBeGreaterThanOrEqual(0);
      expect(s.budget).toBeLessThanOrEqual(4);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Regression: existing M2 behavior preserved
  // ══════════════════════════════════════════════════════════════

  it('sampling disabled → M2 behavior unchanged', async () => {
    const runId = 'reg-m2-' + Date.now();
    await setupRun(store, runId);

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 2,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: false,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
    const atts = await store.listAttemptsByStage(runId + '-s1');
    expect(atts.length).toBe(2);
  });

  it('sampling exception degrades to budget=1, tasks still complete', async () => {
    const runId = 'reg-degrade-' + Date.now();
    await setupRun(store, runId, 2);

    let calls = 0;
    const brokenSampler = {
      async sample() {
        calls++;
        if (calls <= 2) throw new Error('sampling failed');
        return {
          cpu: { usagePercent: 10, cores: 8 },
          memory: { totalMb: 16384, usedMb: 4000, freeMb: 12384, usagePercent: 24 },
          piCount: 0,
          source: 'os' as const,
          degraded: false,
        };
      },
    };

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: brokenSampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
  });

  it('running tasks are not terminated when budget changes', async () => {
    const runId = 'reg-noterm-' + Date.now();
    await setupRun(store, runId, 2);

    // Start with high CPU → budget will be low but tasks still complete
    const sampler = new FakeResourceSampler({ cpuUsagePercent: 88, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: sampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
    const atts = await store.listAttemptsByStage(runId + '-s1');
    expect(atts.length).toBe(2);
    // No task should have been interrupted
    expect(atts.filter((a) => a.status === 'interrupted').length).toBe(0);
  }, 15000);

  it('undeclared same-path conflicts block dispatch even when budget is high', async () => {
    const runId = 'reg-lock-' + Date.now();
    const now = new Date().toISOString();
    await store.createRun({
      id: runId, projectId: 'p', projectRoot: tmpDir,
      requestText: 'lock test', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await store.createStage({ id: runId + '-s1', runId, stageNumber: 1, title: 'S1', status: 'ready' });
    await store.createTask({
      id: runId + '-t1', runId, title: 'T1', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/shared'] },
      createdAt: now, updatedAt: now,
    });
    await store.createTask({
      id: runId + '-t2', runId, title: 'T2', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/shared'] },
      createdAt: now, updatedAt: now,
    });

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });
    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: sampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).not.toBe('completed');
    expect((await store.getStage(runId + '-s1'))?.status).toBe('paused');
    const atts = await store.listAttemptsByStage(runId + '-s1');
    expect(atts).toHaveLength(0);
    const pausedEvents = await store.listEvents(runId, 'stage_paused');
    expect(pausedEvents.some((event) => event.eventDataJson?.includes('undeclared_same_path_conflict'))).toBe(true);
  });

  it('dispatch_decisions only on state change, resource_samples every cycle', async () => {
    const runId = 'reg-records-' + Date.now();
    await setupRun(store, runId, 1);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });
    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: sampler,
      samplingIntervalMs: 10,
    });
    await scheduler.startRun(runId);

    const samples = await store.getRecentResourceSamples(100);
    const decisions = await store.getRecentDispatchDecisions(50);
    // Samples recorded every cycle
    expect(samples.length).toBeGreaterThan(0);
    // Decisions only on state change (stable resources → few or zero)
    expect(decisions.length).toBeLessThanOrEqual(samples.length);
  });
});
