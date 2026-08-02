import type {
  RunStatus,
  StageStatus,
  TaskStatus,
  AttemptStatus,
} from '../core/state-machine.js';
import type {
  StageRecord, CreateStageInput,
  AttemptRecord, CreateAttemptInput,
  PathLockRecord, CreatePathLockInput,
  ReviewRecord, CreateReviewInput,
  IntegrationBatchRecord, CreateIntegrationBatchInput,
  EventRecord, CreateEventInput,
  ActualPathClaimRecord, AttemptProvenanceRecord,
} from '../types/m2-types.js';
import type {
  ResourceSampleRecord,
  DispatchDecisionRecord,
} from '../types/m3-types.js';
import type {
  ApprovalDecision,
  TokenLedgerEntry,
  BudgetPolicy,
  RiskAssessment,
  CostReservation,
} from '../types/m4-types.js';
import type {
  ReconciliationReportRecord,
  ReconciliationFindingRecord,
  CreateReconciliationReportInput,
  CreateReconciliationFindingInput,
} from '../types/m5-types.js';
import type {
  PauseRecord,
  CreateStagePauseInput,
  ResolveStagePauseInput,
} from '../types/pause-types.js';

export interface CreateRunInput {
  id: string;
  projectId: string;
  projectRoot: string;
  requestText: string;
  status: RunStatus;
  codexThreadId?: string | null;
  executionConfigSnapshot?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord extends CreateRunInput {
  finishedAt?: string | null;
  /** Encrypted request text (JSON-serialized EncryptedPayload), if privacy-enabled */
  encryptedRequestText?: string | null;
}

export interface CreateTaskInput {
  id: string;
  runId: string;
  title: string;
  status: TaskStatus;
  specJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord extends CreateTaskInput {
  branchName?: string | null;
  worktreePath?: string | null;
  workerId?: string | null;
  commitHash?: string | null;
  retryCount: number;
  finishedAt?: string | null;
}

export interface ReviewRetryInput {
  runId: string;
  stageId: string;
  taskId: string;
  attemptId: string;
  reason: string;
  updatedAt: string;
}

export interface RunConvergenceFailureInput {
  runId: string;
  reason: string;
  failedAt: string;
}

export interface StateStore {
  close(): Promise<void>;

  // Run operations
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  getActiveRunByProject(projectRoot: string): Promise<RunRecord | null>;
  updateRunStatus(runId: string, status: RunStatus, updatedAt: string): Promise<boolean>;
  failRunForConvergenceAtomically(input: RunConvergenceFailureInput): Promise<boolean>;
  updateRunFinishedAt(runId: string, finishedAt: string): Promise<boolean>;

  // Task operations
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  updateTaskStatus(taskId: string, status: TaskStatus, updatedAt: string): Promise<boolean>;
  updateTaskRetryCount(taskId: string, retryCount: number, updatedAt: string): Promise<boolean>;
  listTasks(runId: string): Promise<TaskRecord[]>;
  listTasksByStage(stageId: string): Promise<TaskRecord[]>;

  // Stage operations
  createStage(input: CreateStageInput): Promise<StageRecord>;
  getStage(stageId: string): Promise<StageRecord | null>;
  updateStageStatus(stageId: string, status: StageStatus, updatedAt: string): Promise<boolean>;
  updateStageBaseCommit(stageId: string, commit: string): Promise<boolean>;
  updateStageIntegrationBranch(stageId: string, branch: string): Promise<boolean>;
  listStages(runId: string): Promise<StageRecord[]>;
  createStagePause(input: CreateStagePauseInput): Promise<PauseRecord>;
  getPauseRecord(pauseId: string): Promise<PauseRecord | null>;
  getActivePauseForStage(stageId: string): Promise<PauseRecord | null>;
  resolveStagePause(input: ResolveStagePauseInput): Promise<boolean>;

  // Attempt operations
  createAttempt(input: CreateAttemptInput): Promise<AttemptRecord>;
  getAttempt(attemptId: string): Promise<AttemptRecord | null>;
  updateAttemptStatus(attemptId: string, status: AttemptStatus, updatedAt: string): Promise<boolean>;
  retryReviewAtomically(input: ReviewRetryInput): Promise<boolean>;
  updateAttemptResult(attemptId: string, updates: Partial<Pick<AttemptRecord, 'piPid' | 'startedAt' | 'stoppedAt' | 'worktreePath' | 'branchName' | 'promptHash' | 'workerResultJson' | 'exitReason' | 'logPath' | 'rawLogPath' | 'resultSource' | 'adoptedCommit' | 'adoptionMetadataJson'>>): Promise<boolean>;
  listAttempts(taskId: string): Promise<AttemptRecord[]>;
  listAttemptsByStage(stageId: string): Promise<AttemptRecord[]>;
  getLatestAttempt(taskId: string): Promise<AttemptRecord | null>;

  // Path lock operations
  createPathLock(input: CreatePathLockInput): Promise<PathLockRecord>;
  acquirePathLocksAtomic(input: AcquirePathLocksInput): Promise<AcquirePathLocksResult>;
  getPathLock(lockId: string): Promise<PathLockRecord | null>;
  releasePathLock(lockId: string, releasedAt: string): Promise<boolean>;
  getActiveLocksForRun(runId: string): Promise<PathLockRecord[]>;
  getConflictingLocks(taskId: string, filePaths: string[], runId: string): Promise<PathLockRecord[]>;
  claimActualPathsAtomic(input: ClaimActualPathsInput): Promise<ClaimActualPathsResult>;
  listActualPathClaims(stageId: string): Promise<ActualPathClaimRecord[]>;
  releaseActualPathClaimsForStage(stageId: string, releasedAt: string): Promise<number>;

  // Immutable attempt identity, persisted before any worker process spawn.
  recordAttemptProvenance(input: CreateAttemptProvenanceInput): Promise<AttemptProvenanceRecord>;
  getAttemptProvenance(attemptId: string): Promise<AttemptProvenanceRecord | null>;

  // Review operations
  createReview(input: CreateReviewInput): Promise<ReviewRecord>;
  getReview(reviewId: string): Promise<ReviewRecord | null>;
  updateReviewResult(reviewId: string, updates: Partial<Pick<ReviewRecord, 'status' | 'reviewJson' | 'findingsJson' | 'requiredReworkJson' | 'reworkCount' | 'mergeAllowed' | 'startedAt' | 'finishedAt' | 'reviewedThroughCommit' | 'finalCommit' | 'coverageStatus' | 'reviewerUnavailable' | 'errorCategory' | 'exitCode' | 'durationMs' | 'stderrHash'>>): Promise<boolean>;
  listReviewsByAttempt(attemptId: string): Promise<ReviewRecord[]>;
  listReviewsByTask(taskId: string): Promise<ReviewRecord[]>;

  // Integration batch operations
  createIntegrationBatch(input: CreateIntegrationBatchInput): Promise<IntegrationBatchRecord>;
  getIntegrationBatch(batchId: string): Promise<IntegrationBatchRecord | null>;
  updateIntegrationBatch(batchId: string, updates: Partial<Pick<IntegrationBatchRecord, 'status' | 'baseCommit' | 'mergeCommitHash' | 'targetMergeCommit' | 'conflictsJson' | 'finishedAt' | 'reviewedThroughCommit' | 'finalCommit' | 'reviewCoverageStatus' | 'reviewerUnavailable' | 'reviewMetadataJson'>>): Promise<boolean>;
  listIntegrationBatches(stageId: string): Promise<IntegrationBatchRecord[]>;

  // Event operations
  createEvent(input: CreateEventInput): Promise<EventRecord>;
  listEvents(runId: string, eventType?: string): Promise<EventRecord[]>;

  // ── M3 Resource sampling operations ──
  /** Insert a resource sample record */
  insertResourceSample(input: CreateResourceSampleInput): Promise<ResourceSampleRecord>;
  /** Get recent resource samples (last N) */
  getRecentResourceSamples(limit?: number): Promise<ResourceSampleRecord[]>;
  /** Clean up resource samples older than retentionDays */
  cleanupResourceSamples(retentionDays?: number): Promise<number>;

  // ── M3 Dispatch decision operations ──
  /** Insert a dispatch decision record */
  insertDispatchDecision(input: CreateDispatchDecisionInput): Promise<DispatchDecisionRecord>;
  /** Get recent dispatch decisions (last N) */
  getRecentDispatchDecisions(limit?: number): Promise<DispatchDecisionRecord[]>;

  // ── M4 Governance operations ──

  // Approval decisions
  createApprovalDecision(input: CreateApprovalDecisionInput): Promise<ApprovalDecision>;
  getApprovalDecision(id: string): Promise<ApprovalDecision | null>;
  updateApprovalDecisionStatus(id: string, status: string, updatedAt: string): Promise<boolean>;
  listApprovalDecisions(runId: string, status?: string): Promise<ApprovalDecision[]>;
  getPendingApprovals(runId: string): Promise<ApprovalDecision[]>;

  // Token ledger
  insertTokenLedgerEntry(input: CreateTokenLedgerEntryInput): Promise<TokenLedgerEntry>;
  /** Update an existing ledger entry — used for estimated → confirmed/unavailable transitions */
  updateTokenLedgerEntry(id: string, updates: Partial<Pick<TokenLedgerEntry, 'status' | 'actualTotal' | 'actualInput' | 'actualOutput' | 'actualCacheHit' | 'model' | 'durationMs'>>): Promise<boolean>;
  getTokenLedgerEntry(id: string): Promise<TokenLedgerEntry | null>;
  listTokenLedgerEntries(runId: string, callType?: string): Promise<TokenLedgerEntry[]>;
  getTokenUsageSummary(runId: string): Promise<TokenUsageSummary>;
  reserveCost?(input: CreateCostReservationInput): Promise<CostReservationResult>;
  settleCostReservation?(id: string, actualCost: number | null): Promise<boolean>;
  markCostReservationSpawned?(id: string, ownerId: string, spawnedAt: string): Promise<boolean>;
  heartbeatCostReservation?(id: string, ownerId: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean>;
  finalizeCostReservation?(input: FinalizeCostReservationInput): Promise<boolean>;
  /** Manual, explicit, auditable write-off of an `unavailable` reservation. */
  writeOffCostReservation?(input: WriteOffCostReservationInput): Promise<boolean>;
  reconcileStaleCostReservations?(runId: string, now: string): Promise<number>;
  listCostReservations?(runId: string): Promise<CostReservation[]>;

  // B (authorized): persistent guard block-probe cache (keyed by full Pi CLI version)
  getGuardProbeCache?(piVersion: string): Promise<{ outcome: string; failureCategory: string | null; checkedAt: string } | null>;
  setGuardProbeCache?(piVersion: string, outcome: string, failureCategory: string | null, checkedAt: string): Promise<void>;

  // Budget policies
  createBudgetPolicy(input: CreateBudgetPolicyInput): Promise<BudgetPolicy>;
  getBudgetPolicy(id: string): Promise<BudgetPolicy | null>;
  updateBudgetPolicy(id: string, tokenLimit: number, action: string): Promise<boolean>;
  listBudgetPolicies(runId?: string | null): Promise<BudgetPolicy[]>;
  getEffectiveBudgetPolicy(policyType: string, runId?: string | null): Promise<BudgetPolicy | null>;

  // Risk assessments
  createRiskAssessment(input: CreateRiskAssessmentInput): Promise<RiskAssessment>;
  getRiskAssessment(id: string): Promise<RiskAssessment | null>;
  resolveRiskAssessment(id: string, resolvedAt: string): Promise<boolean>;
  listRiskAssessments(runId: string): Promise<RiskAssessment[]>;

  // ── M5 Reconciliation operations ──
  /** Insert a reconciliation report (only by explicit reconcile --apply) */
  insertReconciliationReport(input: CreateReconciliationReportInput): Promise<ReconciliationReportRecord>;
  /** Get the most recent applied reconciliation report for a run */
  getLatestReconciliationReport(runId: string): Promise<ReconciliationReportRecord | null>;
  /** Insert a reconciliation finding (associated with a report) */
  insertReconciliationFinding(input: CreateReconciliationFindingInput): Promise<ReconciliationFindingRecord>;
  /** List reconciliation findings for a report */
  listReconciliationFindings(reportId: string): Promise<ReconciliationFindingRecord[]>;
  /** List all reconciliation reports for a run */
  listReconciliationReports(runId: string): Promise<ReconciliationReportRecord[]>;
  /** Get all non-terminal runs (for no-arg reconcile) */
  listNonTerminalRuns(): Promise<RunRecord[]>;
  /** Get all reviews for a task (needed by applicator for review state convergence) */
  listReviewsByTask(taskId: string): Promise<import('../types/m2-types.js').ReviewRecord[]>;
  /** Get all reviews for an attempt */
  listReviewsByAttempt(attemptId: string): Promise<import('../types/m2-types.js').ReviewRecord[]>;

  /**
   * Atomic reconciliation apply: executes all safe actions, persists report/findings/events
   * in a single SQLite transaction. All-or-nothing rollback on failure.
   */
  applyReconciliationAtomically(input: AtomicApplyInput): Promise<AtomicApplyResult>;
}

export type StateQueryStore = Pick<StateStore,
  | 'close'
  | 'getRun'
  | 'getTask'
  | 'listTasks'
  | 'listTasksByStage'
  | 'getStage'
  | 'listStages'
  | 'getAttempt'
  | 'listAttempts'
  | 'listAttemptsByStage'
  | 'getLatestAttempt'
  | 'getPathLock'
  | 'getActiveLocksForRun'
  | 'listReviewsByAttempt'
  | 'listReviewsByTask'
  | 'getIntegrationBatch'
  | 'listIntegrationBatches'
  | 'listEvents'
  | 'getPendingApprovals'
  | 'listCostReservations'
>;

// ══════════════════════════════════════════════════════════════
// M3 Input Types
// ══════════════════════════════════════════════════════════════

export interface CreateResourceSampleInput {
  id: string;
  runId?: string | null;
  timestamp: string;
  cpuPct: number;
  memTotalMb?: number | null;
  memUsedMb?: number | null;
  memPct?: number | null;
  piActive: number;
  budget: number;
  dispatchPaused?: number;
  pauseReason?: string | null;
  degraded?: number;
  degradeReason?: string | null;
  source: string;
}

export interface CreateDispatchDecisionInput {
  id: string;
  runId?: string | null;
  timestamp: string;
  decisionType: string;
  reason: string;
  previousBudget: number;
  newBudget: number;
  sampleJson?: string | null;
}

// ══════════════════════════════════════════════════════════════
// M4 Governance Input Types
// ══════════════════════════════════════════════════════════════

export interface CreateApprovalDecisionInput {
  id: string;
  runId: string;
  gate: string;
  decisionType: string;
  scope: string;
  status?: string;
  approvedBy?: string;
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateTokenLedgerEntryInput {
  id: string;
  runId: string;
  stageId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  callType: string;
  callId: string;
  estimatedTotal?: number | null;
  estimatedInput?: number | null;
  estimatedOutput?: number | null;
  actualTotal?: number | null;
  actualInput?: number | null;
  actualOutput?: number | null;
  actualCacheHit?: number | null;
  promptHash?: string | null;
  model?: string | null;
  durationMs?: number | null;
  isSynthetic?: boolean;
  status?: string;
}

export interface CreateCostReservationInput {
  id: string;
  runId: string;
  stageId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  callType: string;
  callId: string;
  currency: 'CNY' | 'USD';
  budgetLimit: number;
  reservedCost: number;
  pricingVersion: string;
  ownerId?: string | null;
  leaseExpiresAt?: string | null;
  heartbeatAt?: string | null;
}

export interface FinalizeCostReservationInput {
  id: string;
  outcome: 'released' | 'confirmed' | 'unavailable';
  actualCost?: number | null;
  ownerId?: string | null;
  terminationEvidence: string;
  settledAt?: string;
}

export interface WriteOffCostReservationInput {
  id: string;
  /** Mandatory auditable reason. Missing/blank → fail closed. */
  decisionNote: string;
  ownerId?: string | null;
  writtenOffAt?: string;
}

export interface CostReservationResult {
  allowed: boolean;
  reservation: CostReservation | null;
  committedCost: number;
  remaining: number;
  reason?: string;
}

export interface CreateBudgetPolicyInput {
  id: string;
  runId?: string | null;
  scope: string;
  policyType: string;
  tokenLimit: number;
  actionOnExceed?: string;
}

export interface CreateRiskAssessmentInput {
  id: string;
  runId: string;
  stageId?: string | null;
  assessmentType: string;
  riskLevel: string;
  findingsJson?: string | null;
  trigger?: string;
}

export interface TokenUsageSummary {
  codexPlan: { estimated: number; actual: number };
  codexReview: { estimated: number; actual: number };
  piWorker: { estimated: number; actual: number };
  totalEstimated: number;
  totalActual: number;
}

// ══════════════════════════════════════════════════════════════
// M5 Atomic Apply Input/Output Types
// ══════════════════════════════════════════════════════════════

export interface AtomicApplyInput {
  reportId: string;
  runId: string;
  reportInput: CreateReconciliationReportInput;
  findingInputs: CreateReconciliationFindingInput[];
  eventInputs: CreateEventInput[];
  /** Actions to execute; each must be idempotent-safe */
  actions: AtomicAction[];
}

export interface AtomicAction {
  actionType: string;
  targetEntityId: string;
  metadata: Record<string, unknown>;
}

export interface AtomicApplyResult {
  reportRecord: ReconciliationReportRecord;
  findingRecords: ReconciliationFindingRecord[];
  eventRecords: EventRecord[];
  appliedActions: { actionType: string; targetEntityId: string; success: boolean; error?: string }[];
  appliedCount: number;
  skippedCount: number;
}

export interface AcquirePathLocksInput {
  runId: string;
  taskId: string;
  filePaths: string[];
  lockType?: 'exclusive' | 'shared';
}

export interface AcquirePathLocksResult {
  acquired: boolean;
  locks: PathLockRecord[];
  conflicts: PathLockRecord[];
  violations: string[];
}

export interface ClaimActualPathsInput {
  runId: string;
  stageId: string;
  taskId: string;
  attemptId: string;
  filePaths: string[];
}

export interface ActualPathConflict {
  conflictingTaskId: string;
  conflictingAttemptId: string | null;
  candidatePath: string;
  conflictingPath: string;
  conflictLayer: 'estimated' | 'actual';
}

export interface ClaimActualPathsResult {
  claimed: boolean;
  claims: ActualPathClaimRecord[];
  conflicts: ActualPathConflict[];
  violations: string[];
}

export interface CreateAttemptProvenanceInput {
  attemptId: string;
  runId: string;
  stageId: string;
  taskId: string;
  baseCommit: string;
  expectedBranch: string;
  expectedWorktree: string;
  taskPacketHash: string;
  implementationPromptHash: string;
  workerId: string;
  sessionId: string;
}
