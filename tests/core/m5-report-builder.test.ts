// ── M5 Report Builder Tests ─────────────────────────────────────────────
// Validates JSON schema conformance for reconciliation reports.
// Pure memory tests — no filesystem, Git, or SQLite.

import { describe, it, expect } from 'vitest';
import { buildReconciliationReport, buildSummaryJson } from '../../src/core/reconciliation/report-builder.js';
import { converge } from '../../src/core/reconciliation/convergence-engine.js';
import type { ReconciliationFactSnapshot } from '../../src/types/m5-types.js';

// ══════════════════════════════════════════════════════════════
// Helpers — minimal fake snapshot
// ══════════════════════════════════════════════════════════════

function makeMinimalSnapshot(): ReconciliationFactSnapshot {
  return {
    run: {
      runId: 'run-001',
      runStatus: 'running',
      projectRootHash: 'sha256:abc123',
      governanceEnabled: true,
      gitHead: 'abc123def',
      gitHeadResolvable: true,
      mergeConflict: false,
      conflictFiles: [],
    },
    stages: [
      {
        stageId: 'stage-001',
        stageNumber: 1,
        status: 'running',
        baseCommit: 'abc123',
        tasks: [
          {
            taskId: 'task-001',
            title: 'Test Task',
            status: 'running',
            attempts: [
              {
                attemptId: 'att-001',
                attemptNumber: 1,
                status: 'running',
                taskId: 'task-001',
                stageId: 'stage-001',
                pid: 12345,
                pidAlive: 'alive',
                worktreePath: '/tmp/wt',
                worktreeExists: true,
                worktreeRegistered: true,
                worktreeDirty: false,
                branchName: 'task-branch',
                branchExists: true,
                branchHeadMatches: true,
                workerResultExists: false,
                workerResultJson: null,
                locksHeld: 0,
                locksOrphaned: false,
                reviewCompleted: false,
                reviewStatus: null,
              },
            ],
          },
        ],
        integration: null,
        activeLocks: [],
      },
    ],
  };
}

describe('M5 Report Builder', () => {
  it('builds a valid ReconciliationReport with correct top-level fields', () => {
    const snap = makeMinimalSnapshot();
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');

    expect(report.reportId).toContain('m5-report-run-001');
    expect(report.runId).toBe('run-001');
    expect(report.phase).toBe('dry_run');
    expect(report.initiatedBy).toBe('user_direct');
    expect(report.startedAt).toBeDefined();
    expect(report.finishedAt).toBeDefined();
    expect(report.summary).toBeDefined();
    expect(report.entities).toBeDefined();
    expect(report.findings).toBeDefined();
  });

  it('produces correct summary counts', () => {
    const snap = makeMinimalSnapshot();
    // Use the convergence engine to get real findings
    const { findings } = converge(snap, true, 'dry_run', 'user_direct');
    const report = buildReconciliationReport(snap, findings, 'dry_run', 'user_direct');

    const s = report.summary;
    expect(s.totalFindings).toBe(findings.length);
    expect(s.blockingCount + s.warningCount + s.infoCount).toBe(s.totalFindings);
    expect(s.canResume).toBe(s.blockingCount === 0);
    expect(s.canApprove).toBe(s.blockingCount === 0);
    expect(s.appliedCount).toBe(0); // dry_run
    expect(s.skippedCount).toBe(0); // nothing applied/skipped in dry run
  });

  it('entities.run has correct structure', () => {
    const snap = makeMinimalSnapshot();
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');

    const run = report.entities.run;
    expect(run.runId).toBe('run-001');
    expect(run.status).toBe('running');
    expect(run.projectRootHash).toBe('sha256:abc123');
    expect(run.gitHead).toBe('abc123def');
    expect(run.gitHeadResolvable).toBe(true);
    expect(run.mergeConflict).toBe(false);
    expect(run.conflictFiles).toEqual([]);
  });

  it('entities.stages has correct structure', () => {
    const snap = makeMinimalSnapshot();
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');

    expect(report.entities.stages).toHaveLength(1);
    const stage = report.entities.stages[0];
    expect(stage.stageId).toBe('stage-001');
    expect(stage.stageNumber).toBe(1);
    expect(stage.status).toBe('running');
    expect(stage.baseCommit).toBe('abc123');
    expect(stage.tasks).toHaveLength(1);
  });

  it('task reconciliation has correct fields', () => {
    const snap = makeMinimalSnapshot();
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');

    const task = report.entities.stages[0].tasks[0];
    expect(task.taskId).toBe('task-001');
    expect(task.title).toBe('Test Task');
    expect(task.status).toBe('running');
    expect(task.attempts).toHaveLength(1);
  });

  it('attempt reconciliation has correct fields', () => {
    const snap = makeMinimalSnapshot();
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');

    const attempt = report.entities.stages[0].tasks[0].attempts[0];
    expect(attempt.attemptId).toBe('att-001');
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.status).toBe('running');
    expect(attempt.pid).toBe(12345);
    expect(attempt.pidAlive).toBe('alive');
    expect(attempt.worktreeExists).toBe(true);
    expect(attempt.worktreeRegistered).toBe(true);
    expect(attempt.branchExists).toBe(true);
    expect(attempt.workerResultExists).toBe(false);
    expect(attempt.locksHeld).toBe(0);
    expect(attempt.locksOrphaned).toBe(false);
    expect(attempt.reviewCompleted).toBe(false);
  });

  it('integration reconciliation is null when no integration', () => {
    const snap = makeMinimalSnapshot();
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');
    expect(report.entities.stages[0].integration).toBeNull();
  });

  it('integration reconciliation has correct fields when present', () => {
    const snap = makeMinimalSnapshot();
    snap.stages[0].integration = {
      batchId: 'batch-001',
      status: 'integrating',
      integrationBranch: 'int-branch',
      integrationBranchExists: true,
      mergeCommitInGit: false,
      targetAlreadyMerged: false,
      targetBranch: 'main',
      targetMergeCommit: null,
    };
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');

    const integration = report.entities.stages[0].integration!;
    expect(integration.batchId).toBe('batch-001');
    expect(integration.status).toBe('integrating');
    expect(integration.integrationBranch).toBe('int-branch');
    expect(integration.integrationBranchExists).toBe(true);
    expect(integration.mergeCommitInGit).toBe(false);
    expect(integration.targetAlreadyMerged).toBe(false);
    expect(integration.targetBranch).toBe('main');
  });

  it('lock reconciliation has correct fields', () => {
    const snap = makeMinimalSnapshot();
    snap.stages[0].activeLocks = [
      {
        lockId: 'lock-001',
        filePathHash: 'sha256:fp',
        taskId: 'task-001',
        lockType: 'exclusive',
        lockStatus: 'locked',
        ownerAttemptId: 'att-001',
        ownerAttemptStatus: 'running',
        ownerPidAlive: 'alive',
        ownerRunStatus: 'running',
      },
    ];
    const report = buildReconciliationReport(snap, [], 'dry_run', 'user_direct');

    const locks = report.entities.stages[0].activeLocks;
    expect(locks).toHaveLength(1);
    expect(locks[0].lockId).toBe('lock-001');
    expect(locks[0].filePathHash).toBe('sha256:fp');
    expect(locks[0].taskId).toBe('task-001');
    expect(locks[0].lockType).toBe('exclusive');
    expect(locks[0].ownerAttemptStatus).toBe('running');
    expect(locks[0].ownerPidAlive).toBe('alive');
  });

  it('buildSummaryJson contains no paths or secrets', () => {
    const summary = {
      totalFindings: 5,
      blockingCount: 2,
      warningCount: 2,
      infoCount: 1,
      appliedCount: 0,
      skippedCount: 0,
      canResume: false,
      canApprove: false,
    };
    const json = buildSummaryJson(summary);
    const parsed = JSON.parse(json);

    // Check no paths or secrets leaked
    const str = JSON.stringify(parsed);
    expect(str).not.toContain('/tmp');
    expect(str).not.toContain('secret');
    expect(str).not.toContain('password');
    expect(str).not.toContain('token');
    expect(str).not.toContain('.env');

    expect(parsed.totalFindings).toBe(5);
    expect(parsed.blockingCount).toBe(2);
    expect(parsed.canResume).toBe(false);
  });

  it('applied phase report has correct summary', () => {
    const snap = makeMinimalSnapshot();
    const { findings } = converge(snap, true, 'applied', 'user_direct');

    // Simulate some findings being applied
    const modifiedFindings = findings.map((f, i) =>
      i < 1 ? { ...f, status: 'applied' as const, appliedAction: 'test' }
      : { ...f, status: 'skipped' as const });

    const report = buildReconciliationReport(snap, modifiedFindings, 'applied', 'user_direct');
    expect(report.phase).toBe('applied');
    expect(report.summary.appliedCount).toBeGreaterThanOrEqual(1);
    expect(report.summary.skippedCount).toBeGreaterThanOrEqual(0);
  });
});
