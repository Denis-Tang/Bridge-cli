// ── M5 Preflight Tests ──────────────────────────────────────────────────
// Tests approve/resume preflight: blocking findings reject,
// non-blocking pass. Zero writes in preflight path.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { classifyFacts } from '../../src/core/reconciliation/classifier.js';
import { converge } from '../../src/core/reconciliation/convergence-engine.js';
import { runPreflightReconciliation } from '../../src/cli/commands/reconcile.js';
import type {
  ReconciliationFactSnapshot,
} from '../../src/types/m5-types.js';

let tmpDir: string;
let store: SqliteStateStore;

describe('M5 Preflight', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m5-pf-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'm5-pf.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function makeBlockingSnapshot(runId: string): ReconciliationFactSnapshot {
    return {
      run: {
        runId, runStatus: 'running',
        projectRootHash: 'sha256:fake',
        governanceEnabled: false,
        gitHead: null, gitHeadResolvable: false,
        mergeConflict: false, conflictFiles: [],
      },
      stages: [],
    };
  }

  function makeCleanSnapshot(runId: string): ReconciliationFactSnapshot {
    return {
      run: {
        runId, runStatus: 'running',
        projectRootHash: 'sha256:fake',
        governanceEnabled: false,
        gitHead: 'abc123', gitHeadResolvable: true,
        mergeConflict: false, conflictFiles: [],
      },
      stages: [{
        stageId: 'stage-001', stageNumber: 1, status: 'running',
        baseCommit: 'abc123',
        tasks: [{
          taskId: 'task-001', title: 'Test', status: 'running',
          attempts: [{
            attemptId: 'att-001', attemptNumber: 1,
            status: 'running', taskId: 'task-001', stageId: 'stage-001',
            pid: 12345, pidAlive: 'alive',
            worktreePath: '/tmp/wt', worktreeExists: true, worktreeRegistered: true, worktreeDirty: false,
            branchName: 'task-branch', branchExists: true, branchHeadMatches: true,
            workerResultExists: false, workerResultJson: null,
            locksHeld: 0, locksOrphaned: false,
            reviewCoveredByTrustedStageReview: false,
            reviewCompleted: false, reviewStatus: null,
          }],
        }],
        integration: null, activeLocks: [],
      }],
    };
  }

  it('M5-PF01: preflight with blocking finding returns hasBlocking=true', () => {
    const facts = makeBlockingSnapshot('run-blk');
    const findings = classifyFacts(facts, false);
    const blocking = findings.filter((f) => f.severity === 'blocking');
    expect(blocking.length).toBeGreaterThan(0);
  });

  it('M5-PF02: preflight with clean state returns hasBlocking=false', () => {
    const facts = makeCleanSnapshot('run-clean');
    const findings = classifyFacts(facts, false);
    const blocking = findings.filter((f) => f.severity === 'blocking');
    expect(blocking).toHaveLength(0);
  });

  it('M5-PF03: approve_preflight initiatedBy is set in report', () => {
    const facts = makeCleanSnapshot('run-apf');
    const result = converge(facts, false, 'dry_run', 'approve_preflight');
    expect(result.report.initiatedBy).toBe('approve_preflight');
    expect(result.report.phase).toBe('dry_run');
  });

  it('M5-PF04: resume_preflight initiatedBy is set in report', () => {
    const facts = makeCleanSnapshot('run-rpf');
    const result = converge(facts, false, 'dry_run', 'resume_preflight');
    expect(result.report.initiatedBy).toBe('resume_preflight');
    expect(result.report.phase).toBe('dry_run');
  });

  it('M5-PF05: preflight produces zero writes to SQLite', async () => {
    const runId = `run-pf-nowrite-${Date.now()}`;
    await store.createRun({
      id: runId,
      projectId: 'proj-pf',
      projectRoot: '/tmp/pf',
      requestText: 'PF test',
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const facts = makeCleanSnapshot(runId);
    const { report } = converge(facts, false, 'dry_run', 'approve_preflight');

    // Verify no reconciliation_reports written
    const reports = await store.listReconciliationReports(runId);
    expect(reports).toHaveLength(0);
  });

  it('M5-PF06: blocking finding causes canResume=false and canApprove=false', () => {
    const facts = makeBlockingSnapshot('run-blk2');
    const result = converge(facts, false, 'dry_run', 'approve_preflight');
    expect(result.report.summary.canResume).toBe(false);
    expect(result.report.summary.canApprove).toBe(false);
  });

  it('M5-PF07: governance disabled still produces base findings', () => {
    const facts: ReconciliationFactSnapshot = {
      run: {
        runId: 'run-gov-off', runStatus: 'running',
        projectRootHash: 'sha256:fake',
        governanceEnabled: false,
        gitHead: 'abc123', gitHeadResolvable: true,
        mergeConflict: false, conflictFiles: [],
      },
      stages: [{
        stageId: 'stage-001', stageNumber: 1, status: 'running',
        baseCommit: 'abc123',
        tasks: [{
          taskId: 'task-001', title: 'Test', status: 'running',
          attempts: [{
            attemptId: 'att-001', attemptNumber: 1,
            status: 'running', taskId: 'task-001', stageId: 'stage-001',
            pid: 99999, pidAlive: 'gone',
            worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
            branchName: null, branchExists: false, branchHeadMatches: false,
            workerResultExists: false, workerResultJson: null,
            locksHeld: 1, locksOrphaned: true,
            reviewCoveredByTrustedStageReview: false,
            reviewCompleted: false, reviewStatus: null,
          }],
        }],
        integration: null, activeLocks: [],
      }],
    };
    const findings = classifyFacts(facts, false);
    // Should still detect PID missing even with governance off
    expect(findings.some((f) => f.kind === 'pid_missing')).toBe(true);
  });

  it('M5-PF08: preflight reconciliation accepts a trusted stage review proof (no review_evidence_missing)', async () => {
    const runId = `run-trusted-review-${Date.now()}`;
    const repoDir = path.join(tmpDir, `git-repo-${Date.now()}`);
    mkdirSync(repoDir, { recursive: true });

    const runGit = (args: string[]): string => execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();

    runGit(['init', '-b', 'main']);
    runGit(['config', 'user.email', 'test@example.com']);
    runGit(['config', 'user.name', 'Test User']);

    writeFileSync(path.join(repoDir, 'base.txt'), 'base\n');
    runGit(['add', '.']);
    runGit(['commit', '-m', 'base']);
    const baseCommit = runGit(['rev-parse', 'HEAD']);

    // Task branch holds the reviewed-through commit with the real change.
    runGit(['checkout', '-b', 'task-branch']);
    writeFileSync(path.join(repoDir, 'task.txt'), 'task\n');
    runGit(['add', '.']);
    runGit(['commit', '-m', 'task work']);
    const reviewedThroughCommit = runGit(['rev-parse', 'HEAD']);

    // Integration branch points at the exact commit reviewed for the stage.
    runGit(['checkout', '-b', 'int-branch']);
    const mergeCommitHash = runGit(['rev-parse', 'HEAD']);

    const stageId = `${runId}-stage-1`;
    const taskId = `${runId}-task-1`;
    const attemptId = `${runId}-att-1`;
    const batchId = `${runId}-batch-1`;

    const snapshot = JSON.stringify({
      snapshotVersion: 1,
      createdAt: new Date().toISOString(),
      config: { executionMode: 'token-efficient', reviewer: { type: 'codex-cli' } },
    });

    await store.createRun({
      id: runId,
      projectId: `proj-${runId}`,
      projectRoot: repoDir,
      requestText: 'Trusted stage review regression',
      status: 'running',
      executionConfigSnapshot: snapshot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'completed', baseCommit });
    await store.createTask({
      id: taskId,
      runId,
      title: 'T1',
      status: 'merged',
      specJson: { estimatedWritePaths: ['task.txt'] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'approved' });
    await store.updateAttemptResult(attemptId, {
      branchName: 'int-branch',
      workerResultJson: JSON.stringify({ status: 'completed', commitHash: mergeCommitHash }),
    });

    await store.createIntegrationBatch({ id: batchId, stageId, runId, integrationBranch: 'int-branch' });
    await store.updateIntegrationBatch(batchId, {
      status: 'completed',
      mergeCommitHash,
      reviewedThroughCommit,
      reviewCoverageStatus: 'complete',
      reviewerUnavailable: false,
      reviewMetadataJson: JSON.stringify({ reviewer: 'codex-cli' }),
    });

    const skipEvent = await store.createEvent({
      id: `${runId}-ev-skip`,
      runId,
      stageId,
      taskId,
      attemptId,
      eventType: 'review_skipped_token_efficient',
      eventData: { reason: 'token_efficient_mode', mode: 'token-efficient', riskLevel: 'medium' },
    });
    const startedEvent = await store.createEvent({
      id: `${runId}-ev-stage-start`,
      runId,
      stageId,
      taskId: null,
      attemptId: null,
      eventType: 'stage_review_started',
      eventData: { taskCount: 1, stageNumber: 1, reviewedCommit: reviewedThroughCommit },
    });
    const completedEvent = await store.createEvent({
      id: `${runId}-ev-stage-complete`,
      runId,
      stageId,
      taskId: null,
      attemptId: null,
      eventType: 'stage_review_completed',
      eventData: { cacheHit: false, approvedTasks: [taskId] },
    });

    // Force deterministic audit ordering (createdAt, then id).
    const db = store.getDatabase();
    db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run('2024-01-01T00:00:00.500Z', skipEvent.id);
    db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run('2024-01-01T00:00:00.000Z', startedEvent.id);
    db.prepare('UPDATE events SET created_at = ? WHERE id = ?').run('2024-01-01T00:00:01.000Z', completedEvent.id);

    const findings = await runPreflightReconciliation(store, runId, 'approve_preflight');
    expect(findings.some((f) => f.kind === 'review_evidence_missing')).toBe(false);
    expect(findings.some((f) => f.kind === 'fake_review_in_real_path')).toBe(false);
    expect(findings.some((f) => f.severity === 'blocking')).toBe(false);
  });
});
