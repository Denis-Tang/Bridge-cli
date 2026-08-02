// ── M5 Classifier: Pure-function decision table translator ──────────────
// Input: ReconciliationFactSnapshot + governanceEnabled flag
// Output: Finding[]
// Pure function — no SQLite, Git, filesystem, or process access.

import { createHash } from 'node:crypto';
import type {
  ReconciliationFactSnapshot,
  RunFacts,
  StageFacts,
  TaskFacts,
  AttemptFacts,
  LockFacts,
  IntegrationFacts,
  GovernanceFacts,
  Finding,
  FindingSeverity,
  FindingKind,
  FindingEntityType,
  SafeAction,
} from '../../types/m5-types.js';

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

let nextFindingId = 0;
function resetFindingCounter(): void { nextFindingId = 0; }
function nextId(): string { return `f-${++nextFindingId}-${Date.now()}`; }

function makeEvidenceHash(...parts: string[]): string {
  const input = parts.join('|');
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function makeFinding(
  runId: string,
  entityType: FindingEntityType,
  entityId: string,
  kind: FindingKind,
  severity: FindingSeverity,
  proposal: string,
  evidenceParts: string[],
): Finding {
  return {
    id: nextId(),
    entityType,
    entityId,
    runId,
    kind,
    severity,
    status: 'open',
    proposal,
    appliedAction: null,
    evidenceHash: makeEvidenceHash(...evidenceParts),
  };
}

/** Terminal attempt statuses */
const TERMINAL_ATTEMPT_STATUSES = new Set([
  'approved', 'failed', 'interrupted', 'canceled',
]);

/** Worker PID exit is expected while post-worker gates/review retain the lock. */
const POST_WORKER_LOCK_STATUSES = new Set([
  'worker_completed', 'validating', 'reviewing',
]);

/** Terminal stage statuses */
const TERMINAL_STAGE_STATUSES = new Set([
  'completed', 'canceled',
]);

/** Terminal run statuses */
const TERMINAL_RUN_STATUSES = new Set([
  'completed', 'failed', 'canceled',
]);

// ══════════════════════════════════════════════════════════════
// §5.2 Decision Table: classify every fact pattern
// ══════════════════════════════════════════════════════════════

export function classifyFacts(
  snapshot: ReconciliationFactSnapshot,
  governanceEnabled: boolean,
): Finding[] {
  resetFindingCounter();
  const findings: Finding[] = [];

  const { run, stages } = snapshot;

  // ── H. Git status anomalies ──
  classifyGitHead(run, findings);

  // ── Run-level ──
  // F. canceled run recovery
  if (run.runStatus === 'canceled') {
    for (const stage of stages) {
      if (!TERMINAL_STAGE_STATUSES.has(stage.status)) {
        findings.push(makeFinding(
          run.runId, 'stage', stage.stageId,
          'canceled_run_recovery', 'warning',
          `Canceled run has non-terminal stage ${stage.stageNumber} (${stage.status}). Safe-apply will mark it canceled.`,
          ['canceled_run', stage.stageId, stage.status],
        ));
      }
      for (const task of stage.tasks) {
        for (const attempt of task.attempts) {
          if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status) && attempt.status !== 'canceled') {
            findings.push(makeFinding(
              run.runId, 'attempt', attempt.attemptId,
              'canceled_run_recovery', 'warning',
              `Canceled run has non-terminal attempt ${attempt.attemptNumber} (${attempt.status}). Safe-apply will mark it canceled.`,
              ['canceled_run', 'attempt', attempt.attemptId, attempt.status],
            ));
          }
        }
      }
    }
  }

  // ── Per-stage classification ──
  const runIsCanceled = run.runStatus === 'canceled';
  for (const stage of stages) {
    if (!runIsCanceled && stage.status === 'completed') {
      const incompleteTasks = stage.tasks.filter((task) => task.status !== 'merged' && task.status !== 'canceled');
      if (incompleteTasks.length > 0) {
        findings.push(makeFinding(
          run.runId, 'stage', stage.stageId,
          'completed_stage_with_incomplete_tasks', 'blocking',
          `Stage ${stage.stageNumber} is completed but ${incompleteTasks.length} task(s) are not merged or canceled. Completion is not trustworthy and must not be propagated to the run.`,
          ['completed_stage_with_incomplete_tasks', stage.stageId, ...incompleteTasks.map((task) => task.taskId + ':' + task.status)],
        ));
        if (run.runStatus === 'completed') {
          findings.push(makeFinding(
            run.runId, 'run', run.runId,
            'completed_stage_with_incomplete_tasks', 'blocking',
            `Run is completed while stage ${stage.stageNumber} still has incomplete tasks. The run completed state is false-positive.`,
            ['completed_run_with_incomplete_stage', run.runId, stage.stageId],
          ));
        }
      }
    }

    // Stage-level deadlock detection
    if (!runIsCanceled && stage.tasks.length > 0 && !TERMINAL_STAGE_STATUSES.has(stage.status)) {
      const nonTerminalTasks = stage.tasks.filter((t) => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'canceled');
      if (nonTerminalTasks.length === 0 && stage.status !== 'completed') {
        findings.push(makeFinding(
          run.runId, 'stage', stage.stageId,
          'stage_deadlock', 'warning',
          `Stage ${stage.stageNumber} has no non-terminal tasks but status is ${stage.status}. May need status convergence.`,
          ['stage_deadlock', stage.stageId, stage.status],
        ));
      }
    }

    // Per-task classification (skip for canceled runs — handled by canceled_run_recovery above)
    if (!runIsCanceled) {
      for (const task of stage.tasks) {
        for (const attempt of task.attempts) {
          classifyAttempt(run, stage, task, attempt, findings);
        }
      }
    }

    // ── D. Integration batch classification ──
    if (!runIsCanceled && stage.integration) {
      classifyIntegration(run, stage.integration, findings, governanceEnabled);
    }

    // ── E. Active lock classification ──
    // For canceled runs, locks are handled via canceled_run_recovery
    if (!runIsCanceled) {
      for (const lock of stage.activeLocks) {
        classifyLock(run, lock, findings, governanceEnabled);
      }
    }

  }

  if (governanceEnabled && snapshot.governance) {
    classifyGovernance(run, snapshot.governance, findings);
  }

  return findings;
}

// ══════════════════════════════════════════════════════════════
// G. Governance approval and token-budget classification
// ══════════════════════════════════════════════════════════════

function classifyGovernance(
  run: RunFacts,
  governance: GovernanceFacts,
  findings: Finding[],
): void {
  const now = Date.now();
  for (const approval of governance.pendingApprovals) {
    const expiresAt = approval.expiresAt ? Date.parse(approval.expiresAt) : Number.NaN;
    if (!Number.isNaN(expiresAt) && expiresAt < now) {
      findings.push(makeFinding(
        run.runId, 'approval', approval.approvalId,
        'approval_expired', 'info',
        `Pending ${approval.gate} approval has expired. Safe-apply will mark it expired; reconciliation will not approve or recreate it.`,
        ['approval_expired', approval.approvalId, approval.gate, approval.expiresAt!],
      ));
    }
  }

  const budget = governance.budget;
  if (budget.paused && (!budget.policyExists || !budget.hasLedgerUsage)) {
    const reason = !budget.policyExists
      ? 'its referenced budget policy is unavailable'
      : 'the token ledger has no usage for the paused policy';
    findings.push(makeFinding(
      run.runId, 'budget', budget.policyType ?? 'unknown',
      'budget_paused_stale', 'warning',
      `Token budget is paused but ${reason}. Manual investigation is required; reconciliation will never resume a budget.`,
      ['budget_paused_stale', budget.policyType ?? 'unknown', String(budget.policyExists), String(budget.hasLedgerUsage)],
    ));
  }
}

// ══════════════════════════════════════════════════════════════
// A. Running attempt classification
// ══════════════════════════════════════════════════════════════

function classifyAttempt(
  run: RunFacts,
  stage: StageFacts,
  task: TaskFacts,
  attempt: AttemptFacts,
  findings: Finding[],
): void {
  const runId = run.runId;

  if (attempt.status === 'approved') {
    const changedFiles = attempt.changedFiles || [];
    const expectedWritePaths = attempt.expectedWritePaths || [];
    const hasVerifiableChange = attempt.workerResultExists
      && attempt.workerResultCompleted
      && attempt.branchName !== null
      && attempt.branchExists
      && changedFiles.length > 0;
    if (!hasVerifiableChange) {
      findings.push(makeFinding(
        runId, 'attempt', attempt.attemptId,
        'approved_attempt_without_verifiable_change', 'blocking',
        `Attempt ${attempt.attemptNumber} is approved without a verifiable WorkerResult-backed branch diff. Do not treat the task or stage as completed.`,
        ['approved_without_verifiable_change', attempt.attemptId, String(attempt.workerResultExists), String(attempt.workerResultCompleted), String(attempt.branchExists), String(changedFiles.length)],
      ));
    }
    if (expectedWritePaths.length > 0 && !attempt.expectedWriteEvidence) {
      findings.push(makeFinding(
        runId, 'attempt', attempt.attemptId,
        'expected_write_missing', 'blocking',
        `Attempt ${attempt.attemptNumber} is approved but its expected write paths have no matching Git diff evidence.`,
        ['expected_write_missing', attempt.attemptId, String(expectedWritePaths.length), String(changedFiles.length)],
      ));
    }
    if (!attempt.reviewCompleted || !attempt.reviewEvidenceTrusted) {
      findings.push(makeFinding(
        runId, 'attempt', attempt.attemptId,
        attempt.reviewCompleted ? 'fake_review_in_real_path' : 'review_evidence_missing', 'blocking',
        attempt.reviewCompleted
          ? `Attempt ${attempt.attemptNumber} is approved with review evidence marked fake or untrusted.`
          : `Attempt ${attempt.attemptNumber} is approved without completed review evidence.`,
        [attempt.reviewCompleted ? 'fake_review_in_real_path' : 'review_evidence_missing', attempt.attemptId, attempt.reviewStatus || 'none'],
      ));
    }
    return;
  }

  // Skip already-terminal attempts — no recovery needed
  if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
    return;
  }

  // Skip canceled attempts in canceled runs (handled above)
  if (attempt.status === 'canceled') return;

  switch (attempt.status) {
    case 'running':
      classifyRunningAttempt(runId, attempt, findings);
      break;
    case 'worker_completed':
      classifyWorkerCompletedAttempt(runId, stage, attempt, findings);
      break;
    case 'reviewing':
      classifyReviewingAttempt(runId, attempt, findings);
      break;
    case 'validating':
      // Validating is an intermediate state; worker_completed must precede it.
      // If stuck in validating, classify similarly but more conservatively.
      classifyValidatingAttempt(runId, stage, attempt, findings);
      break;
    default:
      // pending, rework_required — no crash recovery needed, just wait
      break;
  }
}

// ── A. Running attempt ──

function classifyRunningAttempt(
  runId: string,
  attempt: AttemptFacts,
  findings: Finding[],
): void {
  // A1: PID alive, worktree exists, branch exists → info
  if (attempt.pidAlive === 'alive' && attempt.worktreeExists && attempt.branchExists) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'pid_alive', 'info',
      `Attempt ${attempt.attemptNumber} PID ${attempt.pid} is alive and environment is intact. No action needed.`,
      ['running', 'pid_alive', attempt.attemptId, String(attempt.pid)],
    ));
    return;
  }

  // A2: PID alive but worktree missing → blocking
  if (attempt.pidAlive === 'alive' && !attempt.worktreeExists) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'worktree_missing', 'blocking',
      `Attempt ${attempt.attemptNumber} PID ${attempt.pid} is alive but worktree is missing. Manual investigation required — do not auto-fix.`,
      ['running', 'worktree_missing', attempt.attemptId, 'pid_alive'],
    ));
    return;
  }

  // A3: PID not alive → warning, can auto-interrupt + release locks
  if (attempt.pidAlive === 'gone') {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'pid_missing', 'warning',
      `Attempt ${attempt.attemptNumber} PID ${attempt.pid} is gone. Safe-apply will mark interrupted and release proven locks.`,
      ['running', 'pid_missing', attempt.attemptId, String(attempt.pid)],
    ));

    // Also flag orphaned locks specifically
    if (attempt.locksHeld > 0 && attempt.locksOrphaned) {
      findings.push(makeFinding(
        runId, 'attempt', attempt.attemptId,
        'lock_orphaned', 'warning',
        `Attempt ${attempt.attemptNumber} holds ${attempt.locksHeld} active lock(s) but PID is gone. Safe-apply will release them.`,
        ['lock_orphaned', attempt.attemptId, String(attempt.locksHeld)],
      ));
    }
    return;
  }

  // A4: piPid is null (no PID recorded)
  if (attempt.pidAlive === 'unknown' && attempt.pid === null) {
    const now = Date.now();
    const leaseExpiry = attempt.dispatchLeaseExpiresAt ? Date.parse(attempt.dispatchLeaseExpiresAt) : Number.NaN;
    const updatedAt = Date.parse(attempt.attemptUpdatedAt);
    if (Number.isFinite(leaseExpiry) && leaseExpiry > now) {
      findings.push(makeFinding(
        runId, 'attempt', attempt.attemptId,
        'no_pid_active_window', 'info',
        `Attempt ${attempt.attemptNumber} is inside an active dispatch lease while PID persistence is pending. No action.`,
        ['running', 'no_pid', 'active_lease', attempt.attemptId, attempt.dispatchLeaseExpiresAt!],
      ));
      return;
    }
    if (attempt.spawnEventObserved) {
      findings.push(makeFinding(
        runId, 'attempt', attempt.attemptId,
        'no_pid_recorded', 'blocking',
        `Attempt ${attempt.attemptNumber} has spawn evidence but no persisted PID. Provider state is unknown; manual investigation required.`,
        ['running', 'no_pid', 'spawn_observed', attempt.attemptId],
      ));
      return;
    }
    if (Number.isFinite(leaseExpiry) && leaseExpiry <= now
      && Number.isFinite(updatedAt) && now - updatedAt >= 60_000) {
      findings.push(makeFinding(
        runId, 'attempt', attempt.attemptId,
        'no_pid_stale', 'warning',
        `Attempt ${attempt.attemptNumber} has an expired dispatch lease and no spawn evidence. Safe-apply will mark interrupted.`,
        ['running', 'no_pid', 'expired_lease', attempt.attemptId, attempt.dispatchLeaseExpiresAt!],
      ));
      return;
    }
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'no_pid_recorded', 'blocking',
      `Attempt ${attempt.attemptNumber} is running without PID or a provably expired dispatch lease. Keep state unchanged and investigate manually.`,
      ['running', 'no_pid', 'insufficient_stale_evidence', attempt.attemptId],
    ));
  }
}

// ── B. worker_completed attempt ──

function classifyWorkerCompletedAttempt(
  runId: string,
  stage: StageFacts,
  attempt: AttemptFacts,
  findings: Finding[],
): void {
  // B1: workerResult exists, worktree exists, branch exists, locks ok → info
  if (attempt.workerResultExists && attempt.worktreeExists && attempt.branchExists && !attempt.locksOrphaned) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'pid_alive', 'info', // using 'pid_alive' as generic "everything ok" for worker_completed
      `Attempt ${attempt.attemptNumber} completed worker with intact evidence. Ready for resume.`,
      ['worker_completed', 'ok', attempt.attemptId],
    ));
    return;
  }

  // B2: workerResult exists, worktree missing → blocking
  if (attempt.workerResultExists && !attempt.worktreeExists) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'worker_completed_blocking', 'blocking',
      `Attempt ${attempt.attemptNumber} worker completed but worktree is missing. Stage will be paused — cannot validate quality gate without worktree evidence.`,
      ['worker_completed', 'worktree_missing', attempt.attemptId],
    ));

    findings.push(makeFinding(
      runId, 'stage', stage.stageId,
      'worker_completed_blocking', 'blocking',
      `Stage ${stage.stageNumber} has worker_completed attempt with missing worktree. Stage must be paused.`,
      ['stage_pause', stage.stageId, 'worktree_missing'],
    ));
    return;
  }

  // B3: workerResult missing → blocking
  if (!attempt.workerResultExists) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'worker_result_missing', 'blocking',
      `Attempt ${attempt.attemptNumber} is worker_completed but WorkerResult is missing. Evidence lost — cannot prove Pi completed. Safe-apply will mark interrupted. Never faking Pi completion.`,
      ['worker_completed', 'worker_result_missing', attempt.attemptId],
    ));
    return;
  }

  // B4: branch missing → blocking
  if (!attempt.branchExists) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'branch_missing', 'blocking',
      `Attempt ${attempt.attemptNumber} worker completed but branch is missing. Evidence incomplete. Stage will be paused.`,
      ['worker_completed', 'branch_missing', attempt.attemptId],
    ));
    findings.push(makeFinding(
      runId, 'stage', stage.stageId,
      'worker_completed_blocking', 'blocking',
      `Stage ${stage.stageNumber} has worker_completed attempt with missing branch. Stage must be paused.`,
      ['stage_pause', stage.stageId, 'branch_missing'],
    ));
    return;
  }

  // B5: branch exists but worktree not registered → warning
  if (attempt.worktreeExists && !attempt.worktreeRegistered) {
    findings.push(makeFinding(
      runId, 'worktree', attempt.attemptId,
      'worktree_unregistered', 'warning',
      `Attempt ${attempt.attemptNumber} worktree exists on disk but not registered in git worktree list. Manual cleanup may be needed. Do not auto-fix.`,
      ['worker_completed', 'worktree_unregistered', attempt.attemptId],
    ));
    return;
  }

  // B6: lock owner mismatch → blocking
  if (attempt.workerResultExists && attempt.locksOrphaned) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'worker_completed_blocking', 'blocking',
      `Attempt ${attempt.attemptNumber} worker completed but active lock ownership is invalid. Stage will be paused.`,
      ['worker_completed', 'lock_mismatch', attempt.attemptId],
    ));
    findings.push(makeFinding(
      runId, 'stage', stage.stageId,
      'worker_completed_blocking', 'blocking',
      `Stage ${stage.stageNumber} has lock conflict on worker_completed attempt. Stage must be paused.`,
      ['stage_pause', stage.stageId, 'lock_conflict'],
    ));
  }
}

// ── C. reviewing attempt ──

function classifyReviewingAttempt(
  runId: string,
  attempt: AttemptFacts,
  findings: Finding[],
): void {
  // C1: Review exists but not completed → warning
  if (attempt.reviewStatus && attempt.reviewStatus !== 'approved' && attempt.reviewStatus !== 'rework_required' && attempt.reviewStatus !== 'failed') {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'review_unfinished', 'warning',
      `Attempt ${attempt.attemptNumber} is reviewing but review has not completed (status: ${attempt.reviewStatus}). Resume will re-run review — do not auto-fix.`,
      ['reviewing', 'unfinished', attempt.attemptId, attempt.reviewStatus || 'null'],
    ));
    return;
  }

  // C2: No review record at all → blocking
  if (!attempt.reviewStatus) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'review_missing', 'blocking',
      `Attempt ${attempt.attemptNumber} is reviewing but no review record exists. Evidence lost — safe-apply will mark attempt as failed.`,
      ['reviewing', 'no_review', attempt.attemptId],
    ));
    return;
  }

  // C3: Review completed but attempt still reviewing → info, can converge
  if (attempt.reviewCompleted &&
      (attempt.reviewStatus === 'approved' || attempt.reviewStatus === 'rework_required')) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'review_state_mismatch', 'info',
      `Attempt ${attempt.attemptNumber} review is completed (${attempt.reviewStatus}) but attempt status is still reviewing. Safe-apply will converge attempt status.`,
      ['reviewing', 'state_mismatch', attempt.attemptId, attempt.reviewStatus],
    ));
  }
}

// ── validating attempt ──

function classifyValidatingAttempt(
  runId: string,
  stage: StageFacts,
  attempt: AttemptFacts,
  findings: Finding[],
): void {
  // Similar to worker_completed but more conservative.
  // If stuck in validating with missing evidence, it's blocking.
  if (!attempt.workerResultExists) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'worker_result_missing', 'blocking',
      `Attempt ${attempt.attemptNumber} is validating but WorkerResult is missing. Evidence lost — safe-apply will mark interrupted.`,
      ['validating', 'worker_result_missing', attempt.attemptId],
    ));
    return;
  }
  if (!attempt.worktreeExists) {
    findings.push(makeFinding(
      runId, 'attempt', attempt.attemptId,
      'worker_completed_blocking', 'blocking',
      `Attempt ${attempt.attemptNumber} is validating but worktree missing. Stage will be paused.`,
      ['validating', 'worktree_missing', attempt.attemptId],
    ));
    findings.push(makeFinding(
      runId, 'stage', stage.stageId,
      'worker_completed_blocking', 'blocking',
      `Stage ${stage.stageNumber} has validating attempt with missing worktree. Stage must be paused.`,
      ['stage_pause', stage.stageId, 'worktree_missing'],
    ));
  }
}

// ══════════════════════════════════════════════════════════════
// D. Integration batch classification
// ══════════════════════════════════════════════════════════════

function classifyIntegration(
  run: RunFacts,
  integration: IntegrationFacts,
  findings: Finding[],
  governanceEnabled: boolean,
): void {
  if (integration.status !== 'integrating' && integration.status !== 'pending') return;

  // D1: Batch running, merge commit exists in Git → info, can converge
  if (integration.mergeCommitInGit) {
    findings.push(makeFinding(
      run.runId, 'integration', integration.batchId,
      'integration_stalled', 'info',
      `Integration batch is ${integration.status} but merge commit already exists in Git. Safe-apply will update batch to completed.`,
      ['integration', 'stalled', integration.batchId, 'merge_exists'],
    ));
    return;
  }

  // D2: Target already contains merge commit → blocking, but safe to converge
  if (integration.targetAlreadyMerged) {
    findings.push(makeFinding(
      run.runId, 'integration', integration.batchId,
      'target_merged_already', 'blocking',
      `Target branch already contains the integration changes. Safe-apply will mark batch as completed (idempotent protection). Never repeat target merge.`,
      ['integration', 'target_already_merged', integration.batchId],
    ));
    return;
  }

  // D3: Integration branch missing → blocking
  if (!integration.integrationBranchExists) {
    findings.push(makeFinding(
      run.runId, 'integration', integration.batchId,
      'integration_missing', 'blocking',
      `Integration branch ${integration.integrationBranch} is missing. Batch will be marked failed.`,
      ['integration', 'branch_missing', integration.batchId, integration.integrationBranch],
    ));
    return;
  }

  // D4: Integration stalled (branch exists, no merge, just stuck) → warning
  findings.push(makeFinding(
    run.runId, 'integration', integration.batchId,
    'integration_stalled', 'warning',
    `Integration batch is ${integration.status} but not yet merged. Manual investigation may be needed. Do not auto-merge.`,
    ['integration', 'stalled', integration.batchId, integration.status],
  ));
}

// ══════════════════════════════════════════════════════════════
// E. Active lock classification
// ══════════════════════════════════════════════════════════════

function classifyLock(
  run: RunFacts,
  lock: LockFacts,
  findings: Finding[],
  governanceEnabled: boolean,
): void {
  // Lock is already released — nothing to do
  if (lock.lockStatus !== 'locked') return;

  // E1: Lock's attempt is terminal → orphaned, safe to release
  if (lock.ownerAttemptStatus !== null && TERMINAL_ATTEMPT_STATUSES.has(lock.ownerAttemptStatus)) {
    findings.push(makeFinding(
      run.runId, 'lock', lock.lockId,
      'lock_orphaned', 'warning',
      `Active lock belongs to attempt in terminal status (${lock.ownerAttemptStatus}). Safe-apply will release lock.`,
      ['lock_orphaned', lock.lockId, lock.ownerAttemptStatus],
    ));
    return;
  }

  // E2: Lock's attempt PID is confirmed gone → release lock + mark attempt interrupted
  if (lock.ownerPidAlive === 'gone'
    && lock.ownerAttemptStatus !== null
    && !TERMINAL_ATTEMPT_STATUSES.has(lock.ownerAttemptStatus)
    && !POST_WORKER_LOCK_STATUSES.has(lock.ownerAttemptStatus)) {
    findings.push(makeFinding(
      run.runId, 'lock', lock.lockId,
      'lock_owner_pid_gone', 'warning',
      `Active lock's owner PID is gone but attempt is still non-terminal (${lock.ownerAttemptStatus}). Safe-apply will release lock and mark attempt interrupted.`,
      ['lock_pid_gone', lock.lockId, lock.ownerAttemptStatus],
    ));
    return;
  }

  // E3: Lock's owner PID is alive → keep lock, warn
  if (lock.ownerPidAlive === 'alive') {
    findings.push(makeFinding(
      run.runId, 'lock', lock.lockId,
      'pid_alive', 'warning',
      `Active lock's owner PID is alive. Lock is still active — do not release.`,
      ['lock_owner_alive', lock.lockId],
    ));
    return;
  }

  // E4: Lock owner unknown (no matching attempt) → blocking
  if (lock.ownerAttemptId === null || lock.ownerAttemptStatus === null) {
    findings.push(makeFinding(
      run.runId, 'lock', lock.lockId,
      'lock_owner_unknown', 'blocking',
      `Active lock's owner is unknown. Manual investigation required — do not auto-release.`,
      ['lock_owner_unknown', lock.lockId, lock.taskId],
    ));
    return;
  }

  // E5: Lock belongs to canceled run → release
  if (lock.ownerRunStatus === 'canceled') {
    findings.push(makeFinding(
      run.runId, 'lock', lock.lockId,
      'lock_orphaned', 'warning',
      `Active lock belongs to canceled run. Safe-apply will release lock.`,
      ['lock_canceled_run', lock.lockId],
    ));
  }
}

// ══════════════════════════════════════════════════════════════
// H. Git head classification
// ══════════════════════════════════════════════════════════════

function classifyGitHead(run: RunFacts, findings: Finding[]): void {
  if (!run.gitHeadResolvable) {
    findings.push(makeFinding(
      run.runId, 'git_head', 'HEAD',
      'git_head_unknown', 'blocking',
      'Git HEAD cannot be resolved. Repository may be in an abnormal state. Manual investigation required — do not auto-fix.',
      ['git_head', 'unresolvable'],
    ));
  }

  if (run.mergeConflict) {
    findings.push(makeFinding(
      run.runId, 'conflict', 'MERGE_HEAD',
      'conflict_state', 'blocking',
      `Git repository has unresolved merge conflicts in: ${run.conflictFiles.join(', ') || 'unknown files'}. Manual resolution required — do not auto-fix.`,
      ['conflict', ...run.conflictFiles],
    ));
  }
}

// ══════════════════════════════════════════════════════════════
// Safe Action derivation
// ══════════════════════════════════════════════════════════════

/**
 * Derive safe actions from findings. Only findings that have a safe,
 * provable, one-way fix produce a SafeAction. All others are skipped.
 * This function is pure — it maps finding kinds to allowed actions per §5.2.
 */
export function deriveSafeActions(findings: Finding[]): SafeAction[] {
  const actions: SafeAction[] = [];

  for (const f of findings) {
    const action = mapFindingToSafeAction(f);
    if (action) actions.push(action);
  }

  return actions;
}

function mapFindingToSafeAction(f: Finding): SafeAction | null {
  switch (f.kind) {
    // A3: PID gone → mark interrupted
    case 'pid_missing':
      return {
        actionType: 'mark_attempt_interrupted',
        targetEntityType: f.entityType,
        targetEntityId: f.entityId,
        runId: f.runId,
        findingId: f.id,
        metadata: { reason: 'pid_missing' },
      };

    // A4: No PID is safe only with an expired lease and no spawn evidence.
    case 'no_pid_stale':
      return {
        actionType: 'mark_attempt_interrupted',
        targetEntityType: f.entityType,
        targetEntityId: f.entityId,
        runId: f.runId,
        findingId: f.id,
        metadata: { reason: 'no_pid_recorded' },
      };

    // B3: Worker result missing → mark interrupted (never fake Pi completion)
    case 'worker_result_missing':
      return {
        actionType: 'mark_attempt_interrupted',
        targetEntityType: f.entityType,
        targetEntityId: f.entityId,
        runId: f.runId,
        findingId: f.id,
        metadata: { reason: 'worker_result_missing' },
      };

    // B2/B4/B6: worker_completed with blocking evidence → pause stage
    case 'worker_completed_blocking':
      if (f.entityType === 'stage') {
        return {
          actionType: 'mark_stage_paused',
          targetEntityType: f.entityType,
          targetEntityId: f.entityId,
          runId: f.runId,
          findingId: f.id,
          metadata: { reason: f.kind },
        };
      }
      return null;

    // C3: Review state mismatch → update attempt per review result
    case 'review_state_mismatch':
      return {
        actionType: 'update_attempt_status_by_review',
        targetEntityType: f.entityType,
        targetEntityId: f.entityId,
        runId: f.runId,
        findingId: f.id,
        metadata: { kind: 'review_state_mismatch' },
      };

    // D1: Integration stalled (merge exists) → update batch completed
    case 'integration_stalled':
      if (f.entityType === 'integration') {
        return {
          actionType: 'update_integration_batch_completed',
          targetEntityType: f.entityType,
          targetEntityId: f.entityId,
          runId: f.runId,
          findingId: f.id,
          metadata: { reason: 'merge_exists' },
        };
      }
      return null;

    // D2: Target already merged → update batch completed (idempotent)
    case 'target_merged_already':
      if (f.entityType === 'integration') {
        return {
          actionType: 'update_integration_batch_completed',
          targetEntityType: f.entityType,
          targetEntityId: f.entityId,
          runId: f.runId,
          findingId: f.id,
          metadata: { reason: 'target_already_merged' },
        };
      }
      return null;

    // D3: Integration branch missing → no safe action (blocking only)
    case 'integration_missing':
      return null; // blocking, no auto-fix

    // E1: Orphaned lock with terminal attempt → release
    case 'lock_orphaned':
      if (f.entityType === 'lock') {
        return {
          actionType: 'release_lock',
          targetEntityType: f.entityType,
          targetEntityId: f.entityId,
          runId: f.runId,
          findingId: f.id,
          metadata: { reason: 'lock_orphaned' },
        };
      }
      return null;

    // E2: Lock owner PID gone → release lock
    case 'lock_owner_pid_gone':
      if (f.entityType === 'lock') {
        return {
          actionType: 'release_lock',
          targetEntityType: f.entityType,
          targetEntityId: f.entityId,
          runId: f.runId,
          findingId: f.id,
          metadata: { reason: 'pid_gone' },
        };
      }
      return null;

    // F: Canceled run recovery → mark attempt/stage canceled
    case 'canceled_run_recovery':
      if (f.entityType === 'attempt') {
        return {
          actionType: 'mark_attempt_canceled',
          targetEntityType: f.entityType,
          targetEntityId: f.entityId,
          runId: f.runId,
          findingId: f.id,
          metadata: { reason: 'canceled_run_recovery' },
        };
      }
      if (f.entityType === 'stage') {
        return {
          actionType: 'mark_stage_canceled',
          targetEntityType: f.entityType,
          targetEntityId: f.entityId,
          runId: f.runId,
          findingId: f.id,
          metadata: { reason: 'canceled_run_recovery' },
        };
      }
      return null;

    // G: Approval expired → update (only if governance enabled; handled at engine level)
    case 'approval_expired':
      return {
        actionType: 'update_approval_expired',
        targetEntityType: f.entityType,
        targetEntityId: f.entityId,
        runId: f.runId,
        findingId: f.id,
        metadata: { reason: 'expired' },
      };

    // All others: no safe action (info, warning-only, or blocking without safe auto-fix)
    case 'pid_alive':
    case 'worktree_missing':
    case 'worktree_unregistered':
    case 'worktree_dirty':
    case 'branch_missing':
    case 'branch_diverged':
    case 'lock_conflict':
    case 'lock_owner_unknown':
    case 'budget_paused_stale':
    case 'git_head_unknown':
    case 'conflict_state':
    case 'review_unfinished':
    case 'review_missing':
    case 'stage_deadlock':
      return null;

    default:
      return null;
  }
}
