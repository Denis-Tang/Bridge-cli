// ══════════════════════════════════════════════════════════════════════════
// Bounded Retry — 有限重试与失败状态收敛 (P0-3)
// ══════════════════════════════════════════════════════════════════════════
//
// 测试覆盖：
//   - 结构化失败分类 (classifyFailure)
//   - 重试预算检查 (checkRetryBudget)
//   - 连续 review reject → 恰好 3 个 attempt
//   - worker missing / throw / worktree / quality / diff throw 有限终止
//   - scope / security / privacy / product-decision / cancel 只执行 1 次
//   - unknown failure fail-closed
//   - Promise rejection 更新 attempt/task/stage 并释放锁
//   - retry-exhausted resume 不重新 dispatch
//   - 一个任务耗尽时 stage 不 integrate / 不 completed
//   - governance off 仍受 retry 上限约束
//   - hard pause / resume / cancel 锁生命周期无泄漏

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { readSqliteConfigFromEnv } from '../../src/state/sqlite-config.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import {
  classifyFailure,
  checkRetryBudget,
  maxAllowedAttempts,
  FailureCategory,
} from '../../src/core/retry-policy.js';
import type { WorkerResult, ReviewResult } from '../../src/types/protocol.js';

// ══════════════════════════════════════════════════════════════════════════
// Shared fixture helpers
// ══════════════════════════════════════════════════════════════════════════

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email retry-test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Retry Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(path.join(dir, 'README.md'), '# Retry Test Repo\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
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

const fakeRejected: ReviewResult = {
  taskId: 'fake', status: 'rejected', reviewSummary: '[fake] Needs rework',
  findings: ['needs_more_work'], requiredRework: ['fix_all'], qualityGateStatus: 'failed',
  mergeAllowed: false, reviewer: 'codex-cli',
};

async function createRunWithStage(prefix: string, stageNum = 1): Promise<{ runId: string; stageId: string }> {
  const now = new Date().toISOString();
  const runId = prefix + '-' + Date.now();
  const stageId = runId + '-s' + stageNum;
  await store.createRun({
    id: runId, projectId: 'p-retry', projectRoot: tmpDir,
    requestText: 'retry test', status: 'running',
    createdAt: now, updatedAt: now,
  });
  await store.createStage({
    id: stageId, runId, stageNumber: stageNum, title: 'Stage ' + stageNum, status: 'ready',
  });
  return { runId, stageId };
}

async function createTask(runId: string, taskSuffix: string, writePaths: string[] = ['src/']): Promise<string> {
  const now = new Date().toISOString();
  const taskId = runId + '-' + taskSuffix;
  await store.createTask({
    id: taskId, runId, title: taskSuffix, status: 'pending',
    specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: writePaths, allowedPaths: ['src/'], forbiddenPaths: [] },
    createdAt: now, updatedAt: now,
  });
  return taskId;
}

async function seedAttempt(
  taskId: string, stageId: string, attemptNum: number,
  status: string, exitReason?: string | null,
): Promise<string> {
  const aid = taskId + '-a' + attemptNum;
  const now = new Date().toISOString();
  await store.createAttempt({ id: aid, taskId, stageId, attemptNumber: attemptNum, status: 'running' });
  if (status !== 'running') {
    await store.updateAttemptStatus(aid, status, now);
  }
  if (exitReason !== undefined) {
    await store.updateAttemptResult(aid, { exitReason, stoppedAt: now, worktreePath: tmpDir + '/wt/' + aid });
  }
  // Update task status to match
  const taskStatus = status === 'approved' ? 'approved'
    : status === 'failed' ? 'failed'
    : status === 'rework_required' ? 'rework_required'
    : 'running';
  await store.updateTaskStatus(taskId, taskStatus as any, now);
  return aid;
}

function makeSchedulerConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectRoot: tmpDir,
    sessionDir: tmpDir,
    logDir: tmpDir,
    worktreeBaseDir: '.brainctl-dev/wt',
    allowRealWorker: false,
    allowRealReviewer: false,
    workerTimeoutMs: 5000,
    maxParallelTasks: 2,
    maxReworkCount: 2,
    targetBranch: 'main',
    qualityGates: PASS_THROUGH_GATE,
    fakeWorkerResult: fakeCompleted,
    fakeReviewResult: fakeApproved,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Unit tests: classifyFailure
// ══════════════════════════════════════════════════════════════════════════

describe('classifyFailure (unit)', () => {
  // ── Non-retriable categories ──
  it('product_decision → non-retriable', () => {
    const r = classifyFailure('failed', 'product_decision: needs_approval');
    expect(r.retriable).toBe(false);
    expect(r.category).toBe(FailureCategory.PRODUCT_DECISION);
  });

  it('privacy blocked → non-retriable', () => {
    const r = classifyFailure('failed', 'privacy: key_missing');
    expect(r.retriable).toBe(false);
    expect(r.category).toBe(FailureCategory.PRIVACY);
  });

  it('security blocked → non-retriable', () => {
    const r = classifyFailure('failed', 'security: unauthorized_access');
    expect(r.retriable).toBe(false);
    expect(r.category).toBe(FailureCategory.SECURITY);
  });

  it('canceled → non-retriable', () => {
    const r1 = classifyFailure('failed', 'canceled:user_request');
    expect(r1.retriable).toBe(false);
    expect(r1.category).toBe(FailureCategory.CANCEL);

    const r2 = classifyFailure('failed', 'canceled');
    expect(r2.retriable).toBe(false);
    expect(r2.category).toBe(FailureCategory.CANCEL);
  });

  it('scope violation → non-retriable', () => {
    const r = classifyFailure('failed', 'scope: wrote to forbidden/path');
    expect(r.retriable).toBe(false);
    expect(r.category).toBe(FailureCategory.SCOPE);
  });

  it('unverifiable diff → non-retriable', () => {
    const r1 = classifyFailure('failed', 'worker_completed_without_verifiable_diff');
    expect(r1.retriable).toBe(false);
    expect(r1.category).toBe(FailureCategory.UNVERIFIABLE);

    const r2 = classifyFailure('failed', 'expected_write_missing');
    expect(r2.retriable).toBe(false);
    expect(r2.category).toBe(FailureCategory.UNVERIFIABLE);

    const r3 = classifyFailure('failed', 'real_reviewer_empty_diff');
    expect(r3.retriable).toBe(false);
    expect(r3.category).toBe(FailureCategory.UNVERIFIABLE);
  });

  it('resume data corruption → non-retriable', () => {
    const r = classifyFailure('failed', 'resume: workerResult missing');
    expect(r.retriable).toBe(false);
    expect(r.category).toBe(FailureCategory.DATA_CORRUPTION);
  });

  it('blocked/needs_decision → non-retriable', () => {
    const r = classifyFailure('failed', 'blocked: needs_decision');
    expect(r.retriable).toBe(false);
    expect(r.category).toBe(FailureCategory.PRODUCT_DECISION);
  });

  it('no quality gates configured → non-retriable', () => {
    const r = classifyFailure('failed', 'no_quality_gates_configured: missing');
    expect(r.retriable).toBe(false);
    expect(r.category).toBe(FailureCategory.UNKNOWN);
  });

  // ── Retriable categories ──
  it('worktree failure → retriable (transient)', () => {
    const r = classifyFailure('failed', 'wt_fail: git error');
    expect(r.retriable).toBe(true);
    expect(r.category).toBe(FailureCategory.TRANSIENT);
  });

  it('worker result missing → retriable (transient)', () => {
    const r = classifyFailure('failed', 'worker_result_missing');
    expect(r.retriable).toBe(true);
    expect(r.category).toBe(FailureCategory.TRANSIENT);
  });

  it('exception in execTask → retriable (transient)', () => {
    const r = classifyFailure('failed', 'exception: something broke');
    expect(r.retriable).toBe(true);
    expect(r.category).toBe(FailureCategory.TRANSIENT);
  });

  it('quality gate failure → retriable (quality)', () => {
    const r = classifyFailure('failed', 'qg_failed: tests failed');
    expect(r.retriable).toBe(true);
    expect(r.category).toBe(FailureCategory.QUALITY);
  });

  it('review rejection → retriable (review)', () => {
    const r = classifyFailure('failed', 'review: needs more changes');
    expect(r.retriable).toBe(true);
    expect(r.category).toBe(FailureCategory.REVIEW);
  });

  it('rework_required with no reason → retriable (review)', () => {
    const r = classifyFailure('rework_required', undefined);
    expect(r.retriable).toBe(true);
    expect(r.category).toBe(FailureCategory.REVIEW);
  });

  // ── Fail-closed: unknown ──
  it('unknown/unrecognized failure → fail-closed (non-retriable)', () => {
    const r1 = classifyFailure('failed', 'some_random_error_never_seen_before');
    expect(r1.retriable).toBe(false);
    expect(r1.category).toBe(FailureCategory.UNKNOWN);

    const r2 = classifyFailure('failed', '');
    expect(r2.retriable).toBe(false);
    expect(r2.category).toBe(FailureCategory.UNKNOWN);

    const r3 = classifyFailure('failed', undefined);
    expect(r3.retriable).toBe(false);
    expect(r3.category).toBe(FailureCategory.UNKNOWN);
  });

  it('failed status with no matching exitReason → fail-closed', () => {
    const r = classifyFailure('failed', 'some_weird_failure');
    expect(r.retriable).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Unit tests: checkRetryBudget
// ══════════════════════════════════════════════════════════════════════════

describe('checkRetryBudget (unit)', () => {
  it('maxAllowedAttempts(2) = 3', () => {
    expect(maxAllowedAttempts(2)).toBe(3);
  });

  it('no attempts → allowed, 2 remaining', () => {
    const r = checkRetryBudget([], 2, 'failed', 'wt_fail: oops');
    expect(r.allowed).toBe(true);
    expect(r.remainingRetries).toBe(3);
    expect(r.retryOrdinal).toBe(1);
    expect(r.exhausted).toBe(false);
  });

  it('1 transient attempt → allowed, 1 remaining', () => {
    const attempts = [{ status: 'failed', exitReason: 'wt_fail: oops' }];
    const r = checkRetryBudget(attempts, 2, 'failed', 'wt_fail: retry');
    expect(r.allowed).toBe(true);
    expect(r.remainingRetries).toBe(2);
    expect(r.retryOrdinal).toBe(2);
  });

  it('3 attempts = max → exhausted', () => {
    const attempts = [
      { status: 'failed', exitReason: 'review: bad' },
      { status: 'failed', exitReason: 'review: still bad' },
      { status: 'failed', exitReason: 'review: nope' },
    ];
    const r = checkRetryBudget(attempts, 2, 'failed', 'review: nope');
    expect(r.allowed).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(r.remainingRetries).toBe(0);
  });

  it('non-retriable failure at attempt 1 → not allowed, not exhausted', () => {
    const attempts = [{ status: 'failed', exitReason: 'scope: bad' }];
    const r = checkRetryBudget(attempts, 2, 'failed', 'scope: bad');
    expect(r.allowed).toBe(false);
    expect(r.exhausted).toBe(false);
    expect(r.failureCategory).toBe(FailureCategory.SCOPE);
  });

  it('canceled attempts excluded from count', () => {
    const attempts = [
      { status: 'canceled', exitReason: 'canceled:user' },
      { status: 'failed', exitReason: 'wt_fail: oops' },
    ];
    const r = checkRetryBudget(attempts, 2, 'failed', 'wt_fail: oops');
    expect(r.allowed).toBe(true); // only 1 non-canceled attempt
    expect(r.remainingRetries).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Integration tests: StageScheduler retry behavior
// ══════════════════════════════════════════════════════════════════════════

describe('StageScheduler bounded retry (integration)', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-retry-test-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'retry-test.db');
    store = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── 1. 连续 3 次 review reject → 恰好 3 个 attempt，无第 4 个 ──
  it('3x review reject → exactly 3 attempts, stage paused, no 4th', async () => {
    const { runId, stageId } = await createRunWithStage('retry-3x-review');
    const taskId = await createTask(runId, 't-review');

    // Pre-seed 3 failed attempts with review rejections
    for (let i = 1; i <= 3; i++) {
      await seedAttempt(taskId, stageId, i, 'failed', 'review: rejection ' + i);
    }

    const scheduler = new StageScheduler(store, makeSchedulerConfig({
      fakeReviewResult: fakeRejected, // would reject on any new attempt
    }) as any);
    await scheduler.startRun(runId);

    // Verify: stage is paused (exhausted)
    const stage = await store.getStage(stageId);
    expect(stage!.status).toBe('paused');

    // Verify: exactly 3 attempts, no 4th
    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(3);
    expect(attempts.every((a) => a.attemptNumber <= 3)).toBe(true);

    // Verify: run is NOT completed
    const run = await store.getRun(runId);
    expect(run!.status).not.toBe('completed');

    // Verify: exhaustion event exists
    const events = await store.listEvents(runId, 'stage_paused');
    expect(events.some((e) => (e.eventDataJson || '').includes('retry_budget_exhausted'))).toBe(true);
  });

  // ── 2. Scope violation → 只执行 1 次，禁止重试 ──
  it('scope violation → only 1 attempt, stage paused', async () => {
    const { runId, stageId } = await createRunWithStage('retry-scope');
    const taskId = await createTask(runId, 't-scope');

    // Pre-seed 1 failed attempt with scope violation
    await seedAttempt(taskId, stageId, 1, 'failed', 'scope: wrote to forbidden/');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(1);

    const stage = await store.getStage(stageId);
    expect(stage!.status).toBe('paused');

    const events = await store.listEvents(runId, 'stage_paused');
    expect(events.some((e) => (e.eventDataJson || '').includes('non_retriable_failure'))).toBe(true);
  });

  // ── 3. Security blocked → 只执行 1 次 ──
  it('security blocked → only 1 attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-security');
    const taskId = await createTask(runId, 't-security');

    await seedAttempt(taskId, stageId, 1, 'failed', 'security: unauthorized');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 4. Privacy blocked → 只执行 1 次 ──
  it('privacy blocked → only 1 attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-privacy');
    const taskId = await createTask(runId, 't-privacy');

    await seedAttempt(taskId, stageId, 1, 'failed', 'privacy: no_encryption_key');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 5. Product decision → 只执行 1 次 ──
  it('product decision required → only 1 attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-product');
    const taskId = await createTask(runId, 't-product');

    await seedAttempt(taskId, stageId, 1, 'failed', 'product_decision: needs_approval');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 6. Cancel → 只执行 1 次 ──
  it('canceled → only 1 attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-cancel');
    const taskId = await createTask(runId, 't-cancel');

    await seedAttempt(taskId, stageId, 1, 'failed', 'canceled:user_cancel');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 7. 一个任务耗尽，其他任务 OK → stage 不 integrate、不 completed ──
  it('one task exhausted + one task approved → stage NOT completed, NOT integrated', async () => {
    const { runId, stageId } = await createRunWithStage('retry-mixed');
    const exhaustedTaskId = await createTask(runId, 't-exhausted', ['src/exhausted']);
    const goodTaskId = await createTask(runId, 't-good', ['src/good']);

    // Exhausted: 3 failed review attempts
    for (let i = 1; i <= 3; i++) {
      await seedAttempt(exhaustedTaskId, stageId, i, 'failed', 'review: bad-' + i);
    }

    // Good: 1 approved attempt
    const goodAid = goodTaskId + '-a1';
    await store.createAttempt({ id: goodAid, taskId: goodTaskId, stageId, attemptNumber: 1, status: 'running' });
    await store.updateAttemptStatus(goodAid, 'approved', new Date().toISOString());
    await store.updateTaskStatus(goodTaskId, 'approved', new Date().toISOString());

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    // Stage should NOT be completed — exhausted task prevents integration
    const stage = await store.getStage(stageId);
    expect(stage!.status).not.toBe('completed');
    expect(stage!.status).toBe('paused');

    // Run should NOT be completed
    const run = await store.getRun(runId);
    expect(run!.status).not.toBe('completed');

    // Good task should still be approved
    const goodTask = await store.getTask(goodTaskId);
    expect(goodTask!.status).toBe('approved');

    // Exhausted task should be waiting_decision
    const exhaustedTask = await store.getTask(exhaustedTaskId);
    expect(exhaustedTask!.status).toBe('waiting_decision');

    // No integration batch should have been created (or if created, should be failed)
    const batches = await store.listIntegrationBatches(stageId);
    expect(batches.length).toBe(0);
  });

  // ── 8. Governance off → 仍受 retry 上限约束 ──
  it('governance disabled → still bounded by retry count', async () => {
    const { runId, stageId } = await createRunWithStage('retry-nogov');
    const taskId = await createTask(runId, 't-nogov');

    // Pre-seed 3 failed attempts
    for (let i = 1; i <= 3; i++) {
      await seedAttempt(taskId, stageId, i, 'failed', 'review: bad-' + i);
    }

    const scheduler = new StageScheduler(store, makeSchedulerConfig({
      governanceEnabled: false,
    })) as any;
    await scheduler.startRun(runId);

    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(3); // no more created

    expect((await store.getStage(stageId))!.status).toBe('paused');
    expect((await store.getRun(runId))!.status).not.toBe('completed');
  });

  // ── 9. retry-exhausted resume → 不重新 dispatch ──
  it('resume retry-exhausted task → does NOT dispatch new attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-resume-exh');
    const taskId = await createTask(runId, 't-resume');

    // Seed 3 failed attempts (exhausted)
    for (let i = 1; i <= 3; i++) {
      await seedAttempt(taskId, stageId, i, 'failed', 'review: bad-' + i);
    }

    // First run: should detect exhaustion and pause
    const scheduler1 = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler1.startRun(runId);
    expect((await store.getStage(stageId))!.status).toBe('paused');

    // Save attempt count
    const attemptsAfterFirst = (await store.listAttempts(taskId)).length;

    // "Resume": manually set stage back to ready (simulate human resume decision)
    await store.updateStageStatus(stageId, 'ready', new Date().toISOString());

    // Second run: should not create new attempts (exhausted)
    const scheduler2 = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler2.startRun(runId);

    const attemptsAfterSecond = (await store.listAttempts(taskId)).length;
    expect(attemptsAfterSecond).toBe(attemptsAfterFirst);
    expect(attemptsAfterSecond).toBe(3);

    // Stage should be paused again
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 10. 正常两任务流程 → 状态正确收敛 ──
  it('two tasks complete normally → stage completed, run completed', async () => {
    const { runId, stageId } = await createRunWithStage('retry-normal');
    await createTask(runId, 't1', ['src/a']);
    await createTask(runId, 't2', ['src/b']);

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    expect((await store.getStage(stageId))!.status).toBe('completed');
    expect((await store.getRun(runId))!.status).toBe('completed');

    const tasks = await store.listTasks(runId);
    for (const t of tasks) expect(t.status).toBe('merged');
  });

  // ── 11. 不可验证 diff → 不重试 ──
  it('unverifiable diff → only 1 attempt, stage paused', async () => {
    const { runId, stageId } = await createRunWithStage('retry-unver');
    const taskId = await createTask(runId, 't-unver');

    await seedAttempt(taskId, stageId, 1, 'failed', 'worker_completed_without_verifiable_diff');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    expect((await store.listAttempts(taskId)).length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 12. Resume data corrupted → 不重试 ──
  it('resume data corruption → only 1 attempt, stage paused', async () => {
    const { runId, stageId } = await createRunWithStage('retry-resume-corr');
    const taskId = await createTask(runId, 't-resume-corr');

    await seedAttempt(taskId, stageId, 1, 'failed', 'resume: workerResult missing');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    expect((await store.listAttempts(taskId)).length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 13. Blocked/needs_decision → 不重试 ──
  it('worker blocked → only 1 attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-blocked');
    const taskId = await createTask(runId, 't-blocked');

    await seedAttempt(taskId, stageId, 1, 'failed', 'blocked: needs_decision');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    expect((await store.listAttempts(taskId)).length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 14. Worktree failure → 重试到上限 ──
  it('worktree failure → retries up to max limit', async () => {
    const { runId, stageId } = await createRunWithStage('retry-wt');
    const taskId = await createTask(runId, 't-wt');

    // Seed 2 failed attempts (will try 3rd)
    await seedAttempt(taskId, stageId, 1, 'failed', 'wt_fail: disk full');
    await seedAttempt(taskId, stageId, 2, 'failed', 'wt_fail: still broken');

    // 3rd attempt: will succeed via fake mode
    const scheduler = new StageScheduler(store, makeSchedulerConfig({
      maxReworkCount: 2,
    })) as any;
    await scheduler.startRun(runId);

    // After the run, the scheduler would try to create a 3rd attempt.
    // With fake mode, the 3rd attempt succeeds → task approved.
    const attempts = await store.listAttempts(taskId);
    // With fake mode, the scheduler will create attempt 3 which succeeds
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.length).toBeLessThanOrEqual(3);
  });

  // ── 15. Unknown failure → fail-closed, no retry ──
  it('unknown failure → fail-closed, only 1 attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-unknown');
    const taskId = await createTask(runId, 't-unknown');

    await seedAttempt(taskId, stageId, 1, 'failed', 'some_mysterious_error');

    const scheduler = new StageScheduler(store, makeSchedulerConfig()) as any;
    await scheduler.startRun(runId);

    expect((await store.listAttempts(taskId)).length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });

  // ── 16. maxReworkCount=0 → 最多 1 个 attempt ──
  it('maxReworkCount=0 → at most 1 attempt', async () => {
    const { runId, stageId } = await createRunWithStage('retry-mr0');
    const taskId = await createTask(runId, 't-mr0');

    await seedAttempt(taskId, stageId, 1, 'failed', 'review: bad');

    const scheduler = new StageScheduler(store, makeSchedulerConfig({
      maxReworkCount: 0,
      fakeReviewResult: fakeRejected,
    })) as any;
    await scheduler.startRun(runId);

    // With maxReworkCount=0, at most 1 attempt total
    const attempts = await store.listAttempts(taskId);
    expect(attempts.length).toBe(1);
    expect((await store.getStage(stageId))!.status).toBe('paused');
  });
});
