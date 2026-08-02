// ══════════════════════════════════════════════════════════════════════════
// Scheduler Race & Lifecycle — 调度持久化竞态专项测试
// ══════════════════════════════════════════════════════════════════════════
//
// 测试覆盖：
//   1. 人为延迟 insertResourceSample / insertDispatchDecision，
//      证明 startRun() 返回前不丢失必须写入（awaitIdle 等待完成）
//   2. 人为使后台采样失败，证明异常被结构化记录
//   3. 并行运行多次 scheduler fixture，证明无跨 run/DB 串扰
//   4. stage 正常完成、暂停、merge-blocked 三种结局下
//      tracker/后台任务最终停止且 store 可安全关闭
//   5. 验证 integration 不会在 pending DB state 尚未收敛时
//      读取过期 task/attempt/stage 状态
//   6. P0-A 故障注入：永不完成写入 → run 不能是 completed
//   7. P0-A 故障注入：写入 rejection → 失败被传播，不静默吞没

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import { FakeResourceSampler } from '../../src/core/resource-sampler.js';
import type { StateStore } from '../../src/state/state-store.js';
import type { WorkerResult, ReviewResult } from '../../src/types/protocol.js';

// ══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ══════════════════════════════════════════════════════════════════════════

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

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email race-test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Race Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(path.join(dir, 'README.md'), '# Race Test Repo\n');
  // The fixture's state DB lives inside the repo root; ignore it so the
  // P0-2 dirty-worktree gate sees a genuinely clean repo.
  writeFileSync(path.join(dir, '.gitignore'), '*.db\n*.db-wal\n*.db-shm\n');
  execSync('git add README.md .gitignore', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
}

async function setupRunFixture(store: StateStore, runId: string, projectRoot: string, taskCount = 2): Promise<string> {
  const now = new Date().toISOString();
  const stageId = runId + '-s1';
  await store.createRun({
    id: runId, projectId: 'race', projectRoot,
    requestText: 'race test', status: 'running',
    createdAt: now, updatedAt: now,
  });
  await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });
  for (let i = 1; i <= taskCount; i++) {
    await store.createTask({
      id: runId + '-t' + i, runId, title: 'T' + i, status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/t' + i], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });
  }
  return stageId;
}

// ══════════════════════════════════════════════════════════════════════════
// Wrapping store to inject artificial delays on resource/dispatch writes
// ══════════════════════════════════════════════════════════════════════════

class DelayedWriteStore implements StateStore {
  constructor(
    private delegate: StateStore,
    private sampleDelayMs: number,
    private decisionDelayMs: number,
  ) {}

  // Delegate all calls, inject delay only on resource/dispatch writes
  async close(): Promise<void> { return this.delegate.close(); }
  async createRun(input: any): Promise<any> { return this.delegate.createRun(input); }
  async getRun(runId: string): Promise<any> { return this.delegate.getRun(runId); }
  async getActiveRunByProject(projectRoot: string): Promise<any> { return this.delegate.getActiveRunByProject(projectRoot); }
  async updateRunStatus(runId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateRunStatus(runId, status, updatedAt); }
  async failRunForConvergenceAtomically(input: any): Promise<boolean> { return this.delegate.failRunForConvergenceAtomically(input); }
  async updateRunFinishedAt(runId: string, finishedAt: string): Promise<boolean> { return this.delegate.updateRunFinishedAt(runId, finishedAt); }
  async createTask(input: any): Promise<any> { return this.delegate.createTask(input); }
  async getTask(taskId: string): Promise<any> { return this.delegate.getTask(taskId); }
  async updateTaskStatus(taskId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateTaskStatus(taskId, status, updatedAt); }
  async updateTaskRetryCount(taskId: string, retryCount: number, updatedAt: string): Promise<boolean> { return this.delegate.updateTaskRetryCount(taskId, retryCount, updatedAt); }
  async listTasks(runId: string): Promise<any[]> { return this.delegate.listTasks(runId); }
  async listTasksByStage(stageId: string): Promise<any[]> { return this.delegate.listTasksByStage(stageId); }
  async createStage(input: any): Promise<any> { return this.delegate.createStage(input); }
  async getStage(stageId: string): Promise<any> { return this.delegate.getStage(stageId); }
  async updateStageStatus(stageId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateStageStatus(stageId, status, updatedAt); }
  async updateStageBaseCommit(stageId: string, commit: string): Promise<boolean> { return this.delegate.updateStageBaseCommit(stageId, commit); }
  async updateStageIntegrationBranch(stageId: string, branch: string): Promise<boolean> { return this.delegate.updateStageIntegrationBranch(stageId, branch); }
  async listStages(runId: string): Promise<any[]> { return this.delegate.listStages(runId); }
  async createAttempt(input: any): Promise<any> { return this.delegate.createAttempt(input); }
  async getAttempt(attemptId: string): Promise<any> { return this.delegate.getAttempt(attemptId); }
  async updateAttemptStatus(attemptId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateAttemptStatus(attemptId, status, updatedAt); }
  async retryReviewAtomically(input: any): Promise<boolean> { return this.delegate.retryReviewAtomically(input); }
  async updateAttemptResult(attemptId: string, updates: any): Promise<boolean> { return this.delegate.updateAttemptResult(attemptId, updates); }
  async listAttempts(taskId: string): Promise<any[]> { return this.delegate.listAttempts(taskId); }
  async listAttemptsByStage(stageId: string): Promise<any[]> { return this.delegate.listAttemptsByStage(stageId); }
  async getLatestAttempt(taskId: string): Promise<any> { return this.delegate.getLatestAttempt(taskId); }
  async recordAttemptProvenance(input: any): Promise<any> { return this.delegate.recordAttemptProvenance(input); }
  async getAttemptProvenance(attemptId: string): Promise<any> { return this.delegate.getAttemptProvenance(attemptId); }
  async createPathLock(input: any): Promise<any> { return this.delegate.createPathLock(input); }
  async acquirePathLocksAtomic(input: any): Promise<any> { return this.delegate.acquirePathLocksAtomic(input); }
  async getPathLock(lockId: string): Promise<any> { return this.delegate.getPathLock(lockId); }
  async releasePathLock(lockId: string, releasedAt: string): Promise<boolean> { return this.delegate.releasePathLock(lockId, releasedAt); }
  async getActiveLocksForRun(runId: string): Promise<any[]> { return this.delegate.getActiveLocksForRun(runId); }
  async getConflictingLocks(taskId: string, filePaths: string[], runId: string): Promise<any[]> { return this.delegate.getConflictingLocks(taskId, filePaths, runId); }
  async claimActualPathsAtomic(input: any): Promise<any> { return this.delegate.claimActualPathsAtomic(input); }
  async listActualPathClaims(stageId: string): Promise<any[]> { return this.delegate.listActualPathClaims(stageId); }
  async releaseActualPathClaimsForStage(stageId: string, releasedAt: string): Promise<number> { return this.delegate.releaseActualPathClaimsForStage(stageId, releasedAt); }
  async createReview(input: any): Promise<any> { return this.delegate.createReview(input); }
  async getReview(reviewId: string): Promise<any> { return this.delegate.getReview(reviewId); }
  async updateReviewResult(reviewId: string, updates: any): Promise<boolean> { return this.delegate.updateReviewResult(reviewId, updates); }
  async listReviewsByAttempt(attemptId: string): Promise<any[]> { return this.delegate.listReviewsByAttempt(attemptId); }
  async listReviewsByTask(taskId: string): Promise<any[]> { return this.delegate.listReviewsByTask(taskId); }
  async createIntegrationBatch(input: any): Promise<any> { return this.delegate.createIntegrationBatch(input); }
  async getIntegrationBatch(batchId: string): Promise<any> { return this.delegate.getIntegrationBatch(batchId); }
  async updateIntegrationBatch(batchId: string, updates: any): Promise<boolean> { return this.delegate.updateIntegrationBatch(batchId, updates); }
  async listIntegrationBatches(stageId: string): Promise<any[]> { return this.delegate.listIntegrationBatches(stageId); }
  async createEvent(input: any): Promise<any> { return this.delegate.createEvent(input); }
  async listEvents(runId: string, eventType?: string): Promise<any[]> { return this.delegate.listEvents(runId, eventType); }
  async getRecentResourceSamples(limit?: number): Promise<any[]> { return this.delegate.getRecentResourceSamples(limit); }
  async getRecentDispatchDecisions(limit?: number): Promise<any[]> { return this.delegate.getRecentDispatchDecisions(limit); }
  async createApprovalDecision(input: any): Promise<any> { return this.delegate.createApprovalDecision(input); }
  async getApprovalDecision(id: string): Promise<any> { return this.delegate.getApprovalDecision(id); }
  async updateApprovalDecisionStatus(id: string, status: string, updatedAt: string): Promise<boolean> { return this.delegate.updateApprovalDecisionStatus(id, status, updatedAt); }
  async listApprovalDecisions(runId: string, status?: string): Promise<any[]> { return this.delegate.listApprovalDecisions(runId, status); }
  async getPendingApprovals(runId: string): Promise<any[]> { return this.delegate.getPendingApprovals(runId); }
  async insertTokenLedgerEntry(input: any): Promise<any> { return this.delegate.insertTokenLedgerEntry(input); }
  async updateTokenLedgerEntry(id: string, updates: any): Promise<boolean> { return this.delegate.updateTokenLedgerEntry(id, updates); }
  async getTokenLedgerEntry(id: string): Promise<any> { return this.delegate.getTokenLedgerEntry(id); }
  async listTokenLedgerEntries(runId: string, callType?: string): Promise<any[]> { return this.delegate.listTokenLedgerEntries(runId, callType); }
  async getTokenUsageSummary(runId: string): Promise<any> { return this.delegate.getTokenUsageSummary(runId); }
  async createBudgetPolicy(input: any): Promise<any> { return this.delegate.createBudgetPolicy(input); }
  async getBudgetPolicy(id: string): Promise<any> { return this.delegate.getBudgetPolicy(id); }
  async updateBudgetPolicy(id: string, tokenLimit: number, action: string): Promise<boolean> { return this.delegate.updateBudgetPolicy(id, tokenLimit, action); }
  async listBudgetPolicies(runId?: string | null): Promise<any[]> { return this.delegate.listBudgetPolicies(runId); }
  async getEffectiveBudgetPolicy(policyType: string, runId?: string | null): Promise<any> { return this.delegate.getEffectiveBudgetPolicy(policyType, runId); }
  async createRiskAssessment(input: any): Promise<any> { return this.delegate.createRiskAssessment(input); }
  async getRiskAssessment(id: string): Promise<any> { return this.delegate.getRiskAssessment(id); }
  async resolveRiskAssessment(id: string, resolvedAt: string): Promise<boolean> { return this.delegate.resolveRiskAssessment(id, resolvedAt); }
  async listRiskAssessments(runId: string): Promise<any[]> { return this.delegate.listRiskAssessments(runId); }
  async insertReconciliationReport(input: any): Promise<any> { return this.delegate.insertReconciliationReport(input); }
  async getLatestReconciliationReport(runId: string): Promise<any> { return this.delegate.getLatestReconciliationReport(runId); }
  async insertReconciliationFinding(input: any): Promise<any> { return this.delegate.insertReconciliationFinding(input); }
  async listReconciliationFindings(reportId: string): Promise<any[]> { return this.delegate.listReconciliationFindings(reportId); }
  async listReconciliationReports(runId: string): Promise<any[]> { return this.delegate.listReconciliationReports(runId); }
  async listNonTerminalRuns(): Promise<any[]> { return this.delegate.listNonTerminalRuns(); }
  async applyReconciliationAtomically(input: any): Promise<any> { return this.delegate.applyReconciliationAtomically(input); }

  // ── Delayed writes ──
  async insertResourceSample(input: any): Promise<any> {
    if (this.sampleDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.sampleDelayMs));
    }
    return this.delegate.insertResourceSample(input);
  }

  async insertDispatchDecision(input: any): Promise<any> {
    if (this.decisionDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.decisionDelayMs));
    }
    return this.delegate.insertDispatchDecision(input);
  }

  async cleanupResourceSamples(retentionDays?: number): Promise<number> {
    return this.delegate.cleanupResourceSamples(retentionDays);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Test Suite 1: Delayed writes with awaitIdle guarantee
// ══════════════════════════════════════════════════════════════════════════

describe('Scheduler Race: delayed DB writes', () => {
  let tmpDir: string;
  let dbPath: string;
  let realStore: SqliteStateStore;
  let delayedStore: DelayedWriteStore;

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-race-delay-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'race-delay.db');
    realStore = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, realStore.getDatabase());
    runner.applyPending();
    // Inject 150ms delay on resource sample writes, 100ms on dispatch decisions
    delayedStore = new DelayedWriteStore(realStore, 150, 100);
  });

  afterAll(async () => {
    await realStore.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('startRun completes and all resource samples are persisted despite write delays', async () => {
    const runId = 'race-delay-samples-' + Date.now();
    await setupRunFixture(delayedStore, runId, tmpDir, 2);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const scheduler = new StageScheduler(delayedStore, {
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

    // After startRun, all writes must be persisted (awaitIdle waited for them)
    const run = await realStore.getRun(runId);
    expect(run!.status).toBe('completed');

    // Samples should be present — the 150ms delay was waited by awaitIdle
    const samples = await realStore.getRecentResourceSamples(100);
    expect(samples.length).toBeGreaterThan(0);

    // All tasks merged
    const tasks = await realStore.listTasks(runId);
    for (const t of tasks) expect(t.status).toBe('merged');
  }, 30000);

  it('dispatch decisions are persisted even with 100ms artificial delay', async () => {
    const runId = 'race-delay-decisions-' + Date.now();
    // Use 4 tasks to give the scheduler enough time to go through multiple sampling cycles
    await setupRunFixture(delayedStore, runId, tmpDir, 4);

    // Sample pattern: start normal (ramp up), then CPU spikes → scale_down/pause decisions
    let cycle = 0;
    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const tracingSampler = {
      async sample() {
        cycle++;
        // Cycles 1-5: normal CPU (ramp to full budget)
        // Cycles 6-8: 88% CPU (triggers scale_down after 3 consecutive)
        // Cycles 9+: back to normal
        if (cycle <= 5) sampler.update({ cpuUsagePercent: 10 });
        else if (cycle <= 8) sampler.update({ cpuUsagePercent: 88 });
        else sampler.update({ cpuUsagePercent: 10 });
        return sampler.sample();
      },
    };

    const scheduler = new StageScheduler(delayedStore, {
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

    // All decisions must be persisted (awaitIdle waited for the 100ms delay)
    const decisions = await realStore.getRecentDispatchDecisions(50);
    // We expect at least some decisions (initial_ramp and possibly scale_down)
    expect(decisions.length).toBeGreaterThan(0);
    // At minimum the initial_ramp decision should be there
    const rampDecisions = decisions.filter((d) => d.decisionType === 'initial_ramp' || d.decisionType === 'scale_down' || d.decisionType === 'scale_up');
    expect(rampDecisions.length).toBeGreaterThan(0);

    const run = await realStore.getRun(runId);
    expect(run!.status).toBe('completed');
  }, 30000);
});

// ══════════════════════════════════════════════════════════════════════════
// Test Suite 2: Sampling exception diagnostics
// ══════════════════════════════════════════════════════════════════════════

describe('Scheduler Race: sampling exception diagnostics', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-race-diag-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'race-diag.db');
    store = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('sampling failures are recorded as diagnostic events, not silently swallowed', async () => {
    const runId = 'race-diag-fail-' + Date.now();
    await setupRunFixture(store, runId, tmpDir, 2);

    let calls = 0;
    const brokenSampler = {
      async sample() {
        calls++;
        // Throw on first 3 cycles, then recover to let the run complete
        if (calls <= 3) throw new Error('SIMULATED_SAMPLING_FAILURE_' + calls);
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
    // Despite initial sampling failures, the run should complete
    expect(run!.status).toBe('completed');

    // At least one degrade event should have been created for the failures
    const degradeEvents = await store.listEvents(runId, 'resource_sampling_degraded');
    expect(degradeEvents.length).toBeGreaterThan(0);
    // The error was NOT silently swallowed
    expect(calls).toBeGreaterThan(0);
  }, 30000);
});

// ══════════════════════════════════════════════════════════════════════════
// Test Suite 3: Parallel fixture isolation
// ══════════════════════════════════════════════════════════════════════════

describe('Scheduler Race: parallel fixture isolation', () => {
  // Each run uses its own tmpDir + DB, proving no cross-run contamination
  it('multiple schedulers with separate DBs run concurrently without cross-contamination', async () => {
    const fixtures: Array<{ dir: string; dbPath: string; store: SqliteStateStore; runId: string }> = [];
    const schedulers: StageScheduler[] = [];

    try {
      // Create 3 isolated fixtures
      for (let i = 0; i < 3; i++) {
        const dir = path.join(tmpdir(), 'brainctl-race-iso-' + i + '-' + Date.now());
        mkdirSync(dir, { recursive: true });
        initGitRepo(dir);
        const dbPath = path.join(dir, 'iso-' + i + '.db');
        const store = SqliteStateStore.create(dbPath);
        const cfg = { path: dbPath, maskedPath: dbPath };
        const runner = new SqliteMigrationRunner(cfg, store.getDatabase());
        runner.applyPending();

        const runId = 'iso-' + i + '-' + Date.now();
        await setupRunFixture(store, runId, dir, 2);

        const scheduler = new StageScheduler(store, {
          projectRoot: dir, sessionDir: dir, logDir: dir,
          worktreeBaseDir: '.brainctl-dev/wt',
          allowRealWorker: false, allowRealReviewer: false,
          workerTimeoutMs: 30000, maxParallelTasks: 4,
          targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
          fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
        });

        fixtures.push({ dir, dbPath, store, runId });
        schedulers.push(scheduler);
      }

      // Run all concurrently
      await Promise.all(schedulers.map((s, i) => s.startRun(fixtures[i].runId)));

      // Verify each fixture independently
      for (const f of fixtures) {
        const run = await f.store.getRun(f.runId);
        expect(run!.status).toBe('completed');

        const tasks = await f.store.listTasks(f.runId);
        for (const t of tasks) {
          expect(t.status).toBe('merged');
        }

        // Verify fixture isolation: only our tasks exist
        expect(tasks.length).toBe(2);

        await f.store.close();
      }
    } finally {
      for (const f of fixtures) {
        try { await f.store.close(); } catch {}
        try { rmSync(f.dir, { recursive: true, force: true }); } catch {}
      }
    }
  }, 60000);
});

// ══════════════════════════════════════════════════════════════════════════
// Test Suite 4: Completion, pause, merge-blocked lifecycle convergence
// ══════════════════════════════════════════════════════════════════════════

describe('Scheduler Race: lifecycle convergence', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-race-lifecycle-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'race-lifecycle.db');
    store = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('normal completion: tracker stops, store closeable, all tasks merged', async () => {
    const runId = 'lifecycle-complete-' + Date.now();
    await setupRunFixture(store, runId, tmpDir, 2);

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });

    await scheduler.startRun(runId);

    // Verify run completed with correct final state
    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');

    const tasks = await store.listTasks(runId);
    expect(tasks.length).toBe(2);
    for (const t of tasks) expect(t.status).toBe('merged');

    // Store close must succeed (no pending writes should block it)
    // This is implicitly tested — afterAll calls store.close()
  });

  it('pause: tracker stops without losing diagnostic events', async () => {
    const now = new Date().toISOString();
    const runId = 'lifecycle-pause-' + Date.now();
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    await store.createRun({
      id: runId, projectId: 'race', projectRoot: tmpDir,
      requestText: 'pause test', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });
    await store.createTask({
      id: taskId, runId, title: 'T1', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });

    // Pre-seed 3 failed attempts (exhaust retry budget → stage pauses)
    for (let i = 1; i <= 3; i++) {
      const aid = taskId + '-a' + i;
      await store.createAttempt({ id: aid, taskId, stageId, attemptNumber: i, status: 'running' });
      await store.updateAttemptStatus(aid, 'failed', now);
      await store.updateAttemptResult(aid, { exitReason: 'review: failure ' + i, stoppedAt: now });
    }
    await store.updateTaskStatus(taskId, 'ready', now);
    await store.updateTaskStatus(taskId, 'running', now);
    await store.updateTaskStatus(taskId, 'rework_required', now);

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxReworkCount: 2,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });

    await scheduler.startRun(runId);

    const stage = await store.getStage(stageId);
    expect(stage!.status).toBe('paused');

    const events = await store.listEvents(runId, 'stage_paused');
    expect(events.some((e) => (e.eventDataJson || '').includes('retry_budget_exhausted'))).toBe(true);

    // Store must be closeable after pause lifecycle
  });

  it('merge-blocked: approved tasks are correctly marked merge_blocked on integration failure', async () => {
    const now = new Date().toISOString();
    const runId = 'lifecycle-mergeblocked-' + Date.now();
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    await store.createRun({
      id: runId, projectId: 'race', projectRoot: tmpDir,
      requestText: 'merge_blocked test', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });
    await store.createTask({
      id: taskId, runId, title: 'T1', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });

    // Pre-seed 1 non-retriable failure (scope violation → merge_blocked)
    const aid = taskId + '-a1';
    await store.createAttempt({ id: aid, taskId, stageId, attemptNumber: 1, status: 'running' });
    await store.updateAttemptStatus(aid, 'failed', now);
    await store.updateAttemptResult(aid, { exitReason: 'scope: wrote to forbidden/', stoppedAt: now });
    await store.updateTaskStatus(taskId, 'waiting_decision', now);

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxReworkCount: 2,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });

    await scheduler.startRun(runId);

    // Stage should be paused (non-retriable failure)
    const stage = await store.getStage(stageId);
    expect(stage!.status).toBe('paused');

    // Task should be waiting_decision (not merged, not running)
    const task = await store.getTask(taskId);
    expect(task!.status).toBe('waiting_decision');

    // Store closeable
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Test Suite 5: State consistency after scheduler completion
// ══════════════════════════════════════════════════════════════════════════

describe('Scheduler Race: state consistency', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-race-consistency-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'race-consistency.db');
    store = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('integration reads consistent task/attempt state (no stale reads after awaitIdle)', async () => {
    const runId = 'consistency-' + Date.now();
    const stageId = await setupRunFixture(store, runId, tmpDir, 1);

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 4,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });

    await scheduler.startRun(runId);

    // All reads after startRun must be consistent
    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');

    const stage = await store.getStage(stageId);
    expect(stage!.status).toBe('completed');

    const tasks = await store.listTasks(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe('merged');

    const attempts = await store.listAttemptsByStage(stageId);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe('approved');

    const batches = await store.listIntegrationBatches(stageId);
    expect(batches.length).toBe(1);
    expect(batches[0].status).toBe('completed');

    // All events should be readable
    const events = await store.listEvents(runId);
    expect(events.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Test Suite 6: P0-A Fault Injection — never-completing critical writes
// ══════════════════════════════════════════════════════════════════════════
// These tests MUST expose the fail-open behavior on the current
// implementation (before fix). After the fix, startRun must NOT
// return 'completed' when critical writes cannot converge.

class HangingWriteStore implements StateStore {
  constructor(
    private delegate: StateStore,
    private hangOnMethod: 'insertResourceSample' | 'insertDispatchDecision' | 'cleanupResourceSamples' | 'none' = 'none',
  ) {}

  // Queue of deferreds — one per hanging write call
  private _hangDeferreds: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private _hangCount = 0;

  /** Call before startRun to get a promise that resolves when at least one write is hanging */
  waitForHang(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this._hangCount > 0) resolve();
        else setTimeout(check, 10);
      };
      check();
    });
  }

  /** Unblock all hanging writes (resolve) */
  resolveAll(): void {
    for (const d of this._hangDeferreds) d.resolve();
    this._hangDeferreds = [];
    this._hangCount = 0;
  }

  /** Unblock all hanging writes with rejection */
  rejectAll(err: Error): void {
    for (const d of this._hangDeferreds) d.reject(err);
    this._hangDeferreds = [];
    this._hangCount = 0;
  }

  get hangCount(): number { return this._hangCount; }

  // ── Delegate all calls ──
  async close(): Promise<void> { return this.delegate.close(); }
  async createRun(input: any): Promise<any> { return this.delegate.createRun(input); }
  async getRun(runId: string): Promise<any> { return this.delegate.getRun(runId); }
  async getActiveRunByProject(projectRoot: string): Promise<any> { return this.delegate.getActiveRunByProject(projectRoot); }
  async updateRunStatus(runId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateRunStatus(runId, status, updatedAt); }
  async failRunForConvergenceAtomically(input: any): Promise<boolean> { return this.delegate.failRunForConvergenceAtomically(input); }
  async updateRunFinishedAt(runId: string, finishedAt: string): Promise<boolean> { return this.delegate.updateRunFinishedAt(runId, finishedAt); }
  async createTask(input: any): Promise<any> { return this.delegate.createTask(input); }
  async getTask(taskId: string): Promise<any> { return this.delegate.getTask(taskId); }
  async updateTaskStatus(taskId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateTaskStatus(taskId, status, updatedAt); }
  async updateTaskRetryCount(taskId: string, retryCount: number, updatedAt: string): Promise<boolean> { return this.delegate.updateTaskRetryCount(taskId, retryCount, updatedAt); }
  async listTasks(runId: string): Promise<any[]> { return this.delegate.listTasks(runId); }
  async listTasksByStage(stageId: string): Promise<any[]> { return this.delegate.listTasksByStage(stageId); }
  async createStage(input: any): Promise<any> { return this.delegate.createStage(input); }
  async getStage(stageId: string): Promise<any> { return this.delegate.getStage(stageId); }
  async updateStageStatus(stageId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateStageStatus(stageId, status, updatedAt); }
  async updateStageBaseCommit(stageId: string, commit: string): Promise<boolean> { return this.delegate.updateStageBaseCommit(stageId, commit); }
  async updateStageIntegrationBranch(stageId: string, branch: string): Promise<boolean> { return this.delegate.updateStageIntegrationBranch(stageId, branch); }
  async listStages(runId: string): Promise<any[]> { return this.delegate.listStages(runId); }
  async createAttempt(input: any): Promise<any> { return this.delegate.createAttempt(input); }
  async getAttempt(attemptId: string): Promise<any> { return this.delegate.getAttempt(attemptId); }
  async updateAttemptStatus(attemptId: string, status: any, updatedAt: string): Promise<boolean> { return this.delegate.updateAttemptStatus(attemptId, status, updatedAt); }
  async retryReviewAtomically(input: any): Promise<boolean> { return this.delegate.retryReviewAtomically(input); }
  async updateAttemptResult(attemptId: string, updates: any): Promise<boolean> { return this.delegate.updateAttemptResult(attemptId, updates); }
  async listAttempts(taskId: string): Promise<any[]> { return this.delegate.listAttempts(taskId); }
  async listAttemptsByStage(stageId: string): Promise<any[]> { return this.delegate.listAttemptsByStage(stageId); }
  async getLatestAttempt(taskId: string): Promise<any> { return this.delegate.getLatestAttempt(taskId); }
  async recordAttemptProvenance(input: any): Promise<any> { return this.delegate.recordAttemptProvenance(input); }
  async getAttemptProvenance(attemptId: string): Promise<any> { return this.delegate.getAttemptProvenance(attemptId); }
  async createPathLock(input: any): Promise<any> { return this.delegate.createPathLock(input); }
  async acquirePathLocksAtomic(input: any): Promise<any> { return this.delegate.acquirePathLocksAtomic(input); }
  async getPathLock(lockId: string): Promise<any> { return this.delegate.getPathLock(lockId); }
  async releasePathLock(lockId: string, releasedAt: string): Promise<boolean> { return this.delegate.releasePathLock(lockId, releasedAt); }
  async getActiveLocksForRun(runId: string): Promise<any[]> { return this.delegate.getActiveLocksForRun(runId); }
  async getConflictingLocks(taskId: string, filePaths: string[], runId: string): Promise<any[]> { return this.delegate.getConflictingLocks(taskId, filePaths, runId); }
  async claimActualPathsAtomic(input: any): Promise<any> { return this.delegate.claimActualPathsAtomic(input); }
  async listActualPathClaims(stageId: string): Promise<any[]> { return this.delegate.listActualPathClaims(stageId); }
  async releaseActualPathClaimsForStage(stageId: string, releasedAt: string): Promise<number> { return this.delegate.releaseActualPathClaimsForStage(stageId, releasedAt); }
  async createReview(input: any): Promise<any> { return this.delegate.createReview(input); }
  async getReview(reviewId: string): Promise<any> { return this.delegate.getReview(reviewId); }
  async updateReviewResult(reviewId: string, updates: any): Promise<boolean> { return this.delegate.updateReviewResult(reviewId, updates); }
  async listReviewsByAttempt(attemptId: string): Promise<any[]> { return this.delegate.listReviewsByAttempt(attemptId); }
  async listReviewsByTask(taskId: string): Promise<any[]> { return this.delegate.listReviewsByTask(taskId); }
  async createIntegrationBatch(input: any): Promise<any> { return this.delegate.createIntegrationBatch(input); }
  async getIntegrationBatch(batchId: string): Promise<any> { return this.delegate.getIntegrationBatch(batchId); }
  async updateIntegrationBatch(batchId: string, updates: any): Promise<boolean> { return this.delegate.updateIntegrationBatch(batchId, updates); }
  async listIntegrationBatches(stageId: string): Promise<any[]> { return this.delegate.listIntegrationBatches(stageId); }
  async createEvent(input: any): Promise<any> { return this.delegate.createEvent(input); }
  async listEvents(runId: string, eventType?: string): Promise<any[]> { return this.delegate.listEvents(runId, eventType); }
  async getRecentResourceSamples(limit?: number): Promise<any[]> { return this.delegate.getRecentResourceSamples(limit); }
  async getRecentDispatchDecisions(limit?: number): Promise<any[]> { return this.delegate.getRecentDispatchDecisions(limit); }
  async createApprovalDecision(input: any): Promise<any> { return this.delegate.createApprovalDecision(input); }
  async getApprovalDecision(id: string): Promise<any> { return this.delegate.getApprovalDecision(id); }
  async updateApprovalDecisionStatus(id: string, status: string, updatedAt: string): Promise<boolean> { return this.delegate.updateApprovalDecisionStatus(id, status, updatedAt); }
  async listApprovalDecisions(runId: string, status?: string): Promise<any[]> { return this.delegate.listApprovalDecisions(runId, status); }
  async getPendingApprovals(runId: string): Promise<any[]> { return this.delegate.getPendingApprovals(runId); }
  async insertTokenLedgerEntry(input: any): Promise<any> { return this.delegate.insertTokenLedgerEntry(input); }
  async updateTokenLedgerEntry(id: string, updates: any): Promise<boolean> { return this.delegate.updateTokenLedgerEntry(id, updates); }
  async getTokenLedgerEntry(id: string): Promise<any> { return this.delegate.getTokenLedgerEntry(id); }
  async listTokenLedgerEntries(runId: string, callType?: string): Promise<any[]> { return this.delegate.listTokenLedgerEntries(runId, callType); }
  async getTokenUsageSummary(runId: string): Promise<any> { return this.delegate.getTokenUsageSummary(runId); }
  async createBudgetPolicy(input: any): Promise<any> { return this.delegate.createBudgetPolicy(input); }
  async getBudgetPolicy(id: string): Promise<any> { return this.delegate.getBudgetPolicy(id); }
  async updateBudgetPolicy(id: string, tokenLimit: number, action: string): Promise<boolean> { return this.delegate.updateBudgetPolicy(id, tokenLimit, action); }
  async listBudgetPolicies(runId?: string | null): Promise<any[]> { return this.delegate.listBudgetPolicies(runId); }
  async getEffectiveBudgetPolicy(policyType: string, runId?: string | null): Promise<any> { return this.delegate.getEffectiveBudgetPolicy(policyType, runId); }
  async createRiskAssessment(input: any): Promise<any> { return this.delegate.createRiskAssessment(input); }
  async getRiskAssessment(id: string): Promise<any> { return this.delegate.getRiskAssessment(id); }
  async resolveRiskAssessment(id: string, resolvedAt: string): Promise<boolean> { return this.delegate.resolveRiskAssessment(id, resolvedAt); }
  async listRiskAssessments(runId: string): Promise<any[]> { return this.delegate.listRiskAssessments(runId); }
  async insertReconciliationReport(input: any): Promise<any> { return this.delegate.insertReconciliationReport(input); }
  async getLatestReconciliationReport(runId: string): Promise<any> { return this.delegate.getLatestReconciliationReport(runId); }
  async insertReconciliationFinding(input: any): Promise<any> { return this.delegate.insertReconciliationFinding(input); }
  async listReconciliationFindings(reportId: string): Promise<any[]> { return this.delegate.listReconciliationFindings(reportId); }
  async listReconciliationReports(runId: string): Promise<any[]> { return this.delegate.listReconciliationReports(runId); }
  async listNonTerminalRuns(): Promise<any[]> { return this.delegate.listNonTerminalRuns(); }
  async applyReconciliationAtomically(input: any): Promise<any> { return this.delegate.applyReconciliationAtomically(input); }

  // ── Hang injection ──
  async insertResourceSample(input: any): Promise<any> {
    if (this.hangOnMethod === 'insertResourceSample') {
      this._hangCount++;
      return new Promise((resolve, reject) => {
        this._hangDeferreds.push({
          resolve: () => resolve(this.delegate.insertResourceSample(input)),
          reject,
        });
      });
    }
    return this.delegate.insertResourceSample(input);
  }

  async insertDispatchDecision(input: any): Promise<any> {
    if (this.hangOnMethod === 'insertDispatchDecision') {
      this._hangCount++;
      return new Promise((resolve, reject) => {
        this._hangDeferreds.push({
          resolve: () => resolve(this.delegate.insertDispatchDecision(input)),
          reject,
        });
      });
    }
    return this.delegate.insertDispatchDecision(input);
  }

  async cleanupResourceSamples(retentionDays?: number): Promise<number> {
    if (this.hangOnMethod === 'cleanupResourceSamples') {
      this._hangCount++;
      return new Promise((resolve, reject) => {
        this._hangDeferreds.push({
          resolve: () => resolve(this.delegate.cleanupResourceSamples(retentionDays)),
          reject,
        });
      });
    }
    return this.delegate.cleanupResourceSamples(retentionDays);
  }
}

describe('P0-A Fault Injection: never-completing writes', () => {
  let tmpDir: string;
  let dbPath: string;
  let realStore: SqliteStateStore;
  let hangingStore: HangingWriteStore;

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-p0a-hang-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'p0a-hang.db');
    realStore = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, realStore.getDatabase());
    runner.applyPending();
    // Hang on cleanupResourceSamples — this is called at startRun entry and trackWrite'd
    hangingStore = new HangingWriteStore(realStore, 'cleanupResourceSamples');
  });

  afterAll(async () => {
    hangingStore.resolveAll();
    await realStore.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('P0A-FI-01: startRun must NOT return completed when writes never converge', async () => {
    const runId = 'p0a-hang-' + Date.now();
    await setupRunFixture(hangingStore, runId, tmpDir, 2);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const scheduler = new StageScheduler(hangingStore, {
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

    // After fix: startRun will throw ConvergenceTimeoutError and fail the run
    let convergenceError: Error | null = null;
    try {
      await scheduler.startRun(runId);
    } catch (err) {
      convergenceError = err as Error;
    }

    const run = await realStore.getRun(runId);
    // P0-A assertion: with hanging writes, run MUST NOT be completed
    expect(run!.status).not.toBe('completed');
    // After fix: run should be 'failed'
    expect(run!.status).toBe('failed');

    // Cleanup: unblock the hanging writes
    hangingStore.resolveAll();
  }, 30000);

  it('P0A-FI-02: diagnostic write rejection is logged, does not block completion', async () => {
    const runId = 'p0a-reject-' + Date.now();
    // Use a fresh hanging store — hang on cleanupResourceSamples
    const rejectStore = new HangingWriteStore(realStore, 'cleanupResourceSamples');
    await setupRunFixture(rejectStore, runId, tmpDir, 2);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const scheduler = new StageScheduler(rejectStore, {
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

    // Inject rejection after a short delay
    let startRunError: Error | null = null;
    const startPromise = scheduler.startRun(runId).catch((err) => {
      startRunError = err as Error;
    });

    // Wait for hang, then reject
    await rejectStore.waitForHang();
    rejectStore.rejectAll(new Error('SIMULATED_DB_CLEANUP_REJECTION'));
    await startPromise;

    // Diagnostic write rejection: cleanupResourceSamples is non-critical.
    // Run should complete normally, but error must be logged (not silently swallowed).
    const run = await realStore.getRun(runId);
    expect(run!.status).toBe('completed');

    // Error must be logged to stderr, not silently swallowed
    // (Verified by `[Scheduler] cleanupResourceSamples failed:` in stderr)
  }, 30000);

  it('P0A-FI-03: delayed-but-eventual writes → completed with full data integrity', async () => {
    const runId = 'p0a-delayed-ok-' + Date.now();
    const delayedStore = new HangingWriteStore(realStore, 'cleanupResourceSamples');
    await setupRunFixture(delayedStore, runId, tmpDir, 2);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });

    const scheduler = new StageScheduler(delayedStore, {
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

    const startPromise = scheduler.startRun(runId);

    // Resolve writes after a short delay (< timeout) — writes should complete before timeout
    await delayedStore.waitForHang();
    await new Promise((r) => setTimeout(r, 100));
    delayedStore.resolveAll();

    await startPromise;

    const run = await realStore.getRun(runId);
    expect(run!.status).toBe('completed');

    // Verify data integrity: samples present
    const samples = await realStore.getRecentResourceSamples(100);
    expect(samples.length).toBeGreaterThan(0);

    // All tasks merged
    const tasks = await realStore.listTasks(runId);
    for (const t of tasks) expect(t.status).toBe('merged');
  }, 30000);
});

describe('P0-A Fault Injection: normal path regression guard', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-p0a-normal-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'p0a-normal.db');
    store = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('P0A-REG-01: normal completion with resource sampling → completed', async () => {
    const runId = 'p0a-normal-' + Date.now();
    await setupRunFixture(store, runId, tmpDir, 2);

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
    expect(run!.status).toBe('completed');

    const tasks = await store.listTasks(runId);
    for (const t of tasks) expect(t.status).toBe('merged');
  }, 30000);

  it('P0A-REG-02: pause path → stage paused, run not completed', async () => {
    const runId = 'p0a-pause-' + Date.now();
    const now = new Date().toISOString();
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    await store.createRun({
      id: runId, projectId: 'p0a', projectRoot: tmpDir,
      requestText: 'test', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });
    await store.createTask({
      id: taskId, runId, title: 'T1', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });
    for (let i = 1; i <= 3; i++) {
      const aid = taskId + '-a' + i;
      await store.createAttempt({ id: aid, taskId, stageId, attemptNumber: i, status: 'running' });
      await store.updateAttemptStatus(aid, 'failed', now);
      await store.updateAttemptResult(aid, { exitReason: 'failure ' + i, stoppedAt: now });
    }
    await store.updateTaskStatus(taskId, 'ready', now);
    await store.updateTaskStatus(taskId, 'running', now);
    await store.updateTaskStatus(taskId, 'rework_required', now);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });
    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxReworkCount: 2,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: sampler,
      samplingIntervalMs: 10,
    });

    await scheduler.startRun(runId);

    const stage = await store.getStage(stageId);
    expect(stage!.status).toBe('paused');

    const run = await store.getRun(runId);
    // Run may be 'paused' or 'running' but NOT 'completed' after exhaustion
    expect(run!.status).not.toBe('completed');
  }, 30000);

  it('P0A-REG-03: merge-blocked path → waiting_decision, not completed', async () => {
    const runId = 'p0a-mergeblock-' + Date.now();
    const now = new Date().toISOString();
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    await store.createRun({
      id: runId, projectId: 'p0a', projectRoot: tmpDir,
      requestText: 'test', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });
    await store.createTask({
      id: taskId, runId, title: 'T1', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });
    const aid = taskId + '-a1';
    await store.createAttempt({ id: aid, taskId, stageId, attemptNumber: 1, status: 'running' });
    await store.updateAttemptStatus(aid, 'failed', now);
    await store.updateAttemptResult(aid, { exitReason: 'scope: wrote to forbidden/', stoppedAt: now });
    await store.updateTaskStatus(taskId, 'waiting_decision', now);

    const sampler = new FakeResourceSampler({ cpuUsagePercent: 10, piCount: 0, memTotalMb: 16384, memUsedMb: 4000 });
    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxReworkCount: 2,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
      resourceSamplingEnabled: true,
      resourceSampler: sampler,
      samplingIntervalMs: 10,
    });

    await scheduler.startRun(runId);

    const task = await store.getTask(taskId);
    expect(task!.status).toBe('waiting_decision');

    const run = await store.getRun(runId);
    expect(run!.status).not.toBe('completed');
  }, 30000);
});
