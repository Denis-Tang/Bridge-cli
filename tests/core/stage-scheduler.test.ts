import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { readSqliteConfigFromEnv } from '../../src/state/sqlite-config.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import { WorktreeManager } from '../../src/git/worktree-manager.js';
import type { WorkerResult, ReviewResult } from '../../src/types/protocol.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  writeFileSync(path.join(dir, 'README.md'), '# Test Repo\n');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
}

describe('StageScheduler Integration', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'brainctl-sched3-test-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'test-sched.db');
    store = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  /** Minimal pass-through quality gate for integration tests */
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

  it('runs two non-conflicting tasks through full lifecycle', async () => {
    const now = new Date().toISOString();
    const runId = 'e2e-concurrent-' + Date.now();
    await store.createRun({
      id: runId, projectId: 'p1', projectRoot: tmpDir,
      requestText: 'concurrent test', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await store.createStage({
      id: runId + '-s1', runId, stageNumber: 1, title: 'S1', status: 'ready',
    });
    await store.createTask({
      id: runId + '-t1', runId, title: 'T1',
      status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/a'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });
    await store.createTask({
      id: runId + '-t2', runId, title: 'T2',
      status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['docs/b'], allowedPaths: ['docs/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 2,
      cleanupMergedWorktrees: true,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
    const stages = await store.listStages(runId);
    expect(stages[0].status).toBe('completed');
    const atts = await store.listAttemptsByStage(stages[0].id);
    expect(atts.length).toBe(2);
    for (const a of atts) {
      expect(a.status).toBe('approved');
      expect(await store.getAttemptProvenance(a.id)).toMatchObject({
        attemptId: a.id, runId, stageId: stages[0].id, taskId: a.taskId,
      });
    }
    const tasks = await store.listTasks(runId);
    for (const task of tasks) expect(task.status).toBe('merged');
    const worktreeList = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    expect(worktreeList).not.toContain(runId);
    const branchList = execFileSync('git', ['branch', '--list', `brainctl/*${runId}*`], {
      cwd: tmpDir,
      encoding: 'utf-8',
    });
    expect(branchList.trim()).toBe('');
  });

  it('blocks a real-reviewer path when WorkerResult completed has no verifiable diff', async () => {
    const now = new Date().toISOString();
    const runId = 'e2e-empty-real-review-' + Date.now();
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    await store.createRun({ id: runId, projectId: 'p-evidence', projectRoot: tmpDir, requestText: 'evidence gate', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });
    await store.createTask({
      id: taskId, runId, title: 'must write file', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/m5-real-chain-acceptance.txt'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir, worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: true, workerTimeoutMs: 30000, maxParallelTasks: 1,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });
    await scheduler.startRun(runId);

    expect((await store.getRun(runId))!.status).not.toBe('completed');
    expect((await store.getStage(stageId))!.status).toBe('paused');
    expect((await store.getTask(taskId))!.status).toBe('waiting_decision');
    expect((await store.getLatestAttempt(taskId))!.status).toBe('failed');
    const failures = await store.listEvents(runId, 'attempt_failed');
    expect(failures.some((event) => (event.eventDataJson || '').includes('worker_completed_without_verifiable_diff'))).toBe(true);
  });

  it('merges integration into the configured target branch', async () => {
    const now = new Date().toISOString();
    const runId = 'e2e-target-branch-' + Date.now();
    const targetBranch = 'release/test-' + Date.now();
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: tmpDir,
      encoding: 'utf-8',
    }).trim();
    execFileSync('git', ['branch', targetBranch], { cwd: tmpDir, stdio: 'pipe' });

    await store.createRun({
      id: runId, projectId: 'p-target', projectRoot: tmpDir,
      requestText: 'target branch test', status: 'running',
      createdAt: now, updatedAt: now,
    });
    await store.createStage({
      id: runId + '-s1', runId, stageNumber: 1, title: 'S1', status: 'ready',
    });
    await store.createTask({
      id: runId + '-t1', runId, title: 'T1',
      status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/target'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxParallelTasks: 1,
      targetBranch, qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });
    try {
      await scheduler.startRun(runId);

      const afterBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8',
      }).trim();
      expect(afterBranch).toBe(targetBranch);
      const events = await store.listEvents(runId, 'integration_completed');
      expect(events.map((e) => JSON.parse(e.eventDataJson || '{}').targetBranch)).toContain(targetBranch);
    } finally {
      execFileSync('git', ['checkout', currentBranch], { cwd: tmpDir, stdio: 'pipe' });
    }
  });

  it('defensively blocks different-hunk writes to the same file even when Git could merge them', async () => {
    const now = new Date().toISOString();
    const runId = 'e2e-actual-conflict-' + Date.now();
    const currentBranch = execFileSync('git', ['branch', '--show-current'], { cwd: tmpDir, encoding: 'utf8' }).trim();
    mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'src', 'shared.ts'), 'one\ntwo\nthree\nfour\n');
    execFileSync('git', ['add', 'src/shared.ts'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'conflict defense base'], { cwd: tmpDir });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).trim();
    const firstBranch = `fixture/${runId}/first`;
    const secondBranch = `fixture/${runId}/second`;
    execFileSync('git', ['checkout', '-b', firstBranch, base], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, 'src', 'shared.ts'), 'ONE\ntwo\nthree\nfour\n');
    execFileSync('git', ['add', 'src/shared.ts'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'first hunk'], { cwd: tmpDir });
    execFileSync('git', ['checkout', '-b', secondBranch, base], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, 'src', 'shared.ts'), 'one\ntwo\nTHREE\nfour\n');
    execFileSync('git', ['add', 'src/shared.ts'], { cwd: tmpDir });
    execFileSync('git', ['commit', '-m', 'second hunk'], { cwd: tmpDir });
    execFileSync('git', ['checkout', currentBranch], { cwd: tmpDir });

    const stageId = `${runId}-s1`;
    await store.createRun({ id: runId, projectId: 'p1', projectRoot: tmpDir, requestText: 'actual conflict', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running', baseCommit: base });
    for (const [taskId, branchName, estimatedPath] of [
      [`${runId}-t1`, firstBranch, 'src/declared-a.ts'],
      [`${runId}-t2`, secondBranch, 'src/declared-b.ts'],
    ] as const) {
      await store.createTask({
        id: taskId, runId, title: taskId, status: 'approved',
        specJson: { taskId, stageNumber: 1, dependencies: [], estimatedWritePaths: [estimatedPath], allowedPaths: ['src/'], forbiddenPaths: [] },
        createdAt: now, updatedAt: now,
      });
      const attemptId = `${taskId}-a1`;
      await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'approved' });
      await store.updateAttemptResult(attemptId, { branchName, worktreePath: tmpDir });
      await store.createEvent({ id: `${attemptId}-diff-base`, runId, stageId, taskId, attemptId, eventType: 'task_diff_base_captured', eventData: { diffBaseCommit: base } });
    }

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir, worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false, workerTimeoutMs: 30000, maxParallelTasks: 2,
      targetBranch: currentBranch, qualityGates: PASS_THROUGH_GATE, fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });
    const stage = (await store.getStage(stageId))!;
    const integrated = await (scheduler as any).integrate(stage, runId, new WorktreeManager(tmpDir, { worktreeBaseDir: '.brainctl-dev/wt' }), base);
    expect(integrated).toBe(false);
    expect(await store.getStage(stageId)).toMatchObject({ status: 'paused' });
    expect(await store.getActivePauseForStage(stageId)).toMatchObject({ reasonCode: 'runtime_undeclared_actual_path_conflict' });
    expect(execFileSync('git', ['rev-parse', currentBranch], { cwd: tmpDir, encoding: 'utf8' }).trim()).toBe(base);

    const integrationPath = path.join(tmpDir, '.brainctl-dev', 'wt', runId, 'int', 'stage-1', 'a1');
    try { execFileSync('git', ['worktree', 'remove', '--force', integrationPath], { cwd: tmpDir }); } catch {}
    for (const branch of [firstBranch, secondBranch, `brainctl/int/${runId}/stage-1/a1`]) {
      try { execFileSync('git', ['branch', '-D', branch], { cwd: tmpDir }); } catch {}
    }
  });

  it('pauses stage when rework limit exceeded', async () => {
    const now = new Date().toISOString();
    const runId = 'e2e-rework-' + Date.now();
    await store.createRun({
      id: runId, projectId: 'p2', projectRoot: tmpDir,
      requestText: 'rework', status: 'running',
      createdAt: now, updatedAt: now,
    });
    const sid = runId + '-s1';
    await store.createStage({ id: sid, runId, stageNumber: 1, title: 'S1', status: 'ready' });
    const tid = runId + '-t1';
    await store.createTask({
      id: tid, runId, title: 'T1', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/'] },
      createdAt: now, updatedAt: now,
    });
    // Seed: 3 failed attempts (maxReworkCount=2 → max 3 attempts, all used)
    for (let i = 1; i <= 3; i++) {
      await store.createAttempt({ id: tid + '-a' + i, taskId: tid, stageId: sid, attemptNumber: i, status: 'failed' });
      await store.updateAttemptResult(tid + '-a' + i, { exitReason: 'review: rework ' + i, stoppedAt: now });
    }
    await store.updateTaskStatus(tid, 'ready', now);
    await store.updateTaskStatus(tid, 'running', now);
    await store.updateTaskStatus(tid, 'rework_required', now);

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000, maxReworkCount: 2,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });
    await scheduler.startRun(runId);

    const stage = await store.getStage(sid);
    expect(stage!.status).toBe('paused');
    // Verify no 4th attempt was created
    const attempts = await store.listAttempts(tid);
    expect(attempts.length).toBe(3);
  });

  it('respects task dependencies', async () => {
    const now = new Date().toISOString();
    const runId = 'e2e-dep-' + Date.now();
    await store.createRun({ id: runId, projectId: 'p3', projectRoot: tmpDir, requestText: 'dep', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: runId + '-s1', runId, stageNumber: 1, title: 'S1', status: 'ready' });
    await store.createTask({
      id: runId + '-tA', runId, title: 'A', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/a'] },
      createdAt: now, updatedAt: now,
    });
    await store.createTask({
      id: runId + '-tB', runId, title: 'B depends on A', status: 'pending',
      specJson: { stageNumber: 1, dependencies: [runId + '-tA'], estimatedWritePaths: ['src/b'] },
      createdAt: now, updatedAt: now,
    });

    const scheduler = new StageScheduler(store, {
      projectRoot: tmpDir, sessionDir: tmpDir, logDir: tmpDir,
      worktreeBaseDir: '.brainctl-dev/wt',
      allowRealWorker: false, allowRealReviewer: false,
      workerTimeoutMs: 30000,
      targetBranch: 'main', qualityGates: PASS_THROUGH_GATE,
      fakeWorkerResult: fakeCompleted, fakeReviewResult: fakeApproved,
    });
    await scheduler.startRun(runId);

    const run = await store.getRun(runId);
    expect(run!.status).toBe('completed');
    const a = await store.getLatestAttempt(runId + '-tA');
    const b = await store.getLatestAttempt(runId + '-tB');
    expect(a!.status).toBe('approved');
    expect(b!.status).toBe('approved');
  });
});
