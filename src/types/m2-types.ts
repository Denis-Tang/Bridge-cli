// ── M2 Stage Concurrency Types ───────────────────────────────────────────

import type { WorkerResult, ReviewResult } from './protocol.js';

// ── Execution Mode ───────────────────────────────────────────────────────
export type ExecutionMode = 'default' | 'simple' | 'token-efficient';

// ── Token-Efficient Task Packet ───────────────────────────────────────────
export interface TaskContextFileSummary {
  path: string;
  hash: string;
  summary: string;
  size: number;
}

export interface MinimalTaskPacket {
  taskId: string;
  title: string;
  goal: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  contextFilesSummary: TaskContextFileSummary[];
  dependencyHash: string;
  dependencySummary: string;
  acceptanceCommands: string[];
  outputFormat: 'worker_result_json';
  riskLevel: 'low' | 'medium' | 'high';
  heavyCommandSlotsRequired: number;
  timeoutSeconds: number;
}

export interface RetryPacket {
  originalTaskId: string;
  previousAttemptNumber: number;
  failureSummary: string;
  findings: string[];
  diffDelta: string;
  repairGoal: string;
}

export interface StageReviewInput {
  stageId: string;
  stageNumber: number;
  aggregatedDiff: string;
  taskIds: string[];
  qualityGateResults: Array<{ taskId: string; passed: boolean; summary: string }>;
}

export interface ReviewCacheEntry {
  cacheKey: string;
  result: ReviewResult;
  createdAt: string;
}

// ── Stage Status ─────────────────────────────────────────────────────────
export type StageStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'integration'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'canceled';

// ── Attempt Status ───────────────────────────────────────────────────────
export type AttemptStatus =
  | 'pending'
  | 'running'
  | 'worker_completed'
  | 'validating'
  | 'reviewing'
  | 'review_skipped'
  | 'approved'
  | 'rework_required'
  | 'failed'
  | 'interrupted'
  | 'canceled';

// ── Lock Type ────────────────────────────────────────────────────────────
export type LockType = 'exclusive' | 'shared';

// ── Lock Status ──────────────────────────────────────────────────────────
export type LockStatus = 'locked' | 'released';

// ── Review Status ────────────────────────────────────────────────────────
export type ReviewStatus =
  | 'pending'
  | 'running'
  | 'approved'
  | 'rework_required'
  | 'failed'
  | 'skipped';

// ── Integration Status ───────────────────────────────────────────────────
export type IntegrationStatus =
  | 'pending'
  | 'integrating'
  | 'completed'
  | 'conflict'
  | 'failed';

// ── Event Types ──────────────────────────────────────────────────────────
export type EventType =
  | 'run_created'
  | 'run_approved'
  | 'run_canceled'
  | 'stage_started'
  | 'stage_completed'
  | 'stage_paused'
  | 'stage_failed'
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'attempt_started'
  | 'attempt_completed'
  | 'attempt_interrupted'
  | 'attempt_failed'
  | 'review_started'
  | 'review_completed'
  | 'review_failed'
  | 'review_skipped_token_efficient'
  | 'review_cache_hit'
  | 'review_cache_miss'
  | 'stage_review_started'
  | 'stage_review_completed'
  | 'stage_review_failed'
  | 'mode_selection'
  | 'integration_started'
  | 'integration_completed'
  | 'integration_conflict'
  | 'path_lock_acquired'
  | 'path_lock_released'
  | 'plan_created'
  | 'plan_approved'
  | 'run_resumed'
  | 'error';

// ── Structured Plan ──────────────────────────────────────────────────────
export interface StructuredStage {
  stageNumber: number;
  title: string;
  tasks: string[];
}

export interface StructuredPlan {
  jobId: string;
  summary: string;
  stages: StructuredStage[];
  tasks: StructuredTaskSpec[];
  riskAssessment: {
    level: 'low' | 'medium' | 'high';
    notes: string[];
  };
}

export interface StructuredTaskSpec {
  taskId: string;
  stageNumber: number;
  title: string;
  goal: string;
  dependencies: string[];
  estimatedWritePaths: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  contextFiles: string[];
  acceptanceChecks: string[];
  allowedCommands: string[];
  riskLevel: 'low' | 'medium' | 'high';
  productDecisionsLocked: boolean;
  expectedOutputs: string[];
  heavyCommandSlotsRequired: number;
  timeoutSeconds: number;
}

// ── Stage Record ─────────────────────────────────────────────────────────
export interface StageRecord {
  id: string;
  runId: string;
  stageNumber: number;
  title: string;
  status: StageStatus;
  baseCommit: string | null;
  integrationBranch: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateStageInput {
  id: string;
  runId: string;
  stageNumber: number;
  title: string;
  status?: StageStatus;
  baseCommit?: string | null;
  integrationBranch?: string | null;
}

// ── Attempt Record ───────────────────────────────────────────────────────
export interface AttemptRecord {
  id: string;
  taskId: string;
  stageId: string;
  attemptNumber: number;
  status: AttemptStatus;
  piPid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  worktreePath: string | null;
  branchName: string | null;
  promptHash: string | null;
  workerResultJson: string | null;
  /** Encrypted worker result (JSON-serialized EncryptedPayload), if privacy-enabled */
  encryptedWorkerResultJson?: string | null;
  exitReason: string | null;
  logPath: string | null;
  rawLogPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAttemptInput {
  id: string;
  taskId: string;
  stageId: string;
  attemptNumber: number;
  status?: AttemptStatus;
}

// ── PathLock Record ──────────────────────────────────────────────────────
export interface PathLockRecord {
  id: string;
  runId: string;
  taskId: string;
  filePath: string;
  lockType: LockType;
  status: LockStatus;
  acquiredAt: string;
  releasedAt: string | null;
}

export interface CreatePathLockInput {
  id: string;
  runId: string;
  taskId: string;
  filePath: string;
  lockType?: LockType;
}

// ── Review Record ────────────────────────────────────────────────────────
export interface ReviewRecord {
  id: string;
  attemptId: string;
  taskId: string;
  reviewerType: string;
  status: ReviewStatus;
  reviewJson: string | null;
  findingsJson: string | null;
  requiredReworkJson: string | null;
  reworkCount: number;
  mergeAllowed: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface CreateReviewInput {
  id: string;
  attemptId: string;
  taskId: string;
  reviewerType: string;
  status?: ReviewStatus;
}

// ── IntegrationBatch Record ──────────────────────────────────────────────
export interface IntegrationBatchRecord {
  id: string;
  stageId: string;
  runId: string;
  status: IntegrationStatus;
  integrationBranch: string;
  baseCommit: string | null;
  mergeCommitHash: string | null;
  /** 最终合并到目标分支的 commit hash */
  targetMergeCommit: string | null;
  conflictsJson: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface CreateIntegrationBatchInput {
  id: string;
  stageId: string;
  runId: string;
  integrationBranch: string;
}

// ── Event Record ─────────────────────────────────────────────────────────
export interface EventRecord {
  id: string;
  runId: string;
  stageId: string | null;
  taskId: string | null;
  attemptId: string | null;
  eventType: string;
  eventDataJson: string | null;
  createdAt: string;
}

export interface CreateEventInput {
  id: string;
  runId: string;
  stageId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  eventType: string;
  eventData?: Record<string, unknown> | null;
}
