// ── M5 Types: Crash Recovery & State Convergence ────────────────────────
// Defines all types for reconciliation: fact snapshots, findings,
// safe actions, reports, and persisted audit records.
// All interfaces are immutable-once-built. No secrets stored.

// ══════════════════════════════════════════════════════════════
// Fact Snapshots — gathered from SQLite + Git/filesystem/process
// ══════════════════════════════════════════════════════════════

/** Overall run facts collected during reconciliation */
export interface RunFacts {
  runId: string;
  runStatus: string;
  projectRootHash: string;       // SHA256 of projectRoot (sanitized)
  governanceEnabled: boolean;
  gitHead: string | null;
  gitHeadResolvable: boolean;
  mergeConflict: boolean;
  conflictFiles: string[];       // file names only, no absolute paths
}

/** Per-stage facts */
export interface StageFacts {
  stageId: string;
  stageNumber: number;
  status: string;
  baseCommit: string | null;
  tasks: TaskFacts[];
  integration: IntegrationFacts | null;
  activeLocks: LockFacts[];
}

/** Per-task facts */
export interface TaskFacts {
  taskId: string;
  title: string;
  status: string;
  attempts: AttemptFacts[];
}

/** Per-attempt facts */
export interface AttemptFacts {
  attemptId: string;
  attemptNumber: number;
  status: string;
  taskId: string;
  stageId: string;
  pid: number | null;
  pidAlive: 'alive' | 'gone' | 'unknown';
  dispatchLeaseExpiresAt: string | null;
  spawnEventObserved: boolean;
  attemptUpdatedAt: string;
  worktreePath: string | null;   // in-memory only, not persisted
  worktreeExists: boolean;
  worktreeRegistered: boolean;
  worktreeDirty: boolean;
  branchName: string | null;
  branchExists: boolean;
  branchHeadMatches: boolean;    // HEAD matches recorded commit
  workerResultExists: boolean;
  workerResultJson: string | null; // in-memory only, not persisted
  workerResultCompleted: boolean;
  workerCommitHash: string | null;
  /** True when the WorkerResult reports filesChanged as an empty array (a legit no-change diagnose/report completion). */
  workerResultNoChange: boolean;
  /** True when the worker's claimed commit is reachable from HEAD (the attempt branch may have been cleaned up after merge). */
  workerCommitMerged: boolean;
  changedFiles: string[];         // relative paths from base..attempt branch
  expectedWritePaths: string[];
  expectedWriteEvidence: boolean;
  reviewEvidenceTrusted: boolean;
  locksHeld: number;
  locksOrphaned: boolean;
  reviewCompleted: boolean;      // review exists and finished
  reviewStatus: string | null;
  /** True when the attempt's approved state is covered by a valid trusted stage review. */
  reviewCoveredByTrustedStageReview: boolean;
}

/** Integration batch facts */
export interface IntegrationFacts {
  batchId: string;
  status: string;
  integrationBranch: string;
  integrationBranchExists: boolean;
  mergeCommitInGit: boolean;
  targetAlreadyMerged: boolean;
  /** Null when SQLite audit events cannot prove which branch was targeted. */
  targetBranch: string | null;
  targetMergeCommit: string | null;
}

/** Per-lock facts */
export interface LockFacts {
  lockId: string;
  filePathHash: string;          // SHA256 of filePath
  taskId: string;
  lockType: string;
  lockStatus: string;
  ownerAttemptId: string | null;
  ownerAttemptStatus: string | null; // attempt status or null if not found
  ownerPidAlive: 'alive' | 'gone' | 'unknown' | 'n/a';
  ownerRunStatus: string | null; // run status if found
}

/** Governance facts are collected only when governance is enabled. */
export interface GovernanceFacts {
  pendingApprovals: Array<{
    approvalId: string;
    gate: string;
    expiresAt: string | null;
  }>;
  budget: {
    paused: boolean;
    policyType: string | null;
    policyExists: boolean;
    hasLedgerUsage: boolean;
  };
}

/** Complete fact snapshot for a single run */
export interface ReconciliationFactSnapshot {
  run: RunFacts;
  stages: StageFacts[];
  governance?: GovernanceFacts;
}

// ══════════════════════════════════════════════════════════════
// Finding — a classified anomaly detected during reconciliation
// ══════════════════════════════════════════════════════════════

export type FindingSeverity = 'info' | 'warning' | 'blocking';

export type FindingStatus = 'open' | 'applied' | 'skipped' | 'superseded';

export type FindingKind =
  | 'pid_missing'
  | 'pid_alive'
  | 'no_pid_recorded'
  | 'no_pid_active_window'
  | 'no_pid_stale'
  | 'worker_result_missing'
  | 'worktree_missing'
  | 'worktree_unregistered'
  | 'worktree_dirty'
  | 'branch_missing'
  | 'branch_diverged'
  | 'lock_orphaned'
  | 'lock_owner_mismatch'
  | 'lock_conflict'
  | 'lock_owner_unknown'
  | 'lock_owner_pid_gone'
  | 'integration_stalled'
  | 'integration_missing'
  | 'target_merged_already'
  | 'approval_expired'
  | 'budget_paused_stale'
  | 'git_head_unknown'
  | 'conflict_state'
  | 'canceled_run_recovery'
  | 'stage_deadlock'
  | 'review_unfinished'
  | 'review_missing'
  | 'review_state_mismatch'
  | 'worker_completed_blocking'
  | 'completed_stage_with_incomplete_tasks'
  | 'approved_attempt_without_verifiable_change'
  | 'expected_write_missing'
  | 'fake_review_in_real_path'
  | 'review_evidence_missing';

export type FindingEntityType =
  | 'attempt'
  | 'stage'
  | 'run'
  | 'lock'
  | 'worktree'
  | 'branch'
  | 'integration'
  | 'approval'
  | 'budget'
  | 'git_head'
  | 'conflict';

export interface Finding {
  id: string;
  entityType: FindingEntityType;
  entityId: string;
  runId: string;
  kind: FindingKind;
  severity: FindingSeverity;
  status: FindingStatus;          // in-memory: 'open'; persisted: 'applied'|'skipped'|'superseded'
  proposal: string;               // human-readable fix proposal (no paths/secrets)
  appliedAction: string | null;   // what was applied (null if just diagnosed)
  evidenceHash: string;           // SHA256 of sanitized evidence
}

// ══════════════════════════════════════════════════════════════
// Safe Action — an action the applicator is allowed to perform
// ══════════════════════════════════════════════════════════════

export type SafeActionType =
  | 'mark_attempt_interrupted'
  | 'release_lock'
  | 'mark_stage_paused'
  | 'mark_attempt_canceled'
  | 'mark_stage_canceled'
  | 'update_integration_batch_completed'
  | 'update_approval_expired'
  | 'update_attempt_status_by_review';

export interface SafeAction {
  actionType: SafeActionType;
  targetEntityType: FindingEntityType;
  targetEntityId: string;
  runId: string;
  findingId: string;             // the finding this action resolves
  metadata: Record<string, unknown>; // action-specific params (e.g., lockId, newStatus)
}

// ══════════════════════════════════════════════════════════════
// Reconciliation Report (JSON output)
// ══════════════════════════════════════════════════════════════

export type ReconciliationPhase = 'dry_run' | 'applied';

export type ReconciliationInitiatedBy = 'user_direct' | 'approve_preflight' | 'resume_preflight' | 'scheduler';

export interface ReconciliationReport {
  reportId: string;
  runId: string;
  phase: ReconciliationPhase;
  initiatedBy: ReconciliationInitiatedBy;
  startedAt: string;
  finishedAt: string;
  summary: ReconciliationSummary;
  entities: {
    run: RunReconciliation;
    stages: StageReconciliation[];
  };
  findings: Finding[];
}

export interface ReconciliationSummary {
  totalFindings: number;
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  appliedCount: number;
  skippedCount: number;
  canResume: boolean;
  canApprove: boolean;
}

export interface RunReconciliation {
  runId: string;
  status: string;
  projectRootHash: string;
  gitHead: string | null;
  gitHeadResolvable: boolean;
  mergeConflict: boolean;
  conflictFiles: string[];
}

export interface StageReconciliation {
  stageId: string;
  stageNumber: number;
  status: string;
  baseCommit: string | null;
  tasks: TaskReconciliation[];
  integration: IntegrationReconciliation | null;
  activeLocks: LockReconciliation[];
}

export interface TaskReconciliation {
  taskId: string;
  title: string;
  status: string;
  attempts: AttemptReconciliation[];
}

export interface AttemptReconciliation {
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
}

export interface IntegrationReconciliation {
  batchId: string;
  status: string;
  integrationBranch: string;
  integrationBranchExists: boolean;
  mergeCommitInGit: boolean;
  targetAlreadyMerged: boolean;
  targetBranch: string | null;
}

export interface LockReconciliation {
  lockId: string;
  filePathHash: string;
  taskId: string;
  lockType: string;
  ownerAttemptStatus: string | null;
  ownerPidAlive: 'alive' | 'gone' | 'unknown' | 'n/a';
}

// ══════════════════════════════════════════════════════════════
// Persisted Records (as stored in SQLite)
// ══════════════════════════════════════════════════════════════

export interface ReconciliationReportRecord {
  id: string;
  runId: string;
  phase: 'applied';               // only applied phase is persisted
  initiatedBy: 'user_direct';     // only user_direct is persisted
  totalFindings: number;
  blockingCount: number;
  appliedCount: number;
  skippedCount: number;
  summaryJson: string;            // JSON summary, no paths or secrets
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface ReconciliationFindingRecord {
  id: string;
  reportId: string;
  runId: string;
  entityType: FindingEntityType;
  entityId: string;
  kind: FindingKind;
  severity: FindingSeverity;
  status: 'open' | 'applied' | 'skipped' | 'superseded';
  proposal: string;
  appliedAction: string | null;
  evidenceHash: string;
  createdAt: string;
  appliedAt: string | null;
}

// ══════════════════════════════════════════════════════════════
// Input types for StateStore
// ══════════════════════════════════════════════════════════════

export interface CreateReconciliationReportInput {
  id: string;
  runId: string;
  totalFindings: number;
  blockingCount: number;
  appliedCount: number;
  skippedCount: number;
  summaryJson: string;
  startedAt: string;
  finishedAt?: string | null;
}

export interface CreateReconciliationFindingInput {
  id: string;
  reportId: string;
  runId: string;
  entityType: FindingEntityType;
  entityId: string;
  kind: FindingKind;
  severity: FindingSeverity;
  status: 'open' | 'applied' | 'skipped' | 'superseded';
  proposal: string;
  appliedAction?: string | null;
  evidenceHash: string;
  appliedAt?: string | null;
}

// ══════════════════════════════════════════════════════════════
// StatusSnapshot extension (optional field added to existing type)
// ══════════════════════════════════════════════════════════════

export interface ReconciliationStatusSummary {
  lastReportId: string | null;
  lastReportAt: string | null;
  openBlockingFindings: number;
  openWarningFindings: number;
  message: string;
}

// ══════════════════════════════════════════════════════════════
// FactGatherer interface (injectable for testing)
// ══════════════════════════════════════════════════════════════

export interface FactGatherer {
  /** Check if a PID is alive on the system */
  checkPidAlive(pid: number): Promise<'alive' | 'gone' | 'unknown'>;

  /** Check if a path exists on disk */
  pathExists(absPath: string): Promise<boolean>;

  /** Check if a git branch exists */
  branchExists(projectRoot: string, branchName: string): Promise<boolean>;

  /** Resolve current Git HEAD in project root */
  getGitHead(projectRoot: string): Promise<string | null>;

  /** Check if project is in merge conflict state */
  hasMergeConflict(projectRoot: string): Promise<boolean>;

  /** Get conflict file names (no paths, just filenames) */
  getConflictFiles(projectRoot: string): Promise<string[]>;

  /** Check if a worktree is registered (git worktree list --porcelain) */
  isWorktreeRegistered(projectRoot: string, worktreePath: string): Promise<boolean>;

  /** Check if a worktree is dirty */
  isWorktreeDirty(worktreePath: string): Promise<boolean>;

  /** Check if a branch has been merged to target */
  isBranchMerged(projectRoot: string, branch: string, targetBranch: string): Promise<boolean>;

  /** Check if a specific commit is reachable from current HEAD */
  isCommitReachable(projectRoot: string, commitHash: string): Promise<boolean>;

  /** Get the HEAD commit of a specific branch */
  getBranchHead(projectRoot: string, branchName: string): Promise<string | null>;
}
