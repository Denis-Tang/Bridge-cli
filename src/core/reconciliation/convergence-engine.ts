// ── M5 Convergence Engine ────────────────────────────────────────────────
// Orchestrates reconciliation: gathers facts, classifies, ranks by severity,
// derives safe actions, and produces a complete report.

import { classifyFacts, deriveSafeActions } from './classifier.js';
import { randomUUID } from 'node:crypto';
import type {
  ReconciliationFactSnapshot,
  ReconciliationReport,
  ReconciliationSummary,
  Finding,
  SafeAction,
  ReconciliationInitiatedBy,
  ReconciliationPhase,
} from '../../types/m5-types.js';

export interface ConvergenceResult {
  findings: Finding[];
  safeActions: SafeAction[];
  report: ReconciliationReport;
}

/**
 * Run the full convergence pipeline on a fact snapshot.
 * This is a pure function: facts → findings → safe actions → report.
 * Zero side effects.
 */
export function converge(
  facts: ReconciliationFactSnapshot,
  governanceEnabled: boolean,
  phase: ReconciliationPhase,
  initiatedBy: ReconciliationInitiatedBy,
): ConvergenceResult {
  // 1. Classify facts into findings
  const findings = classifyFacts(facts, governanceEnabled);

  // 2. Sort findings by severity (blocking first, then warning, then info)
  const sorted = sortBySeverity(findings);

  // 3. Derive safe actions from findings
  const safeActions = deriveSafeActions(sorted);

  // 4. Build report
  const report = buildReport(facts, sorted, governanceEnabled, phase, initiatedBy);

  return { findings: sorted, safeActions, report };
}

/**
 * Sort findings: blocking → warning → info, then stable by entity.
 */
function sortBySeverity(findings: Finding[]): Finding[] {
  const severityOrder: Record<string, number> = {
    blocking: 0,
    warning: 1,
    info: 2,
  };

  return [...findings].sort((a, b) => {
    const sevDiff = (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99);
    if (sevDiff !== 0) return sevDiff;
    return a.entityId.localeCompare(b.entityId);
  });
}

/**
 * Build a full ReconciliationReport from facts and findings.
 */
function buildReport(
  facts: ReconciliationFactSnapshot,
  findings: Finding[],
  governanceEnabled: boolean,
  phase: ReconciliationPhase,
  initiatedBy: ReconciliationInitiatedBy,
): ReconciliationReport {
  const now = new Date().toISOString();
  const blockingCount = findings.filter((f) => f.severity === 'blocking').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  const summary: ReconciliationSummary = {
    totalFindings: findings.length,
    blockingCount,
    warningCount,
    infoCount,
    appliedCount: phase === 'applied' ? findings.filter((f) => f.status === 'applied').length : 0,
    skippedCount: findings.filter((f) => f.status === 'skipped').length,
    canResume: blockingCount === 0,
    canApprove: blockingCount === 0,
  };

  return {
    reportId: `m5-report-${facts.run.runId}-${Date.now()}-${randomUUID()}`,
    runId: facts.run.runId,
    phase,
    initiatedBy,
    startedAt: now,
    finishedAt: now,
    summary,
    entities: {
      run: {
        runId: facts.run.runId,
        status: facts.run.runStatus,
        projectRootHash: facts.run.projectRootHash,
        gitHead: facts.run.gitHead,
        gitHeadResolvable: facts.run.gitHeadResolvable,
        mergeConflict: facts.run.mergeConflict,
        conflictFiles: facts.run.conflictFiles,
      },
      stages: facts.stages.map((s) => ({
        stageId: s.stageId,
        stageNumber: s.stageNumber,
        status: s.status,
        baseCommit: s.baseCommit,
        tasks: s.tasks.map((t) => ({
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
        })),
        integration: s.integration ? {
          batchId: s.integration.batchId,
          status: s.integration.status,
          integrationBranch: s.integration.integrationBranch,
          integrationBranchExists: s.integration.integrationBranchExists,
          mergeCommitInGit: s.integration.mergeCommitInGit,
          targetAlreadyMerged: s.integration.targetAlreadyMerged,
          targetBranch: s.integration.targetBranch,
        } : null,
        activeLocks: s.activeLocks.map((l) => ({
          lockId: l.lockId,
          filePathHash: l.filePathHash,
          taskId: l.taskId,
          lockType: l.lockType,
          ownerAttemptStatus: l.ownerAttemptStatus,
          ownerPidAlive: l.ownerPidAlive,
        })),
      })),
    },
    findings,
  };
}
