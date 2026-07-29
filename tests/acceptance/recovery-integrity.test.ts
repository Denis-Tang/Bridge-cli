// ── Crash Recovery & Orphan Resource Acceptance Tests ───────────────────
// Validates crash recovery, PID ownership, cancel races, and worktree/SQLite
// state consistency using fake/disposable fixtures only.
//
// Zero real Pi/Codex, network, .env, or user data access.
// Never calls taskkill/kill on real processes.
//
// Parallel modification boundary: ONLY this file + helpers/recovery-fixtures.ts
// + docs/RECOVERY-FAKE-ACCEPTANCE.md. Do not modify src/**, existing tests/**,
// or package/vitest config.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { classifyFacts, deriveSafeActions } from '../../src/core/reconciliation/classifier.js';
import { converge } from '../../src/core/reconciliation/convergence-engine.js';
import { applySafeActions } from '../../src/core/reconciliation/applicator.js';
import type { ReconciliationFactSnapshot } from '../../src/types/m5-types.js';

import {
  makeRecoveryGitRepo, makeRecoveryStore, setupRecoveryScheduler,
  setupRecoveryPipeline, teardownRecovery, uid,
  makeRecoveryTaskSpec,
  ControllablePiRunner, ControllableCodexRunner,
  FastRecoveryPiRunner, FastRecoveryCodexRunner,
  getBranchHead, getFileFromBranch, verifyFileContent,
  assertNoDuplicateLedgerCallIds,
} from './helpers/recovery-fixtures.js';
import type { RecoveryBenchContext, RecoveryPipelineContext } from './helpers/recovery-fixtures.js';

// ══════════════════════════════════════════════════════════════
// Shared pipeline test helpers
// ══════════════════════════════════════════════════════════════

function makeBaseFacts(runId: string): ReconciliationFactSnapshot['run'] {
  return {
    runId, runStatus: 'running', projectRootHash: 'sha256:fake',
    governanceEnabled: false, gitHead: 'abc123', gitHeadResolvable: true,
    mergeConflict: false, conflictFiles: [],
  };
}

// ══════════════════════════════════════════════════════════════
// A组: Worker/Review 中断后的恢复
// ══════════════════════════════════════════════════════════════

describe('A — Worker/Review Interruption Recovery', () => {

  // ── A-01: End-to-end PID-gone recovery via startRun() ──
  describe('A-01: PID gone → interrupted + scheduler recovery', () => {
    let ctx: RecoveryBenchContext & { controllablePi: ControllablePiRunner | null; controllableCodex: ControllableCodexRunner | null };
    const stageId = 'rec-a01-s1';
    const taskId = 'rec-a01-t1';
    const attemptId = 'rec-a01-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryScheduler(2, 'a01', { maxReworkCount: 1 });
      const now = new Date().toISOString();

      // Create a stage and task with a running attempt that has a non-existent PID
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'ready' });
      const spec = makeRecoveryTaskSpec(taskId, 1, 'src/recovery_a01.ts');
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: spec.title, status: 'running',
        specJson: spec, createdAt: now, updatedAt: now,
      });
      await ctx.store.createAttempt({
        id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any,
      });
      // Assign a PID that definitely does not exist
      await ctx.store.updateAttemptResult(attemptId, {
        piPid: 99999,
        startedAt: now,
      });

      // Now run the scheduler — it should reconcile the gone PID and recover
      await ctx.scheduler.startRun(ctx.runId);
    }, 90000);

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('original attempt with gone PID is marked interrupted', async () => {
      const attempt = await ctx.store.getAttempt(attemptId);
      expect(attempt, 'attempt must exist').not.toBeNull();
      expect(attempt!.status, 'PID-gone attempt must be interrupted').toBe('interrupted');
      expect(attempt!.exitReason, 'exit reason must mention PID').toMatch(/pid|PID/i);
    });

    it('task is eventually merged (retry succeeded)', async () => {
      const task = await ctx.store.getTask(taskId);
      expect(task, 'task must exist').not.toBeNull();
      // After recovery, the task should have been retried and completed
      expect(['merged', 'completed', 'approved']).toContain(task!.status);
    });

    it('run reaches terminal state', async () => {
      const run = await ctx.store.getRun(ctx.runId);
      expect(run, 'run must exist').not.toBeNull();
      // Run should not be stuck in running — should reach terminal or at least not fail silently
      expect(run!.status).not.toBe('running');
    });

    it('no duplicate ledger callIds', async () => {
      const dupes = await assertNoDuplicateLedgerCallIds(ctx.store, ctx.runId);
      expect(dupes, 'no duplicate ledger callIds').toBe(0);
    });
  });

  // ── A-02: worker_completed + missing workerResult → interrupted (pipeline) ──
  describe('A-02: worker_completed with missing workerResult', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-a02-s1';
    const taskId = 'rec-a02-t1';
    const attemptId = 'rec-a02-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('a02');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'worker_completed' as any });
      await ctx.store.updateAttemptResult(attemptId, { workerResultJson: null });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('worker_completed without workerResult → classified as blocking', () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
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
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      const blockingFindings = findings.filter(f => f.severity === 'blocking');
      expect(blockingFindings.length, 'must have at least one blocking finding').toBeGreaterThanOrEqual(1);
      expect(blockingFindings.some(f => f.kind === 'worker_result_missing'), 'must flag worker_result_missing').toBe(true);
    });

    it('applySafeActions marks attempt as interrupted', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
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
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
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
      await applySafeActions(ctx.store, report, findings, safeActions);

      const attempt = await ctx.store.getAttempt(attemptId);
      expect(attempt!.status).toBe('interrupted');
      expect(attempt!.exitReason).toContain('worker_result_missing');
    });
  });

  // ── A-03: reviewing + review completed but attempt still reviewing → converge (pipeline) ──
  describe('A-03: reviewing with stale state → review convergence', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-a03-s1';
    const taskId = 'rec-a03-t1';
    const attemptId = 'rec-a03-a1';
    const reviewId = 'rec-a03-rev1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('a03');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'reviewing' as any });
      // Review exists and is completed/approved, but attempt is still 'reviewing'
      await ctx.store.createReview({
        id: reviewId, attemptId, taskId,
        reviewerType: 'codex',
        status: 'approved',
      });
      await ctx.store.updateReviewResult(reviewId, {
        status: 'approved', finishedAt: new Date().toISOString(),
        mergeAllowed: true,
      });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('review_completed but attempt still reviewing → info finding, can converge', () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'reviewing', taskId, stageId,
              pid: null, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: true, workerResultJson: '{}',
              workerResultCompleted: true, workerCommitHash: 'def456',
              changedFiles: ['src/test.ts'], expectedWritePaths: ['src/test.ts'], expectedWriteEvidence: true,
              reviewEvidenceTrusted: true,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: true, reviewStatus: 'approved',
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      // Should have review_state_mismatch (info) since review completed but attempt still reviewing
      const mismatchFindings = findings.filter(f => f.kind === 'review_state_mismatch');
      expect(mismatchFindings.length, 'must detect review_state_mismatch').toBeGreaterThanOrEqual(1);
      expect(mismatchFindings.every(f => f.severity === 'info'), 'mismatch should be info, not blocking').toBe(true);
    });

    it('apply converges attempt status per review result', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'reviewing', taskId, stageId,
              pid: null, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: true, workerResultJson: '{}',
              workerResultCompleted: true, workerCommitHash: 'def456',
              changedFiles: ['src/test.ts'], expectedWritePaths: ['src/test.ts'], expectedWriteEvidence: true,
              reviewEvidenceTrusted: true,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: true, reviewStatus: 'approved',
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      const result = await applySafeActions(ctx.store, report, findings, safeActions);
      expect(result.atomicResult.appliedActions.some(a => a.success)).toBe(true);
    });
  });

  // ── A-04: Integration batch stalled with merge commit → convergence (pipeline) ──
  describe('A-04: integration batch stalled with merge in Git', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-a04-s1';
    const batchId = 'rec-a04-b1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('a04');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'integration' as any });
      await ctx.store.createIntegrationBatch({
        id: batchId, stageId, runId: ctx.runId,
        integrationBranch: 'brainctl/int-rec-a04',
      });
      // Update batch to 'integrating' status for the test scenario
      await ctx.store.updateIntegrationBatch(batchId, { status: 'integrating' });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('integration batch with merge commit in Git → info, can converge', () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'integration', baseCommit: 'abc123',
          tasks: [],
          integration: {
            batchId, status: 'integrating',
            integrationBranch: 'brainctl/int-rec-a04', integrationBranchExists: true,
            mergeCommitInGit: true, targetAlreadyMerged: false,
            targetBranch: 'main', targetMergeCommit: null,
          },
          activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      const stalledFindings = findings.filter(f => f.kind === 'integration_stalled');
      expect(stalledFindings.length, 'must detect integration_stalled').toBeGreaterThanOrEqual(1);
    });

    it('apply converges batch to completed', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'integration', baseCommit: 'abc123',
          tasks: [],
          integration: {
            batchId, status: 'integrating',
            integrationBranch: 'brainctl/int-rec-a04', integrationBranchExists: true,
            mergeCommitInGit: true, targetAlreadyMerged: false,
            targetBranch: 'main', targetMergeCommit: null,
          },
          activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      const result = await applySafeActions(ctx.store, report, findings, safeActions);
      expect(result.atomicResult.appliedActions.some(a => a.success)).toBe(true);
    });
  });

  // ── A-05: validating + missing workerResult → interrupted (pipeline) ──
  describe('A-05: validating with missing workerResult', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-a05-s1';
    const taskId = 'rec-a05-t1';
    const attemptId = 'rec-a05-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('a05');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'validating' as any });
      await ctx.store.updateAttemptResult(attemptId, { workerResultJson: null });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('validating without workerResult → blocking, marks interrupted on apply', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'validating', taskId, stageId,
              pid: null, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: false, workerResultJson: null,
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      const blockingFindings = findings.filter(f => f.severity === 'blocking');
      expect(blockingFindings.some(f => f.kind === 'worker_result_missing'), 'must flag worker_result_missing in validating').toBe(true);

      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      await applySafeActions(ctx.store, report, findings, safeActions);

      const attempt = await ctx.store.getAttempt(attemptId);
      expect(attempt!.status).toBe('interrupted');
    });
  });
});

// ══════════════════════════════════════════════════════════════
// B组: PID 所有权与孤儿资源
// ══════════════════════════════════════════════════════════════

describe('B — PID Ownership & Orphan Resources', () => {

  // ── B-01: PID alive, worktree exists, branch exists → info (pipeline) ──
  describe('B-01: PID alive + environment intact', () => {
    it('classifies alive PID as info only, no action', () => {
      const runId = uid('run-b01');
      const attemptId = uid('att');

      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(runId),
        stages: [{
          stageId: uid('stage'), stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId: uid('task'), title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'running', taskId: uid('task'), stageId: uid('stage'),
              pid: 1234, pidAlive: 'alive',
              worktreePath: '/tmp/wt', worktreeExists: true, worktreeRegistered: true, worktreeDirty: false,
              branchName: 'brainctl/task', branchExists: true, branchHeadMatches: true,
              workerResultExists: false, workerResultJson: null,
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      const pidFindings = findings.filter(f => f.kind === 'pid_alive');
      expect(pidFindings.length, 'must have pid_alive finding').toBeGreaterThanOrEqual(1);
      expect(pidFindings.every(f => f.severity === 'info'), 'pid_alive must be info').toBe(true);

      const safeActions = deriveSafeActions(findings);
      const pidActions = safeActions.filter(a => a.targetEntityId === attemptId);
      expect(pidActions.length, 'no safe actions for alive PID').toBe(0);
    });
  });

  // ── B-02: PID gone (attempt crashed) → warning, auto-interrupt (pipeline) ──
  describe('B-02: PID gone → auto-interrupt with lock release', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-b02-s1';
    const taskId = 'rec-b02-t1';
    const attemptId = 'rec-b02-a1';
    const lockId = 'rec-b02-lk1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('b02');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
      await ctx.store.updateAttemptResult(attemptId, { piPid: 88888, startedAt: new Date().toISOString() });
      await ctx.store.createPathLock({ id: lockId, runId: ctx.runId, taskId, filePath: 'src/b02.ts', lockType: 'exclusive' });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('PID gone with orphan locks → warning findings for both', () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'running', taskId, stageId,
              pid: 88888, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: false, workerResultJson: null,
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 1, locksOrphaned: true,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null,
          activeLocks: [{
            lockId, filePathHash: 'sha256:b02', taskId,
            lockType: 'exclusive', lockStatus: 'locked',
            ownerAttemptId: attemptId, ownerAttemptStatus: 'running',
            ownerPidAlive: 'gone', ownerRunStatus: 'running',
          }],
        }],
      };

      const findings = classifyFacts(facts, false);
      expect(findings.some(f => f.kind === 'pid_missing'), 'must flag pid_missing').toBe(true);
      expect(findings.some(f => f.kind === 'lock_orphaned'), 'must flag lock_orphaned').toBe(true);
    });

    it('apply marks attempt interrupted and releases orphan lock', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'running', taskId, stageId,
              pid: 88888, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: false, workerResultJson: null,
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 1, locksOrphaned: true,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null,
          activeLocks: [{
            lockId, filePathHash: 'sha256:b02', taskId,
            lockType: 'exclusive', lockStatus: 'locked',
            ownerAttemptId: attemptId, ownerAttemptStatus: 'running',
            ownerPidAlive: 'gone', ownerRunStatus: 'running',
          }],
        }],
      };

      const findings = classifyFacts(facts, false);
      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      await applySafeActions(ctx.store, report, findings, safeActions);

      const attempt = await ctx.store.getAttempt(attemptId);
      expect(attempt!.status).toBe('interrupted');

      const lock = await ctx.store.getPathLock(lockId);
      expect(lock!.status).toBe('released');
    });
  });

  // ── B-03: Orphan lock with terminal owner → released (pipeline) ──
  describe('B-03: orphan lock, terminal attempt owner → release', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-b03-s1';
    const taskId = 'rec-b03-t1';
    const attemptId = 'rec-b03-a1';
    const lockId = 'rec-b03-lk1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('b03');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'completed',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'approved' as any });
      await ctx.store.createPathLock({ id: lockId, runId: ctx.runId, taskId, filePath: 'src/b03.ts', lockType: 'exclusive' });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('orphan lock with approved owner → released', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
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
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null,
          activeLocks: [{
            lockId, filePathHash: 'sha256:b03', taskId,
            lockType: 'exclusive', lockStatus: 'locked',
            ownerAttemptId: attemptId, ownerAttemptStatus: 'approved',
            ownerPidAlive: 'n/a', ownerRunStatus: 'running',
          }],
        }],
      };

      const findings = classifyFacts(facts, false);
      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      await applySafeActions(ctx.store, report, findings, safeActions);

      const lock = await ctx.store.getPathLock(lockId);
      expect(lock!.status).toBe('released');
    });
  });

  // ── B-04: Lock with unknown owner → blocking, NOT released (pipeline) ──
  describe('B-04: lock with unknown owner → blocking, not auto-released', () => {
    let ctx: RecoveryPipelineContext;
    const lockId = 'rec-b04-lk1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('b04');
      await ctx.store.createStage({ id: 'rec-b04-s1', runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      // Need a task for FK constraint
      await ctx.store.createTask({
        id: 'rec-b04-t1', runId: ctx.runId, title: 'T1', status: 'failed',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createPathLock({
        id: lockId, runId: ctx.runId, taskId: 'rec-b04-t1', filePath: 'src/b04.ts', lockType: 'exclusive',
      });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('unknown owner lock → blocking, no release action', () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId: 'rec-b04-s1', stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [],
          integration: null,
          activeLocks: [{
            lockId, filePathHash: 'sha256:b04', taskId: 'rec-b04-t1',
            lockType: 'exclusive', lockStatus: 'locked',
            ownerAttemptId: null, ownerAttemptStatus: null,
            ownerPidAlive: 'unknown', ownerRunStatus: null,
          }],
        }],
      };

      const findings = classifyFacts(facts, false);
      const lockFindings = findings.filter(f => f.entityType === 'lock');
      expect(lockFindings.some(f => f.kind === 'lock_owner_unknown'), 'must flag lock_owner_unknown').toBe(true);
      expect(lockFindings.some(f => f.severity === 'blocking'), 'unknown owner must be blocking').toBe(true);

      const safeActions = deriveSafeActions(findings);
      const lockActions = safeActions.filter(a => a.targetEntityId === lockId);
      expect(lockActions.length, 'no safe action for unknown-owner lock (fail closed)').toBe(0);
    });

    it('lock is NOT released (fail closed)', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId: 'rec-b04-s1', stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [],
          integration: null,
          activeLocks: [{
            lockId, filePathHash: 'sha256:b04', taskId: 'rec-b04-t1',
            lockType: 'exclusive', lockStatus: 'locked',
            ownerAttemptId: null, ownerAttemptStatus: null,
            ownerPidAlive: 'unknown', ownerRunStatus: null,
          }],
        }],
      };

      const findings = classifyFacts(facts, false);
      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      await applySafeActions(ctx.store, report, findings, safeActions);

      const lock = await ctx.store.getPathLock(lockId);
      expect(lock!.status).not.toBe('released');
    });
  });
});

// ══════════════════════════════════════════════════════════════
// C组: 取消与恢复竞态
// ══════════════════════════════════════════════════════════════

describe('C — Cancel & Recovery Race Conditions', () => {

  // ── C-01: Cancel before merge lease → no target advancement (end-to-end) ──
  describe('C-01: cancel before merge lease → no target HEAD advancement', () => {
    let ctx: RecoveryBenchContext & { controllablePi: ControllablePiRunner | null; controllableCodex: ControllableCodexRunner | null };
    const stageId = 'rec-c01-s1';
    const taskId = 'rec-c01-t1';

    beforeAll(async () => {
      ctx = await setupRecoveryScheduler(1, 'c01', { controllable: true, maxReworkCount: 0 });
      const now = new Date().toISOString();

      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'ready' });
      const spec = makeRecoveryTaskSpec(taskId, 1, 'src/recovery_c01.ts');
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: spec.title, status: 'pending',
        specJson: spec, createdAt: now, updatedAt: now,
      });

      // Block review so merge cannot proceed; cancel during review
      ctx.controllableCodex!.installBarrier();
    }, 90000);

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('cancel during review (before merge lease) → target HEAD unchanged, no merge', async () => {
      // Start the run — worker completes, review blocks
      const runPromise = ctx.scheduler.startRun(ctx.runId);

      // Wait for worker to complete (reviewer will block on barrier)
      await new Promise(r => setTimeout(r, 2000));

      // Cancel the run during review — prevents merge lease acquisition
      const now = new Date().toISOString();
      await ctx.store.updateRunStatus(ctx.runId, 'canceled', now);
      await ctx.store.updateRunFinishedAt(ctx.runId, now);

      // Release the review barrier
      ctx.controllableCodex!.release();

      // Wait for startRun to finish
      await runPromise;

      // Verify run is canceled
      const run = await ctx.store.getRun(ctx.runId);
      expect(run!.status).toBe('canceled');

      // A review result may be retained for audit, but cancellation must win
      // before the task/attempt can advance to approved or enter merge.
      const task = await ctx.store.getTask(taskId);
      expect(task!.status, 'task must be canceled after cancel during review').toBe('canceled');
      const attempt = await ctx.store.getLatestAttempt(taskId);
      expect(attempt!.status, 'attempt must be canceled after cancel during review').toBe('canceled');

      // Target branch: seed file must still exist (merge never happened)
      const seedContent = getFileFromBranch(ctx.projectRoot, 'main', 'src/seed.ts');
      expect(seedContent, 'target branch must still have original seed').toContain('export const seed = 1');

      // No recovery files in target
      let fileList = '';
      try {
        fileList = execFileSync('git', ['ls-tree', '--name-only', '-r', 'HEAD'], {
          cwd: ctx.projectRoot, stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
        });
      } catch { fileList = ''; }
      const files = fileList.trim().split('\n').filter(Boolean);
      const recoveryFiles = files.filter(f => f.includes('recovery'));
      expect(recoveryFiles.length, 'no recovery files in target after cancel').toBe(0);

      // No duplicate ledger callIds
      const dupes = await assertNoDuplicateLedgerCallIds(ctx.store, ctx.runId);
      expect(dupes, 'no duplicate ledger callIds').toBe(0);
    }, 60000);
  });

  // ── C-02: Cancel race → no duplicate dispatch or ledger (pipeline) ──
  describe('C-02: cancel does not produce duplicate dispatch', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-c02-s1';
    const taskId = 'rec-c02-t1';
    const attemptId = 'rec-c02-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('c02');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('canceled run → unique cancel event, no duplicate dispatch', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: { ...makeBaseFacts(ctx.runId), runStatus: 'canceled' },
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'running', taskId, stageId,
              pid: 77777, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: false, workerResultJson: null,
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const eventsBefore = await ctx.store.listEvents(ctx.runId);
      const findings = classifyFacts(facts, false);
      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      await applySafeActions(ctx.store, report, findings, safeActions);

      // Should have reconciled_mark_attempt_canceled event from the cancel action
      const eventsAfter = await ctx.store.listEvents(ctx.runId);
      const cancelEvents = eventsAfter.filter(e =>
        e.eventType === 'reconciled_mark_attempt_canceled');
      expect(cancelEvents.length, 'must have cancel events from reconciliation').toBeGreaterThanOrEqual(1);
    });
  });

  // ── C-03: Canceled run recovery → all non-terminal canceled (pipeline) ──
  describe('C-03: canceled run recovery via pipeline', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-c03-s1';
    const taskId = 'rec-c03-t1';
    const attemptId = 'rec-c03-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('c03');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('canceled run → non-terminal attempt canceled, run stays canceled', async () => {
      const facts: ReconciliationFactSnapshot = {
        run: { ...makeBaseFacts(ctx.runId), runStatus: 'canceled' },
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
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      const cancelFindings = findings.filter(f => f.kind === 'canceled_run_recovery');
      expect(cancelFindings.length, 'must find canceled_run_recovery findings').toBeGreaterThanOrEqual(1);

      const safeActions = deriveSafeActions(findings);
      const { report } = converge(facts, false, 'applied', 'user_direct');
      await applySafeActions(ctx.store, report, findings, safeActions);

      const attempt = await ctx.store.getAttempt(attemptId);
      expect(attempt!.status).toBe('canceled');
    });
  });

  // ── C-04: Cancel race → no duplicate events/ledger entries ──
  describe('C-04: cancel does not produce duplicate events', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-c04-s1';
    const taskId = 'rec-c04-t1';
    const attemptId = 'rec-c04-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('c04');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' as any });
      await ctx.store.updateAttemptResult(attemptId, { piPid: 77777 });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('applying canceled_run_recovery twice produces no duplicate events', async () => {
      const makeFacts = (): ReconciliationFactSnapshot => ({
        run: { ...makeBaseFacts(ctx.runId), runStatus: 'canceled' },
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'running',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'running', taskId, stageId,
              pid: 77777, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: false, workerResultJson: null,
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null, activeLocks: [],
        }],
      });

      // First apply
      const f1 = makeFacts();
      const findings1 = classifyFacts(f1, false);
      const actions1 = deriveSafeActions(findings1);
      const { report: r1 } = converge(f1, false, 'applied', 'user_direct');
      const result1 = await applySafeActions(ctx.store, r1, findings1, actions1);
      expect(result1.atomicResult.appliedActions.some(a => a.success)).toBe(true);

      // Event count after first apply
      const eventsAfter1 = await ctx.store.listEvents(ctx.runId);
      const eventCount1 = eventsAfter1.length;

      // Second apply: facts must reflect the already-canceled state
      const f2: ReconciliationFactSnapshot = {
        run: { ...makeBaseFacts(ctx.runId), runStatus: 'canceled' },
        stages: [{
          stageId, stageNumber: 1, status: 'canceled', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'canceled',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'canceled', taskId, stageId,
              pid: null, pidAlive: 'gone',
              worktreePath: null, worktreeExists: false, worktreeRegistered: false, worktreeDirty: false,
              branchName: null, branchExists: false, branchHeadMatches: false,
              workerResultExists: false, workerResultJson: null,
              workerResultCompleted: false, workerCommitHash: null,
              changedFiles: [], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: false, reviewStatus: null,
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings2 = classifyFacts(f2, false);
      const actions2 = deriveSafeActions(findings2);
      const { report: r2 } = converge(f2, false, 'applied', 'user_direct');
      const result2 = await applySafeActions(ctx.store, r2, findings2, actions2);
      // appliedCount should be 0 on second run (all already terminal)
      expect(result2.atomicResult.appliedCount).toBe(0);

      // Event count must not increase
      const eventsAfter2 = await ctx.store.listEvents(ctx.runId);
      expect(eventsAfter2.length, 'no duplicate events on second apply').toBe(eventCount1);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// D组: Worktree/SQLite 清理与状态一致性
// ══════════════════════════════════════════════════════════════

describe('D — Worktree/SQLite Cleanup & State Consistency', () => {

  // ── D-01: Completed run → full state consistency (end-to-end) ──
  describe('D-01: completed run state consistency', () => {
    let ctx: RecoveryBenchContext & { controllablePi: ControllablePiRunner | null; controllableCodex: ControllableCodexRunner | null };
    const stageId = 'rec-d01-s1';
    const taskId = 'rec-d01-t1';

    beforeAll(async () => {
      ctx = await setupRecoveryScheduler(2, 'd01', { maxReworkCount: 1 });
      const now = new Date().toISOString();

      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'ready' });
      const spec = makeRecoveryTaskSpec(taskId, 1, 'src/recovery_d01.ts');
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: spec.title, status: 'pending',
        specJson: spec, createdAt: now, updatedAt: now,
      });

      await ctx.scheduler.startRun(ctx.runId);
    }, 90000);

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('run is completed', async () => {
      const run = await ctx.store.getRun(ctx.runId);
      expect(run!.status).toBe('completed');
    });

    it('stage is completed', async () => {
      const stage = await ctx.store.getStage(stageId);
      expect(stage!.status).toBe('completed');
    });

    it('task is merged', async () => {
      const task = await ctx.store.getTask(taskId);
      expect(task!.status).toBe('merged');
    });

    it('target branch HEAD contains recovery file', () => {
      // List files in HEAD to find the worker-written recovery file
      let fileList = '';
      try {
        fileList = execFileSync('git', ['ls-tree', '--name-only', '-r', 'HEAD'], {
          cwd: ctx.projectRoot, stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
        });
      } catch { fileList = ''; }
      const files = fileList.trim().split('\n').filter(Boolean);
      const recoveryFiles = files.filter(f => f.includes('recovery'));
      expect(recoveryFiles.length, 'must have at least one recovery file in HEAD after merge').toBeGreaterThan(0);
    });

    it('target branch HEAD is valid commit', () => {
      const head = getBranchHead(ctx.projectRoot, 'main');
      expect(head, 'main branch HEAD must be resolvable').not.toBeNull();
      expect(head!.length).toBe(40);
    });

    it('integration batch records merge commit', async () => {
      const batches = await ctx.store.listIntegrationBatches(stageId);
      expect(batches.length, 'must have integration batch').toBeGreaterThanOrEqual(1);
      const batch = batches[batches.length - 1];
      expect(batch.status).toBe('completed');
      expect(batch.targetMergeCommit, 'must have target merge commit').not.toBeNull();
    });

    it('no duplicate ledger callIds', async () => {
      const dupes = await assertNoDuplicateLedgerCallIds(ctx.store, ctx.runId);
      expect(dupes, 'no duplicate ledger callIds').toBe(0);
    });

    it('SQLite run/stage/task/attempt/event states are mutually consistent', async () => {
      const run = await ctx.store.getRun(ctx.runId);
      const stages = await ctx.store.listStages(ctx.runId);
      const tasks = await ctx.store.listTasks(ctx.runId);
      const events = await ctx.store.listEvents(ctx.runId);

      // Run completed → all stages must be completed or canceled
      expect(run!.status).toBe('completed');
      for (const s of stages) {
        expect(['completed', 'canceled']).toContain(s.status);
      }

      // All tasks must be terminal
      for (const t of tasks) {
        expect(['merged', 'failed', 'canceled', 'rejected', 'merge_blocked']).toContain(t.status);
      }

      // Must have events for key lifecycle phases
      expect(events.length, 'must have events').toBeGreaterThan(0);
    });
  });

  // ── D-02: merge_blocked → SQLite state consistency (pipeline) ──
  describe('D-02: merge_blocked state consistency', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-d02-s1';
    const taskId = 'rec-d02-t1';
    const attemptId = 'rec-d02-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('d02');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'running' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'merge_blocked',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'approved' as any });
      await ctx.store.updateAttemptResult(attemptId, { workerResultJson: '{"status":"completed"}', branchName: 'brainctl/task-d02' });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('merge_blocked task is terminal → no action required', () => {
      const facts: ReconciliationFactSnapshot = {
        run: makeBaseFacts(ctx.runId),
        stages: [{
          stageId, stageNumber: 1, status: 'running', baseCommit: 'abc123',
          tasks: [{
            taskId, title: 'T1', status: 'merge_blocked',
            attempts: [{
              attemptId, attemptNumber: 1, status: 'approved', taskId, stageId,
              pid: null, pidAlive: 'gone',
              worktreePath: '/tmp/wt-d02', worktreeExists: true, worktreeRegistered: true, worktreeDirty: false,
              branchName: 'brainctl/task-d02', branchExists: true, branchHeadMatches: false,
              workerResultExists: true, workerResultJson: '{}',
              workerResultCompleted: true, workerCommitHash: null,
              changedFiles: ['src/d02.ts'], expectedWritePaths: [], expectedWriteEvidence: false,
              reviewEvidenceTrusted: false,
              locksHeld: 0, locksOrphaned: false,
              reviewCompleted: true, reviewStatus: 'approved',
            }],
          }],
          integration: null, activeLocks: [],
        }],
      };

      const findings = classifyFacts(facts, false);
      // merge_blocked is a terminal task status; no crash recovery needed
      const actionableFindings = findings.filter(f => f.severity !== 'info');
      // Any findings should NOT include pid_missing or similar recovery actions for this task
      expect(actionableFindings.filter(f => f.entityId === attemptId && f.kind === 'pid_missing').length, 'no pid_missing for merge_blocked task').toBe(0);
    });

    it('merge_blocked task remains merge_blocked', async () => {
      const task = await ctx.store.getTask(taskId);
      expect(task!.status).toBe('merge_blocked');
    });
  });

  // ── D-03: paused stage → worktree preserved (pipeline) ──
  describe('D-03: paused stage → SQLite consistency, worktree evidence preserved', () => {
    let ctx: RecoveryPipelineContext;
    const stageId = 'rec-d03-s1';
    const taskId = 'rec-d03-t1';
    const attemptId = 'rec-d03-a1';

    beforeAll(async () => {
      ctx = await setupRecoveryPipeline('d03');
      await ctx.store.createStage({ id: stageId, runId: ctx.runId, stageNumber: 1, title: 'S1', status: 'paused' as any });
      await ctx.store.createTask({
        id: taskId, runId: ctx.runId, title: 'T1', status: 'running',
        specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ctx.store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'worker_completed' as any });
      await ctx.store.updateAttemptResult(attemptId, {
        workerResultJson: '{"status":"completed"}',
        worktreePath: '/tmp/wt-d03',
        branchName: 'brainctl/task-d03',
      });
    });

    afterAll(async () => {
      await teardownRecovery(ctx);
    });

    it('paused stage status preserved', async () => {
      const stage = await ctx.store.getStage(stageId);
      expect(stage!.status).toBe('paused');
    });

    it('worker_completed attempt with worktree → evidence preserved (worktree not n/a)', async () => {
      const attempt = await ctx.store.getAttempt(attemptId);
      expect(attempt!.status).toBe('worker_completed');
      // Worktree path is recorded — paused means don't auto-clean
      expect(attempt!.worktreePath, 'worktree path recorded for paused stage').not.toBeNull();
    });

    it('run not completed while stage is paused', async () => {
      const run = await ctx.store.getRun(ctx.runId);
      expect(run!.status).not.toBe('completed');
    });
  });

  // ── D-04: Temp resource cleanup verification ──
  describe('D-04: temp resources properly cleaned', () => {
    it('fixture temp directories are cleaned after teardown', async () => {
      const ctx = await setupRecoveryPipeline('d04-cleanup');
      const tmpPath = ctx.tmp;
      expect(existsSync(tmpPath), 'temp dir must exist before teardown').toBe(true);

      await teardownRecovery(ctx);

      // After teardown, the temp directory must be gone
      // (rmSync with recursive+force should remove everything)
      expect(existsSync(tmpPath), 'temp dir must be gone after teardown').toBe(false);
    });
  });
});
