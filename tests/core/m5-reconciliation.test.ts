// ── M5 Reconciliation Integration Tests ────────────────────────────────
// Tests the full reconciliation pipeline using per-test unique IDs
// with shared temporary SQLite store.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { converge } from '../../src/core/reconciliation/convergence-engine.js';
import { applySafeActions } from '../../src/core/reconciliation/applicator.js';
import { classifyFacts, deriveSafeActions } from '../../src/core/reconciliation/classifier.js';
import type {
  ReconciliationFactSnapshot,
} from '../../src/types/m5-types.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('M5 Reconciliation Integration', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m5-recon-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'm5-recon.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Helper: create entities with unique-per-test suffix
  function uid(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // ══════════════════════════════════════════════════════════
  // M5-01: running attempt PID gone → interrupted + lock release
  // ══════════════════════════════════════════════════════════

  it('M5-01: running attempt PID gone → mark interrupted in apply', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const taskId = uid('task');
    const attemptId = uid('att');
    const lockId = uid('lock');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
    await store.updateAttemptResult(attemptId, { piPid: 99999, startedAt: new Date().toISOString() });
    await store.createPathLock({ id: lockId, runId, taskId, filePath: 'test.ts', lockType: 'exclusive' });

    const facts: ReconciliationFactSnapshot = {
      run: { runId, runStatus: 'running', projectRootHash: 'sha256:fake', governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [] },
      stages: [{
        stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
        tasks: [{
          taskId, title: 'T1', status: 'running',
          attempts: [{
            attemptId, attemptNumber: 1, status: 'running', taskId, stageId,
            pid: 99999, pidAlive: 'gone',
            worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
            branchName: null, branchExists: false, branchHeadMatches: false,
            workerResultExists: false, workerResultJson: null,
            locksHeld: 1, locksOrphaned: true,
            reviewCompleted: false, reviewStatus: null,
          }],
        }],
        integration: null,
        activeLocks: [{
          lockId, filePathHash: 'sha256:path', taskId,
          lockType: 'exclusive', lockStatus: 'locked',
          ownerAttemptId: attemptId, ownerAttemptStatus: 'running',
          ownerPidAlive: 'gone', ownerRunStatus: 'running',
        }],
      }],
    };

    const findings = classifyFacts(facts, false);
    const safeActions = deriveSafeActions(findings);
    const { report } = converge(facts, false, 'applied', 'user_direct');
    const result = await applySafeActions(store, report, findings, safeActions);
    expect(result.atomicResult.appliedActions.some((a) => a.success)).toBe(true);

    const attempt = await store.getAttempt(attemptId);
    expect(attempt).not.toBeNull();
    expect(attempt!.status).toBe('interrupted');
    expect(attempt!.exitReason).toContain('pid_missing');
  });

  // ══════════════════════════════════════════════════════════
  // M5-02: worker_completed + workerResult missing → interrupted
  // ══════════════════════════════════════════════════════════

  it('M5-02: worker_completed with missing workerResult → interrupted', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const taskId = uid('task');
    const attemptId = uid('att');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'worker_completed' as any });
    await store.updateAttemptResult(attemptId, { workerResultJson: null });

    const facts: ReconciliationFactSnapshot = {
      run: { runId, runStatus: 'running', projectRootHash: 'sha256:fake', governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [] },
      stages: [{
        stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
        tasks: [{
          taskId, title: 'T1', status: 'running',
          attempts: [{
            attemptId, attemptNumber: 1, status: 'worker_completed', taskId, stageId,
            pid: null, pidAlive: 'gone',
            worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
            branchName: null, branchExists: false, branchHeadMatches: false,
            workerResultExists: false, workerResultJson: null,
            locksHeld: 0, locksOrphaned: false,
            reviewCompleted: false, reviewStatus: null,
          }],
        }],
        integration: null, activeLocks: [],
      }],
    };

    const findings = classifyFacts(facts, false);
    const safeActions = deriveSafeActions(findings);
    const { report } = converge(facts, false, 'applied', 'user_direct');
    await applySafeActions(store, report, findings, safeActions);

    const attempt = await store.getAttempt(attemptId);
    expect(attempt!.status).toBe('interrupted');
    expect(attempt!.exitReason).toContain('worker_result_missing');
  });

  // ══════════════════════════════════════════════════════════
  // M5-03: orphan lock release on terminal attempt
  // ══════════════════════════════════════════════════════════

  it('M5-03: orphan lock released when owner attempt is terminal', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const taskId = uid('task');
    const attemptId = uid('att');
    const lockId = uid('lock');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'completed', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'approved' as any });
    await store.createPathLock({ id: lockId, runId, taskId, filePath: 'test.ts', lockType: 'exclusive' });

    const facts: ReconciliationFactSnapshot = {
      run: { runId, runStatus: 'running', projectRootHash: 'sha256:fake', governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [] },
      stages: [{
        stageId, stageNumber: 1, status: 'completed', baseCommit: 'abc123',
        tasks: [{
          taskId, title: 'T1', status: 'completed',
          attempts: [{
            attemptId, attemptNumber: 1, status: 'approved', taskId, stageId,
            pid: null, pidAlive: 'gone',
            worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
            branchName: null, branchExists: false, branchHeadMatches: false,
            workerResultExists: false, workerResultJson: null,
            locksHeld: 0, locksOrphaned: false,
            reviewCompleted: false, reviewStatus: null,
          }],
        }],
        integration: null,
        activeLocks: [{
          lockId, filePathHash: 'sha256:path', taskId,
          lockType: 'exclusive', lockStatus: 'locked',
          ownerAttemptId: attemptId, ownerAttemptStatus: 'approved',
          ownerPidAlive: 'n/a', ownerRunStatus: 'running',
        }],
      }],
    };

    const findings = classifyFacts(facts, false);
    const safeActions = deriveSafeActions(findings);
    const { report } = converge(facts, false, 'applied', 'user_direct');
    await applySafeActions(store, report, findings, safeActions);

    const lock = await store.getPathLock(lockId);
    expect(lock).not.toBeNull();
    expect(lock!.status).toBe('released');
  });

  // ══════════════════════════════════════════════════════════
  // M5-04: canceled run → non-terminal stages/attempts canceled
  // ══════════════════════════════════════════════════════════

  it('M5-04: canceled run auto-cancels non-terminal attempts', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const taskId = uid('task');
    const attemptId = uid('att');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Test', status: 'canceled',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
    await store.updateAttemptResult(attemptId, { piPid: 99999 });

    const facts: ReconciliationFactSnapshot = {
      run: { runId, runStatus: 'canceled', projectRootHash: 'sha256:fake', governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [] },
      stages: [{
        stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
        tasks: [{
          taskId, title: 'T1', status: 'running',
          attempts: [{
            attemptId, attemptNumber: 1, status: 'running', taskId, stageId,
            pid: 99999, pidAlive: 'gone',
            worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
            branchName: null, branchExists: false, branchHeadMatches: false,
            workerResultExists: false, workerResultJson: null,
            locksHeld: 0, locksOrphaned: false,
            reviewCompleted: false, reviewStatus: null,
          }],
        }],
        integration: null, activeLocks: [],
      }],
    };

    const findings = classifyFacts(facts, false);
    const safeActions = deriveSafeActions(findings);
    const { report } = converge(facts, false, 'applied', 'user_direct');
    await applySafeActions(store, report, findings, safeActions);

    const attempt = await store.getAttempt(attemptId);
    expect(attempt!.status).toBe('canceled');
  });

  // ══════════════════════════════════════════════════════════
  // M5-05: dry-run produces zero writes
  // ══════════════════════════════════════════════════════════

  it('M5-05: dry-run produces zero writes to reconciliation tables', async () => {
    const runId = uid('run');
    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    const facts: ReconciliationFactSnapshot = {
      run: { runId, runStatus: 'running', projectRootHash: 'sha256:fake', governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [] },
      stages: [],
    };

    const { report } = converge(facts, false, 'dry_run', 'user_direct');
    const reports = await store.listReconciliationReports(runId);
    expect(reports).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════
  // M5-06: reconciliation report persisted after apply
  // ══════════════════════════════════════════════════════════

  it('M5-06: reconciliation report persisted after apply', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const taskId = uid('task');
    const attemptId = uid('att');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
    await store.updateAttemptResult(attemptId, { piPid: 99999 });

    const facts: ReconciliationFactSnapshot = {
      run: { runId, runStatus: 'running', projectRootHash: 'sha256:fake', governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [] },
      stages: [{
        stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
        tasks: [{
          taskId, title: 'T1', status: 'running',
          attempts: [{
            attemptId, attemptNumber: 1, status: 'running', taskId, stageId,
            pid: 99999, pidAlive: 'gone',
            worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
            branchName: null, branchExists: false, branchHeadMatches: false,
            workerResultExists: false, workerResultJson: null,
            locksHeld: 0, locksOrphaned: false,
            reviewCompleted: false, reviewStatus: null,
          }],
        }],
        integration: null, activeLocks: [],
      }],
    };

    const findings = classifyFacts(facts, false);
    const safeActions = deriveSafeActions(findings);
    const { report } = converge(facts, false, 'applied', 'user_direct');
    const result = await applySafeActions(store, report, findings, safeActions);

    const reports = await store.listReconciliationReports(runId);
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].runId).toBe(runId);
    expect(reports[0].phase).toBe('applied');

    const storedFindings = await store.listReconciliationFindings(reports[0].id);
    expect(storedFindings.length).toBeGreaterThanOrEqual(1);
  });
});
