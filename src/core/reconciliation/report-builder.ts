// ── M5 Report Builder ────────────────────────────────────────────────────
// Builds a ReconciliationReport from findings and fact snapshots.
// Strictly conforms to contract §7 JSON schema.
// Pure function — no side effects.

import { randomUUID } from 'node:crypto';

import type {
  ReconciliationReport,
  ReconciliationSummary,
  Finding,
  ReconciliationFactSnapshot,
  ReconciliationInitiatedBy,
  ReconciliationPhase,
  RunReconciliation,
  StageReconciliation,
  TaskReconciliation,
  AttemptReconciliation,
  IntegrationReconciliation,
  LockReconciliation,
} from '../../types/m5-types.js';

/**
 * Build a ReconciliationReport from a classified fact snapshot.
 */
export function buildReconciliationReport(
  facts: ReconciliationFactSnapshot,
  findings: Finding[],
  phase: ReconciliationPhase,
  initiatedBy: ReconciliationInitiatedBy,
): ReconciliationReport {
  const now = new Date().toISOString();

  const blockingCount = findings.filter((f) => f.severity === 'blocking').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;
  const appliedCount = findings.filter((f) => f.status === 'applied').length;
  const skippedCount = findings.filter((f) => f.status === 'skipped').length;

  const summary: ReconciliationSummary = {
    totalFindings: findings.length,
    blockingCount,
    warningCount,
    infoCount,
    appliedCount,
    skippedCount,
    canResume: blockingCount === 0,
    canApprove: blockingCount === 0,
  };

  const runEntities: RunReconciliation = {
    runId: facts.run.runId,
    status: facts.run.runStatus,
    projectRootHash: facts.run.projectRootHash,
    gitHead: facts.run.gitHead,
    gitHeadResolvable: facts.run.gitHeadResolvable,
    mergeConflict: facts.run.mergeConflict,
    conflictFiles: facts.run.conflictFiles,
  };

  const stageEntities: StageReconciliation[] = facts.stages.map((s) => ({
    stageId: s.stageId,
    stageNumber: s.stageNumber,
    status: s.status,
    baseCommit: s.baseCommit,
    tasks: s.tasks.map(buildTaskReconciliation),
    integration: s.integration ? buildIntegrationReconciliation(s.integration) : null,
    activeLocks: s.activeLocks.map(buildLockReconciliation),
  }));

  return {
    reportId: `m5-report-${facts.run.runId}-${Date.now()}-${randomUUID()}`,
    runId: facts.run.runId,
    phase,
    initiatedBy,
    startedAt: now,
    finishedAt: now,
    summary,
    entities: {
      run: runEntities,
      stages: stageEntities,
    },
    findings,
  };
}

function buildTaskReconciliation(t: {
  taskId: string;
  title: string;
  status: string;
  attempts: {
    attemptId: string;
    attemptNumber: number;
    status: string;
    pid: number | null;
    pidAlive: 'alive' | 'gone' | 'unknown';
    worktreeExists: boolean;
    worktreeRegistered: boolean;
    branchExists: boolean;
    workerResultExists: boolean;
    locksHeld: number;
    locksOrphaned: boolean;
    reviewCompleted: boolean;
  }[];
}): TaskReconciliation {
  return {
    taskId: t.taskId,
    title: t.title,
    status: t.status,
    attempts: t.attempts.map((a) => ({
      attemptId: a.attemptId,
      attemptNumber: a.attemptNumber,
      status: a.status,
      pid: a.pid,
      pidAlive: a.pidAlive,
      worktreeExists: a.worktreeExists,
      worktreeRegistered: a.worktreeRegistered,
      branchExists: a.branchExists,
      workerResultExists: a.workerResultExists,
      locksHeld: a.locksHeld,
      locksOrphaned: a.locksOrphaned,
      reviewCompleted: a.reviewCompleted,
    })),
  };
}

function buildIntegrationReconciliation(i: {
  batchId: string;
  status: string;
  integrationBranch: string;
  integrationBranchExists: boolean;
  mergeCommitInGit: boolean;
  targetAlreadyMerged: boolean;
  targetBranch: string | null;
}): IntegrationReconciliation {
  return {
    batchId: i.batchId,
    status: i.status,
    integrationBranch: i.integrationBranch,
    integrationBranchExists: i.integrationBranchExists,
    mergeCommitInGit: i.mergeCommitInGit,
    targetAlreadyMerged: i.targetAlreadyMerged,
    targetBranch: i.targetBranch,
  };
}

function buildLockReconciliation(l: {
  lockId: string;
  filePathHash: string;
  taskId: string;
  lockType: string;
  ownerAttemptStatus: string | null;
  ownerPidAlive: 'alive' | 'gone' | 'unknown' | 'n/a';
}): LockReconciliation {
  return {
    lockId: l.lockId,
    filePathHash: l.filePathHash,
    taskId: l.taskId,
    lockType: l.lockType,
    ownerAttemptStatus: l.ownerAttemptStatus,
    ownerPidAlive: l.ownerPidAlive,
  };
}

/**
 * Build a summary JSON string (for SQLite storage).
 * Contains only top-level metadata — no paths, no secrets.
 */
export function buildSummaryJson(summary: ReconciliationSummary): string {
  return JSON.stringify({
    totalFindings: summary.totalFindings,
    blockingCount: summary.blockingCount,
    warningCount: summary.warningCount,
    infoCount: summary.infoCount,
    appliedCount: summary.appliedCount,
    skippedCount: summary.skippedCount,
    canResume: summary.canResume,
    canApprove: summary.canApprove,
  });
}
