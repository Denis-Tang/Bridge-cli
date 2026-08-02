import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import type { StateStore } from '../state/state-store.js';
import type { AttemptRecord, PathLockRecord, StageRecord, StructuredTaskSpec } from '../types/m2-types.js';
import type { WorkerResult, ReviewResult } from '../types/protocol.js';
import type { ResourceSampler } from '../types/m3-types.js';
import type { CostBudgetConfig, CallType } from '../types/m4-types.js';
import { QUOTA_UNIT, QUOTA_PRICING_PLACEHOLDER } from '../types/m4-types.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import { DiffScopeValidator } from '../git/diff-scope-validator.js';
import type { QualityGateConfig } from '../quality/quality-gate-runner.js';
import { PiRpcWorker } from '../adapters/pi-rpc-worker.js';
import { CodexTechnicalClarifier } from '../adapters/codex-technical-clarifier.js';
import { PrivacyService } from '../privacy/privacy-service.js';
import type { PiWorkerConfig } from '../adapters/pi-worker-types.js';
import { NoopResourceSampler } from './resource-sampler.js';
import { BudgetTracker } from './budget-tracker.js';
export { ConvergenceTimeoutError } from './budget-tracker.js';
import { StageIntegrationCoordinator } from './stage-integration.js';
import { PostWorkerHandler } from './post-worker-handler.js';
import { startCostReservationHeartbeat, stopCostReservationHeartbeat } from './cost-heartbeat.js';
import type { WorkerConfig, ReviewerConfig } from '../adapters/project-adapter.js';
// ── M4 Governance imports ──
import { getGovernanceConfig, resetGovernanceConfigCache } from './decision-gate.js';
import { checkG2Approvable, checkG3Approvable, createG2Approval, createG3Approval } from './decision-gate.js';
import { checkScopeExpansion } from './scope-guard.js';
import { checkRetryBudget, shouldRetry, maxAllowedAttempts } from './retry-policy.js';
import { estimatePiWorkerTokens } from './token-ledger.js';
import { resolveExecutionMode, isTokenEfficientMode, type ExecutionModeConfig } from './execution-mode.js';
import { ReviewResultCache } from './review-cache.js';
import { assessStageReviewInputCoverage, runStageReview, prepareStageReviewInput, type StageReviewInputLimits } from './stage-review.js';
import { preCheckBudget, postCheckBudget, isBudgetPaused } from './token-budget.js';
import { ensureDefaultPolicies } from './budget-policy-store.js';
import { SqliteLedgerSink } from './token-telemetry.js';
import { buildMinimalTaskPacket, buildRetryPacket } from '../adapters/task-packet-builder.js';
import { buildPiWorkerMinimalPrompt, buildPiWorkerRetryPrompt, buildPiWorkerPrompt } from '../adapters/pi-worker-prompt.js';
import { pauseStage } from './pause-service.js';
import type { PauseCategory, PauseRecord } from '../types/pause-types.js';
import { runAutomaticReconciliation } from '../cli/commands/reconcile.js';
import { tasksHaveSerialOwnership } from './path-ownership.js';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function classifyPauseReason(
  reasonCode: string,
  eventData: Record<string, unknown> | undefined,
): { category: PauseCategory; requiredApprovalType: string | null } {
  const failureCategory = String(eventData?.failureCategory ?? '');
  if (reasonCode.includes('scope') || failureCategory === 'scope') {
    return { category: 'scope', requiredApprovalType: 'scope_expansion' };
  }
  if (reasonCode.includes('privacy') || failureCategory === 'privacy') {
    return { category: 'privacy', requiredApprovalType: 'privacy_override' };
  }
  if (reasonCode.includes('security') || failureCategory === 'security') {
    return { category: 'security', requiredApprovalType: 'security_override' };
  }
  if (reasonCode.includes('product_decision') || failureCategory === 'product_decision') {
    return { category: 'product_decision', requiredApprovalType: 'product_decision' };
  }
  if (reasonCode.includes('requirement') || failureCategory === 'requirement_choice') {
    return { category: 'requirement_choice', requiredApprovalType: 'requirement_choice' };
  }
  if (reasonCode.includes('budget') || reasonCode.includes('cost')) {
    return { category: 'budget', requiredApprovalType: 'run_budget' };
  }
  if (reasonCode.includes('reviewer') || reasonCode.includes('review_')) {
    return { category: 'reviewer', requiredApprovalType: null };
  }
  if (reasonCode.includes('integration') || reasonCode.includes('merge') || reasonCode.includes('conflict')) {
    return { category: 'integration', requiredApprovalType: null };
  }
  if (reasonCode.includes('recovery') || reasonCode.includes('resume_')) {
    return { category: 'recovery', requiredApprovalType: null };
  }
  if (reasonCode.includes('quality') || reasonCode.includes('gate')) {
    return { category: 'quality', requiredApprovalType: null };
  }
  if (reasonCode.includes('retry') || reasonCode.includes('exhausted')) {
    return { category: 'retry', requiredApprovalType: null };
  }
  return { category: 'transient', requiredApprovalType: null };
}


// ══════════════════════════════════════════════════════════════
// SchedulerConfig
// ══════════════════════════════════════════════════════════════

export interface SchedulerConfig {
  projectRoot: string;
  sessionDir: string;
  logDir: string;
  worktreeBaseDir: string;
  allowRealWorker: boolean;
  allowRealReviewer: boolean;
  workerTimeoutMs: number;
  maxParallelTasks: number;
  maxReworkCount: number;
  defaultLockedPaths: string[];
  /** 目标分支（run 创建时记录），集成后合并到此分支 */
  targetBranch: string;
  qualityGates?: QualityGateConfig[];
  taskQualityGates?: QualityGateConfig[];
  stageQualityGates?: QualityGateConfig[];
  workerConfig?: WorkerConfig;
  reviewerConfig?: ReviewerConfig;
  fakeWorkerResult?: WorkerResult;
  fakeReviewResult?: ReviewResult;
  // ── M3: Resource sampling ──
  resourceSamplingEnabled?: boolean;
  resourceSampler?: ResourceSampler;
  samplingIntervalMs?: number;
  // ── M4: Governance ──
  governanceEnabled?: boolean;
  /** Required whenever a real Provider is enabled. Calls reserve their declared worst-case cost before spawn. */
  costBudget?: CostBudgetConfig | null;
  // ── M4 v3: Injectable process runners for testing ──
  piProcessRunner?: import('../adapters/pi-worker-types.js').ProcessRunner;
  codexProcessRunner?: import('../adapters/codex-process-runner.js').CodexProcessRunner;
  /** Force the 95% clarification gate for an injected Pi runner. Real non-injected Pi defaults to true. */
  requireWorkerClarification?: boolean;
  cleanupMergedWorktrees?: boolean;
  /** P0-2: Privacy service for real Provider spawn gating and env allowlisting */
  privacyService?: PrivacyService;
  // ── Token-Efficient Mode ──
  executionMode?: import('../types/m2-types.js').ExecutionMode;
  reviewGranularity?: 'per-task' | 'stage-level';
  reviewCacheEnabled?: boolean;
  taskPacketMaxContextFiles?: number;
  taskPacketMaxContextChars?: number;
  /** Operational byte/line proxy ceilings; never reported as Provider tokens. */
  stageReviewInputLimits?: Partial<StageReviewInputLimits>;
  /** R2: cost reservation heartbeat interval (ms). Default: lease window / 3. Test-injectable. */
  costReservationHeartbeatMs?: number;
}

const DEFAULT_CONFIG: SchedulerConfig = {
  projectRoot: '', sessionDir: '.brainctl-dev/sessions', logDir: '.brainctl-dev/logs',
  worktreeBaseDir: '.brainctl-dev/worktrees', allowRealWorker: false, allowRealReviewer: false,
  workerTimeoutMs: 180000, maxParallelTasks: 4, maxReworkCount: 2,
  defaultLockedPaths: ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.gitignore', 'tsconfig.json'],
  targetBranch: '',
  qualityGates: [],
  resourceSamplingEnabled: false,
  samplingIntervalMs: 5000,
  cleanupMergedWorktrees: false,
  privacyService: undefined,
  executionMode: 'default',
  costBudget: null,
};

// ══════════════════════════════════════════════════════════════
// StageScheduler
// ══════════════════════════════════════════════════════════════

export class StageScheduler {
  private store: StateStore;
  private config: SchedulerConfig;
  private sampler: ResourceSampler;
  private running = false;
  private abortController: AbortController | null = null;
  private budgetTracker: BudgetTracker | null = null;
  private eventSeq = 0;
  private modeConfig: ExecutionModeConfig;
  private reviewCache: ReviewResultCache;
  private integrationCoordinator: StageIntegrationCoordinator;
  private postWorkerHandler: PostWorkerHandler;

  constructor(store: StateStore, config: Partial<SchedulerConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sampler = this.config.resourceSampler || new NoopResourceSampler();
    this.modeConfig = resolveExecutionMode(this.config);
    this.reviewCache = new ReviewResultCache({
      enabled: this.config.reviewCacheEnabled !== false,
    });
    this.integrationCoordinator = new StageIntegrationCoordinator(
      this.store,
      this.config,
      this.reviewCache,
      {
        nextEventId: (runId, prefix) => this.nextEventId(runId, prefix),
        recordStagePause: (input) => this.recordStagePause(input),
        reserveProviderCost: (input) => this.reserveProviderCost(input),
        stopIfCanceled: (runId, stageId, taskId, attemptId, checkpoint) =>
          this.stopIfCanceled(runId, stageId, taskId, attemptId, checkpoint),
        tasksForStage: (stage, runId) => this.tasksForStage(stage, runId),
        getAttemptDiffBase: (runId, attemptId, fallback) => this.getAttemptDiffBase(runId, attemptId, fallback),
        pathsOverlap: (left, right) => this.pathsOverlap(left, right),
        getAbortSignal: () => this.abortController?.signal,
      },
    );
    this.postWorkerHandler = new PostWorkerHandler(
      this.store,
      this.config,
      this.modeConfig,
      {
        nextEventId: (runId, prefix) => this.nextEventId(runId, prefix),
        recordStagePause: (input) => this.recordStagePause(input),
        reserveProviderCost: (input) => this.reserveProviderCost(input),
        recordCostPause: (input) => this.recordCostPause(input),
        retryReviewFromWorkerCompleted: (input) => this.retryReviewFromWorkerCompleted(input),
        claimActualPathsOrPause: (runId, stageId, taskId, attemptId, changedFiles) =>
          this.claimActualPathsOrPause(runId, stageId, taskId, attemptId, changedFiles),
        stopIfCanceled: (runId, stageId, taskId, attemptId, checkpoint) =>
          this.stopIfCanceled(runId, stageId, taskId, attemptId, checkpoint),
        releaseLocks: (taskId, runId) => this.releaseLocks(taskId, runId),
        getAbortSignal: () => this.abortController?.signal,
      },
    );
  }

  private nextEventId(runId: string, prefix: string): string {
    return `${runId}-${prefix}-${Date.now()}-${++this.eventSeq}`;
  }

  private async recordStagePause(input: {
    runId: string;
    stageId: string;
    reasonCode: string;
    category?: PauseCategory;
    recoverable?: boolean;
    requiredApprovalType?: string | null;
    decisionId?: string | null;
    taskId?: string | null;
    attemptId?: string | null;
    eventData?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<PauseRecord> {
    const active = await this.store.getActivePauseForStage(input.stageId);
    if (active) return active;

    const classified = classifyPauseReason(input.reasonCode, input.eventData);
    let decisionId = input.decisionId ?? null;
    const requiredApprovalType = input.requiredApprovalType !== undefined
      ? input.requiredApprovalType
      : input.category !== undefined
        ? null
        : classified.requiredApprovalType;
    if (requiredApprovalType && !decisionId) {
      const decisions = await this.store.listApprovalDecisions(input.runId);
      const matching = decisions.filter((decision) =>
        decision.decisionType === requiredApprovalType
        && (decision.status === 'pending' || decision.status === 'approved')
        && ((decision.metadata as { stageId?: string }).stageId === input.stageId
          || (input.taskId != null && (decision.metadata as { taskId?: string }).taskId === input.taskId)),
      );
      decisionId = matching.at(-1)?.id ?? null;
    }

    const evidence = {
      reasonCode: input.reasonCode,
      category: input.category ?? classified.category,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      ...(input.eventData ?? {}),
    };
    const evidenceSummary = `sha256:${createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
    const pauseId = this.nextEventId(input.runId, 'pause');
    return pauseStage(this.store, {
      id: pauseId,
      eventId: this.nextEventId(input.runId, 'ev-stage-pause'),
      runId: input.runId,
      stageId: input.stageId,
      reasonCode: input.reasonCode,
      category: input.category ?? classified.category,
      recoverable: input.recoverable ?? true,
      requiredApprovalType,
      decisionId,
      evidenceSummary,
      taskId: input.taskId,
      attemptId: input.attemptId,
      eventData: input.eventData,
      createdAt: input.createdAt,
    });
  }

  private async reserveProviderCost(input: {
    runId: string; stageId?: string | null; taskId?: string | null; attemptId?: string | null;
    callType: CallType; callId: string; provider: 'pi' | 'codex';
  }): Promise<{ allowed: boolean; reservationId: string | null; ownerId: string | null; reason?: string; remaining?: number }> {
    const budget = this.config.costBudget;
    if (!budget) return { allowed: false, reservationId: null, ownerId: null, reason: 'cost_budget_missing' };
    if (!this.store.reserveCost) return { allowed: false, reservationId: null, ownerId: null, reason: 'cost_ledger_unavailable' };
    const reservationId = `${input.callId}-cost`;
    const ownerId = `${input.runId}:${input.attemptId ?? input.stageId ?? input.callId}`;
    const now = new Date();
    const worstCaseCost = input.callType === 'pi_worker'
      ? budget.maxPiCallCost * 4 + budget.maxCodexCallCost * 2
      : input.provider === 'pi' ? budget.maxPiCallCost : budget.maxCodexCallCost;
    const result = await this.store.reserveCost({
      id: reservationId,
      runId: input.runId,
      stageId: input.stageId ?? null,
      taskId: input.taskId ?? null,
      attemptId: input.attemptId ?? null,
      callType: input.callType,
      callId: input.callId,
      currency: QUOTA_UNIT,
      budgetLimit: budget.limit,
      reservedCost: worstCaseCost,
      pricingVersion: QUOTA_PRICING_PLACEHOLDER,
      ownerId,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + Math.max(this.config.workerTimeoutMs, 120_000) + 60_000).toISOString(),
    });
    return { allowed: result.allowed, reservationId: result.reservation?.id ?? null, ownerId: result.allowed ? ownerId : null, reason: result.reason, remaining: result.remaining };
  }

  private async recordCostPause(input: {
    runId: string; stageId: string; taskId?: string | null; attemptId?: string | null;
    provider: 'pi' | 'codex'; reason: string; remaining?: number;
  }): Promise<void> {
    await this.recordStagePause({
      runId: input.runId,
      stageId: input.stageId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      reasonCode: input.reason,
      category: 'budget',
      requiredApprovalType: 'run_budget',
      eventData: { provider: input.provider, remaining: input.remaining ?? null },
    });
  }

  getSampler(): ResourceSampler { return this.sampler; }
  getMaxParallelTasks(): number { return this.config.maxParallelTasks; }
  isResourceSamplingEnabled(): boolean { return this.config.resourceSamplingEnabled === true; }

  async startRun(runId: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();

    // Init budget tracker and start background refresh
    if (this.isResourceSamplingEnabled()) {
      this.budgetTracker = new BudgetTracker(
        this.sampler, this.store,
        this.config.maxParallelTasks,
        this.config.maxParallelTasks,
        this.config.samplingIntervalMs || 5000,
        runId, '',
      );
      this.budgetTracker.start(runId, '');
    } else {
      this.budgetTracker = null;
    }

    // Periodic cleanup of old resource samples (best-effort, non-blocking, tracked when tracker active)
    if (this.budgetTracker) {
      this.budgetTracker.trackWrite(this.store.cleanupResourceSamples(7).catch((err) => {
        console.error('[Scheduler] cleanupResourceSamples failed: ' + (err instanceof Error ? err.message : String(err)));
      }));
    } else {
      this.store.cleanupResourceSamples(7).catch((err) => {
        console.error('[Scheduler] cleanupResourceSamples failed: ' + (err instanceof Error ? err.message : String(err)));
      });
    }

    try {
      const run = await this.store.getRun(runId);
      if (!run || run.status === 'completed' || run.status === 'canceled' || run.status === 'failed') { return; }

      // A production Pi worker must never be accepted through a local/fake
      // reviewer. Injected runners remain available for disposable tests.
      if (this.config.allowRealWorker && !this.config.piProcessRunner
        && (!this.config.allowRealReviewer || this.config.reviewerConfig?.type === 'local-rule')) {
        const stages = await this.store.listStages(runId);
        const stage = stages.find((candidate) => !['completed', 'canceled', 'failed'].includes(candidate.status));
        if (stage) {
          await this.recordStagePause({
            runId,
            stageId: stage.id,
            reasonCode: 'real_worker_requires_real_codex_reviewer',
            category: 'reviewer',
          });
        }
        console.error('[Scheduler] Real Pi spawn blocked: a real codex-cli reviewer is required.');
        return;
      }

      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-mode-selection'),
        runId,
        eventType: 'mode_selection',
        eventData: {
          mode: this.modeConfig.mode,
          autoSelected: this.modeConfig.autoSelected,
          reason: this.modeConfig.selectionReason,
        },
      });
      console.log('[Scheduler] Execution mode: ' + this.modeConfig.mode + ' — ' + this.modeConfig.selectionReason);

      // ── M4: Initialize governance ──
      if (this.config.governanceEnabled) {
        resetGovernanceConfigCache();
        const govCfg = getGovernanceConfig(run.projectRoot);
        if (!govCfg.enabled) {
          this.config.governanceEnabled = false;
        } else {
          await ensureDefaultPolicies(this.store);
        }
      }

      // ── M4: Check token budget pause before starting ──
      if (this.config.governanceEnabled) {
        const bp = await isBudgetPaused(this.store, runId);
        if (bp.paused) {
          console.log('[Scheduler] Token budget paused: ' + (bp.reason || 'exceeded') + '. Run blocked until budget raised.');
          return;
        }
      }

      await this.reconcile(runId);
      await this.processRun(runId);
    } catch (err) {
      console.error('[Scheduler] Run error:', err);
      await this.failRunSafely(runId, err instanceof Error ? err.message : String(err));
    }
    finally {
      this.running = false;
      // Stop the tracker first (prevents new writes from being added),
      // then await convergence of all existing pending writes.
      if (this.budgetTracker) {
        this.budgetTracker.stop();
        try {
          await this.budgetTracker.awaitIdle();
        } catch (convergenceErr) {
          const msg = convergenceErr instanceof Error ? convergenceErr.message : String(convergenceErr);
          console.error('[Scheduler] Convergence failure: ' + msg);
          await this.failRunSafely(runId, msg);
        }
      }
    }
  }

  /**
   * Transition a run to 'failed' — idempotent, never throws.
   * Overwrites a premature 'completed' status (convergence failure means
   * completion was not valid). Does NOT overwrite 'canceled' or an
   * already-valid 'failed'.
   */
  private async failRunSafely(runId: string, reason: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.store.failRunForConvergenceAtomically({ runId, reason, failedAt: now });
    } catch {
      // Must never throw — cleanup is best-effort
    }
  }

  private async retryReviewFromWorkerCompleted(input: {
    runId: string;
    stageId: string;
    taskId: string;
    attemptId: string;
    reason: string;
    updatedAt: string;
  }): Promise<void> {
    const reset = await this.store.retryReviewAtomically(input);
    if (!reset) {
      throw new Error(`Review retry CAS rejected for attempt ${input.attemptId}`);
    }
  }

  private async beginTaskAttempt(taskId: string, updatedAt: string): Promise<void> {
    let task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found before attempt dispatch`);
    if (task.status === 'pending' || task.status === 'rework_required') {
      const readied = await this.store.updateTaskStatus(taskId, 'ready', updatedAt);
      if (!readied) throw new Error(`Task ${taskId} could not transition to ready`);
      task = await this.store.getTask(taskId);
    }
    if (task?.status === 'running') return;
    if (task?.status !== 'ready' && task?.status !== 'waiting_decision') {
      throw new Error(`Task ${taskId} cannot start an attempt from ${String(task?.status ?? 'missing')}`);
    }
    const started = await this.store.updateTaskStatus(taskId, 'running', updatedAt);
    if (!started) throw new Error(`Task ${taskId} attempt dispatch lost status CAS`);
  }

  private async reconcile(runId: string): Promise<void> {
    const result = await runAutomaticReconciliation(this.store as import('../state/sqlite-store.js').SqliteStateStore, runId);
    if (result.appliedCount > 0) {
      console.log('[Scheduler] Shared reconciliation applied ' + result.appliedCount + ' safe action(s).');
    }
  }

  abort(): void { if (this.abortController) this.abortController.abort(); }
  private aborted(): boolean { return this.abortController?.signal.aborted ?? false; }

  private async processRun(runId: string): Promise<void> {
    const stages = await this.store.listStages(runId);
    const now = new Date().toISOString();
    for (const _s of stages) {
      if (await this.aborted()) return;
      const stage = await this.store.getStage(_s.id);
      if (!stage || stage.status === 'completed' || stage.status === 'canceled' || stage.status === 'failed') continue;
      if (stage.status === 'paused') { console.log('[Scheduler] Stage ' + stage.stageNumber + ' paused.'); return; }
      if (stage.status === 'pending') {
        await this.store.updateStageStatus(stage.id, 'ready', now);
      }
      if (stage.status === 'pending' || stage.status === 'ready') {
        await this.store.updateStageStatus(stage.id, 'running', now);
        await this.store.createEvent({ id: runId + '-ev-stage-' + Date.now(), runId, stageId: stage.id, eventType: 'stage_started', eventData: { stageNumber: stage.stageNumber } });
      }
      // Update budget tracker's stage context
      if (this.budgetTracker) this.budgetTracker.setStageId(stage.id);

      const base = await this.resolveBase(stage, runId);
      if (!base) { console.log('[Scheduler] No base commit stage ' + stage.stageNumber); await this.store.updateStageStatus(stage.id, 'failed', now); return; }
      await this.store.updateStageBaseCommit(stage.id, base);
      const ok = await this.processStage(stage, runId, base);
      if (!ok) { console.log('[Scheduler] Stage ' + stage.stageNumber + ' paused.'); return; }
    }
    const fin = await this.store.listStages(runId);
    for (const completedStage of fin.filter((s) => s.status === 'completed')) {
      const completedTasks = await this.tasksForStage(completedStage, runId);
      const incomplete = completedTasks.filter((task) => task.status !== 'merged' && task.status !== 'canceled' && task.status !== 'merge_blocked');
      if (incomplete.length > 0) {
        const finishedAt = new Date().toISOString();
        await this.store.updateRunStatus(runId, 'failed', finishedAt);
        await this.store.updateRunFinishedAt(runId, finishedAt);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-completion-invariant'), runId, stageId: completedStage.id,
          eventType: 'error',
          eventData: { reason: 'completed_stage_with_incomplete_tasks', taskIds: incomplete.map((task) => task.id) },
        });
        console.log('[Scheduler] Completion invariant failed: stage ' + completedStage.stageNumber + ' has incomplete task(s).');
        return;
      }
    }
    if (fin.every((s) => s.status === 'completed' || s.status === 'canceled')) {
      await this.store.updateRunStatus(runId, 'completed', new Date().toISOString());
      await this.store.updateRunFinishedAt(runId, new Date().toISOString());
      await this.store.createEvent({ id: runId + '-ev-done-' + Date.now(), runId, eventType: 'run_completed', eventData: {} });
      console.log('[Scheduler] Run ' + runId + ' completed.');
    }
  }

  private async resolveBase(stage: StageRecord, runId: string): Promise<string | null> {
    if (stage.baseCommit) return stage.baseCommit;
    if (stage.stageNumber <= 1) { try { return new WorktreeManager(this.config.projectRoot, { worktreeBaseDir: this.config.worktreeBaseDir }).getCurrentCommit(this.config.projectRoot); } catch { return null; } }
    const stages = await this.store.listStages(runId);
    const p = stages.find((s) => s.stageNumber === stage.stageNumber - 1);
    if (p) {
      const bs = await this.store.listIntegrationBatches(p.id);
      const completed = bs.filter((batch) => batch.status === 'completed' && batch.targetMergeCommit);
      if (completed.length > 0) return completed[completed.length - 1].targetMergeCommit!;
    }
    return null;
  }

  private async tasksForStage(stage: StageRecord, runId: string): Promise<Array<{ id: string; status: string; specJson: unknown }>> {
    const all = await this.store.listTasks(runId);
    let tasks = all.filter((task) => {
      const spec = task.specJson as { stageNumber?: number } | null;
      return spec?.stageNumber === stage.stageNumber;
    });
    if (tasks.length === 0) {
      const attempts = await this.store.listAttemptsByStage(stage.id);
      const taskIds = new Set(attempts.map((attempt) => attempt.taskId));
      tasks = all.filter((task) => taskIds.has(task.id));
    }
    return tasks;
  }

  private async stopIfCanceled(
    runId: string,
    stageId: string,
    taskId: string | null,
    attemptId: string | null,
    checkpoint: string,
  ): Promise<boolean> {
    const run = await this.store.getRun(runId);
    const stage = await this.store.getStage(stageId);
    if (run?.status !== 'canceled' && stage?.status !== 'canceled') return false;
    const now = new Date().toISOString();
    if (attemptId) {
      const attempt = await this.store.getAttempt(attemptId);
      if (attempt && !['approved', 'failed', 'interrupted', 'canceled'].includes(attempt.status)) {
        await this.store.updateAttemptStatus(attemptId, 'canceled', now);
        await this.store.updateAttemptResult(attemptId, { stoppedAt: now, exitReason: `canceled:${checkpoint}` });
      }
    }
    if (taskId) {
      const task = await this.store.getTask(taskId);
      if (task && !['merged', 'failed', 'canceled', 'rejected', 'merge_blocked'].includes(task.status)) {
        await this.store.updateTaskStatus(taskId, 'canceled', now);
      }
    }
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-cancel-checkpoint'), runId, stageId, taskId, attemptId,
      eventType: 'attempt_interrupted',
      eventData: { reason: 'canceled_checkpoint', checkpoint },
    }).catch(() => {});
    return true;
  }

  private pathsOverlap(left: string, right: string): boolean {
    const a = this.normalizeLockPath(left);
    const b = this.normalizeLockPath(right);
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  }

  private lockPathsFor(spec: StructuredTaskSpec, observedPaths: string[] = []): string[] {
    const estimated = spec.estimatedWritePaths?.length > 0 ? spec.estimatedWritePaths : ['src/'];
    const compared = [...estimated, ...observedPaths];
    const overlappingProtected = this.config.defaultLockedPaths.filter((protectedPath) =>
      compared.some((candidatePath) => this.pathsOverlap(protectedPath, candidatePath)),
    );
    return [...new Set([...compared, ...overlappingProtected])];
  }

  private async claimActualPathsOrPause(
    runId: string, stageId: string, taskId: string, attemptId: string, changedFiles: string[],
  ): Promise<boolean> {
    // Synthetic fixtures may intentionally exercise lifecycle behavior without
    // a diff. Real completion evidence rejects an empty diff before this point.
    if (changedFiles.length === 0) return true;
    const result = await this.store.claimActualPathsAtomic({ runId, stageId, taskId, attemptId, filePaths: changedFiles });
    if (result.claimed) return true;
    const now = new Date().toISOString();
    await this.store.updateAttemptResult(attemptId, {
      exitReason: result.violations.length > 0
        ? `actual_path_claim_invalid:${result.violations.join(';')}`
        : 'runtime_undeclared_actual_path_conflict',
    });
    await this.recordStagePause({
      runId, stageId, taskId, attemptId,
      reasonCode: result.violations.length > 0 ? 'actual_path_claim_invalid' : 'runtime_undeclared_actual_path_conflict',
      category: 'integration',
      eventData: { conflictLayer: 'runtime_undeclared', conflicts: result.conflicts, violations: result.violations },
      createdAt: now,
    });
    return false;
  }

  private readBoundedContextFiles(spec: StructuredTaskSpec, worktreePath: string): Map<string, string> {
    const contents = new Map<string, string>();
    for (const contextFile of spec.contextFiles || []) {
      const normalized = contextFile.replace(/\\/g, '/');
      const segments = normalized.toLowerCase().split('/');
      const sensitive = segments.some((segment) =>
        segment === '.env' || segment.startsWith('.env.') || segment.endsWith('.pem') || segment.endsWith('.key')
        || segment.includes('secret') || segment.includes('credential') || segment.includes('token'),
      );
      if (!normalized || isAbsolute(contextFile) || normalized.split('/').includes('..') || sensitive) continue;
      const filePath = resolve(worktreePath, contextFile);
      const rel = relative(worktreePath, filePath);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || !existsSync(filePath)) continue;
      try {
        if (statSync(filePath).size > 1_048_576) continue;
        contents.set(contextFile, readFileSync(filePath, 'utf8'));
      } catch {
        // Missing, binary, or unreadable context is omitted; Pi can request bounded clarification.
      }
    }
    return contents;
  }

  private parseStringArray(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private async buildImplementationPrompt(
    spec: StructuredTaskSpec,
    worktreePath: string,
    previousAttempt: import('../types/m2-types.js').AttemptRecord | null,
    diffBaseCommit: string,
    runId: string,
    stageId: string,
    attemptId: string,
  ): Promise<{ prompt: string; taskPacketHash: string }> {
    if (!isTokenEfficientMode(this.modeConfig.mode)) {
      return { prompt: buildPiWorkerPrompt({ taskSpec: spec }), taskPacketHash: sha256(canonicalJson(spec)) };
    }

    if (previousAttempt && ['failed', 'rework_required'].includes(previousAttempt.status)) {
      const reviews = await this.store.listReviewsByAttempt(previousAttempt.id);
      const latestReview = reviews.at(-1);
      const findings = [
        ...this.parseStringArray(latestReview?.findingsJson),
        ...this.parseStringArray(latestReview?.requiredReworkJson),
      ].slice(0, 12).map((finding) => finding.slice(0, 600));
      let diffDelta = '';
      try {
        diffDelta = git(worktreePath, ['diff', `${diffBaseCommit}..HEAD`, '--']);
      } catch {
        diffDelta = '(无法读取上次累计 diff；请先检查当前 worktree)';
      }
      if (diffDelta.length > 12_000) diffDelta = diffDelta.slice(0, 12_000) + '\n... [diff truncated by brainctl]';
      const requiredRework = this.parseStringArray(latestReview?.requiredReworkJson);
      const packet = buildRetryPacket(
        previousAttempt,
        (previousAttempt.exitReason || '上次 attempt 未通过').slice(0, 1_200),
        findings,
        diffDelta,
        requiredRework.length > 0 ? requiredRework.join('; ') : `修复上次失败并完成目标: ${spec.goal}`,
        spec,
      );
      const prompt = buildPiWorkerRetryPrompt(packet);
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-retry-packet'), runId, stageId, taskId: spec.taskId, attemptId,
        eventType: 'retry_packet_built',
        eventData: { previousAttemptId: previousAttempt.id, findingsCount: findings.length, diffChars: diffDelta.length, promptChars: prompt.length },
      });
      return { prompt, taskPacketHash: sha256(canonicalJson(packet)) };
    }

    const { packet, overflow } = buildMinimalTaskPacket(
      spec,
      this.readBoundedContextFiles(spec, worktreePath),
      {
        maxContextFiles: this.config.taskPacketMaxContextFiles ?? 5,
        maxContextFileChars: this.config.taskPacketMaxContextChars ?? 500,
        allowContextExpansion: false,
      },
    );
    const prompt = buildPiWorkerMinimalPrompt(packet);
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-minimal-packet'), runId, stageId, taskId: spec.taskId, attemptId,
      eventType: 'minimal_task_packet_built',
      eventData: { contextFiles: packet.contextFilesSummary.length, overflowCount: overflow.length, promptChars: prompt.length },
    });
    return { prompt, taskPacketHash: sha256(canonicalJson(packet)) };
  }

  private dependsOn(
    taskId: string,
    dependencyId: string,
    specs: Map<string, StructuredTaskSpec>,
    seen = new Set<string>(),
  ): boolean {
    if (taskId === dependencyId || seen.has(taskId)) return taskId === dependencyId;
    seen.add(taskId);
    const spec = specs.get(taskId);
    return Boolean(spec?.dependencies.some((dep) => dep === dependencyId || this.dependsOn(dep, dependencyId, specs, seen)));
  }

  private findUndeclaredSamePathConflicts(
    specs: Map<string, StructuredTaskSpec>,
  ): Array<{ firstTaskId: string; secondTaskId: string; paths: string[] }> {
    const entries = [...specs.entries()];
    const conflicts: Array<{ firstTaskId: string; secondTaskId: string; paths: string[] }> = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [firstTaskId, first] = entries[i];
        const [secondTaskId, second] = entries[j];
        if (this.dependsOn(firstTaskId, secondTaskId, specs) || this.dependsOn(secondTaskId, firstTaskId, specs)) continue;
        const paths = first.estimatedWritePaths.filter((path) => second.estimatedWritePaths.some((other) => this.pathsOverlap(path, other)));
        if (paths.length > 0) conflicts.push({ firstTaskId, secondTaskId, paths });
      }
    }
    return conflicts;
  }

  private async mergeDependencyBaselines(
    worktreePath: string,
    spec: StructuredTaskSpec,
    stage: StageRecord,
    runId: string,
    taskId: string,
    attemptId: string,
  ): Promise<boolean> {
    for (const dependencyId of spec.dependencies) {
      const dependencyAttempt = await this.store.getLatestAttempt(dependencyId);
      if (!dependencyAttempt?.branchName || !['approved', 'review_skipped'].includes(dependencyAttempt.status)) {
        const now = new Date().toISOString();
        await this.store.updateAttemptStatus(attemptId, 'failed', now);
        await this.store.updateTaskStatus(taskId, 'waiting_decision', now);
        await this.store.updateAttemptResult(attemptId, { exitReason: `dependency_baseline_unavailable:${dependencyId}`, stoppedAt: now });
        await this.recordStagePause({
          runId, stageId: stage.id, taskId, attemptId,
          reasonCode: 'dependency_baseline_unavailable',
          eventData: { dependencyId }, createdAt: now,
        });
        return false;
      }
      try {
        git(worktreePath, ['merge', '--no-ff', '--no-edit', '--', dependencyAttempt.branchName]);
      } catch (error: any) {
        const now = new Date().toISOString();
        await this.store.updateAttemptStatus(attemptId, 'failed', now);
        await this.store.updateTaskStatus(taskId, 'waiting_decision', now);
        await this.store.updateAttemptResult(attemptId, { exitReason: `dependency_baseline_conflict:${dependencyId}`, stoppedAt: now });
        await this.recordStagePause({
          runId, stageId: stage.id, taskId, attemptId,
          reasonCode: 'dependency_baseline_conflict', category: 'integration',
          eventData: { dependencyId, message: error?.message || String(error) }, createdAt: now,
        });
        return false;
      }
    }
    return true;
  }

  private async recordAttemptDiffBase(
    runId: string,
    stageId: string,
    taskId: string,
    attemptId: string,
    diffBaseCommit: string,
  ): Promise<void> {
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-task-diff-base'),
      runId,
      stageId,
      taskId,
      attemptId,
      eventType: 'task_diff_base_captured',
      eventData: { diffBaseCommit },
    });
  }

  private async getAttemptDiffBase(runId: string, attemptId: string, fallback: string): Promise<string> {
    const events = await this.store.listEvents(runId, 'task_diff_base_captured');
    const match = [...events].reverse().find((event) => event.attemptId === attemptId);
    if (!match?.eventDataJson) return fallback;
    try {
      const data = JSON.parse(match.eventDataJson) as { diffBaseCommit?: unknown };
      return typeof data.diffBaseCommit === 'string' && /^[0-9a-f]{40}$/i.test(data.diffBaseCommit)
        ? data.diffBaseCommit
        : fallback;
    } catch {
      return fallback;
    }
  }

  private async processStage(stage: StageRecord, runId: string, base: string): Promise<boolean> {
    const tasks = await this.tasksForStage(stage, runId);
    if (tasks.length === 0) { console.log('[Scheduler] Stage ' + stage.stageNumber + ' no tasks.'); return true; }

    const specs = new Map<string, StructuredTaskSpec>();
    for (const t of tasks) { const s = (t.specJson || {}) as StructuredTaskSpec; s.taskId = t.id; specs.set(t.id, s); }

    const undeclaredSamePathConflicts = this.findUndeclaredSamePathConflicts(specs);
    if (undeclaredSamePathConflicts.length > 0) {
      const now = new Date().toISOString();
      await this.recordStagePause({
        runId, stageId: stage.id, reasonCode: 'declared_write_conflict_missing_dependency',
        category: 'integration', eventData: { conflictLayer: 'declared_preventable', conflicts: undeclaredSamePathConflicts }, createdAt: now,
      });
      console.log('[Scheduler] Stage ' + stage.stageNumber + ' paused: same-path tasks require a dependency edge.');
      return false;
    }

    const done = new Set<string>();
    const exhausted = new Set<string>(); // tasks that exhausted retry budget
    let fail = false;
    const wtm = new WorktreeManager(this.config.projectRoot, { worktreeBaseDir: this.config.worktreeBaseDir });
    const dv = new DiffScopeValidator();
    const active = new Map<string, Promise<{ taskId: string; error?: string }>>();

    while (done.size + exhausted.size < tasks.length && !fail) {
      if (await this.aborted()) {
        if (active.size > 0) await Promise.allSettled([...active.values()]);
        return false;
      }
      // A run can be canceled externally while a worker/reviewer promise is in
      // flight. Do not schedule another attempt after that promise returns:
      // canceled work must not satisfy dependencies or consume retry budget.
      const currentRun = await this.store.getRun(runId);
      if (!currentRun || currentRun.status === 'canceled') {
        if (active.size > 0) await Promise.allSettled([...active.values()]);
        return false;
      }
      const cur = await this.store.getStage(stage.id);
      if (!cur || cur.status === 'paused' || cur.status === 'canceled') {
        if (active.size > 0) await Promise.allSettled([...active.values()]);
        return false;
      }

      const runnable: Array<{ task: typeof tasks[0]; spec: StructuredTaskSpec }> = [];
      for (const t of tasks) {
        if (done.has(t.id) || exhausted.has(t.id) || active.has(t.id)) continue;
        const sp = specs.get(t.id);
        if (!sp) continue;
        if (!sp.dependencies.every((d) => done.has(d))) continue;
        const lat = await this.store.getLatestAttempt(t.id);
        const paths = this.lockPathsFor(sp);
        if ((!lat || lat.status !== 'worker_completed') && (await this.store.getConflictingLocks(t.id, paths, runId)).length > 0) continue;
        if (lat && (lat.status === 'approved' || lat.status === 'review_skipped')) { done.add(t.id); continue; }

        // ── P0-3: Retry budget check using actual attempt count ──
        if (lat && (lat.status === 'failed' || lat.status === 'rework_required')) {
          const allAttempts = await this.store.listAttempts(t.id);
          const budget = checkRetryBudget(
            allAttempts.map(a => ({ status: a.status, exitReason: a.exitReason })),
            this.config.maxReworkCount,
            lat.status,
            lat.exitReason || undefined,
          );

          if (!budget.allowed) {
            console.log('[Scheduler] Task ' + t.id + ' retry not allowed: ' + budget.reason);
            const now = new Date().toISOString();
            await this.store.updateTaskStatus(t.id, 'waiting_decision', now);
            await this.store.createEvent({
              id: this.nextEventId(runId, 'ev-retry-blocked'),
              runId, stageId: stage.id, taskId: t.id, attemptId: lat.id,
              eventType: 'task_failed',
              eventData: {
                reason: budget.reason,
                retryOrdinal: budget.retryOrdinal,
                remainingRetries: budget.remainingRetries,
                exhausted: budget.exhausted,
                failureCategory: budget.failureCategory || 'unknown',
              },
            });
            exhausted.add(t.id);
            if (budget.exhausted) {
              // Retry budget exhausted → pause stage for human decision
              await this.recordStagePause({
                runId, stageId: stage.id, taskId: t.id,
                reasonCode: 'retry_budget_exhausted', category: 'retry',
                eventData: { maxReworkCount: this.config.maxReworkCount }, createdAt: now,
              });
              fail = true; break;
            }
            // Non-retriable (scope/security/privacy/product-decision/unverifiable) → pause stage for human decision
            await this.recordStagePause({
              runId, stageId: stage.id, taskId: t.id,
              reasonCode: 'non_retriable_failure',
              eventData: { failureCategory: budget.failureCategory || 'unknown', detail: budget.reason },
              createdAt: now,
            });
            fail = true; break;
          }

          // Retry allowed — log retry event
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-retry-scheduled'),
            runId, stageId: stage.id, taskId: t.id, attemptId: lat.id,
            eventType: 'attempt_started',
            eventData: {
              reason: budget.reason,
              retryOrdinal: budget.retryOrdinal,
              remainingRetries: budget.remainingRetries - 1, // after this attempt
              category: budget.reason,
            },
          });
        }

        runnable.push({ task: t, spec: sp });
      }
      if (fail) {
        if (active.size > 0) await Promise.allSettled([...active.values()]);
        break;
      }
      if (runnable.length === 0) {
        if (done.size === tasks.length) break;
        if (active.size > 0) {
          await Promise.race([...active.values()]);
          continue;
        }
        let running = false;
        for (const t of tasks) {
          if (done.has(t.id)) continue;
          const l = await this.store.getLatestAttempt(t.id);
          if (l && (l.status === 'running' || l.status === 'reviewing')) { running = true; break; }
        }
        if (!running) {
          console.log('[Scheduler] Stage deadlock.');
          const now = new Date().toISOString();
          const blockedTasks: Array<{ taskId: string; reason: string; missingDeps: string[]; lockConflicts: number }> = [];
          for (const t of tasks) {
            if (done.has(t.id) || exhausted.has(t.id)) continue;
            const sp = specs.get(t.id);
            if (!sp) continue;
            const missingDeps = sp.dependencies.filter((d) => !done.has(d));
            if (missingDeps.length > 0) {
              blockedTasks.push({ taskId: t.id, reason: 'waiting_dependencies', missingDeps, lockConflicts: 0 });
              continue;
            }
            const lat = await this.store.getLatestAttempt(t.id);
            const paths = this.lockPathsFor(sp);
            const conflicts = (lat && lat.status !== 'worker_completed') ? await this.store.getConflictingLocks(t.id, paths, runId) : [];
            if (conflicts.length > 0) {
              blockedTasks.push({ taskId: t.id, reason: 'path_lock_conflict', missingDeps: [], lockConflicts: conflicts.length });
              continue;
            }
            blockedTasks.push({ taskId: t.id, reason: 'unknown_deadlock', missingDeps: [], lockConflicts: 0 });
          }
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'stage_deadlock',
            eventData: { blockedTasks, stageNumber: stage.stageNumber }, createdAt: now,
          });
          return false;
        }
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // ── M3: Sync-read cached budget (never blocks on sampling) ──
      let effectiveMax: number;
      if (this.budgetTracker) {
        const budgetState = this.budgetTracker.getBudget();
        effectiveMax = budgetState.current;

        // If no first sample yet, throttle dispatch to give sampling time to fire
        if (!this.budgetTracker.hasFirstSample() && effectiveMax <= 1) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }

        if (budgetState.dispatchPaused) {
          const reason = this.budgetTracker.getPauseReason() || 'resource_pressure';
          console.log('[Scheduler] Dispatch paused: ' + reason + '. Waiting for resources...');
          await new Promise((r) => setTimeout(r, this.config.samplingIntervalMs || 5000));
          continue;
        }
      } else {
        effectiveMax = this.config.maxParallelTasks;
      }

      if (effectiveMax <= 0) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const dispatchLimit = Math.min(effectiveMax, this.config.maxParallelTasks);
      let dispatched = 0;
      let blockedByGovernance = 0;
      for (const { task, spec } of runnable) {
        if (active.size >= dispatchLimit) break;

        // ── M4: G2 Execution Gate (only when governance enabled) ──
        if (this.config.governanceEnabled) {
          const g2Check = await checkG2Approvable(this.store, runId, task.id);
          if (!g2Check.approvable) {
            console.log('[Scheduler] G2 blocked task ' + task.id + ' (' + g2Check.pendingDecisions.length + ' pending)');
            blockedByGovernance++;
            continue;
          }

          // Token budget pre-check for attempt — skip for worker_completed (Pi already ran)
          const lat = await this.store.getLatestAttempt(task.id);
          if (!lat || lat.status !== 'worker_completed') {
            const estTokens = estimatePiWorkerTokens(spec.goal.length, spec.estimatedWritePaths.length);
            const budgetCheck = await preCheckBudget(this.store, runId, 'pi_attempt', estTokens.total);
            if (!budgetCheck.allowed) {
              console.log('[Scheduler] Token budget exceeded for task ' + task.id + ': ' + budgetCheck.reason);
              await createG2Approval(this.store, runId, task.id, 'run_budget', budgetCheck.reason || 'token_budget_exceeded');
              blockedByGovernance++;
              continue;
            }
          }
        }

        const latest = await this.store.getLatestAttempt(task.id);
        if (!latest || latest.status !== 'worker_completed') {
          const lockPaths = this.lockPathsFor(spec);
          const lockResult = await this.store.acquirePathLocksAtomic({ runId, taskId: task.id, filePaths: lockPaths, lockType: 'exclusive' });
          if (!lockResult.acquired) {
            await this.store.createEvent({
              id: this.nextEventId(runId, 'ev-lock-blocked'), runId, stageId: stage.id, taskId: task.id,
              eventType: 'path_lock_blocked',
              eventData: { reason: 'path_lock_unavailable', conflicts: lockResult.conflicts.length, violations: lockResult.violations },
            }).catch(() => {});
            continue;
          }
        }
        // Rolling pool: refill the freed slot as soon as any task settles.
        const taskRef = task;
        const taskPromise = this.execTask(task, spec, stage, runId, base, wtm, dv)
          .then(() => ({ taskId: taskRef.id }))
          .catch(async (err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[Scheduler] execTask unhandled rejection for task ' + taskRef.id + ': ' + errMsg);
            const errNow = new Date().toISOString();
            try {
              await this.store.updateTaskStatus(taskRef.id, 'rework_required', errNow);
              await this.recordStagePause({
                runId, stageId: stage.id, taskId: taskRef.id,
                reasonCode: 'exec_task_pool_rejection',
                eventData: { message: errMsg }, createdAt: errNow,
              });
              await this.store.createEvent({
                id: this.nextEventId(runId, 'ev-pool-rejection-task'),
                runId, stageId: stage.id, taskId: taskRef.id,
                eventType: 'error',
                eventData: { reason: 'exec_task_pool_rejection', message: errMsg, taskId: taskRef.id },
              });
              await this.releaseLocks(taskRef.id, runId);
            } catch { /* best-effort */ }
            return { taskId: taskRef.id, error: errMsg };
          });
        const tracked = taskPromise.finally(() => { active.delete(taskRef.id); });
        active.set(taskRef.id, tracked);
        dispatched++;
      }

      // If all runnable tasks are blocked by governance, pause stage and exit
      if (blockedByGovernance > 0 && dispatched === 0 && active.size === 0) {
        console.log('[Scheduler] All tasks blocked by governance. Pausing stage ' + stage.stageNumber + '.');
        const pending = await this.store.getPendingApprovals(runId);
        const dedicated = pending[0] ?? null;
        await this.recordStagePause({
          runId, stageId: stage.id, reasonCode: 'governance_blocked',
          category: dedicated?.decisionType === 'run_budget' ? 'budget' : 'product_decision',
          requiredApprovalType: dedicated?.decisionType ?? 'product_decision',
          decisionId: dedicated?.id ?? null,
          eventData: { blockedTasks: blockedByGovernance },
        });
        return false;
      }

      if (active.size > 0) {
        const result = await Promise.race([...active.values()]);
        if (result.error) {
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-pool-rejection'),
            runId, stageId: stage.id,
            eventType: 'error',
            eventData: { reason: 'exec_task_rejection', message: result.error, taskId: result.taskId },
          }).catch(() => {});
        }
      }
    }

    if (!fail) {
      // Any exhausted task (non-retriable or retry-exhausted) prevents stage integration
      if (exhausted.size > 0) {
        console.log('[Scheduler] Stage has ' + exhausted.size + ' exhausted task(s); integration blocked.');
        const now = new Date().toISOString();
        await this.recordStagePause({
          runId, stageId: stage.id, reasonCode: 'exhausted_tasks_block_integration',
          category: 'retry', eventData: { exhaustedTaskIds: [...exhausted] }, createdAt: now,
        });
        return false;
      }

      let allOk = true;
      let hasMergeBlocked = false;
      for (const t of tasks) {
        const l = await this.store.getLatestAttempt(t.id);
        // Accept both approved and review_skipped as "ready for integration"
        if (!l || (l.status !== 'approved' && l.status !== 'review_skipped')) { allOk = false; break; }
        // Also check current task status: merge_blocked tasks cannot be integrated again
        const ct = await this.store.getTask(t.id);
        if (ct?.status === 'merge_blocked') { hasMergeBlocked = true; }
      }
      if (hasMergeBlocked) {
        console.log('[Scheduler] Stage has merge_blocked task(s); integration permanently blocked.');
        return false;
      }
      if (allOk) {
        if (!await this.integrate(stage, runId, wtm, base)) return false;
      } else {
        // Not all tasks approved — stage cannot complete
        console.log('[Scheduler] Stage incomplete: not all tasks approved.');
        const now = new Date().toISOString();
        await this.recordStagePause({
          runId, stageId: stage.id, reasonCode: 'stage_incomplete_not_all_approved',
          category: 'quality', createdAt: now,
        });
        return false;
      }
    }
    return !fail;
  }

  private async execTask(
    task: { id: string; specJson: unknown }, spec: StructuredTaskSpec,
    stage: StageRecord, runId: string, base: string, wtm: WorktreeManager, dv: DiffScopeValidator,
  ): Promise<void> {
    const tid = task.id;
    // P0-3: Tracks whether locks should be preserved on exit (token budget hard pause only)
    let preserveLocks = false;

    try {
    // ── M4: Resume from token-budget-paused worker_completed attempt ──
    const latestBeforeExec = await this.store.getLatestAttempt(tid);
    if (latestBeforeExec && latestBeforeExec.status === 'worker_completed') {
      await this.resumeFromWorkerCompleted(latestBeforeExec, spec, stage, runId, base, wtm, dv);
      return;
    }

    await this.beginTaskAttempt(tid, new Date().toISOString());
    const pn = latestBeforeExec?.attemptNumber ?? 0;
    const an = pn + 1;
    const aid = runId + '-att-' + tid + '-a' + an;
    const bn = 'brainctl/' + runId + '/' + tid + '/a' + an;
    const wr = this.config.worktreeBaseDir + '/' + runId + '/' + tid + '/a' + an;
    const wp = resolve(this.config.projectRoot, wr);
    const sd = resolve(this.config.projectRoot, this.config.sessionDir);
    const ld = resolve(this.config.projectRoot, this.config.logDir);
    mkdirSync(sd, { recursive: true }); mkdirSync(ld, { recursive: true });

    await this.store.createAttempt({ id: aid, taskId: tid, stageId: stage.id, attemptNumber: an, status: 'running' });
    const dispatchLeasedAt = new Date();
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-attempt-dispatch-lease'),
      runId, stageId: stage.id, taskId: tid, attemptId: aid,
      eventType: 'attempt_dispatch_lease',
      eventData: {
        ownerId: `${runId}:${aid}`,
        heartbeatAt: dispatchLeasedAt.toISOString(),
        leaseExpiresAt: new Date(dispatchLeasedAt.getTime() + this.config.workerTimeoutMs + 60_000).toISOString(),
      },
    });

    let branchStartRef = base;
    let taskDiffBase = base;
    let reusedPreviousBranch = false;
    // Interrupted attempts do not consume retry budget. If recovery preserved a
    // checkpoint commit on their branch, continue from it instead of silently
    // discarding paid worker progress and restarting from the stage base.
    if (latestBeforeExec?.branchName && ['failed', 'rework_required', 'interrupted'].includes(latestBeforeExec.status)) {
      try {
        git(this.config.projectRoot, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${latestBeforeExec.branchName}`]);
        branchStartRef = latestBeforeExec.branchName;
        taskDiffBase = await this.getAttemptDiffBase(runId, latestBeforeExec.id, base);
        reusedPreviousBranch = true;
      } catch {
        // A missing prior branch cannot be reused; retry safely starts from the stage base.
      }
    }

    try { wtm.createBranch(bn, branchStartRef); wtm.createWorktree(bn, wr); }
    catch (e: any) {
      await this.store.updateAttemptStatus(aid, 'failed', new Date().toISOString());
      await this.store.updateTaskStatus(tid, 'rework_required', new Date().toISOString());
      await this.store.updateAttemptResult(aid, { exitReason: 'wt_fail: ' + (e.message || String(e)), stoppedAt: new Date().toISOString(), worktreePath: wp, branchName: bn });
      await this.releaseLocks(tid, runId); return;
    }
    const attemptStartedAt = new Date().toISOString();
    await this.store.updateAttemptResult(aid, { worktreePath: wp, branchName: bn, startedAt: attemptStartedAt });

    if (!(await this.mergeDependencyBaselines(wp, spec, stage, runId, tid, aid))) {
      await this.releaseLocks(tid, runId);
      return;
    }
    if (!reusedPreviousBranch) taskDiffBase = git(wp, ['rev-parse', 'HEAD']);
    await this.recordAttemptDiffBase(runId, stage.id, tid, aid, taskDiffBase);
    if (reusedPreviousBranch) {
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-retry-branch-reused'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
        eventType: 'retry_branch_reused',
        eventData: { previousAttemptId: latestBeforeExec?.id, previousBranch: latestBeforeExec?.branchName },
      });
    }

    let wrResult: WorkerResult | null = null;
    let pid: number | null = null;
    let exitReason: string | undefined;
    let rawLog: string | undefined;
    let ph: string | undefined;
    let stoppedAt = new Date().toISOString();
    let piCostReservationId: string | null = null;
    let implementationPrompt: string | undefined;

    // ── M4: Create LedgerSink for Pi worker (only when governance enabled) ──
    let piLedgerSink: SqliteLedgerSink | null = null;
    let piInvocationCtx: import('../core/token-telemetry.js').InvocationContext | null = null;
    if (this.config.governanceEnabled) {
      piLedgerSink = new SqliteLedgerSink(this.store);
      piInvocationCtx = {
        runId, stageId: stage.id, taskId: tid, attemptId: aid,
        callType: 'pi_worker', callId: aid, model: this.config.workerConfig?.model || 'configured-worker',
      };
    }

    if (this.config.allowRealWorker) {
      // Local fail-closed checks and prompt construction happen before money is reserved.
      if (this.config.privacyService) {
        const spawnGate = this.config.privacyService.canSpawnRealProvider();
        if (!spawnGate.allowed) {
          console.error('[Scheduler] Real Pi spawn blocked: ' + spawnGate.reason);
          await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
          await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
          await this.store.updateAttemptResult(aid, { exitReason: 'privacy_gate_blocked: ' + spawnGate.reason, stoppedAt });
          await this.recordCostPause({ runId, stageId: stage.id, taskId: tid, attemptId: aid, provider: 'pi', reason: 'privacy_gate_blocked' });
          await this.releaseLocks(tid, runId);
          return;
        }
      }
      try {
        const built = await this.buildImplementationPrompt(
          spec, wp, latestBeforeExec, taskDiffBase, runId, stage.id, aid,
        );
        implementationPrompt = built.prompt;
        await this.store.recordAttemptProvenance({
          attemptId: aid, runId, stageId: stage.id, taskId: tid, baseCommit: taskDiffBase,
          expectedBranch: bn, expectedWorktree: wp, taskPacketHash: built.taskPacketHash,
          implementationPromptHash: sha256(built.prompt), workerId: 'bc-' + aid, sessionId: `${runId}:${aid}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
        await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
        await this.store.updateAttemptResult(aid, { exitReason: 'prompt_build_failed_before_spawn: ' + message, stoppedAt });
        await this.releaseLocks(tid, runId);
        return;
      }
      // R2: an injected runner with a configured budget still reserves (so the
      // cost ledger + heartbeat are exercised in fake tests); only an injected
      // runner WITHOUT a budget skips the gate (legacy fake-test behavior). A
      // real non-injected Pi always reserves.
      const costGate = (this.config.piProcessRunner && !this.config.costBudget)
        ? { allowed: true, reservationId: null, ownerId: null }
        : await this.reserveProviderCost({
        runId, stageId: stage.id, taskId: tid, attemptId: aid,
        callType: 'pi_worker', callId: aid, provider: 'pi',
      });
      if (!costGate.allowed) {
        const reason = costGate.reason || 'cost_budget_exceeded';
        console.error('[Scheduler] Real Pi spawn blocked by cost gate: ' + reason);
        await this.store.updateAttemptStatus(aid, 'interrupted', stoppedAt);
        await this.store.updateTaskStatus(tid, 'rework_required', stoppedAt);
        await this.store.updateAttemptResult(aid, { exitReason: reason, stoppedAt });
        await this.recordCostPause({ runId, stageId: stage.id, taskId: tid, attemptId: aid, provider: 'pi', reason, remaining: costGate.remaining });
        await this.releaseLocks(tid, runId);
        return;
      }
      piCostReservationId = costGate.reservationId;
      const cfg: PiWorkerConfig = {
        workerId: 'bc-' + aid,
        command: this.config.workerConfig?.command || 'pi',
        args: this.config.workerConfig?.args ?? ['--mode', 'rpc'],
        model: this.config.workerConfig?.model || undefined,
        workingDirectory: wp,
        sessionDirectory: sd,
        rawLogPath: resolve(ld, runId + '_' + tid + '.log'),
        timeoutMs: this.config.workerConfig?.timeoutMs ?? this.config.workerTimeoutMs,
        allowRealPiExecution: true,
        // Production Provider execution cannot bypass the 95% understanding gate.
        // The override remains only for injected, non-provider test runners.
        requireClarification: this.config.piProcessRunner
          ? (this.config.requireWorkerClarification ?? false)
          : true,
        env: this.config.privacyService?.buildProviderEnv('pi', undefined, this.config.workerConfig?.model),
        clarificationResponder: new CodexTechnicalClarifier({
          command: this.config.reviewerConfig?.command || 'codex',
          args: this.config.reviewerConfig?.args ?? ['exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '-'],
          timeoutMs: this.config.reviewerConfig?.timeoutMs ?? 120_000,
          env: this.config.privacyService?.buildProviderEnv('codex'),
          signal: this.abortController?.signal,
        }, this.config.codexProcessRunner, {
          // H3: the 95%-understanding gate spends real Codex calls. Give them a
          // ledger record so the gate's added cost is at least visible.
          ledgerSink: this.config.governanceEnabled ? new SqliteLedgerSink(this.store) : null,
          invocationContext: this.config.governanceEnabled
            ? {
              runId, stageId: stage.id, taskId: tid, attemptId: aid,
              callType: 'codex_clarification', callId: `${aid}-clarify`,
              model: this.config.reviewerConfig?.model || 'codex-cli',
            }
            : null,
        }),
        onProcessSpawn: async (spawnedPid) => {
          if (piCostReservationId && this.store.markCostReservationSpawned) {
            await this.store.markCostReservationSpawned(piCostReservationId, costGate.ownerId ?? '', new Date().toISOString());
          }
          // R2: refresh the one-shot lease while the worker is running.
          heartbeatTimer = piCostReservationId && this.store.heartbeatCostReservation
            ? startCostReservationHeartbeat({
                reservationId: piCostReservationId,
                ownerId: costGate.ownerId ?? '',
                workerTimeoutMs: this.config.workerTimeoutMs,
                overrideIntervalMs: this.config.costReservationHeartbeatMs,
                heartbeat: (id, owner, at, lease) => this.store.heartbeatCostReservation!(id, owner, at, lease),
              })
            : null;
          await this.store.updateAttemptResult(aid, { piPid: spawnedPid, startedAt: attemptStartedAt });
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-attempt-spawned'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
            eventType: 'attempt_started',
            eventData: { pid: spawnedPid },
          });
        },
        // R3: guard runtime self-check before the real Pi clarification session.
        // Zero-inference probe; failure refuses to start (fail closed). Result is
        // audited into SQLite (never the raw stderr — only category/version/duration/hash).
        guardSelfCheck: {
          markerDir: resolve(this.config.projectRoot, '.brainctl-dev/guard-selfcheck'),
          verifiedPiVersion: this.config.workerConfig?.verifiedPiVersion ?? '0.82.1',
          onResult: async (result) => {
            await this.store.createEvent({
              id: this.nextEventId(runId, 'ev-guard-selfcheck'),
              runId, stageId: stage.id, taskId: tid, attemptId: aid,
              eventType: 'pi_guard_selfcheck',
              eventData: {
                ok: result.ok,
                piVersion: result.piVersion,
                verifiedPiVersion: result.verifiedPiVersion,
                versionMismatch: result.versionMismatch,
                durationMs: result.durationMs,
                failureCategory: result.failureCategory,
                stderrHash: result.stderrHash,
              },
            });
          },
          // B (authorized): one minimal inference, cost-gated, cached per Pi version.
          inferenceProbe: {
            enabled: this.config.workerConfig?.allowInferenceProbe === true,
            model: this.config.workerConfig?.model || 'deepseek/deepseek-v4-flash',
            reserveCost: async () => {
              const budget = this.config.costBudget;
              if (!budget || !this.store.reserveCost) return { allowed: false, reason: 'cost_budget_missing' };
              const result = await this.store.reserveCost({
                id: `${runId}-guard-block-probe-cost`,
                runId,
                stageId: stage.id,
                taskId: tid,
                attemptId: aid,
                callType: 'pi_worker',
                callId: `${runId}-guard-block-probe`,
                currency: QUOTA_UNIT,
                budgetLimit: budget.limit,
                reservedCost: budget.maxPiCallCost,
                pricingVersion: QUOTA_PRICING_PLACEHOLDER,
                ownerId: `${runId}:${aid}:guard-block-probe`,
                heartbeatAt: new Date().toISOString(),
              });
              return { allowed: result.allowed, reason: result.reason };
            },
            settleCost: async (outcome, terminationEvidence) => {
              if (!this.store.finalizeCostReservation) return false;
              return this.store.finalizeCostReservation({
                id: `${runId}-guard-block-probe-cost`,
                outcome,
                ownerId: `${runId}:${aid}:guard-block-probe`,
                terminationEvidence,
              });
            },
            cacheGet: async (piVersion) => {
              if (!this.store.getGuardProbeCache) return null;
              return this.store.getGuardProbeCache(piVersion);
            },
            cacheSet: async (piVersion, outcome, failureCategory) => {
              if (!this.store.setGuardProbeCache) return;
              await this.store.setGuardProbeCache(piVersion, outcome, failureCategory, new Date().toISOString());
            },
            onResult: async (result) => {
              await this.store.createEvent({
                id: this.nextEventId(runId, 'ev-guard-block-probe'),
                runId, stageId: stage.id, taskId: tid, attemptId: aid,
                eventType: 'pi_guard_block_probe',
                eventData: {
                  ok: result.ok,
                  outcome: result.outcome,
                  failureCategory: result.failureCategory,
                  piVersion: result.piVersion,
                  durationMs: result.durationMs,
                  stderrHash: result.stderrHash,
                },
              });
            },
          },
        },
      };
      let heartbeatTimer: NodeJS.Timeout | null = null;
      const pi = new PiRpcWorker(cfg, this.config.piProcessRunner, { ledgerSink: piLedgerSink, invocationContext: piInvocationCtx });
      let r: Awaited<ReturnType<PiRpcWorker['executeTask']>>;
      try {
        r = await pi.executeTask({ taskSpec: spec, implementationPrompt, worktreePath: wp, runId });
      } catch (error) {
        if (piCostReservationId && this.store.finalizeCostReservation) {
          await this.store.finalizeCostReservation({
            id: piCostReservationId, outcome: 'unavailable', ownerId: costGate.ownerId,
            terminationEvidence: 'pi_runner_threw_after_spawn_unknown',
          });
        }
        throw error;
      } finally {
        // R2: heartbeat timer must be cleared on EVERY exit path (success,
        // throw, timeout, abort) — never leave a ref that keeps the process up.
        stopCostReservationHeartbeat(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (piCostReservationId && this.store.finalizeCostReservation) {
        await this.store.finalizeCostReservation({
          id: piCostReservationId, outcome: 'unavailable', ownerId: costGate.ownerId,
          terminationEvidence: 'provider_money_usage_unavailable',
        });
      }
      stoppedAt = new Date().toISOString();
      wrResult = r.workerResult; pid = r.pid ?? null; exitReason = r.errorMessage; rawLog = r.rawLogPath;
      if (!wrResult) {
        const detail = exitReason || 'Pi did not return a valid WorkerResult';
        const reason = `worker_result_missing: ${detail}`;
        await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
        await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
        await this.store.updateAttemptResult(aid, { piPid: pid, stoppedAt, exitReason: reason, rawLogPath: rawLog || null, promptHash: null as any, workerResultJson: null });
        await this.store.createEvent({ id: runId + '-ev-wr-missing-' + Date.now(), runId, stageId: stage.id, taskId: tid, attemptId: aid, eventType: 'attempt_failed', eventData: { reason: 'worker_result_missing', pid } });
        await this.recordStagePause({
          runId, stageId: stage.id, taskId: tid, attemptId: aid,
          reasonCode: 'worker_result_missing_recovery_available', category: 'recovery', createdAt: stoppedAt,
        });
        console.log('[Scheduler] WorkerResult MISSING for attempt ' + aid + ' — marked failed (no manual completion).');
        await this.releaseLocks(tid, runId);
        return;
      }
      ph = undefined;
    } else {
      try {
        const syntheticPacketHash = sha256(canonicalJson(spec));
        await this.store.recordAttemptProvenance({
          attemptId: aid, runId, stageId: stage.id, taskId: tid, baseCommit: taskDiffBase,
          expectedBranch: bn, expectedWorktree: wp, taskPacketHash: syntheticPacketHash,
          implementationPromptHash: syntheticPacketHash, workerId: 'fake-' + aid, sessionId: `${runId}:${aid}:fake`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
        await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
        await this.store.updateAttemptResult(aid, { exitReason: 'provenance_persist_failed_before_fake_worker: ' + message, stoppedAt });
        await this.recordStagePause({
          runId, stageId: stage.id, taskId: tid, attemptId: aid,
          reasonCode: 'provenance_persist_failed', category: 'recovery', createdAt: stoppedAt,
        });
        await this.releaseLocks(tid, runId);
        return;
      }
      wrResult = this.config.fakeWorkerResult || { taskId: tid, status: 'completed', summary: 'fake', filesChanged: [], checks: [], scopeViolations: [], risks: [], unresolvedQuestions: [], productDecisionRequired: false, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 } };
      exitReason = 'fake_ok'; ph = 'fake';
      stoppedAt = new Date().toISOString();
      console.log('[Scheduler] FAKE mode: attempt ' + aid + ' using fakeWorkerResult (not a real Pi).');
    }

    if (await this.stopIfCanceled(runId, stage.id, tid, aid, 'after_worker')) {
      await this.releaseLocks(tid, runId);
      return;
    }

    // ── M4: Post-check after Pi worker (adapter already wrote estimate/confirmed/unavailable) ──
    // MUST be awaited to prevent race. On exceeded: save Pi results as worker_completed,
    // pause stage, and return WITHOUT proceeding to quality gate or Codex review.
    let tokenPaused = false;
    if (this.config.governanceEnabled) {
      const postActual = wrResult?.tokenUsage
        ? wrResult.tokenUsage.inputTokens + wrResult.tokenUsage.outputTokens + (wrResult.tokenUsage.cacheHitTokens || 0)
        : 0;
      const pc = await postCheckBudget(this.store, runId, 'pi_attempt', postActual).catch(() => null);
      if (pc && pc.exceeded) {
        console.log('[Scheduler] Token budget exceeded after Pi task ' + tid + ': ' + pc.remaining + '/' + pc.limit);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-token-exceeded'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
          eventType: 'token_budget_exceeded',
          eventData: { policyType: 'pi_attempt', remaining: pc.remaining, limit: pc.limit },
        });
        await this.recordStagePause({
          runId, stageId: stage.id, taskId: tid, attemptId: aid,
          reasonCode: 'token_budget_exceeded', category: 'budget',
          requiredApprovalType: 'run_budget', eventData: { policyType: 'pi_attempt' },
        });
        tokenPaused = true;
      }
    }

    // Persist Pi results BEFORE checking for hard pause
    await this.store.updateAttemptResult(aid, {
      piPid: pid ?? undefined,
      stoppedAt,
      promptHash: ph || null,
      workerResultJson: wrResult ? JSON.stringify(wrResult) : null,
      exitReason: exitReason || 'unknown',
      rawLogPath: rawLog || null,
    });
    // ── P0-3: Check for non-retriable worker results ──
    if (wrResult && wrResult.productDecisionRequired) {
      await this.store.updateAttemptStatus(aid, 'rework_required', stoppedAt);
      await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'product_decision: ' + (exitReason || 'product_decision_required') });
      await this.recordStagePause({
        runId, stageId: stage.id, taskId: tid, attemptId: aid,
        reasonCode: 'product_decision_required', category: 'product_decision',
        requiredApprovalType: 'product_decision',
        eventData: { unresolvedQuestions: wrResult.unresolvedQuestions }, createdAt: stoppedAt,
      });
      await this.releaseLocks(tid, runId);
      return;
    }
    if (wrResult && (wrResult.status === 'blocked' || wrResult.status === 'needs_decision')) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'blocked: ' + wrResult.status });
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-worker-blocked'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
        eventType: 'attempt_failed',
        eventData: { reason: 'worker_blocked', workerStatus: wrResult.status },
      });
      await this.recordStagePause({
        runId, stageId: stage.id, taskId: tid, attemptId: aid,
        reasonCode: 'worker_blocked', category: 'product_decision', createdAt: stoppedAt,
      });
      await this.releaseLocks(tid, runId);
      return;
    }
    if (!wrResult || wrResult.status === 'failed' || wrResult.status === 'scope_violation') {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, wrResult?.status === 'scope_violation' ? 'waiting_decision' : 'rework_required', stoppedAt);
      await this.releaseLocks(tid, runId);
      return;
    }
    await this.store.updateAttemptStatus(aid, 'worker_completed', stoppedAt);
    await this.store.updateTaskStatus(tid, 'worker_completed', stoppedAt);

    // ── M4: Hard pause — exit before quality gate / review if budget exceeded ──
    if (tokenPaused) {
      console.log('[Scheduler] Hard pause: exiting execTask before quality gate/review for attempt ' + aid);
      // Keep locks (needed for resume); worker_completed status enables resume path
      preserveLocks = true;
      return;
    }

    const ch = wtm.getChangedFiles(wp, taskDiffBase);
    await this.postWorkerHandler.handle({
      source: 'fresh', runId, stage, taskId: tid, attemptId: aid, spec,
      workerResult: wrResult, branchName: bn, worktreePath: wp, reviewBase: base,
      changedFiles: ch, scopeValidator: dv, worktreeManager: wtm, timestamp: stoppedAt,
    });
    return;

    } catch (err: any) {
      // P0-3: Unified exception boundary — prevent unhandled rejections from
      // silently breaking retry logic and leaving locks held indefinitely.
      const errMsg = err?.message || String(err);
      console.error('[Scheduler] Unhandled exception in execTask for task ' + tid + ': ' + errMsg);
      const errNow = new Date().toISOString();
      try {
        const latest = await this.store.getLatestAttempt(tid);
        if (latest && !['approved', 'failed', 'interrupted', 'canceled'].includes(latest.status)) {
          await this.store.updateAttemptStatus(latest.id, 'failed', errNow);
          await this.store.updateAttemptResult(latest.id, { exitReason: 'exception: ' + errMsg, stoppedAt: errNow });
        }
        const taskAfterError = await this.store.getTask(tid);
        if (taskAfterError && !['merged', 'failed', 'canceled', 'rejected'].includes(taskAfterError.status)) {
          await this.store.updateTaskStatus(tid, 'rework_required', errNow);
        }
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-exception'),
          runId, stageId: stage.id, taskId: tid,
          eventType: 'error',
          eventData: { reason: 'exec_task_exception', message: errMsg },
        });
      } catch { /* best-effort */ }
    } finally {
      // P0-3: Guarantee lock release on every path except intentional hard pause
      if (!preserveLocks) {
        await this.releaseLocks(tid, runId).catch(() => {});
      }
    }
  }

  /**
   * M4: Resume a task from worker_completed state after token budget pause.
   * Skips Pi re-execution (worktree/branch/WorkerResult already saved),
   * continues with quality gate → Codex review → integration.
   */
  private async resumeFromWorkerCompleted(
    attempt: AttemptRecord,
    spec: StructuredTaskSpec,
    stage: StageRecord, runId: string, base: string,
    wtm: WorktreeManager, dv: DiffScopeValidator,
  ): Promise<void> {
    const tid = attempt.taskId;
    const aid = attempt.id;
    const wp = attempt.worktreePath!;
    const bn = attempt.branchName!;
    const stoppedAt = new Date().toISOString();

    console.log('[Scheduler] Resuming from worker_completed for attempt ' + aid + ' (skipping Pi re-execution).');

    // Load saved WorkerResult
    let wrResult: WorkerResult | null = null;
    try {
      if (attempt.workerResultJson) wrResult = JSON.parse(attempt.workerResultJson);
    } catch { /* */ }

    if (!wrResult) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'resume: workerResult missing' });
      await this.releaseLocks(tid, runId);
      return;
    }

    // Verify worktree still exists
    const { existsSync } = await import('node:fs');
    if (!existsSync(wp)) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'resume: worktree missing: ' + wp });
      await this.releaseLocks(tid, runId);
      return;
    }

    const recoveryProof = this.readRecoveryAdoptionProof(attempt, wrResult);
    if (recoveryProof.kind === 'invalid') {
      await this.pauseForInvalidRecovery(runId, stage.id, tid, aid, recoveryProof.reason);
      return;
    }
    if (recoveryProof.kind === 'valid') {
      const currentCommit = wtm.getCurrentCommit(wp);
      if (currentCommit !== attempt.adoptedCommit) {
        await this.pauseForInvalidRecovery(runId, stage.id, tid, aid, 'adopted_commit_drift');
        return;
      }
      let currentBranch: string;
      try {
        currentBranch = git(wp, ['branch', '--show-current']);
      } catch {
        await this.pauseForInvalidRecovery(runId, stage.id, tid, aid, 'adopted_worktree_invalid');
        return;
      }
      if (currentBranch !== bn) {
        await this.pauseForInvalidRecovery(runId, stage.id, tid, aid, 'adopted_branch_drift');
        return;
      }
    }

    // Reuse the active locks kept by the hard-pause/recovery path. Recovery
    // additionally proves and locks every adopted changed path, including an
    // explicitly approved legacy TaskSpec expansion.
    const observedRecoveryPaths = recoveryProof.kind === 'valid' ? recoveryProof.changedFiles : [];
    const lps = this.lockPathsFor(spec, observedRecoveryPaths);
    const lockCheck = await this.verifyResumeLocks(runId, stage.id, tid, aid, lps);
    if (!lockCheck.ok) return;

    // Scope check
    const taskDiffBase = await this.getAttemptDiffBase(runId, aid, base);
    const ch = wtm.getChangedFiles(wp, taskDiffBase);
    let approvedRecoveryExpansion: string[] = [];
    if (recoveryProof.kind === 'valid') {
      const actualChangedFiles = this.canonicalRecoveryPaths(ch);
      if (actualChangedFiles.length !== recoveryProof.changedFileCount
        || this.hashRecoveryPaths(actualChangedFiles) !== recoveryProof.changedFilesHash) {
        await this.pauseForInvalidRecovery(runId, stage.id, tid, aid, 'adopted_changed_files_drift');
        return;
      }
      const scope = checkScopeExpansion(
        ch, spec.estimatedWritePaths ?? [], spec.allowedPaths ?? [], 0,
      );
      approvedRecoveryExpansion = this.canonicalRecoveryPaths([...scope.expandedFiles, ...scope.forbiddenFiles]);
      const expansionHash = approvedRecoveryExpansion.length > 0
        ? this.hashRecoveryPaths(approvedRecoveryExpansion) : null;
      if (approvedRecoveryExpansion.length !== recoveryProof.scopeExpansionFileCount
        || expansionHash !== recoveryProof.scopeExpansionFilesHash) {
        await this.pauseForInvalidRecovery(runId, stage.id, tid, aid, 'adopted_scope_expansion_drift');
        return;
      }
    }
    const taskAllowedPaths = spec.allowedPaths || [];
    const effectiveAllowedPaths = taskAllowedPaths.length === 0
      ? []
      : [...taskAllowedPaths, ...approvedRecoveryExpansion];
    await this.postWorkerHandler.handle({
      source: 'resume', runId, stage, taskId: tid, attemptId: aid, spec,
      workerResult: wrResult, branchName: bn, worktreePath: wp, reviewBase: base,
      changedFiles: ch, scopeValidator: dv, worktreeManager: wtm, timestamp: stoppedAt,
      effectiveAllowedPaths, recoveryExpansionApproved: recoveryProof.kind === 'valid',
    });
    return;

  }

  private canonicalRecoveryPaths(paths: string[]): string[] {
    return [...new Set(paths.map((value) => value.replace(/\\/g, '/').replace(/^\.\//, '')))].sort();
  }

  private hashRecoveryPaths(paths: string[]): string {
    return createHash('sha256').update(this.canonicalRecoveryPaths(paths).join('\n')).digest('hex');
  }

  private readRecoveryAdoptionProof(
    attempt: AttemptRecord,
    workerResult: WorkerResult,
  ):
    | { kind: 'none' }
    | { kind: 'invalid'; reason: string }
    | {
      kind: 'valid'; changedFiles: string[]; changedFileCount: number; changedFilesHash: string;
      scopeExpansionFileCount: number; scopeExpansionFilesHash: string | null;
    } {
    if (attempt.resultSource === 'pi') return { kind: 'none' };
    if (!['manual', 'codex_recovery'].includes(attempt.resultSource)
      || !attempt.adoptedCommit
      || workerResult.commitHash !== attempt.adoptedCommit) {
      return { kind: 'invalid', reason: 'adoption_provenance_invalid' };
    }

    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(attempt.adoptionMetadataJson || '{}') as Record<string, unknown>;
    } catch {
      return { kind: 'invalid', reason: 'adoption_metadata_invalid' };
    }
    const changedFiles = this.canonicalRecoveryPaths(workerResult.filesChanged || []);
    const changedFileCount = Number(metadata.changedFileCount);
    const changedFilesHash = typeof metadata.changedFilesHash === 'string' ? metadata.changedFilesHash : '';
    const scopeExpansionFileCount = Number(metadata.scopeExpansionFileCount);
    const scopeExpansionFilesHash = metadata.scopeExpansionFilesHash == null
      ? null : String(metadata.scopeExpansionFilesHash);
    if (!Number.isInteger(changedFileCount) || changedFileCount !== changedFiles.length
      || changedFilesHash !== this.hashRecoveryPaths(changedFiles)
      || !Number.isInteger(scopeExpansionFileCount) || scopeExpansionFileCount < 0
      || (scopeExpansionFileCount > 0 && !scopeExpansionFilesHash)
      || (scopeExpansionFileCount === 0 && scopeExpansionFilesHash !== null)) {
      return { kind: 'invalid', reason: 'adoption_metadata_mismatch' };
    }
    return {
      kind: 'valid', changedFiles, changedFileCount, changedFilesHash,
      scopeExpansionFileCount, scopeExpansionFilesHash,
    };
  }

  private async pauseForInvalidRecovery(
    runId: string,
    stageId: string,
    taskId: string,
    attemptId: string,
    detail: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.store.updateAttemptResult(attemptId, { exitReason: 'recovery_integrity_invalid: ' + detail });
    await this.recordStagePause({
      runId, stageId, taskId, attemptId,
      reasonCode: 'recovery_integrity_invalid', category: 'recovery',
      eventData: { detail }, createdAt: now,
    });
    console.log('[Scheduler] Resume paused for attempt ' + attemptId + ': recovery integrity invalid (' + detail + ').');
  }

  private expectedLockId(runId: string, taskId: string, filePath: string): string {
    const normalized = this.normalizeLockPath(filePath);
    // SHA-256 of the normalized path — must stay byte-identical with
    // SqliteStateStore.createDeterministicLockId and recover.ts lockId.
    return runId + '-lk-' + taskId + '-' + createHash('sha256').update(normalized).digest('hex');
  }

  private normalizeLockPath(filePath: string): string {
    return filePath.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/').toLowerCase();
  }

  private async verifyResumeLocks(
    runId: string,
    stageId: string,
    taskId: string,
    attemptId: string,
    filePaths: string[],
  ): Promise<{ ok: true; locks: PathLockRecord[] } | { ok: false }> {
    const activeLocks = await this.store.getActiveLocksForRun(runId);
    const byId = new Map(activeLocks.map((lock) => [lock.id, lock]));
    const validLocks: PathLockRecord[] = [];

    for (const fp of filePaths) {
      const lockId = this.expectedLockId(runId, taskId, fp);
      const lock = byId.get(lockId) || await this.store.getPathLock(lockId);
      const invalidReason = !lock ? 'missing'
        : lock.runId !== runId ? 'wrong_run'
          : lock.taskId !== taskId ? 'wrong_task'
            : this.normalizeLockPath(lock.filePath) !== this.normalizeLockPath(fp) ? 'wrong_path'
              : lock.status !== 'locked' ? 'not_active'
                : null;

      if (invalidReason) {
        await this.pauseForInvalidResumeLock(runId, stageId, taskId, attemptId, invalidReason, fp);
        return { ok: false };
      }

      validLocks.push(lock as PathLockRecord);
    }

    const conflicts = await this.store.getConflictingLocks(taskId, filePaths, runId);
    if (conflicts.length > 0) {
      await this.pauseForInvalidResumeLock(runId, stageId, taskId, attemptId, 'conflicting_owner', undefined, conflicts.length);
      return { ok: false };
    }

    return { ok: true, locks: validLocks };
  }

  private async pauseForInvalidResumeLock(
    runId: string,
    stageId: string,
    taskId: string,
    attemptId: string,
    reason: string,
    filePath?: string,
    conflictCount?: number,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.store.updateAttemptResult(attemptId, { exitReason: 'resume_path_lock_invalid: ' + reason });
    await this.recordStagePause({
      runId, stageId, taskId, attemptId,
      reasonCode: 'resume_path_lock_invalid', category: 'recovery',
      eventData: {
        detail: reason,
        filePath,
        conflictCount,
      },
      createdAt: now,
    });
    console.log('[Scheduler] Resume paused for attempt ' + attemptId + ': invalid path lock (' + reason + ').');
  }

  /** Thin orchestration seam retained for characterization tests. */
  private async integrate(
    stage: StageRecord,
    runId: string,
    worktrees: WorktreeManager,
    base: string,
  ): Promise<boolean> {
    return this.integrationCoordinator.integrate(stage, runId, worktrees, base);
  }

  private async releaseLocks(taskId: string, runId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const l of await this.store.getActiveLocksForRun(runId)) { if (l.taskId === taskId) await this.store.releasePathLock(l.id, now); }
  }
}
