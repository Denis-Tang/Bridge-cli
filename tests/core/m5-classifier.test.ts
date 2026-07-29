// ── M5 Classifier Tests ─────────────────────────────────────────────────
// Pure memory tests for classifier, convergence engine, and safe action derivation.
// Zero file system, Git, or SQLite access. Fake facts only.

import { describe, it, expect } from 'vitest';
import { classifyFacts, deriveSafeActions } from '../../src/core/reconciliation/classifier.js';
import { converge } from '../../src/core/reconciliation/convergence-engine.js';
import type {
  ReconciliationFactSnapshot,
  RunFacts,
  StageFacts,
  TaskFacts,
  AttemptFacts,
  LockFacts,
  IntegrationFacts,
  SafeAction,
} from '../../src/types/m5-types.js';

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function makeRunFacts(overrides: Partial<RunFacts> = {}): RunFacts {
  return {
    runId: 'run-001',
    runStatus: 'running',
    projectRootHash: 'sha256:fake-project',
    governanceEnabled: true,
    gitHead: 'abc123',
    gitHeadResolvable: true,
    mergeConflict: false,
    conflictFiles: [],
    ...overrides,
  };
}

function makeAttemptFacts(overrides: Partial<AttemptFacts> = {}): AttemptFacts {
  return {
    attemptId: 'att-001',
    attemptNumber: 1,
    status: 'running',
    taskId: 'task-001',
    stageId: 'stage-001',
    pid: 12345,
    pidAlive: 'alive',
    worktreePath: '/tmp/wt-001',
    worktreeExists: true,
    worktreeRegistered: true,
    worktreeDirty: false,
    branchName: 'task-branch-001',
    branchExists: true,
    branchHeadMatches: true,
    workerResultExists: false,
    workerResultJson: null,
    workerResultCompleted: false,
    workerCommitHash: null,
    changedFiles: [],
    expectedWritePaths: [],
    expectedWriteEvidence: false,
    locksHeld: 1,
    locksOrphaned: false,
    reviewCompleted: false,
    reviewStatus: null,
    reviewEvidenceTrusted: false,
    ...overrides,
  };
}

function makeTaskFacts(overrides: Partial<TaskFacts> & { attempts?: AttemptFacts[] } = {}): TaskFacts {
  return {
    taskId: 'task-001',
    title: 'Test Task',
    status: 'running',
    attempts: overrides.attempts || [makeAttemptFacts()],
    ...overrides,
  };
}

function makeStageFacts(overrides: Partial<StageFacts> & { tasks?: TaskFacts[]; integration?: IntegrationFacts | null; activeLocks?: LockFacts[] } = {}): StageFacts {
  return {
    stageId: 'stage-001',
    stageNumber: 1,
    status: 'running',
    baseCommit: 'abc123',
    tasks: overrides.tasks || [makeTaskFacts()],
    integration: overrides.integration !== undefined ? overrides.integration : null,
    activeLocks: overrides.activeLocks || [],
    ...overrides,
    tasks: overrides.tasks || [makeTaskFacts()],
    integration: overrides.integration !== undefined ? overrides.integration : null,
    activeLocks: overrides.activeLocks || [],
  };
}

function makeSnapshot(
  run: Partial<RunFacts> = {},
  stages: Partial<StageFacts>[] = [],
): ReconciliationFactSnapshot {
  const stagesFacts = stages.length > 0
    ? stages.map((s, i) => ({
        stageId: `stage-00${i + 1}`,
        stageNumber: i + 1,
        status: 'running',
        baseCommit: 'abc123',
        tasks: [],
        integration: null,
        activeLocks: [],
        ...s,
      }))
    : [{
        stageId: 'stage-001',
        stageNumber: 1,
        status: 'running',
        baseCommit: 'abc123',
        tasks: [makeTaskFacts()],
        integration: null,
        activeLocks: [],
      }];
  return {
    run: makeRunFacts(run),
    stages: stagesFacts,
  };
}

// ══════════════════════════════════════════════════════════════
// Classifier Tests
// ══════════════════════════════════════════════════════════════

describe('M5 Classifier', () => {
  it('blocks completed run/stage and approved attempt when persisted completion has no real change evidence', () => {
    const approvedWithoutEvidence = makeAttemptFacts({
      status: 'approved',
      workerResultExists: true,
      workerResultCompleted: true,
      workerResultJson: JSON.stringify({ status: 'completed', filesChanged: [] }),
      branchExists: true,
      changedFiles: [],
      expectedWritePaths: ['src/m5-real-chain-acceptance.txt'],
      expectedWriteEvidence: false,
      reviewCompleted: true,
      reviewStatus: 'approved',
      reviewEvidenceTrusted: false,
    });
    const snap = makeSnapshot(
      { runStatus: 'completed' },
      [{ status: 'completed', tasks: [makeTaskFacts({ status: 'pending', attempts: [approvedWithoutEvidence] })] }],
    );

    const kinds = classifyFacts(snap, true).map((finding) => finding.kind);
    expect(kinds).toContain('completed_stage_with_incomplete_tasks');
    expect(kinds).toContain('approved_attempt_without_verifiable_change');
    expect(kinds).toContain('expected_write_missing');
    expect(kinds).toContain('fake_review_in_real_path');
  });

  describe('Running attempt', () => {
    it('M5-01: running attempt + PID alive → info finding, no blocking', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'alive', worktreeExists: true, branchExists: true })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const blocking = findings.filter((f) => f.severity === 'blocking');
      expect(blocking).toHaveLength(0);
      const info = findings.filter((f) => f.kind === 'pid_alive');
      expect(info.length).toBeGreaterThanOrEqual(1);
      expect(info[0].proposal).toContain('intact');
    });

    it('M5-02: running attempt + PID gone → warning + can auto-interrupt', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'gone', locksHeld: 2, locksOrphaned: true })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const pidMissing = findings.filter((f) => f.kind === 'pid_missing');
      expect(pidMissing.length).toBeGreaterThanOrEqual(1);
      expect(pidMissing[0].severity).toBe('warning');

      const actions = deriveSafeActions(findings);
      const interruptAction = actions.find((a) => a.actionType === 'mark_attempt_interrupted');
      expect(interruptAction).toBeDefined();
      expect(interruptAction!.targetEntityId).toBe('att-001');
    });

    it('M5-03: running attempt + PID alive + worktree missing → blocking', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'alive', worktreeExists: false })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const wtMissing = findings.filter((f) => f.kind === 'worktree_missing');
      expect(wtMissing.length).toBeGreaterThanOrEqual(1);
      expect(wtMissing[0].severity).toBe('blocking');

      // No safe action for this
      const actions = deriveSafeActions(findings).filter((a) =>
        a.targetEntityId === 'att-001' && a.actionType !== 'release_lock');
      expect(actions).toHaveLength(0);
    });

    it('M5-04: running attempt + no PID recorded → warning', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({ status: 'running', pid: null, pidAlive: 'unknown' })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const noPid = findings.filter((f) => f.kind === 'no_pid_recorded');
      expect(noPid.length).toBeGreaterThanOrEqual(1);
      expect(noPid[0].severity).toBe('warning');

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'mark_attempt_interrupted')).toBe(true);
    });
  });

  describe('worker_completed attempt', () => {
    it('M5-05: worker completes with full evidence → info, ready for resume', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({
            status: 'worker_completed', pidAlive: 'gone',
            workerResultExists: true, worktreeExists: true,
            branchExists: true, locksOrphaned: false,
          })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const blocking = findings.filter((f) => f.severity === 'blocking');
      expect(blocking).toHaveLength(0);
    });

    it('M5-06: worker_completed + worktree missing → blocking + stage paused', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({
            status: 'worker_completed', pidAlive: 'gone',
            workerResultExists: true, worktreeExists: false,
          })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const blocking = findings.filter((f) => f.severity === 'blocking');
      expect(blocking.length).toBeGreaterThanOrEqual(1);

      // Should produce stage paused action
      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'mark_stage_paused')).toBe(true);
    });

    it('M5-07: worker_completed + workerResult missing → blocking + interrupted', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({
            status: 'worker_completed', pidAlive: 'gone',
            workerResultExists: false,
          })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const wrMissing = findings.filter((f) => f.kind === 'worker_result_missing');
      expect(wrMissing.length).toBeGreaterThanOrEqual(1);
      expect(wrMissing[0].severity).toBe('blocking');

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'mark_attempt_interrupted')).toBe(true);
    });

    it('M5-08: worker_completed + branch missing → blocking + stage paused', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({
            status: 'worker_completed', pidAlive: 'gone',
            workerResultExists: true, worktreeExists: true,
            branchExists: false,
          })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const branchMissing = findings.filter((f) => f.kind === 'branch_missing');
      expect(branchMissing.length).toBeGreaterThanOrEqual(1);
      expect(branchMissing[0].severity).toBe('blocking');
    });
  });

  describe('reviewing attempt', () => {
    it('M5-09: reviewing + review unfinished → warning, do not auto-fix', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({
            status: 'reviewing', pidAlive: 'gone',
            reviewCompleted: false, reviewStatus: 'running',
          })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const reviewUnfinished = findings.filter((f) => f.kind === 'review_unfinished');
      expect(reviewUnfinished.length).toBeGreaterThanOrEqual(1);
      expect(reviewUnfinished[0].severity).toBe('warning');

      // No safe action
      const actions = deriveSafeActions(findings);
      expect(actions.some((a) =>
        a.targetEntityId === 'att-001' && a.actionType !== 'release_lock'
      )).toBe(false);
    });

    it('M5-10: reviewing + no review record → blocking + attempt failed', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({
            status: 'reviewing', pidAlive: 'gone',
            reviewCompleted: false, reviewStatus: null,
          })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const reviewMissing = findings.filter((f) => f.kind === 'review_missing');
      expect(reviewMissing.length).toBeGreaterThanOrEqual(1);
      expect(reviewMissing[0].severity).toBe('blocking');
    });

    it('M5-11: reviewing + review completed → info, state mismatch can converge', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({
            status: 'reviewing', pidAlive: 'gone',
            reviewCompleted: true, reviewStatus: 'approved',
          })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const mismatch = findings.filter((f) => f.kind === 'review_state_mismatch');
      expect(mismatch.length).toBeGreaterThanOrEqual(1);
      expect(mismatch[0].severity).toBe('info');

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'update_attempt_status_by_review')).toBe(true);
    });
  });

  describe('integration batch', () => {
    it('M5-12: integration running + merge commit exists → info, converge batch', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ integration: {
          batchId: 'batch-001', status: 'integrating',
          integrationBranch: 'int-branch', integrationBranchExists: true,
          mergeCommitInGit: true, targetAlreadyMerged: false,
          targetBranch: 'main', targetMergeCommit: null,
        }, tasks: [] }],
      );
      const findings = classifyFacts(snap, true);
      const stalled = findings.filter((f) => f.kind === 'integration_stalled');
      expect(stalled.length).toBeGreaterThanOrEqual(1);
      expect(stalled[0].severity).toBe('info');

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'update_integration_batch_completed')).toBe(true);
    });

    it('M5-13: integration batch + target already merged → blocking, idempotent converge', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ integration: {
          batchId: 'batch-001', status: 'integrating',
          integrationBranch: 'int-branch', integrationBranchExists: true,
          mergeCommitInGit: false, targetAlreadyMerged: true,
          targetBranch: 'main', targetMergeCommit: null,
        }, tasks: [] }],
      );
      const findings = classifyFacts(snap, true);
      const already = findings.filter((f) => f.kind === 'target_merged_already');
      expect(already.length).toBeGreaterThanOrEqual(1);
      expect(already[0].severity).toBe('blocking');

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'update_integration_batch_completed')).toBe(true);
    });
  });

  describe('active locks', () => {
    it('M5-14: orphan lock (owner terminal) → warning + release', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ activeLocks: [{
          lockId: 'lock-001', filePathHash: 'sha256:fp',
          taskId: 'task-001', lockType: 'exclusive', lockStatus: 'locked',
          ownerAttemptId: 'att-001', ownerAttemptStatus: 'approved',
          ownerPidAlive: 'gone', ownerRunStatus: 'running',
        }], tasks: [] }],
      );
      const findings = classifyFacts(snap, true);
      const orphaned = findings.filter((f) => f.kind === 'lock_orphaned');
      expect(orphaned.length).toBeGreaterThanOrEqual(1);
      expect(orphaned[0].severity).toBe('warning');

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'release_lock')).toBe(true);
    });

    it('M5-15: lock owner unknown → blocking, do not release', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ activeLocks: [{
          lockId: 'lock-002', filePathHash: 'sha256:fp2',
          taskId: 'task-unknown', lockType: 'exclusive', lockStatus: 'locked',
          ownerAttemptId: null, ownerAttemptStatus: null,
          ownerPidAlive: 'n/a', ownerRunStatus: 'running',
        }], tasks: [] }],
      );
      const findings = classifyFacts(snap, true);
      const unknown = findings.filter((f) => f.kind === 'lock_owner_unknown');
      expect(unknown.length).toBeGreaterThanOrEqual(1);
      expect(unknown[0].severity).toBe('blocking');

      // No safe action
      const actions = deriveSafeActions(findings);
      expect(actions.filter((a) => a.actionType === 'release_lock')).toHaveLength(0);
    });

    it('M5-16: lock owner PID gone → warning + release', () => {
      const snap = makeSnapshot(
        { runStatus: 'running' },
        [{ activeLocks: [{
          lockId: 'lock-003', filePathHash: 'sha256:fp3',
          taskId: 'task-001', lockType: 'exclusive', lockStatus: 'locked',
          ownerAttemptId: 'att-001', ownerAttemptStatus: 'running',
          ownerPidAlive: 'gone', ownerRunStatus: 'running',
        }], tasks: [] }],
      );
      const findings = classifyFacts(snap, true);
      const pidGone = findings.filter((f) => f.kind === 'lock_owner_pid_gone');
      expect(pidGone.length).toBeGreaterThanOrEqual(1);

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'release_lock')).toBe(true);
    });
  });

  describe('canceled run', () => {
    it('M5-17: canceled run + non-terminal attempt → warning + auto-cancel', () => {
      const snap = makeSnapshot(
        { runStatus: 'canceled' },
        [{ status: 'running', tasks: [makeTaskFacts({
          status: 'running',
          attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'gone' })],
        })] }],
      );
      const findings = classifyFacts(snap, true);
      const cr = findings.filter((f) => f.kind === 'canceled_run_recovery');
      expect(cr.length).toBeGreaterThanOrEqual(1);

      const actions = deriveSafeActions(findings);
      expect(actions.some((a) => a.actionType === 'mark_attempt_canceled')).toBe(true);
      expect(actions.some((a) => a.actionType === 'mark_stage_canceled')).toBe(true);
    });
  });

  describe('Git anomalies', () => {
    it('M5-18: Git HEAD unresolvable → blocking', () => {
      const snap = makeSnapshot(
        { gitHeadResolvable: false, gitHead: null },
        [],
      );
      const findings = classifyFacts(snap, true);
      const headUnknown = findings.filter((f) => f.kind === 'git_head_unknown');
      expect(headUnknown.length).toBeGreaterThanOrEqual(1);
      expect(headUnknown[0].severity).toBe('blocking');

      // No safe action
      const actions = deriveSafeActions(findings);
      expect(actions).toHaveLength(0);
    });

    it('M5-19: merge conflict → blocking, no auto-fix', () => {
      const snap = makeSnapshot(
        { mergeConflict: true, conflictFiles: ['file1.ts', 'file2.ts'] },
        [],
      );
      const findings = classifyFacts(snap, true);
      const conflict = findings.filter((f) => f.kind === 'conflict_state');
      expect(conflict.length).toBeGreaterThanOrEqual(1);
      expect(conflict[0].severity).toBe('blocking');

      // No safe action
      const actions = deriveSafeActions(findings);
      expect(actions).toHaveLength(0);
    });
  });

  describe('governance disabled', () => {
    it('M5-20: governance=false still detects PID/lock issues', () => {
      const snap = makeSnapshot(
        { runStatus: 'running', governanceEnabled: false },
        [{ tasks: [makeTaskFacts({
          attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'gone', locksHeld: 1, locksOrphaned: true })],
        })] }],
      );
      const findings = classifyFacts(snap, false);
      const pidMissing = findings.filter((f) => f.kind === 'pid_missing');
      expect(pidMissing.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ══════════════════════════════════════════════════════════════
// Convergence Engine Tests
// ══════════════════════════════════════════════════════════════

describe('M5 Convergence Engine', () => {
  it('produces findings sorted by severity (blocking first)', () => {
    const snap = makeSnapshot(
      { mergeConflict: true, conflictFiles: ['a.ts'] },
      [{ tasks: [makeTaskFacts({
        attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'alive', worktreeExists: true, branchExists: true })],
      })] }],
    );
    const result = converge(snap, true, 'dry_run', 'user_direct');

    // First finding should be blocking (conflict), then info (pid_alive)
    if (result.findings.length >= 2) {
      expect(result.findings[0].severity).toBe('blocking');
    }
    expect(result.report.phase).toBe('dry_run');
    expect(result.report.summary.blockingCount).toBeGreaterThanOrEqual(1);
    expect(result.report.summary.canResume).toBe(false);
  });

  it('report has correct structure for dry_run phase', () => {
    const snap = makeSnapshot();
    const result = converge(snap, true, 'dry_run', 'user_direct');
    const r = result.report;

    expect(r.phase).toBe('dry_run');
    expect(r.reportId).toContain('m5-report-run-001');
    expect(r.entities.run).toBeDefined();
    expect(r.entities.run.runId).toBe('run-001');
    expect(r.entities.stages).toHaveLength(1);
    expect(r.summary.totalFindings).toBeGreaterThanOrEqual(0);
    expect(r.summary.canResume).toBeDefined();
    expect(r.summary.canApprove).toBeDefined();
  });

  it('preflight initiatedBy is set correctly', () => {
    const snap = makeSnapshot();
    const result = converge(snap, true, 'dry_run', 'approve_preflight');
    expect(result.report.initiatedBy).toBe('approve_preflight');
  });

  it('applied phase sets correct summary', () => {
    const snap = makeSnapshot();
    const result = converge(snap, true, 'applied', 'user_direct');
    expect(result.report.phase).toBe('applied');
  });
});

// ══════════════════════════════════════════════════════════════
// Safe Action Derivation Tests
// ══════════════════════════════════════════════════════════════

describe('M5 Safe Action Derivation', () => {
  it('pid_alive finding produces no safe action', () => {
    const snap = makeSnapshot(
      {},
      [{ tasks: [makeTaskFacts({
        attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'alive' })],
      })] }],
    );
    const findings = classifyFacts(snap, true);
    const actions = deriveSafeActions(findings);
    // pid_alive should produce no action
    const aliveActions = actions.filter((a) =>
      a.targetEntityId === 'att-001' && a.findingId);
    expect(aliveActions).toHaveLength(0);
  });

  it('pid_missing produces mark_attempt_interrupted', () => {
    const snap = makeSnapshot(
      {},
      [{ tasks: [makeTaskFacts({
        attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'gone' })],
      })] }],
    );
    const findings = classifyFacts(snap, true);
    const actions = deriveSafeActions(findings);
    const interrupt = actions.filter((a) => a.actionType === 'mark_attempt_interrupted');
    expect(interrupt.length).toBeGreaterThanOrEqual(1);
    expect(interrupt[0].metadata.reason).toBe('pid_missing');
  });

  it('worker_result_missing produces mark_attempt_interrupted', () => {
    const snap = makeSnapshot(
      {},
      [{ tasks: [makeTaskFacts({
        attempts: [makeAttemptFacts({ status: 'worker_completed', workerResultExists: false })],
      })] }],
    );
    const findings = classifyFacts(snap, true);
    const actions = deriveSafeActions(findings);
    expect(actions.some((a) =>
      a.actionType === 'mark_attempt_interrupted' && a.metadata.reason === 'worker_result_missing'
    )).toBe(true);
  });

  it('worktree_missing on running + pid alive → no action', () => {
    const snap = makeSnapshot(
      {},
      [{ tasks: [makeTaskFacts({
        attempts: [makeAttemptFacts({ status: 'running', pidAlive: 'alive', worktreeExists: false })],
      })] }],
    );
    const findings = classifyFacts(snap, true);
    const actions = deriveSafeActions(findings);
    // Blocking finding but no safe action
    expect(actions.filter((a) =>
      a.targetEntityId === 'att-001' && a.actionType !== 'release_lock'
    )).toHaveLength(0);
  });
});
