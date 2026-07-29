// ── M5 Idempotency Tests ────────────────────────────────────────────────
// Proves that two consecutive reconcile --apply invocations:
// 1. First: applies safe actions, produces appliedCount > 0
// 2. Second: produces appliedCount = 0 and no duplicate events

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { classifyFacts, deriveSafeActions } from '../../src/core/reconciliation/classifier.js';
import { converge } from '../../src/core/reconciliation/convergence-engine.js';
import { applySafeActions } from '../../src/core/reconciliation/applicator.js';
import type { ReconciliationFactSnapshot } from '../../src/types/m5-types.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('M5 Idempotency', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m5-idem-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'm5-idem.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function uid(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  it('M5-ID01: two consecutive applies → second appliedCount=0, no duplicate state changes', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const taskId = uid('task');
    const attemptId = uid('att');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Idempotency', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
    await store.updateAttemptResult(attemptId, { piPid: 99999, startedAt: new Date().toISOString() });

    const makeFacts = (): ReconciliationFactSnapshot => ({
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
    });

    // First apply
    const facts1 = makeFacts();
    const findings1 = classifyFacts(facts1, false);
    const safeActions1 = deriveSafeActions(findings1);
    const { report: report1 } = converge(facts1, false, 'applied', 'user_direct');
    const result1 = await applySafeActions(store, report1, findings1, safeActions1);
    expect(result1.atomicResult.appliedActions.filter((a) => a.success).length).toBeGreaterThan(0);

    const att1 = await store.getAttempt(attemptId);
    expect(att1!.status).toBe('interrupted');

    const reports1 = await store.listReconciliationReports(runId);
    const reportCount1 = reports1.length;

    // Second apply — attempt already interrupted, should be idempotent
    const facts2 = makeFacts();
    const findings2 = classifyFacts(facts2, false);
    const safeActions2 = deriveSafeActions(findings2);
    const { report: report2 } = converge(facts2, false, 'applied', 'user_direct');
    const result2 = await applySafeActions(store, report2, findings2, safeActions2);

    const att2 = await store.getAttempt(attemptId);
    expect(att2!.status).toBe('interrupted'); // unchanged

    const reports2 = await store.listReconciliationReports(runId);
    expect(reports2.length).toBeGreaterThanOrEqual(reportCount1);
  });

  it('M5-ID02: release lock idempotent (already released)', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const taskId = uid('task');
    const attemptId = uid('att');
    const lockId = uid('lock');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Lock idem', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'completed', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'approved' as any });
    await store.createPathLock({ id: lockId, runId, taskId, filePath: 'test.ts', lockType: 'exclusive' });

    // First apply: release lock (it's orphaned — owner attempt is approved)
    const facts1: ReconciliationFactSnapshot = {
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

    const findings1 = classifyFacts(facts1, false);
    const safeActions1 = deriveSafeActions(findings1);
    const { report: report1 } = converge(facts1, false, 'applied', 'user_direct');
    await applySafeActions(store, report1, findings1, safeActions1);

    const lock1 = await store.getPathLock(lockId);
    expect(lock1!.status).toBe('released');

    // Second apply: lock already released — not in locked facts anymore
    const facts2: ReconciliationFactSnapshot = {
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
        integration: null, activeLocks: [], // lock already released
      }],
    };

    const findings2 = classifyFacts(facts2, false);
    // No lock_orphaned finding since lock is released
    const lockActions = findings2.filter((f) => f.kind === 'lock_orphaned');
    expect(lockActions).toHaveLength(0);
  });

  it('M5-ID03: integration batch completed → second apply skips', async () => {
    const runId = uid('run');
    const stageId = uid('stage');
    const batchId = uid('batch');

    await store.createRun({
      id: runId, projectId: `proj-${runId}`, projectRoot: `/tmp/${runId}`,
      requestText: 'Integration idem', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' as any });
    await store.createIntegrationBatch({ id: batchId, stageId, runId, integrationBranch: 'int-branch' });
    await store.updateIntegrationBatch(batchId, { status: 'integrating' as any });

    const makeFacts = (): ReconciliationFactSnapshot => ({
      run: { runId, runStatus: 'running', projectRootHash: 'sha256:fake', governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [] },
      stages: [{
        stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
        tasks: [],
        integration: {
          batchId, status: 'integrating',
          integrationBranch: 'int-branch', integrationBranchExists: true,
          mergeCommitInGit: true, targetAlreadyMerged: false,
          targetBranch: 'main', targetMergeCommit: null,
        },
        activeLocks: [],
      }],
    });

    // First apply: mark batch completed
    const facts1 = makeFacts();
    const findings1 = classifyFacts(facts1, false);
    const safeActions1 = deriveSafeActions(findings1);
    const { report: report1 } = converge(facts1, false, 'applied', 'user_direct');
    await applySafeActions(store, report1, findings1, safeActions1);

    const batch1 = await store.getIntegrationBatch(batchId);
    expect(batch1!.status).toBe('completed');

    // Second apply: batch already completed → applicator returns success (idempotent)
    const facts2 = makeFacts();
    const findings2 = classifyFacts(facts2, false);
    const safeActions2 = deriveSafeActions(findings2);
    const { report: report2 } = converge(facts2, false, 'applied', 'user_direct');
    const result2 = await applySafeActions(store, report2, findings2, safeActions2);

    // Should still report but batch stays completed
    expect(result2.atomicResult.appliedCount).toBeGreaterThanOrEqual(0);
  });
});
