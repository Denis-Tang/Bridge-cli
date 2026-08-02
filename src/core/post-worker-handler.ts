import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexCliReviewer } from '../adapters/codex-cli-reviewer.js';
import type { CodexProcessRunner } from '../adapters/codex-process-runner.js';
import { LocalRuleReviewer } from '../adapters/local-rule-reviewer.js';
import type { ReviewerConfig } from '../adapters/project-adapter.js';
import { DiffScopeValidator } from '../git/diff-scope-validator.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import type { PrivacyService } from '../privacy/privacy-service.js';
import { QualityGateRunner, type QualityGateConfig } from '../quality/quality-gate-runner.js';
import type { StateStore, ReviewRetryInput } from '../state/state-store.js';
import type { ReviewStatus, StageRecord, StructuredTaskSpec } from '../types/m2-types.js';
import type { ReviewResult, WorkerResult } from '../types/protocol.js';
import { createG2Approval } from './decision-gate.js';
import { isTokenEfficientMode, type ExecutionModeConfig } from './execution-mode.js';
import { shouldDoTaskLevelReview } from './review-granularity.js';
import { checkScopeExpansion } from './scope-guard.js';
import { startCostReservationHeartbeat, stopCostReservationHeartbeat } from './cost-heartbeat.js';
import type {
  ProviderCostGate,
  ProviderCostRequest,
  StagePauseRequest,
} from './stage-integration.js';
import { postCheckBudget } from './token-budget.js';
import { SqliteLedgerSink, type InvocationContext } from './token-telemetry.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface PostWorkerConfig {
  projectRoot: string;
  sessionDir: string;
  allowRealWorker: boolean;
  allowRealReviewer: boolean;
  governanceEnabled?: boolean;
  qualityGates?: QualityGateConfig[];
  taskQualityGates?: QualityGateConfig[];
  reviewerConfig?: ReviewerConfig;
  fakeReviewResult?: ReviewResult;
  privacyService?: PrivacyService;
  codexProcessRunner?: CodexProcessRunner;
  /** R2: lease window basis for cost-reservation heartbeats (default 180000). */
  workerTimeoutMs?: number;
  /** R2: cost reservation heartbeat interval (ms); default lease window / 3. */
  costReservationHeartbeatMs?: number;
}

export interface CostPauseRequest {
  runId: string;
  stageId: string;
  taskId?: string | null;
  attemptId?: string | null;
  provider: 'pi' | 'codex';
  reason: string;
  remaining?: number;
}

export interface CompletionEvidenceRequest {
  attemptId: string;
  taskId: string;
  stage: StageRecord;
  runId: string;
  workerResult: WorkerResult;
  branchName: string;
  changedFiles: string[];
  spec: StructuredTaskSpec;
  timestamp: string;
  worktreePath: string;
}

export interface PostWorkerHooks {
  nextEventId(runId: string, prefix: string): string;
  recordStagePause(input: StagePauseRequest): Promise<unknown>;
  reserveProviderCost(input: ProviderCostRequest): Promise<ProviderCostGate>;
  recordCostPause(input: CostPauseRequest): Promise<void>;
  retryReviewFromWorkerCompleted(input: ReviewRetryInput): Promise<void>;
  claimActualPathsOrPause(
    runId: string,
    stageId: string,
    taskId: string,
    attemptId: string,
    changedFiles: string[],
  ): Promise<boolean>;
  stopIfCanceled(
    runId: string,
    stageId: string,
    taskId: string | null,
    attemptId: string | null,
    checkpoint: string,
  ): Promise<boolean>;
  releaseLocks(taskId: string, runId: string): Promise<void>;
  getAbortSignal(): AbortSignal | undefined;
}

export interface PostWorkerInput {
  source: 'fresh' | 'resume';
  runId: string;
  stage: StageRecord;
  taskId: string;
  attemptId: string;
  spec: StructuredTaskSpec;
  workerResult: WorkerResult;
  branchName: string;
  worktreePath: string;
  reviewBase: string;
  changedFiles: string[];
  scopeValidator: DiffScopeValidator;
  worktreeManager: WorktreeManager;
  timestamp: string;
  effectiveAllowedPaths?: string[];
  recoveryExpansionApproved?: boolean;
}

/**
 * Owns the single post-worker state machine shared by fresh execution and
 * worker_completed recovery. Spawn/provenance and recovery-adoption proof stay
 * in the scheduler; everything from scope validation onward converges here.
 */
export class PostWorkerHandler {
  constructor(
    private readonly store: StateStore,
    private readonly config: PostWorkerConfig,
    private readonly modeConfig: ExecutionModeConfig,
    private readonly hooks: PostWorkerHooks,
  ) {}

  private checkpoint(base: string, source: PostWorkerInput['source']): string {
    return source === 'resume' ? `${base}_resume` : base;
  }

  private async release(input: PostWorkerInput): Promise<void> {
    await this.hooks.releaseLocks(input.taskId, input.runId);
  }

  private async blockUnverifiableCompletion(
    input: PostWorkerInput,
    reason: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.store.updateAttemptStatus(input.attemptId, 'failed', input.timestamp);
    await this.store.updateTaskStatus(input.taskId, 'waiting_decision', input.timestamp);
    await this.store.updateAttemptResult(input.attemptId, { exitReason: reason, stoppedAt: input.timestamp });
    await this.store.createEvent({
      id: this.hooks.nextEventId(input.runId, 'ev-unverifiable-completion'),
      runId: input.runId,
      stageId: input.stage.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      eventType: 'attempt_failed',
      eventData: { reason, ...detail },
    });
    await this.hooks.recordStagePause({
      runId: input.runId,
      stageId: input.stage.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      reasonCode: reason,
      category: 'quality',
      eventData: detail,
      createdAt: input.timestamp,
    });
    console.log('[Scheduler] Completion evidence rejected for attempt ' + input.attemptId + ': ' + reason + '.');
  }

  private async verifyCompletionEvidence(input: PostWorkerInput): Promise<boolean> {
    if (!this.config.allowRealWorker && !this.config.allowRealReviewer) return true;

    const expected = input.spec.estimatedWritePaths || [];
    const touchesExpectedPath = expected.some((expectedPath) => input.changedFiles.some((changedPath) =>
      changedPath === expectedPath || changedPath.startsWith(expectedPath.endsWith('/') ? expectedPath : expectedPath + '/'),
    ));
    const hasExpectedPath = input.workerResult.status === 'completed'
      && Boolean(input.branchName)
      && input.changedFiles.length > 0
      && touchesExpectedPath;
    if (hasExpectedPath) return true;

    if (input.workerResult.status === 'completed'
      && Boolean(input.branchName)
      && input.changedFiles.length > 0
      && !touchesExpectedPath
      && input.changedFiles.every((filePath) => existsSync(resolve(input.worktreePath, filePath)))) {
      console.log('[Scheduler] Completion evidence accepted via file-existence fallback (P0-BENCH-02).');
      return true;
    }

    const reason = input.workerResult.status !== 'completed'
      ? 'worker_result_not_completed'
      : input.changedFiles.length === 0
        ? 'worker_completed_without_verifiable_diff'
        : !touchesExpectedPath
          ? 'expected_write_missing'
          : 'worker_completion_evidence_missing';
    await this.blockUnverifiableCompletion(input, reason, {
      branchName: Boolean(input.branchName),
      changedFileCount: input.changedFiles.length,
      expectedWritePathCount: expected.length,
    });
    return false;
  }

  private async validateScopeAndClaims(input: PostWorkerInput): Promise<boolean> {
    const allowedPaths = input.effectiveAllowedPaths ?? input.spec.allowedPaths ?? [];
    const scope = input.scopeValidator.validate(
      input.changedFiles,
      allowedPaths,
      input.spec.forbiddenPaths || [],
      this.config.projectRoot,
    );
    if (!scope.valid || scope.violations.length > 0) {
      await this.store.updateAttemptStatus(input.attemptId, 'failed', input.timestamp);
      await this.store.updateTaskStatus(input.taskId, 'waiting_decision', input.timestamp);
      await this.store.updateAttemptResult(input.attemptId, { exitReason: 'scope: ' + scope.violations.join('; ') });
      if (input.source === 'fresh') {
        await this.store.createEvent({
          id: this.hooks.nextEventId(input.runId, 'ev-scope-violation'),
          runId: input.runId,
          stageId: input.stage.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          eventType: 'attempt_failed',
          eventData: { reason: 'scope_violation', violations: scope.violations, forbiddenFiles: scope.forbiddenFiles },
        });
        await this.hooks.recordStagePause({
          runId: input.runId,
          stageId: input.stage.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          reasonCode: 'scope_violation',
          category: 'scope',
          createdAt: input.timestamp,
        });
      }
      await this.release(input);
      return false;
    }

    if (!await this.verifyCompletionEvidence(input)) {
      await this.release(input);
      return false;
    }

    if (this.config.governanceEnabled && input.changedFiles.length > 0) {
      const expansion = checkScopeExpansion(
        input.changedFiles,
        input.spec.estimatedWritePaths || ['src/'],
        input.spec.allowedPaths || [],
      );
      if (expansion.expanded && !input.recoveryExpansionApproved) {
        const decision = await createG2Approval(
          this.store,
          input.runId,
          input.taskId,
          'scope_expansion',
          `Scope expansion: ${(expansion.expansionPct * 100).toFixed(1)}% outside estimate`,
        );
        await this.store.createEvent({
          id: this.hooks.nextEventId(input.runId, 'ev-scope'),
          runId: input.runId,
          stageId: input.stage.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          eventType: 'scope_expansion',
          eventData: {
            taskId: input.taskId,
            expansionPct: expansion.expansionPct,
            expandedCount: expansion.expandedFiles.length,
          },
        });
        await this.store.updateAttemptStatus(input.attemptId, 'rework_required', input.timestamp);
        await this.store.updateTaskStatus(input.taskId, 'waiting_decision', input.timestamp);
        await this.hooks.recordStagePause({
          runId: input.runId,
          stageId: input.stage.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          reasonCode: 'scope_expansion',
          category: 'scope',
          requiredApprovalType: 'scope_expansion',
          decisionId: decision.id,
          eventData: {
            expansionPct: expansion.expansionPct,
            expandedCount: expansion.expandedFiles.length,
          },
          createdAt: input.timestamp,
        });
        await this.release(input);
        return false;
      }
    }

    if (!await this.hooks.claimActualPathsOrPause(
      input.runId,
      input.stage.id,
      input.taskId,
      input.attemptId,
      input.changedFiles,
    )) {
      await this.release(input);
      return false;
    }
    return true;
  }

  private async runQualityGates(input: PostWorkerInput): Promise<boolean> {
    if (await this.hooks.stopIfCanceled(
      input.runId,
      input.stage.id,
      input.taskId,
      input.attemptId,
      this.checkpoint('before_quality_gate', input.source),
    )) {
      await this.release(input);
      return false;
    }

    await this.store.updateAttemptStatus(input.attemptId, 'validating', input.timestamp);
    await this.store.updateTaskStatus(input.taskId, 'validating', input.timestamp);
    const gates = this.config.taskQualityGates ?? this.config.qualityGates ?? [];
    if (gates.length === 0) {
      console.log('[Scheduler] FATAL: No quality gates configured for task ' + input.taskId + '.');
      await this.store.createEvent({
        id: input.runId + '-ev-nogate-' + Date.now(),
        runId: input.runId,
        stageId: input.stage.id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        eventType: 'error',
        eventData: { reason: 'no_quality_gates_configured', fatal: true },
      });
      await this.store.updateAttemptStatus(input.attemptId, 'failed', input.timestamp);
      await this.store.updateTaskStatus(input.taskId, 'waiting_decision', input.timestamp);
      await this.store.updateAttemptResult(input.attemptId, { exitReason: 'no_quality_gates_configured' });
      await this.hooks.recordStagePause({
        runId: input.runId,
        stageId: input.stage.id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        reasonCode: 'no_quality_gates_configured',
        category: 'quality',
        createdAt: input.timestamp,
      });
      await this.release(input);
      return false;
    }

    const startedAt = Date.now();
    const result = await new QualityGateRunner(input.worktreePath).runGates(gates, true);
    await this.store.createEvent({
      id: input.runId + '-ev-qg-' + Date.now(),
      runId: input.runId,
      stageId: input.stage.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      eventType: 'review_completed',
      eventData: {
        kind: 'quality_gate',
        passed: result.passed,
        summary: result.summary,
        results: result.results,
        durationMs: Date.now() - startedAt,
      },
    });
    if (result.passed) return true;

    await this.store.updateAttemptStatus(input.attemptId, 'failed', input.timestamp);
    await this.store.updateTaskStatus(input.taskId, 'rework_required', input.timestamp);
    await this.store.updateAttemptResult(input.attemptId, { exitReason: 'qg_failed: ' + result.summary });
    await this.release(input);
    return false;
  }

  private async skipTokenEfficientReview(input: PostWorkerInput): Promise<boolean> {
    const attemptNumber = (await this.store.getLatestAttempt(input.taskId))?.attemptNumber ?? 1;
    const isRetry = attemptNumber > 1;
    if (!isTokenEfficientMode(this.modeConfig.mode)
      || shouldDoTaskLevelReview(input.spec, input.workerResult, true, this.modeConfig.mode, isRetry)) {
      return false;
    }

    await this.store.updateAttemptStatus(input.attemptId, 'review_skipped', input.timestamp);
    await this.store.updateTaskStatus(input.taskId, 'review_skipped', input.timestamp);
    await this.store.createEvent({
      id: this.hooks.nextEventId(input.runId, 'ev-review-skipped'),
      runId: input.runId,
      stageId: input.stage.id,
      taskId: input.taskId,
      attemptId: input.attemptId,
      eventType: 'review_skipped_token_efficient',
      eventData: { reason: 'token_efficient_mode', mode: this.modeConfig.mode, riskLevel: input.spec.riskLevel },
    });
    console.log('[Scheduler] Token-efficient: skipped per-task Codex review for ' + input.taskId + ' (risk=' + input.spec.riskLevel + ')');

    if (this.config.governanceEnabled) {
      const sink = new SqliteLedgerSink(this.store);
      const context: InvocationContext = {
        runId: input.runId,
        stageId: input.stage.id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        callType: 'codex_review_skipped',
        callId: input.attemptId + '-skipped',
        model: 'none',
        synthetic: false,
      };
      await sink.writeEstimate(context, 0, 0, 0);
      await sink.confirmActual(input.attemptId + '-skipped', 0, 0, 0, 0, 0);
    }
    await this.release(input);
    return true;
  }

  private reviewRecordStatus(result: ReviewResult): ReviewStatus {
    if (result.reviewerUnavailable) return 'failed';
    if (result.status === 'approved') return 'approved';
    return 'rework_required';
  }

  private async runReview(input: PostWorkerInput): Promise<void> {
    if (await this.hooks.stopIfCanceled(
      input.runId,
      input.stage.id,
      input.taskId,
      input.attemptId,
      this.checkpoint('before_review', input.source),
    )) {
      await this.release(input);
      return;
    }
    if (await this.skipTokenEfficientReview(input)) return;

    await this.store.updateAttemptStatus(input.attemptId, 'reviewing', input.timestamp);
    await this.store.updateTaskStatus(input.taskId, 'reviewing', input.timestamp);
    const diff = input.worktreeManager.getDiff(input.worktreePath, input.reviewBase);
    const reviewerType = this.config.reviewerConfig?.type || 'codex-cli';
    const sourceTag = input.source === 'resume' ? '-resume' : '';
    const review = await this.store.createReview({
      id: input.runId + '-rv-' + input.attemptId + sourceTag + '-' + Date.now(),
      attemptId: input.attemptId,
      taskId: input.taskId,
      reviewerType,
      status: 'running',
    });

    let ledgerSink: SqliteLedgerSink | null = null;
    let invocationContext: InvocationContext | null = null;
    if (this.config.governanceEnabled) {
      ledgerSink = new SqliteLedgerSink(this.store);
      invocationContext = {
        runId: input.runId,
        stageId: input.stage.id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        callType: 'codex_review',
        callId: review.id,
        model: 'codex-cli',
      };
    }

    let result: ReviewResult;
    if (this.config.allowRealReviewer && (!diff || diff.trim().length === 0)) {
      await this.blockUnverifiableCompletion(input, 'real_reviewer_empty_diff');
      await this.store.updateReviewResult(review.id, {
        status: 'failed',
        reviewJson: JSON.stringify({
          taskId: input.taskId,
          status: 'rejected',
          reviewSummary: 'real reviewer blocked: empty diff',
          findings: ['real_reviewer_empty_diff'],
          requiredRework: [],
          qualityGateStatus: 'not_run',
          mergeAllowed: false,
          reviewer: 'codex-cli',
        }),
        findingsJson: JSON.stringify(['real_reviewer_empty_diff']),
        requiredReworkJson: '[]',
        mergeAllowed: false,
        finishedAt: new Date().toISOString(),
      });
      await this.release(input);
      return;
    } else if (this.config.allowRealReviewer) {
      const costGate = this.config.codexProcessRunner
        ? { allowed: true, reservationId: null, ownerId: null }
        : await this.hooks.reserveProviderCost({
          runId: input.runId,
          stageId: input.stage.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          callType: 'codex_review',
          callId: review.id,
          provider: 'codex',
        });
      if (!costGate.allowed) {
        const reason = costGate.reason || 'cost_budget_exceeded';
        await this.store.updateReviewResult(review.id, {
          status: 'failed', reviewerUnavailable: true, errorCategory: 'cost_gate',
          mergeAllowed: false, finishedAt: new Date().toISOString(),
        });
        await this.hooks.retryReviewFromWorkerCompleted({
          runId: input.runId, stageId: input.stage.id, taskId: input.taskId,
          attemptId: input.attemptId, reason, updatedAt: input.timestamp,
        });
        await this.store.updateAttemptResult(input.attemptId, { exitReason: 'reviewer_unavailable: ' + reason });
        await this.hooks.recordCostPause({
          runId: input.runId, stageId: input.stage.id, taskId: input.taskId,
          attemptId: input.attemptId, provider: 'codex', reason, remaining: costGate.remaining,
        });
        await this.release(input);
        return;
      }

      const reservationId = costGate.reservationId;
      if (this.config.privacyService) {
        const spawnGate = this.config.privacyService.canSpawnRealProvider();
        if (!spawnGate.allowed) {
          console.error('[Scheduler] Real Codex review spawn blocked: ' + spawnGate.reason);
          if (reservationId && this.store.finalizeCostReservation) {
            await this.store.finalizeCostReservation({
              id: reservationId,
              outcome: 'released',
              ownerId: costGate.ownerId,
              terminationEvidence: 'privacy_gate_blocked_before_spawn',
            });
          }
          await this.store.updateReviewResult(review.id, {
            status: 'failed', reviewerUnavailable: true, errorCategory: 'privacy_gate',
            mergeAllowed: false, finishedAt: new Date().toISOString(),
          });
          await this.hooks.retryReviewFromWorkerCompleted({
            runId: input.runId, stageId: input.stage.id, taskId: input.taskId,
            attemptId: input.attemptId, reason: 'privacy_gate_blocked', updatedAt: input.timestamp,
          });
          await this.store.updateAttemptResult(input.attemptId, {
            exitReason: 'reviewer_unavailable: privacy_gate_blocked',
            stoppedAt: input.timestamp,
          });
          await this.hooks.recordCostPause({
            runId: input.runId, stageId: input.stage.id, taskId: input.taskId,
            attemptId: input.attemptId, provider: 'codex', reason: 'privacy_gate_blocked',
          });
          await this.release(input);
          return;
        }
      }
      if (reservationId && this.store.markCostReservationSpawned) {
        await this.store.markCostReservationSpawned(reservationId, costGate.ownerId ?? '', new Date().toISOString());
      }
      // R2: refresh the one-shot lease while a long Codex review runs.
      const reviewHeartbeat = reservationId && this.store.heartbeatCostReservation
        ? startCostReservationHeartbeat({
            reservationId,
            ownerId: costGate.ownerId ?? '',
            workerTimeoutMs: this.config.workerTimeoutMs ?? 180_000,
            overrideIntervalMs: this.config.costReservationHeartbeatMs,
            heartbeat: (id, owner, at, lease) => this.store.heartbeatCostReservation!(id, owner, at, lease),
          })
        : null;
      try {
        result = await new CodexCliReviewer(
          {
            workDir: input.worktreePath,
            sessionDir: resolve(this.config.projectRoot, this.config.sessionDir),
            allowRealReview: true,
            timeoutMs: this.config.reviewerConfig?.timeoutMs ?? 120000,
            command: this.config.reviewerConfig?.command,
            args: this.config.reviewerConfig?.args,
            env: this.config.privacyService?.buildProviderEnv('codex'),
            signal: this.hooks.getAbortSignal(),
          },
          { processRunner: this.config.codexProcessRunner, ledgerSink, invocationContext },
        ).reviewDiff(diff, input.taskId);
      } finally {
        stopCostReservationHeartbeat(reviewHeartbeat);
        if (reservationId && this.store.finalizeCostReservation) {
          await this.store.finalizeCostReservation({
            id: reservationId,
            outcome: 'unavailable',
            ownerId: costGate.ownerId,
            terminationEvidence: input.source === 'resume'
              ? 'codex_resume_review_money_usage_unavailable'
              : 'codex_review_money_usage_unavailable',
          });
        }
      }
    } else {
      result = reviewerType === 'local-rule'
        ? new LocalRuleReviewer().reviewDiff(diff, input.taskId)
        : this.config.fakeReviewResult || {
          taskId: input.taskId,
          status: 'approved',
          reviewSummary: 'fake ok',
          findings: [],
          requiredRework: [],
          qualityGateStatus: 'passed',
          mergeAllowed: true,
          reviewer: reviewerType,
        };
      console.log('[Scheduler] Local/fake review mode: attempt ' + input.attemptId + ' using ' + reviewerType + '.');
    }

    await this.store.updateReviewResult(review.id, {
      status: this.reviewRecordStatus(result),
      reviewJson: JSON.stringify(result),
      findingsJson: JSON.stringify(result.findings || []),
      requiredReworkJson: JSON.stringify(result.requiredRework || []),
      mergeAllowed: result.mergeAllowed,
      finishedAt: new Date().toISOString(),
      reviewedThroughCommit: git(input.worktreePath, ['rev-parse', 'HEAD']),
      coverageStatus: result.reviewerUnavailable ? 'partial' : 'complete',
      reviewerUnavailable: result.reviewerUnavailable === true,
      errorCategory: result.executionMetadata?.errorCategory ?? null,
      exitCode: result.executionMetadata?.exitCode ?? null,
      durationMs: result.executionMetadata?.durationMs ?? null,
      stderrHash: result.executionMetadata?.stderrHash ?? null,
    });
    if (result.reviewerUnavailable) {
      await this.hooks.retryReviewFromWorkerCompleted({
        runId: input.runId,
        stageId: input.stage.id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        reason: 'reviewer_unavailable',
        updatedAt: new Date().toISOString(),
      });
      await this.store.updateAttemptResult(input.attemptId, {
        exitReason: 'reviewer_unavailable: ' + result.reviewSummary,
      });
      await this.hooks.recordCostPause({
        runId: input.runId,
        stageId: input.stage.id,
        taskId: input.taskId,
        attemptId: input.attemptId,
        provider: 'codex',
        reason: 'reviewer_unavailable',
      });
      await this.release(input);
      return;
    }

    if (await this.hooks.stopIfCanceled(
      input.runId,
      input.stage.id,
      input.taskId,
      input.attemptId,
      this.checkpoint('before_approve', input.source),
    )) {
      await this.release(input);
      return;
    }
    const finishedAt = new Date().toISOString();
    if (result.status === 'approved' && result.mergeAllowed) {
      await this.store.updateAttemptStatus(input.attemptId, 'approved', finishedAt);
      await this.store.updateTaskStatus(input.taskId, 'approved', finishedAt);
    } else {
      await this.store.updateAttemptStatus(input.attemptId, 'rework_required', finishedAt);
      await this.store.updateTaskStatus(input.taskId, 'rework_required', finishedAt);
      await this.store.updateAttemptResult(input.attemptId, { exitReason: 'review: ' + result.reviewSummary });
    }

    if (this.config.governanceEnabled && invocationContext) {
      const reviewTokens = diff ? diff.split('\n').length * 2 + 500 : 500;
      const postCheck = await postCheckBudget(this.store, input.runId, 'codex_review_stage', reviewTokens).catch(() => null);
      if (postCheck?.exceeded) {
        console.log('[Scheduler] Codex review budget exceeded for stage ' + input.stage.stageNumber + ': ' + postCheck.remaining + '/' + postCheck.limit);
        await this.store.createEvent({
          id: this.hooks.nextEventId(input.runId, 'ev-review-exceeded'),
          runId: input.runId,
          stageId: input.stage.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          eventType: 'token_budget_exceeded',
          eventData: { policyType: 'codex_review_stage', remaining: postCheck.remaining, limit: postCheck.limit },
        });
        await this.hooks.recordStagePause({
          runId: input.runId,
          stageId: input.stage.id,
          taskId: input.taskId,
          attemptId: input.attemptId,
          reasonCode: 'token_budget_exceeded',
          category: 'budget',
          requiredApprovalType: 'review_budget_override',
          eventData: { policyType: 'codex_review_stage' },
        });
      }
    }

    await this.release(input);
    if (input.source === 'resume') {
      console.log('[Scheduler] Resume complete for attempt ' + input.attemptId + ' (status: ' + (result.status === 'approved' ? 'approved' : 'rework_required') + ')');
    }
  }

  async handle(input: PostWorkerInput): Promise<void> {
    if (!await this.validateScopeAndClaims(input)) return;
    if (!await this.runQualityGates(input)) return;
    await this.runReview(input);
  }
}
