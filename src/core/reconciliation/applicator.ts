// ── M5 Applicator: Safe Apply Engine ─────────────────────────────────────
// Only component that applies state changes during reconcile --apply.
// Accepts only SafeActions derived by the classifier.
// Delegates to StateStore.applyReconciliationAtomically for single-transaction atomicity.
// Never creates worktrees, resets Git, auto-merges/rebase, kills Pi,
// or fakes WorkerResult.

import type {
  SafeAction,
  Finding,
  ReconciliationReport,
  ReconciliationPhase,
} from '../../types/m5-types.js';
import { buildSummaryJson } from './report-builder.js';
import type { StateStore, AtomicApplyInput, AtomicApplyResult } from '../../state/state-store.js';
import type { CreateEventInput } from '../../types/m2-types.js';

export interface ApplyResult {
  report: ReconciliationReport;
  atomicResult: AtomicApplyResult;
}

/**
 * Apply safe actions within a single SQLite transaction via atomic method.
 * Idempotent: re-running with the same findings produces zero additional state changes.
 */
export async function applySafeActions(
  store: StateStore,
  report: ReconciliationReport,
  findings: Finding[],
  safeActions: SafeAction[],
): Promise<ApplyResult> {
  const now = new Date().toISOString();

  // ── Map safe actions to atomic actions ──
  const atomicActions: AtomicApplyInput['actions'] = safeActions.map((a) => ({
    actionType: a.actionType,
    targetEntityId: a.targetEntityId,
    metadata: a.metadata,
  }));

  // ── Prepare findings for persistence ──
  // (Action results are determined inside the transaction;
  //  we pre-apply pessimistic finding statuses and let the atomic
  //  method persist them.)
  const findingInputs = findings.map((f) => {
    const hasAction = safeActions.some((a) => a.findingId === f.id);
    return {
      id: f.id,
      reportId: report.reportId,
      runId: f.runId,
      entityType: f.entityType,
      entityId: f.entityId,
      kind: f.kind,
      severity: f.severity,
      status: hasAction ? ('applied' as const) : ('skipped' as const),
      proposal: f.proposal,
      appliedAction: hasAction
        ? safeActions.find((a) => a.findingId === f.id)!.actionType
        : null,
      evidenceHash: f.evidenceHash,
      appliedAt: hasAction ? now : null,
    };
  });

  // ── Prepare events ──
  const eventInputs: CreateEventInput[] = safeActions.map((a) => ({
    id: `${report.runId}-ev-reconciled-${a.actionType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    runId: report.runId,
    stageId: null,
    taskId: null,
    attemptId: a.targetEntityType === 'attempt' ? a.targetEntityId : null,
    eventType: `reconciled_${a.actionType}`,
    eventData: {
      actionType: a.actionType,
      targetEntityId: a.targetEntityId,
      appliedAt: now,
    },
  }));

  // Update summary counts before sending for persistence
  const blockingCount = findings.filter((f) => f.severity === 'blocking').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;
  const appliedCountEstimate = safeActions.length;
  const skippedCount = findings.length - appliedCountEstimate;

  // ── Single atomic call ──
  const atomicResult = await store.applyReconciliationAtomically({
    reportId: report.reportId,
    runId: report.runId,
    reportInput: {
      id: report.reportId,
      runId: report.runId,
      totalFindings: findings.length,
      blockingCount,
      appliedCount: appliedCountEstimate,
      skippedCount,
      summaryJson: buildSummaryJson({
        totalFindings: findings.length,
        blockingCount,
        warningCount,
        infoCount,
        appliedCount: appliedCountEstimate,
        skippedCount,
        canResume: blockingCount === 0,
        canApprove: blockingCount === 0,
      }),
      startedAt: report.startedAt,
      finishedAt: now,
    },
    findingInputs,
    eventInputs,
    actions: atomicActions,
  });

  // ── Build final report from atomic result ──
  const updatedFindings = findings.map((f) => {
    const actionResult = atomicResult.appliedActions.find((a) =>
      a.targetEntityId === f.entityId && a.success);
    if (actionResult) {
      return {
        ...f,
        status: 'applied' as const,
        appliedAction: actionResult.actionType,
      };
    }
    return { ...f, status: 'skipped' as const };
  });

  const finalReport: ReconciliationReport = {
    ...report,
    phase: 'applied' as ReconciliationPhase,
    finishedAt: now,
    summary: {
      totalFindings: findings.length,
      blockingCount,
      warningCount,
      infoCount,
      appliedCount: atomicResult.appliedCount,
      skippedCount: atomicResult.skippedCount,
      canResume: blockingCount === 0,
      canApprove: blockingCount === 0,
    },
    findings: updatedFindings,
  };

  return { report: finalReport, atomicResult };
}
