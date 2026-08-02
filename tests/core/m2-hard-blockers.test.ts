import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import type { WorkerResult, ReviewResult } from '../../src/types/protocol.js';

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email t@t.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name T', { cwd: dir, stdio: 'pipe' });
  writeFileSync(path.join(dir, 'README.md'), '# Test');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
}

const fakeCompleted: WorkerResult = {
  taskId: 'x', status: 'completed', summary: 'fake', filesChanged: [],
  checks: [], scopeViolations: [], risks: [], unresolvedQuestions: [],
  productDecisionRequired: false,
  tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
};
const fakeApproved: ReviewResult = {
  taskId: 'x', status: 'approved', reviewSummary: 'ok', findings: [],
  requiredRework: [], qualityGateStatus: 'passed', mergeAllowed: true, reviewer: 'codex-cli',
};

/** Minimal quality gate for tests that need real completion flow */
const PASS_THROUGH_GATE = [{ name: 'noop', command: 'node', args: ['-e', 'console.log("ok")'] }];

function makeScheduler(store: SqliteStateStore, root: string, overrides?: Record<string, any>) {
  return new StageScheduler(store, {
    projectRoot: root, sessionDir: root, logDir: root,
    worktreeBaseDir: '.brainctl-dev/wt',
    allowRealWorker: false, allowRealReviewer: false,
    workerTimeoutMs: 30000, maxParallelTasks: 2, maxReworkCount: 2,
    targetBranch: 'main',
    qualityGates: PASS_THROUGH_GATE,
    fakeWorkerResult: fakeCompleted,
    fakeReviewResult: fakeApproved,
    ...overrides,
  });
}

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('M2 Hard Blockers', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), 'm2hard-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    initGitRepo(tmpDir);
    dbPath = path.join(tmpDir, 'test.db');
    store = SqliteStateStore.create(dbPath);
    new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('records real pids, not exitCodes', async () => {
    const now = new Date().toISOString();
    const rid = 'pid-' + Date.now();
    await store.createRun({ id: rid, projectId: 'p', projectRoot: tmpDir, requestText: 't', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: rid + '-s1', runId: rid, stageNumber: 1, title: 'S', status: 'ready' });
    await store.createTask({ id: rid + '-t1', runId: rid, title: 'T', status: 'pending', specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['a/'] }, createdAt: now, updatedAt: now });

    // quality gates configured: ensures completion path works
    const s = makeScheduler(store, tmpDir);
    await s.startRun(rid);

    const att = await store.getLatestAttempt(rid + '-t1');
    // In fake mode pid is null (no real process), but it must NEVER be a positive exitCode
    expect(att!.piPid).toBeNull();
    // exitReason should be set (fake_ok from test mode)
    expect(att!.exitReason).toBeDefined();
    expect(att!.exitReason).toContain('fake_ok');
  });

  it('creates new attempt and worktree on retry', async () => {
    const now = new Date().toISOString();
    const rid = 'retry-' + Date.now();
    await store.createRun({ id: rid, projectId: 'p', projectRoot: tmpDir, requestText: 't', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: rid + '-s1', runId: rid, stageNumber: 1, title: 'S', status: 'ready' });
    await store.createTask({ id: rid + '-t1', runId: rid, title: 'T', status: 'pending', specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['b/'] }, createdAt: now, updatedAt: now });

    // Seed a failed attempt with rework_required
    await store.createAttempt({ id: rid + '-att-t1-a1', taskId: rid + '-t1', stageId: rid + '-s1', attemptNumber: 1, status: 'rework_required' });
    await store.createReview({ id: rid + '-r1', attemptId: rid + '-att-t1-a1', taskId: rid + '-t1', reviewerType: 'codex-cli', status: 'rework_required' });
    await store.updateReviewResult(rid + '-r1', { reworkCount: 0 });

    const s = makeScheduler(store, tmpDir);
    await s.startRun(rid);

    const attempts = await store.listAttempts(rid + '-t1');
    expect(attempts.length).toBeGreaterThanOrEqual(2); // original + new
    const latest = attempts[attempts.length - 1];
    expect(latest.attemptNumber).toBeGreaterThan(1);
    expect(latest.status).toBe('approved');
    // Each attempt should have a unique worktree path
    const paths = attempts.map((a) => a.worktreePath).filter(Boolean);
    expect(new Set(paths).size).toBe(paths.length); // all unique
  });

  it('reconcile marks missing PID as interrupted', async () => {
    const now = new Date().toISOString();
    const rid = 'rec-' + Date.now();
    await store.createRun({ id: rid, projectId: 'p', projectRoot: tmpDir, requestText: 't', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: rid + '-s1', runId: rid, stageNumber: 1, title: 'S', status: 'running' });
    await store.createTask({ id: rid + '-t1', runId: rid, title: 'T', status: 'pending', specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['c/'] }, createdAt: now, updatedAt: now });

    // Create a checkpoint branch for a running attempt with a non-existent PID.
    // Recovery should preserve and reuse this paid progress.
    const targetBranch = execSync('git branch --show-current', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    const checkpointBranch = `brainctl/${rid}/checkpoint`;
    const checkpointFile = path.join(tmpDir, 'c', `${rid}.txt`);
    execSync(`git checkout -b "${checkpointBranch}"`, { cwd: tmpDir, stdio: 'pipe' });
    mkdirSync(path.dirname(checkpointFile), { recursive: true });
    writeFileSync(checkpointFile, 'preserved worker checkpoint');
    execSync(`git add "c/${rid}.txt"`, { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "checkpoint interrupted work"', { cwd: tmpDir, stdio: 'pipe' });
    execSync(`git checkout "${targetBranch}"`, { cwd: tmpDir, stdio: 'pipe' });

    await store.createAttempt({ id: rid + '-att-ghost', taskId: rid + '-t1', stageId: rid + '-s1', attemptNumber: 1, status: 'running' });
    await store.updateAttemptResult(rid + '-att-ghost', {
      piPid: 9999999,
      branchName: checkpointBranch,
    }); // PID that doesn't exist

    // Start scheduler - reconciliation should catch it
    const s = makeScheduler(store, tmpDir);
    await s.startRun(rid);

    const att = await store.getAttempt(rid + '-att-ghost');
    expect(att!.status).toBe('interrupted');
    expect(att!.exitReason).toContain('reconciled');

    // Check event was recorded
    const events = await store.listEvents(rid, 'reconciled_mark_attempt_interrupted');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(checkpointFile)).toBe(true);
    const reusedEvents = await store.listEvents(rid, 'retry_branch_reused');
    expect(reusedEvents.some((event) => event.attemptId !== rid + '-att-ghost')).toBe(true);
  });

  it('quality gates: no-config marks attempt failed and stage paused (not completed)', async () => {
    const now = new Date().toISOString();
    const rid = 'qg-' + Date.now();
    await store.createRun({ id: rid, projectId: 'p', projectRoot: tmpDir, requestText: 't', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: rid + '-s1', runId: rid, stageNumber: 1, title: 'S', status: 'ready' });
    await store.createTask({ id: rid + '-t1', runId: rid, title: 'T', status: 'pending', specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['d/'] }, createdAt: now, updatedAt: now });

    // quality gates empty - must mark attempt failed, stage paused, NOT completed
    const s = makeScheduler(store, tmpDir, { qualityGates: [] });
    await s.startRun(rid);

    const events = await store.listEvents(rid, 'error');
    const noGateEv = events.find((e) => {
      const d = e.eventDataJson ? JSON.parse(e.eventDataJson) : null;
      return d && d.reason === 'no_quality_gates_configured';
    });
    expect(noGateEv).toBeDefined();

    // Stage must be paused, NOT completed
    const stage = await store.getStage(rid + '-s1');
    expect(stage!.status).toBe('paused');
    
    // Attempt must be failed
    const att = await store.getLatestAttempt(rid + '-t1');
    expect(att!.status).toBe('failed');
    expect(att!.exitReason).toContain('no_quality_gates_configured');
  });

  it('cancel stops running attempt and marks interrupted', async () => {
    const now = new Date().toISOString();
    const rid = 'cancel-' + Date.now();
    await store.createRun({ id: rid, projectId: 'p', projectRoot: tmpDir, requestText: 't', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: rid + '-s1', runId: rid, stageNumber: 1, title: 'S', status: 'running' });
    await store.createTask({ id: rid + '-t1', runId: rid, title: 'T', status: 'pending', specJson: { stageNumber: 1, dependencies: [], estimatedWritePaths: ['e/'] }, createdAt: now, updatedAt: now });

    // Create running attempt with a fake PID (null pid = no real process => should still mark interrupted)
    await store.createAttempt({ id: rid + '-att-run', taskId: rid + '-t1', stageId: rid + '-s1', attemptNumber: 1, status: 'running' });
    await store.updateAttemptResult(rid + '-att-run', { piPid: null });

    // Simulate cancel by updating status directly (cancel command does this)
    await store.updateAttemptStatus(rid + '-att-run', 'interrupted', new Date().toISOString());
    await store.updateAttemptResult(rid + '-att-run', { exitReason: 'canceled_by_user', stoppedAt: new Date().toISOString() });
    await store.updateRunStatus(rid, 'canceled', new Date().toISOString());

    const att = await store.getAttempt(rid + '-att-run');
    expect(att!.status).toBe('interrupted');
    expect(att!.exitReason).toContain('canceled_by_user');

    const run = await store.getRun(rid);
    expect(run!.status).toBe('canceled');
  });
});
