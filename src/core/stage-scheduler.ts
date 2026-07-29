import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import type { StateStore } from '../state/state-store.js';
import type { PathLockRecord, StageRecord, StructuredTaskSpec } from '../types/m2-types.js';
import type { WorkerResult, ReviewResult } from '../types/protocol.js';
import type { ResourceSampler, ResourceSample, BudgetState } from '../types/m3-types.js';
import { computeBudget, deriveHardCap } from '../types/m3-types.js';
import { canTransitionStage } from './state-machine.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import { DiffScopeValidator } from '../git/diff-scope-validator.js';
import { QualityGateRunner, type QualityGateConfig } from '../quality/quality-gate-runner.js';
import { PiRpcWorker } from '../adapters/pi-rpc-worker.js';
import { CodexCliReviewer } from '../adapters/codex-cli-reviewer.js';
import { CodexTechnicalClarifier } from '../adapters/codex-technical-clarifier.js';
import { LocalRuleReviewer } from '../adapters/local-rule-reviewer.js';
import { PrivacyService } from '../privacy/privacy-service.js';
import type { PiWorkerConfig } from '../adapters/pi-worker-types.js';
import { NoopResourceSampler } from './resource-sampler.js';
import type { WorkerConfig, ReviewerConfig } from '../adapters/project-adapter.js';
// ── M4 Governance imports ──
import { getGovernanceConfig, resetGovernanceConfigCache } from './decision-gate.js';
import { checkG2Approvable, checkG3Approvable, createG2Approval, createG3Approval } from './decision-gate.js';
import { checkScopeExpansion } from './scope-guard.js';
import { checkRetryBudget, shouldRetry, maxAllowedAttempts } from './retry-policy.js';
import { estimatePiWorkerTokens } from './token-ledger.js';
import { resolveExecutionMode, isTokenEfficientMode, type ExecutionModeConfig } from './execution-mode.js';
import { shouldDoTaskLevelReview } from './review-granularity.js';
import { ReviewResultCache } from './review-cache.js';
import { runStageReview, prepareStageReviewInput } from './stage-review.js';
import { preCheckBudget, postCheckBudget, isBudgetPaused } from './token-budget.js';
import { ensureDefaultPolicies } from './budget-policy-store.js';
import { SqliteLedgerSink } from './token-telemetry.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// ══════════════════════════════════════════════════════════════
// Convergence timeout — structured error for fail-closed propagation
// ══════════════════════════════════════════════════════════════

export class ConvergenceTimeoutError extends Error {
  public readonly details: {
    pendingCount: number;
    runId: string;
    stageId?: string;
    totalElapsedMs: number;
  };

  constructor(message: string, details: { pendingCount: number; runId: string; stageId?: string; totalElapsedMs: number }) {
    super(message);
    this.name = 'ConvergenceTimeoutError';
    this.details = details;
  }
}

// ══════════════════════════════════════════════════════════════
// M3 Budget Tracker — non-blocking, hysteresis-based dispatch
// ══════════════════════════════════════════════════════════════

class BudgetTracker {
  // ── Cached budget: sync-read by dispatch loop ──
  private cache: BudgetState;

  // ── Hysteresis counters ──
  private consecutiveCpuElevated = 0;  // cpuPressure > 0.85
  private consecutiveCpuHigh = 0;      // cpuPressure > 0.92
  private consecutiveSafe = 0;
  private consecutiveLowPi = 0;
  private dispatchPaused = false;
  private pauseReason: string | undefined;
  private firstSampleDone = false;     // allow initial ramp-up before hysteresis

  // ── Background refresh ──
  private sampler: ResourceSampler;
  private store: StateStore;
  private userMax: number;
  private hardCap: number;
  private samplingIntervalMs: number;
  private refreshPromise: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private runId: string;
  private stageId: string;
  private aborted = false;
  private stopped = false;

  // ── Pending write tracking: makes fire-and-forget DB ops awaitable for lifecycle convergence ──
  private pendingWrites: Set<Promise<void>> = new Set();
  private diagnosticErrors: Array<{ ts: string; kind: string; message: string }> = [];

  constructor(
    sampler: ResourceSampler,
    store: StateStore,
    userMax: number,
    hardCap: number,
    samplingIntervalMs: number,
    runId: string,
    stageId: string,
  ) {
    this.sampler = sampler;
    this.store = store;
    this.userMax = userMax;
    this.hardCap = hardCap;
    this.samplingIntervalMs = samplingIntervalMs;
    this.runId = runId;
    this.stageId = stageId;

    // Safe initial budget: 1 until first sample completes
    this.cache = {
      current: 1,
      userMax,
      hardCap,
      dispatchPaused: false,
    };
  }

  /** Synchronous — dispatch loop reads this without blocking */
  getBudget(): BudgetState {
    return this.cache;
  }

  /** Start background refresh loop */
  start(runId: string, stageId: string): void {
    this.runId = runId;
    this.stageId = stageId;
    this.stopped = false;
    // Kick off the self-scheduling loop
    this.scheduleNextRefresh();
  }

  /** Stop background refresh (graceful: allows in-flight refresh to complete) */
  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  isPaused(): boolean { return this.dispatchPaused; }
  getPauseReason(): string | undefined { return this.pauseReason; }
  hasFirstSample(): boolean { return this.firstSampleDone; }

  /** Update stageId as we move through stages */
  setStageId(stageId: string): void { this.stageId = stageId; }

  /**
   * Track a fire-and-forget DB write so lifecycle boundaries can await it.
   * The promise is removed from the set when it settles (success or failure).
   * Public so that startRun() can track cleanupResourceSamples.
   */
  trackWrite(p: Promise<unknown>): void {
    const voidP = p.then(() => {});
    this.pendingWrites.add(voidP);
    voidP.finally(() => { this.pendingWrites.delete(voidP); });
  }

  /**
   * Wait for all currently-pending fire-and-forget DB writes to settle.
   * Called at lifecycle boundaries (shutdown, fixture close, pre-assertion).
   *
   * Uses a proper timeout (default 5000ms). Loops until all pending writes
   * settle or the deadline is reached — tolerates new writes being added
   * during convergence (continuous background sampling).
   * On timeout, throws ConvergenceTimeoutError with diagnostic info.
   */
  async awaitIdle(timeoutMs = 5000): Promise<void> {
    if (this.pendingWrites.size === 0) return;

    const deadline = Date.now() + timeoutMs;

    while (this.pendingWrites.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const pending = [...this.pendingWrites].length;
        throw new ConvergenceTimeoutError(
          `BudgetTracker convergence timeout after ${timeoutMs}ms: ${pending} pending writes remain`,
          { pendingCount: pending, runId: this.runId, stageId: this.stageId || undefined, totalElapsedMs: timeoutMs },
        );
      }

      const batch = [...this.pendingWrites];
      // Race this batch against the remaining time budget.
      // If the batch completes, loop again (new writes may have been added).
      // If the batch times out, writes are truly stuck → throw.
      const result = await Promise.race([
        Promise.allSettled(batch).then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
      ]);

      if (result === 'timeout') {
        const pending = [...this.pendingWrites].length;
        throw new ConvergenceTimeoutError(
          `BudgetTracker single-batch timeout after ${timeoutMs}ms: ${pending} writes stuck`,
          { pendingCount: pending, runId: this.runId, stageId: this.stageId || undefined, totalElapsedMs: timeoutMs },
        );
      }
      // Batch settled — some writes may have resolved, loop to drain remainder
    }
  }

  /**
   * Return a snapshot of buffered diagnostic errors (sampling failures, write errors).
   * Cleared on read so each caller sees only new entries.
   */
  drainDiagnosticErrors(): Array<{ ts: string; kind: string; message: string }> {
    const copy = [...this.diagnosticErrors];
    this.diagnosticErrors.length = 0;
    return copy;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private scheduleNextRefresh(): void {
    if (this.stopped) return;
    // First refresh fires immediately; subsequent ones use samplingIntervalMs
    const delay = this.firstSampleDone ? this.samplingIntervalMs : 0;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.stopped) return;
      this.doRefresh()
        .catch((err) => {
          this.diagnosticErrors.push({
            ts: new Date().toISOString(),
            kind: 'refresh_exception',
            message: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          // Self-schedule next refresh
          this.scheduleNextRefresh();
        });
    }, delay);
  }

  private async doRefresh(): Promise<void> {
    // 1. Sample (may be slow — but this is the async path, not blocking dispatch)
    let sample: ResourceSample;
    try {
      sample = await this.sampler.sample();
    } catch {
      this.applyDegrade('sampling_exception');
      return;
    }

    // 2. Record sample to SQLite asynchronously (best-effort, don't await)
    this.recordSample(sample);

    if (sample.degraded) {
      this.applyDegrade(sample.degradeReason || 'degraded');
      return;
    }

    // 3. Recompute hardCap
    const hc = deriveHardCap(sample.cpu.cores);
    if (hc !== this.hardCap) this.hardCap = hc;

    // 4. Compute raw (candidate) budget
    const raw = computeBudget(sample, this.userMax, this.hardCap);

    // 5. Update hysteresis counters
    const cpuPressure = sample.cpu.usagePercent / 100;
    const memPressure = sample.memory.totalMb > 0 ? sample.memory.usagePercent / 100 : 0;

    if (cpuPressure > 0.92) {
      this.consecutiveCpuHigh++;
      this.consecutiveCpuElevated++;
      this.consecutiveSafe = 0;
      this.consecutiveLowPi = 0;
    } else if (cpuPressure > 0.85) {
      this.consecutiveCpuHigh = 0;
      this.consecutiveCpuElevated++;
      this.consecutiveSafe = 0;
      this.consecutiveLowPi = 0;
    } else {
      this.consecutiveCpuHigh = 0;
      this.consecutiveCpuElevated = 0;
    }

    const isPressured = cpuPressure > 0.80 || memPressure > 0.85
      || sample.piCount >= this.hardCap * 0.75;

    if (!isPressured) {
      this.consecutiveSafe++;
      if (sample.piCount < this.hardCap * 0.5) {
        this.consecutiveLowPi++;
      } else {
        this.consecutiveLowPi = 0;
      }
    } else {
      this.consecutiveSafe = 0;
      this.consecutiveLowPi = 0;
    }

    // 6. Apply hysteresis decisions — raw.current is a candidate
    const prevCached = this.dispatchPaused ? 0 : this.cache.current;
    let effectiveBudget = this.dispatchPaused ? 0 : this.cache.current;
    let decisionType: string | undefined;
    let decisionReason: string | undefined;

    // First successful sample: ramp up from safe budget=1 to raw budget immediately
    if (!this.firstSampleDone && !this.dispatchPaused) {
      this.firstSampleDone = true;
      effectiveBudget = raw.current;
      if (effectiveBudget !== prevCached) {
        decisionType = effectiveBudget > prevCached ? 'scale_up' : 'scale_down';
        decisionReason = 'initial_ramp';
      }
    }

    // Pause decisions
    if (!this.dispatchPaused) {
      if (this.consecutiveCpuHigh >= 2) {
        this.dispatchPaused = true;
        this.pauseReason = `cpu_critical:${(cpuPressure * 100).toFixed(0)}%`;
        effectiveBudget = 0;
        decisionType = 'pause';
        decisionReason = this.pauseReason;
      } else if (memPressure > 0.90) {
        this.dispatchPaused = true;
        this.pauseReason = `mem_critical:${(memPressure * 100).toFixed(0)}%`;
        effectiveBudget = 0;
        decisionType = 'pause';
        decisionReason = this.pauseReason;
      } else if (sample.piCount >= this.hardCap) {
        this.dispatchPaused = true;
        this.pauseReason = `pi_cap:${sample.piCount}/${this.hardCap}`;
        effectiveBudget = 0;
        decisionType = 'pause';
        decisionReason = this.pauseReason;
      } else if (raw.dispatchPaused) {
        this.dispatchPaused = true;
        this.pauseReason = raw.pauseReason || 'budget_paused';
        effectiveBudget = 0;
        decisionType = 'pause';
        decisionReason = this.pauseReason;
      }
    }

    // Resume: 2 consecutive safe cycles
    if (this.dispatchPaused && this.consecutiveSafe >= 2) {
      this.dispatchPaused = false;
      this.pauseReason = undefined;
      this.consecutiveSafe = 0;
      this.firstSampleDone = false; // allow ramp-up after resume
      effectiveBudget = raw.current;
      decisionType = 'resume';
      decisionReason = 'pressures_normalized';
    }

    // Scale down: cpu >85% for 3 consecutive cycles → apply raw budget
    if (!this.dispatchPaused && this.consecutiveCpuElevated >= 3 && !decisionType) {
      if (raw.current < prevCached && prevCached > 1) {
        effectiveBudget = raw.current;
        decisionType = 'scale_down';
        decisionReason = raw.pauseReason || `cpu_elevated:${(cpuPressure * 100).toFixed(0)}%`;
      }
    }

    // Scale up: low Pi + no pressure for 2 cycles → apply raw budget
    if (!this.dispatchPaused && this.consecutiveLowPi >= 2 && !decisionType) {
      if (raw.current > prevCached) {
        effectiveBudget = raw.current;
        decisionType = 'scale_up';
        decisionReason = `low_pi:${sample.piCount}/${this.hardCap}`;
      }
    }

    // 7. Update cache
    this.cache = {
      current: this.dispatchPaused ? 0 : effectiveBudget,
      userMax: this.userMax,
      hardCap: this.hardCap,
      dispatchPaused: this.dispatchPaused,
      pauseReason: this.dispatchPaused ? this.pauseReason : undefined,
    };

    // 8. Record decision on change (async, best-effort)
    if (decisionType) {
      this.recordDecision(decisionType, decisionReason || '', prevCached, effectiveBudget, sample);
    }
  }

  private applyDegrade(reason: string): void {
    const prev = this.dispatchPaused ? 0 : this.cache.current;
    if (!this.dispatchPaused || this.cache.current !== 1) {
      this.recordDecision('degrade', reason, prev, 1, null);
      this.trackWrite(
        this.store.createEvent({
          id: `${this.runId}-ev-degrade-${Date.now()}`,
          runId: this.runId,
          stageId: this.stageId,
          eventType: 'resource_sampling_degraded',
          eventData: { reason, previousBudget: prev, newBudget: 1 },
        }).catch((err) => {
          this.diagnosticErrors.push({
            ts: new Date().toISOString(),
            kind: 'degrade_event_write_error',
            message: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    this.dispatchPaused = false;
    this.pauseReason = `degraded: ${reason}`;
    this.consecutiveCpuElevated = 0;
    this.consecutiveCpuHigh = 0;
    this.consecutiveSafe = 0;
    this.consecutiveLowPi = 0;
    this.firstSampleDone = false; // allow re-ramp after recovery

    this.cache = {
      current: 1,
      userMax: this.userMax,
      hardCap: this.hardCap,
      dispatchPaused: false,
      pauseReason: this.pauseReason,
    };
  }

  // ── Async best-effort DB writes (fire-and-forget with pending tracking) ──

  private recordSample(sample: ResourceSample): void {
    this.trackWrite(
      this.store.insertResourceSample({
        id: `${this.runId}-rs-${Date.now()}`,
        runId: this.runId,
        timestamp: new Date().toISOString(),
        cpuPct: sample.cpu.usagePercent,
        memTotalMb: sample.memory.totalMb,
        memUsedMb: sample.memory.usedMb,
        memPct: sample.memory.usagePercent,
        piActive: sample.piCount,
        budget: this.dispatchPaused ? 0 : this.cache.current,
        dispatchPaused: this.dispatchPaused ? 1 : 0,
        pauseReason: this.pauseReason || null,
        degraded: sample.degraded ? 1 : 0,
        degradeReason: sample.degradeReason || null,
        source: sample.source,
      }).catch((err) => {
        this.diagnosticErrors.push({
          ts: new Date().toISOString(),
          kind: 'record_sample_write_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }

  private recordDecision(
    decisionType: string,
    reason: string,
    previousBudget: number,
    newBudget: number,
    sample: ResourceSample | null,
  ): void {
    this.trackWrite(
      this.store.insertDispatchDecision({
        id: `${this.runId}-dd-${Date.now()}`,
        runId: this.runId,
        timestamp: new Date().toISOString(),
        decisionType,
        reason,
        previousBudget,
        newBudget,
        sampleJson: sample ? JSON.stringify(sample) : null,
      }).catch((err) => {
        this.diagnosticErrors.push({
          ts: new Date().toISOString(),
          kind: 'record_decision_write_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }),
    );

    this.trackWrite(
      this.store.createEvent({
        id: `${this.runId}-ev-budget-${Date.now()}`,
        runId: this.runId,
        stageId: this.stageId,
        eventType: decisionType === 'pause' ? 'dispatch_paused'
          : decisionType === 'resume' ? 'dispatch_resumed'
          : decisionType === 'scale_down' ? 'budget_scaled_down'
          : decisionType === 'scale_up' ? 'budget_scaled_up'
          : 'resource_sampling_degraded',
        eventData: { decisionType, reason, previousBudget, newBudget },
      }).catch((err) => {
        this.diagnosticErrors.push({
          ts: new Date().toISOString(),
          kind: 'record_decision_event_write_error',
          message: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }
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

  constructor(store: StateStore, config: Partial<SchedulerConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sampler = this.config.resourceSampler || new NoopResourceSampler();
    this.modeConfig = resolveExecutionMode(this.config);
    this.reviewCache = new ReviewResultCache({
      enabled: this.config.reviewCacheEnabled !== false,
    });
  }

  private nextEventId(runId: string, prefix: string): string {
    return `${runId}-${prefix}-${Date.now()}-${++this.eventSeq}`;
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
      const run = await this.store.getRun(runId);
      if (!run) return;
      // Never overwrite explicitly canceled runs
      if (run.status === 'canceled') return;
      // Already failed — no-op
      if (run.status === 'failed') return;

      const now = new Date().toISOString();
      await this.store.updateRunStatus(runId, 'failed', now);
      await this.store.updateRunFinishedAt(runId, now);
      await this.store.createEvent({
        id: `${runId}-ev-convergence-fail-${Date.now()}`,
        runId,
        eventType: 'error',
        eventData: { reason: 'convergence_failure', detail: reason },
      }).catch(() => {});
    } catch {
      // Must never throw — cleanup is best-effort
    }
  }

  private async reconcile(runId: string): Promise<void> {
    const now = new Date().toISOString();
    const stages = await this.store.listStages(runId);
    for (const stage of stages) {
      if (stage.status === 'completed' || stage.status === 'canceled') continue;
      const attempts = await this.store.listAttemptsByStage(stage.id);
      for (const attempt of attempts) {
        if (attempt.status !== 'running' || attempt.piPid == null) continue;
        let alive = false;
        try {
          if (process.platform === 'win32') {
            const out = execFileSync('tasklist', ['/FI', `PID eq ${attempt.piPid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe', encoding: 'utf-8' });
            alive = out.includes('"' + attempt.piPid + '"');
          } else {
            process.kill(attempt.piPid, 0);
            alive = true;
          }
        } catch { alive = false; }
        if (!alive) {
          await this.store.updateAttemptStatus(attempt.id, 'interrupted', now);
          await this.store.updateAttemptResult(attempt.id, { exitReason: 'reconciled: PID ' + attempt.piPid + ' missing', stoppedAt: now });
          await this.store.createEvent({ id: runId + '-ev-rec-' + Date.now(), runId, stageId: stage.id, taskId: attempt.taskId, attemptId: attempt.id, eventType: 'attempt_interrupted', eventData: { reason: 'reconciled', pid: attempt.piPid } });
          for (const l of await this.store.getActiveLocksForRun(runId)) { if (l.taskId === attempt.taskId) await this.store.releasePathLock(l.id, now); }
          console.log('[Scheduler] Reconciled: attempt ' + attempt.id + ' (PID ' + attempt.piPid + ') marked interrupted.');
        }
      }
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
      if (stage.status === 'pending' || stage.status === 'ready') {
        if (canTransitionStage(stage.status as any, 'running')) {
          await this.store.updateStageStatus(stage.id, 'running', now);
          await this.store.createEvent({ id: runId + '-ev-stage-' + Date.now(), runId, stageId: stage.id, eventType: 'stage_started', eventData: { stageNumber: stage.stageNumber } });
        }
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
      if (bs.length > 0 && bs[bs.length - 1].mergeCommitHash) return bs[bs.length - 1].mergeCommitHash!;
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

  /**
   * Real execution may only proceed when the completed WorkerResult is backed
   * by an actual branch diff touching an expected path. Fake-only scheduler
   * tests remain a state-machine simulation and are intentionally excluded.
   */
  private async verifyCompletionEvidence(
    attemptId: string,
    taskId: string,
    stage: StageRecord,
    runId: string,
    workerResult: WorkerResult,
    branchName: string,
    changedFiles: string[],
    spec: StructuredTaskSpec,
    timestamp: string,
    worktreePath?: string,
  ): Promise<boolean> {
    if (!this.config.allowRealWorker && !this.config.allowRealReviewer) return true;

    const expected = spec.estimatedWritePaths || [];
    const touchesExpectedPath = expected.some((expectedPath) => changedFiles.some((changedPath) =>
      changedPath === expectedPath || changedPath.startsWith(expectedPath.endsWith('/') ? expectedPath : expectedPath + '/'),
    ));
    // Primary check: worker did write files matching estimated paths
    const hasExpectedPath = workerResult.status === 'completed'
      && Boolean(branchName)
      && changedFiles.length > 0
      && touchesExpectedPath;
    if (hasExpectedPath) return true;

    // Fallback check (P0-BENCH-02): git diff confirms files were written,
    // but estimatedWritePaths didn't capture them. Verify file existence in worktree
    // as a backup signal instead of blindly rejecting.
    if (workerResult.status === 'completed' && Boolean(branchName) && changedFiles.length > 0 && !touchesExpectedPath) {
      const wp = worktreePath;
      if (wp) {
        const { existsSync } = await import('node:fs');
        const filesExist = changedFiles.every((f) =>
          existsSync(resolve(wp, f))
        );
        if (filesExist) {
          console.log('[Scheduler] Completion evidence accepted via file-existence fallback (P0-BENCH-02).');
          return true;
        }
      }
      // Still reject if files don't actually exist or worktree path unknown
    }

    const reason = workerResult.status !== 'completed'
      ? 'worker_result_not_completed'
      : changedFiles.length === 0
        ? 'worker_completed_without_verifiable_diff'
        : !touchesExpectedPath
          ? 'expected_write_missing'
          : 'worker_completion_evidence_missing';
    await this.blockUnverifiableCompletion(attemptId, taskId, stage, runId, timestamp, reason, {
      branchName: Boolean(branchName),
      changedFileCount: changedFiles.length,
      expectedWritePathCount: expected.length,
    });
    return false;
  }

  private async blockUnverifiableCompletion(
    attemptId: string,
    taskId: string,
    stage: StageRecord,
    runId: string,
    timestamp: string,
    reason: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.store.updateAttemptStatus(attemptId, 'failed', timestamp);
    await this.store.updateTaskStatus(taskId, 'failed', timestamp);
    await this.store.updateAttemptResult(attemptId, { exitReason: reason, stoppedAt: timestamp });
    await this.store.updateStageStatus(stage.id, 'paused', timestamp);
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-unverifiable-completion'), runId, stageId: stage.id, taskId, attemptId,
      eventType: 'attempt_failed',
      eventData: { reason, ...detail },
    });
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-unverifiable-pause'), runId, stageId: stage.id,
      eventType: 'stage_paused',
      eventData: { reason, taskId, attemptId },
    });
    console.log('[Scheduler] Completion evidence rejected for attempt ' + attemptId + ': ' + reason + '.');
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
        await this.store.updateStageStatus(stage.id, 'paused', now);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-dependency-baseline-missing'), runId, stageId: stage.id, taskId, attemptId,
          eventType: 'stage_paused', eventData: { reason: 'dependency_baseline_unavailable', dependencyId },
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
        await this.store.updateStageStatus(stage.id, 'paused', now);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-dependency-baseline-conflict'), runId, stageId: stage.id, taskId, attemptId,
          eventType: 'stage_paused', eventData: { reason: 'dependency_baseline_conflict', dependencyId, message: error?.message || String(error) },
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
      await this.store.updateStageStatus(stage.id, 'paused', now);
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-undeclared-same-path'), runId, stageId: stage.id,
        eventType: 'stage_paused', eventData: { reason: 'undeclared_same_path_conflict', conflicts: undeclaredSamePathConflicts },
      });
      console.log('[Scheduler] Stage ' + stage.stageNumber + ' paused: same-path tasks require a dependency edge.');
      return false;
    }

    const done = new Set<string>();
    const exhausted = new Set<string>(); // tasks that exhausted retry budget
    let fail = false;
    const wtm = new WorktreeManager(this.config.projectRoot, { worktreeBaseDir: this.config.worktreeBaseDir });
    const dv = new DiffScopeValidator();

    while (done.size + exhausted.size < tasks.length && !fail) {
      if (await this.aborted()) return false;
      // A run can be canceled externally while a worker/reviewer promise is in
      // flight. Do not schedule another attempt after that promise returns:
      // canceled work must not satisfy dependencies or consume retry budget.
      const currentRun = await this.store.getRun(runId);
      if (!currentRun || currentRun.status === 'canceled') return false;
      const cur = await this.store.getStage(stage.id);
      if (!cur || cur.status === 'paused' || cur.status === 'canceled') return false;

      const runnable: Array<{ task: typeof tasks[0]; spec: StructuredTaskSpec }> = [];
      for (const t of tasks) {
        if (done.has(t.id) || exhausted.has(t.id)) continue;
        const sp = specs.get(t.id);
        if (!sp) continue;
        if (!sp.dependencies.every((d) => done.has(d))) continue;
        const lat = await this.store.getLatestAttempt(t.id);
        const paths = [...new Set([...(sp.estimatedWritePaths || ['src/']), ...this.config.defaultLockedPaths])];
        if ((!lat || lat.status !== 'worker_completed') && (await this.store.getConflictingLocks(t.id, paths, runId)).length > 0) continue;
        if (lat && lat.status === 'approved') { done.add(t.id); continue; }

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
              await this.store.updateStageStatus(stage.id, 'paused', now);
              await this.store.createEvent({
                id: this.nextEventId(runId, 'ev-retry-exhausted-pause'),
                runId, stageId: stage.id,
                eventType: 'stage_paused',
                eventData: { reason: 'retry_budget_exhausted', taskId: t.id, maxReworkCount: this.config.maxReworkCount },
              });
              fail = true; break;
            }
            // Non-retriable (scope/security/privacy/product-decision/unverifiable) → pause stage for human decision
            await this.store.updateStageStatus(stage.id, 'paused', now);
            await this.store.createEvent({
              id: this.nextEventId(runId, 'ev-non-retriable-pause'),
              runId, stageId: stage.id, taskId: t.id,
              eventType: 'stage_paused',
              eventData: { reason: 'non_retriable_failure', taskId: t.id, failureCategory: budget.failureCategory || 'unknown', detail: budget.reason },
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
      if (fail) break;
      if (runnable.length === 0) {
        if (done.size === tasks.length) break;
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
            const paths = [...new Set([...(sp.estimatedWritePaths || ['src/']), ...this.config.defaultLockedPaths])];
            const conflicts = (lat && lat.status !== 'worker_completed') ? await this.store.getConflictingLocks(t.id, paths, runId) : [];
            if (conflicts.length > 0) {
              blockedTasks.push({ taskId: t.id, reason: 'path_lock_conflict', missingDeps: [], lockConflicts: conflicts.length });
              continue;
            }
            blockedTasks.push({ taskId: t.id, reason: 'unknown_deadlock', missingDeps: [], lockConflicts: 0 });
          }
          await this.store.updateStageStatus(stage.id, 'paused', now);
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-deadlock'),
            runId, stageId: stage.id,
            eventType: 'stage_paused',
            eventData: { reason: 'stage_deadlock', blockedTasks, stageNumber: stage.stageNumber },
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
      const pool: Promise<void>[] = [];
      let blockedByGovernance = 0;
      for (const { task, spec } of runnable.slice(0, dispatchLimit)) {
        if (pool.length >= dispatchLimit) break;

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
          const lockPaths = [...new Set([...(spec.estimatedWritePaths || ['src/']), ...this.config.defaultLockedPaths])];
          const lockResult = await this.store.acquirePathLocksAtomic({ runId, taskId: task.id, filePaths: lockPaths, lockType: 'exclusive' });
          if (!lockResult.acquired) {
            await this.store.createEvent({
              id: this.nextEventId(runId, 'ev-lock-blocked'), runId, stageId: stage.id, taskId: task.id,
              eventType: 'stage_paused',
              eventData: { reason: 'path_lock_unavailable', conflicts: lockResult.conflicts.length, violations: lockResult.violations },
            }).catch(() => {});
            continue;
          }
        }
        // Wrap execTask with catch to handle unhandled rejections with task context
        const taskRef = task;
        pool.push(
          this.execTask(task, spec, stage, runId, base, wtm, dv).catch(async (err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[Scheduler] execTask unhandled rejection for task ' + taskRef.id + ': ' + errMsg);
            const errNow = new Date().toISOString();
            try {
              await this.store.updateTaskStatus(taskRef.id, 'failed', errNow);
              await this.store.updateStageStatus(stage.id, 'paused', errNow);
              await this.store.createEvent({
                id: this.nextEventId(runId, 'ev-pool-rejection-task'),
                runId, stageId: stage.id, taskId: taskRef.id,
                eventType: 'error',
                eventData: { reason: 'exec_task_pool_rejection', message: errMsg, taskId: taskRef.id },
              });
              await this.releaseLocks(taskRef.id, runId);
            } catch { /* best-effort */ }
            throw err; // re-throw so allSettled still sees it
          }),
        );
      }

      // If all runnable tasks are blocked by governance, pause stage and exit
      if (blockedByGovernance > 0 && pool.length === 0) {
        console.log('[Scheduler] All tasks blocked by governance. Pausing stage ' + stage.stageNumber + '.');
        await this.store.updateStageStatus(stage.id, 'paused', new Date().toISOString());
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-gov-pause'), runId, stageId: stage.id,
          eventType: 'stage_paused',
          eventData: { reason: 'governance_blocked', blockedTasks: blockedByGovernance },
        });
        return false;
      }

      const settled = await Promise.allSettled(pool);
      // P0-3: Log any rejections that would otherwise be silently swallowed
      for (const result of settled) {
        if (result.status === 'rejected') {
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          console.error('[Scheduler] execTask rejection: ' + errMsg);
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-pool-rejection'),
            runId, stageId: stage.id,
            eventType: 'error',
            eventData: { reason: 'exec_task_rejection', message: errMsg },
          }).catch(() => {});
        }
      }
    }

    if (!fail) {
      // Any exhausted task (non-retriable or retry-exhausted) prevents stage integration
      if (exhausted.size > 0) {
        console.log('[Scheduler] Stage has ' + exhausted.size + ' exhausted task(s); integration blocked.');
        const now = new Date().toISOString();
        await this.store.updateStageStatus(stage.id, 'paused', now);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-exhausted-integration-blocked'),
          runId, stageId: stage.id,
          eventType: 'stage_paused',
          eventData: { reason: 'exhausted_tasks_block_integration', exhaustedTaskIds: [...exhausted] },
        });
        return false;
      }

      let allOk = true;
      let hasMergeBlocked = false;
      let hasReviewSkipped = false;
      for (const t of tasks) {
        const l = await this.store.getLatestAttempt(t.id);
        // Accept both approved and review_skipped as "ready for integration"
        if (!l || (l.status !== 'approved' && l.status !== 'review_skipped')) { allOk = false; break; }
        if (l.status === 'review_skipped') { hasReviewSkipped = true; }
        // Also check current task status: merge_blocked tasks cannot be integrated again
        const ct = await this.store.getTask(t.id);
        if (ct?.status === 'merge_blocked') { hasMergeBlocked = true; }
      }
      if (hasMergeBlocked) {
        console.log('[Scheduler] Stage has merge_blocked task(s); integration permanently blocked.');
        return false;
      }
      if (allOk) {
        await this.integrate(stage, runId, wtm, base);
      } else {
        // Not all tasks approved — stage cannot complete
        console.log('[Scheduler] Stage incomplete: not all tasks approved.');
        const now = new Date().toISOString();
        await this.store.updateStageStatus(stage.id, 'paused', now);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-stage-incomplete'),
          runId, stageId: stage.id,
          eventType: 'stage_paused',
          eventData: { reason: 'stage_incomplete_not_all_approved' },
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

    await this.store.updateTaskStatus(tid, 'running', new Date().toISOString());
    const pn = (await this.store.getLatestAttempt(tid))?.attemptNumber ?? 0;
    const an = pn + 1;
    const aid = runId + '-att-' + tid + '-a' + an;
    const bn = 'brainctl/' + runId + '/' + tid + '/a' + an;
    const wr = this.config.worktreeBaseDir + '/' + runId + '/' + tid + '/a' + an;
    const wp = resolve(this.config.projectRoot, wr);
    const sd = resolve(this.config.projectRoot, this.config.sessionDir);
    const ld = resolve(this.config.projectRoot, this.config.logDir);
    mkdirSync(sd, { recursive: true }); mkdirSync(ld, { recursive: true });

    await this.store.createAttempt({ id: aid, taskId: tid, stageId: stage.id, attemptNumber: an, status: 'running' });

    try { wtm.createBranch(bn, base); wtm.createWorktree(bn, wr); }
    catch (e: any) {
      await this.store.updateAttemptStatus(aid, 'failed', new Date().toISOString());
      await this.store.updateTaskStatus(tid, 'failed', new Date().toISOString());
      await this.store.updateAttemptResult(aid, { exitReason: 'wt_fail: ' + (e.message || String(e)), stoppedAt: new Date().toISOString(), worktreePath: wp, branchName: bn });
      await this.releaseLocks(tid, runId); return;
    }
    const attemptStartedAt = new Date().toISOString();
    await this.store.updateAttemptResult(aid, { worktreePath: wp, branchName: bn, startedAt: attemptStartedAt });

    if (!(await this.mergeDependencyBaselines(wp, spec, stage, runId, tid, aid))) {
      await this.releaseLocks(tid, runId);
      return;
    }
    const taskDiffBase = git(wp, ['rev-parse', 'HEAD']);
    await this.recordAttemptDiffBase(runId, stage.id, tid, aid, taskDiffBase);

    let wrResult: WorkerResult | null = null;
    let pid: number | null = null;
    let exitReason: string | undefined;
    let rawLog: string | undefined;
    let ph: string | undefined;
    let stoppedAt = new Date().toISOString();

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
      // P0-2: Privacy gate before real Provider spawn
      if (this.config.privacyService) {
        const spawnGate = this.config.privacyService.canSpawnRealProvider();
        if (!spawnGate.allowed) {
          console.error('[Scheduler] Real Pi spawn blocked: ' + spawnGate.reason);
          await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
          await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
          await this.store.updateAttemptResult(aid, { exitReason: 'privacy_gate_blocked: ' + spawnGate.reason, stoppedAt });
          await this.releaseLocks(tid, runId);
          return;
        }
      }
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
        requireClarification: this.config.requireWorkerClarification ?? !this.config.piProcessRunner,
        env: this.config.privacyService?.buildProviderEnv('pi', undefined, this.config.workerConfig?.model),
        clarificationResponder: new CodexTechnicalClarifier({
          command: this.config.reviewerConfig?.command || 'codex',
          args: this.config.reviewerConfig?.args ?? ['exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '-'],
          timeoutMs: this.config.reviewerConfig?.timeoutMs ?? 120_000,
          env: this.config.privacyService?.buildProviderEnv('codex'),
        }, this.config.codexProcessRunner),
        onProcessSpawn: async (spawnedPid) => {
          await this.store.updateAttemptResult(aid, { piPid: spawnedPid, startedAt: attemptStartedAt });
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-attempt-spawned'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
            eventType: 'attempt_started',
            eventData: { pid: spawnedPid },
          });
        },
      };
      const pi = new PiRpcWorker(cfg, this.config.piProcessRunner, { ledgerSink: piLedgerSink, invocationContext: piInvocationCtx });
      const r = await pi.executeTask({ taskSpec: spec, worktreePath: wp, runId });
      stoppedAt = new Date().toISOString();
      wrResult = r.workerResult; pid = r.pid ?? null; exitReason = r.errorMessage; rawLog = r.rawLogPath;
      if (!wrResult) {
        const detail = exitReason || 'Pi did not return a valid WorkerResult';
        const reason = `worker_result_missing: ${detail}`;
        await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
        await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
        await this.store.updateAttemptResult(aid, { piPid: pid, stoppedAt, exitReason: reason, rawLogPath: rawLog || null, promptHash: null as any, workerResultJson: null });
        await this.store.createEvent({ id: runId + '-ev-wr-missing-' + Date.now(), runId, stageId: stage.id, taskId: tid, attemptId: aid, eventType: 'attempt_failed', eventData: { reason: 'worker_result_missing', pid } });
        console.log('[Scheduler] WorkerResult MISSING for attempt ' + aid + ' — marked failed (no manual completion).');
        await this.releaseLocks(tid, runId);
        return;
      }
      ph = undefined;
    } else {
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
        await this.store.updateStageStatus(stage.id, 'paused', new Date().toISOString());
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-pause-budget'), runId, stageId: stage.id,
          eventType: 'stage_paused',
          eventData: { reason: 'token_budget_exceeded', policyType: 'pi_attempt' },
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
      await this.store.updateStageStatus(stage.id, 'paused', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'product_decision: ' + (exitReason || 'product_decision_required') });
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-product-decision'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
        eventType: 'stage_paused',
        eventData: { reason: 'product_decision_required', unresolvedQuestions: wrResult.unresolvedQuestions },
      });
      await this.releaseLocks(tid, runId);
      return;
    }
    if (wrResult && (wrResult.status === 'blocked' || wrResult.status === 'needs_decision')) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'blocked: ' + wrResult.status });
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-worker-blocked'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
        eventType: 'attempt_failed',
        eventData: { reason: 'worker_blocked', workerStatus: wrResult.status },
      });
      await this.releaseLocks(tid, runId);
      return;
    }
    if (!wrResult || wrResult.status === 'failed' || wrResult.status === 'scope_violation') { await this.store.updateAttemptStatus(aid, 'failed', stoppedAt); await this.store.updateTaskStatus(tid, 'failed', stoppedAt); await this.releaseLocks(tid, runId); return; }
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
    const sv = dv.validate(ch, spec.allowedPaths || [], spec.forbiddenPaths || []);
    if (!sv.valid || sv.violations.length > 0) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'scope: ' + sv.violations.join('; ') });
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-scope-violation'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
        eventType: 'attempt_failed',
        eventData: { reason: 'scope_violation', violations: sv.violations, forbiddenFiles: sv.forbiddenFiles },
      });
      await this.releaseLocks(tid, runId);
      return;
    }

    if (!await this.verifyCompletionEvidence(aid, tid, stage, runId, wrResult, bn, ch, spec, stoppedAt, wp)) {
      await this.releaseLocks(tid, runId);
      return;
    }

    // ── M4: Scope expansion guard (only when governance enabled) ──
    if (this.config.governanceEnabled && ch.length > 0) {
      const scopeResult = checkScopeExpansion(ch, spec.estimatedWritePaths || ['src/'], spec.allowedPaths || []);
      if (scopeResult.expanded) {
        await createG2Approval(this.store, runId, tid, 'scope_expansion',
          `Scope expansion: ${(scopeResult.expansionPct * 100).toFixed(1)}% outside estimate`);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-scope'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
          eventType: 'scope_expansion',
          eventData: { taskId: tid, expansionPct: scopeResult.expansionPct, expandedCount: scopeResult.expandedFiles.length },
        });
        console.log('[Scheduler] Scope expansion detected for task ' + tid + ' — G2 approval created.');
        await this.store.updateAttemptStatus(aid, 'rework_required', stoppedAt);
        await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
        await this.store.updateStageStatus(stage.id, 'paused', stoppedAt);
        await this.releaseLocks(tid, runId);
        return;
      }
    }

    if (await this.stopIfCanceled(runId, stage.id, tid, aid, 'before_quality_gate')) {
      await this.releaseLocks(tid, runId);
      return;
    }


    await this.store.updateAttemptStatus(aid, 'validating', stoppedAt);
    await this.store.updateTaskStatus(tid, 'validating', stoppedAt);
    const gs = this.config.taskQualityGates ?? this.config.qualityGates ?? [];
    if (gs.length > 0) {
      const qgStart = Date.now();
      const qgr = await new QualityGateRunner(wp).runGates(gs, true);
      const qgDurationMs = Date.now() - qgStart;
      await this.store.createEvent({ id: runId + '-ev-qg-' + Date.now(), runId, stageId: stage.id, taskId: tid, attemptId: aid, eventType: 'review_completed', eventData: { kind: 'quality_gate', passed: qgr.passed, summary: qgr.summary, results: qgr.results, durationMs: qgDurationMs } });
      if (!qgr.passed) {
        await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
        await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
        await this.store.updateAttemptResult(aid, { exitReason: 'qg_failed: ' + qgr.summary });
        await this.releaseLocks(tid, runId);
        return;
      }
    } else {
      console.log('[Scheduler] FATAL: No quality gates configured for task ' + tid + '. Marking stage incomplete — stage cannot complete without quality gates.');
      await this.store.createEvent({ id: runId + '-ev-nogate-' + Date.now(), runId, stageId: stage.id, taskId: tid, attemptId: aid, eventType: 'error', eventData: { reason: 'no_quality_gates_configured', fatal: true } });
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'no_quality_gates_configured: 缺少阶段级质量门，不能标 completed' });
      await this.store.updateStageStatus(stage.id, 'paused', stoppedAt);
      await this.store.createEvent({ id: runId + '-ev-stage-nogate-' + Date.now(), runId, stageId: stage.id, eventType: 'stage_paused', eventData: { reason: 'no_quality_gates_configured' } });
      await this.releaseLocks(tid, runId);
      return;
    }

    if (await this.stopIfCanceled(runId, stage.id, tid, aid, 'before_review')) {
      await this.releaseLocks(tid, runId);
      return;
    }

    // ── Token-Efficient: Skip per-task Codex review for low/medium risk tasks ──
    const attemptNumber = (await this.store.getLatestAttempt(tid))?.attemptNumber ?? 1;
    const isRetry = attemptNumber > 1;
    if (isTokenEfficientMode(this.modeConfig.mode) &&
        !shouldDoTaskLevelReview(spec, wrResult, true, this.modeConfig.mode, isRetry)) {
      // Skip per-task review — approve directly from quality gate passage
      await this.store.updateAttemptStatus(aid, 'review_skipped', stoppedAt);
      await this.store.updateTaskStatus(tid, 'review_skipped', stoppedAt);
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-review-skipped'),
        runId, stageId: stage.id, taskId: tid, attemptId: aid,
        eventType: 'review_skipped_token_efficient',
        eventData: { reason: 'token_efficient_mode', mode: this.modeConfig.mode, riskLevel: spec.riskLevel },
      });
      console.log('[Scheduler] Token-efficient: skipped per-task Codex review for ' + tid + ' (risk=' + spec.riskLevel + ')');

      // Record zero-token ledger entry for skipped review
      if (this.config.governanceEnabled) {
        const skipSink = new SqliteLedgerSink(this.store);
        const skipCtx: import('../core/token-telemetry.js').InvocationContext = {
          runId, stageId: stage.id, taskId: tid, attemptId: aid,
          callType: 'codex_review_skipped', callId: aid + '-skipped', model: 'none',
          synthetic: false,
        };
        await skipSink.writeEstimate(skipCtx, 0, 0, 0);
        await skipSink.confirmActual(aid + '-skipped', 0, 0, 0, 0, 0);
      }

      await this.releaseLocks(tid, runId);
      return;
    }

    await this.store.updateAttemptStatus(aid, 'reviewing', stoppedAt);
    await this.store.updateTaskStatus(tid, 'reviewing', stoppedAt);
    const diff = wtm.getDiff(wp, base);
    const configuredReviewerType = this.config.reviewerConfig?.type || 'codex-cli';
    const rv = await this.store.createReview({ id: runId + '-rv-' + aid, attemptId: aid, taskId: tid, reviewerType: configuredReviewerType, status: 'running' });

    // ── M4: Create LedgerSink for Codex review (only when governance enabled) ──
    let reviewLedgerSink: SqliteLedgerSink | null = null;
    let reviewInvocationCtx: import('../core/token-telemetry.js').InvocationContext | null = null;
    if (this.config.governanceEnabled) {
      reviewLedgerSink = new SqliteLedgerSink(this.store);
      reviewInvocationCtx = {
        runId, stageId: stage.id, taskId: tid, attemptId: aid,
        callType: 'codex_review', callId: rv.id, model: 'codex-cli',
      };
    }

    let rr: ReviewResult;
    if (this.config.allowRealReviewer && (!diff || diff.trim().length === 0)) {
      await this.blockUnverifiableCompletion(aid, tid, stage, runId, stoppedAt, 'real_reviewer_empty_diff');
      await this.store.updateReviewResult(rv.id, { status: 'failed', reviewJson: JSON.stringify({ taskId: tid, status: 'rejected', reviewSummary: 'real reviewer blocked: empty diff', findings: ['real_reviewer_empty_diff'], requiredRework: [], qualityGateStatus: 'not_run', mergeAllowed: false, reviewer: 'codex-cli' }), findingsJson: JSON.stringify(['real_reviewer_empty_diff']), requiredReworkJson: '[]', mergeAllowed: false, finishedAt: new Date().toISOString() });
      await this.releaseLocks(tid, runId);
      return;
    } else if (this.config.allowRealReviewer) {
      // P0-2: Privacy gate before real Provider spawn
      if (this.config.privacyService) {
        const spawnGate = this.config.privacyService.canSpawnRealProvider();
        if (!spawnGate.allowed) {
          console.error('[Scheduler] Real Codex review spawn blocked: ' + spawnGate.reason);
          await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
          await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
          await this.store.updateAttemptResult(aid, { exitReason: 'privacy_gate_blocked: ' + spawnGate.reason, stoppedAt });
          await this.releaseLocks(tid, runId);
          return;
        }
      }
      rr = await new CodexCliReviewer(
        { workDir: wp, sessionDir: sd, allowRealReview: true, timeoutMs: this.config.reviewerConfig?.timeoutMs ?? 120000, command: this.config.reviewerConfig?.command, args: this.config.reviewerConfig?.args, env: this.config.privacyService?.buildProviderEnv('codex') },
        { processRunner: this.config.codexProcessRunner, ledgerSink: reviewLedgerSink, invocationContext: reviewInvocationCtx },
      ).reviewDiff(diff, tid);
    } else {
      rr = configuredReviewerType === 'local-rule'
        ? new LocalRuleReviewer().reviewDiff(diff, tid)
        : this.config.fakeReviewResult || { taskId: tid, status: 'approved', reviewSummary: 'fake ok', findings: [], requiredRework: [], qualityGateStatus: 'passed', mergeAllowed: true, reviewer: configuredReviewerType };
      console.log('[Scheduler] Local/fake review mode: attempt ' + aid + ' using ' + configuredReviewerType + '.');
    }

    await this.store.updateReviewResult(rv.id, { status: (rr.status === 'rejected' ? 'rework_required' : rr.status) as any, reviewJson: JSON.stringify(rr), findingsJson: JSON.stringify(rr.findings || []), requiredReworkJson: JSON.stringify(rr.requiredRework || []), mergeAllowed: rr.mergeAllowed, finishedAt: new Date().toISOString() });
    if (await this.stopIfCanceled(runId, stage.id, tid, aid, 'before_approve')) {
      await this.releaseLocks(tid, runId);
      return;
    }
    if (rr.status === 'approved' && rr.mergeAllowed) { await this.store.updateAttemptStatus(aid, 'approved', new Date().toISOString()); await this.store.updateTaskStatus(tid, 'approved', new Date().toISOString()); }
    else { await this.store.updateAttemptStatus(aid, 'rework_required', new Date().toISOString()); await this.store.updateTaskStatus(tid, 'rework_required', new Date().toISOString()); await this.store.updateAttemptResult(aid, { exitReason: 'review: ' + rr.reviewSummary }); }

    // ── M4: Post-check after Codex review (adapter already wrote estimate/confirmed/unavailable) ──
    if (this.config.governanceEnabled && reviewInvocationCtx) {
      const reviewTokens = diff ? diff.split('\n').length * 2 + 500 : 500;
      const rpc = await postCheckBudget(this.store, runId, 'codex_review_stage', reviewTokens).catch(() => null);
      if (rpc && rpc.exceeded) {
        console.log('[Scheduler] Codex review budget exceeded for stage ' + stage.stageNumber + ': ' + rpc.remaining + '/' + rpc.limit);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-review-exceeded'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
          eventType: 'token_budget_exceeded',
          eventData: { policyType: 'codex_review_stage', remaining: rpc.remaining, limit: rpc.limit },
        });
        await this.store.updateStageStatus(stage.id, 'paused', new Date().toISOString());
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-pause-review'), runId, stageId: stage.id,
          eventType: 'stage_paused',
          eventData: { reason: 'token_budget_exceeded', policyType: 'codex_review_stage' },
        });
      }
    }

    await this.releaseLocks(tid, runId);
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
        await this.store.updateTaskStatus(tid, 'failed', errNow);
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
    attempt: import('../types/m2-types.js').AttemptRecord,
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

    // Reuse the active locks kept by the hard-pause path. Recreating them would
    // collide with the deterministic lock id and could also hide ownership drift.
    const lps = [...new Set([...(spec.estimatedWritePaths || ['src/']), ...this.config.defaultLockedPaths])];
    const lockCheck = await this.verifyResumeLocks(runId, stage.id, tid, aid, lps);
    if (!lockCheck.ok) return;

    // Load saved WorkerResult
    let wrResult: WorkerResult | null = null;
    try {
      if (attempt.workerResultJson) wrResult = JSON.parse(attempt.workerResultJson);
    } catch { /* */ }

    if (!wrResult) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'resume: workerResult missing' });
      await this.releaseLocks(tid, runId);
      return;
    }

    // Verify worktree still exists
    const { existsSync } = await import('node:fs');
    if (!existsSync(wp)) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'resume: worktree missing: ' + wp });
      await this.releaseLocks(tid, runId);
      return;
    }

    // Scope check
    const taskDiffBase = await this.getAttemptDiffBase(runId, aid, base);
    const ch = wtm.getChangedFiles(wp, taskDiffBase);
    const sv = dv.validate(ch, spec.allowedPaths || [], spec.forbiddenPaths || []);
    if (!sv.valid || sv.violations.length > 0) {
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'scope: ' + sv.violations.join('; ') });
      await this.releaseLocks(tid, runId);
      return;
    }

    if (!await this.verifyCompletionEvidence(aid, tid, stage, runId, wrResult, bn, ch, spec, stoppedAt, wp)) {
      await this.releaseLocks(tid, runId);
      return;
    }

    // ── M4: Scope expansion guard ──
    if (this.config.governanceEnabled && ch.length > 0) {
      const scopeResult = checkScopeExpansion(ch, spec.estimatedWritePaths || ['src/'], spec.allowedPaths || []);
      if (scopeResult.expanded) {
        await createG2Approval(this.store, runId, tid, 'scope_expansion',
          `Scope expansion: ${(scopeResult.expansionPct * 100).toFixed(1)}% outside estimate`);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-scope'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
          eventType: 'scope_expansion',
          eventData: { taskId: tid, expansionPct: scopeResult.expansionPct, expandedCount: scopeResult.expandedFiles.length },
        });
        await this.store.updateAttemptStatus(aid, 'rework_required', stoppedAt);
        await this.store.updateTaskStatus(tid, 'waiting_decision', stoppedAt);
        await this.store.updateStageStatus(stage.id, 'paused', stoppedAt);
        await this.releaseLocks(tid, runId);
        return;
      }
    }

    if (await this.stopIfCanceled(runId, stage.id, tid, aid, 'before_quality_gate_resume')) {
      await this.releaseLocks(tid, runId);
      return;
    }

    // Quality gate
    await this.store.updateAttemptStatus(aid, 'validating', stoppedAt);
    await this.store.updateTaskStatus(tid, 'validating', stoppedAt);
    const gs = this.config.taskQualityGates ?? this.config.qualityGates ?? [];
    if (gs.length > 0) {
      const qgStart = Date.now();
      const qgr = await new QualityGateRunner(wp).runGates(gs, true);
      const qgDurationMs = Date.now() - qgStart;
      await this.store.createEvent({ id: runId + '-ev-qg-' + Date.now(), runId, stageId: stage.id, taskId: tid, attemptId: aid, eventType: 'review_completed', eventData: { kind: 'quality_gate', passed: qgr.passed, summary: qgr.summary, results: qgr.results, durationMs: qgDurationMs } });
      if (!qgr.passed) {
        await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
        await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
        await this.store.updateAttemptResult(aid, { exitReason: 'qg_failed: ' + qgr.summary });
        await this.releaseLocks(tid, runId);
        return;
      }
    } else {
      console.log('[Scheduler] FATAL: No quality gates configured for resumed task ' + tid + '.');
      await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
      await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
      await this.store.updateAttemptResult(aid, { exitReason: 'no_quality_gates_configured' });
      await this.store.updateStageStatus(stage.id, 'paused', stoppedAt);
      await this.releaseLocks(tid, runId);
      return;
    }

    if (await this.stopIfCanceled(runId, stage.id, tid, aid, 'before_review_resume')) {
      await this.releaseLocks(tid, runId);
      return;
    }

    // Codex review
    await this.store.updateAttemptStatus(aid, 'reviewing', stoppedAt);
    await this.store.updateTaskStatus(tid, 'reviewing', stoppedAt);
    const diff = wtm.getDiff(wp, base);
    const configuredReviewerType = this.config.reviewerConfig?.type || 'codex-cli';
    const rv = await this.store.createReview({ id: runId + '-rv-' + aid, attemptId: aid, taskId: tid, reviewerType: configuredReviewerType, status: 'running' });

    let reviewLedgerSink: SqliteLedgerSink | null = null;
    let reviewInvocationCtx: import('../core/token-telemetry.js').InvocationContext | null = null;
    if (this.config.governanceEnabled) {
      reviewLedgerSink = new SqliteLedgerSink(this.store);
      reviewInvocationCtx = { runId, stageId: stage.id, taskId: tid, attemptId: aid, callType: 'codex_review', callId: rv.id, model: 'codex-cli' };
    }

    const sd = resolve(this.config.projectRoot, this.config.sessionDir);
    let rr: ReviewResult;
    if (this.config.allowRealReviewer && (!diff || diff.trim().length === 0)) {
      await this.blockUnverifiableCompletion(aid, tid, stage, runId, stoppedAt, 'real_reviewer_empty_diff');
      await this.store.updateReviewResult(rv.id, { status: 'failed', reviewJson: JSON.stringify({ taskId: tid, status: 'rejected', reviewSummary: 'real reviewer blocked: empty diff', findings: ['real_reviewer_empty_diff'], requiredRework: [], qualityGateStatus: 'not_run', mergeAllowed: false, reviewer: 'codex-cli' }), findingsJson: JSON.stringify(['real_reviewer_empty_diff']), requiredReworkJson: '[]', mergeAllowed: false, finishedAt: new Date().toISOString() });
      await this.releaseLocks(tid, runId);
      return;
    } else if (this.config.allowRealReviewer) {
      // P0-2: Privacy gate before real Provider spawn
      if (this.config.privacyService) {
        const spawnGate = this.config.privacyService.canSpawnRealProvider();
        if (!spawnGate.allowed) {
          console.error('[Scheduler] Real Codex review spawn blocked (resume): ' + spawnGate.reason);
          await this.store.updateAttemptStatus(aid, 'failed', stoppedAt);
          await this.store.updateTaskStatus(tid, 'failed', stoppedAt);
          await this.store.updateAttemptResult(aid, { exitReason: 'privacy_gate_blocked: ' + spawnGate.reason, stoppedAt });
          await this.releaseLocks(tid, runId);
          return;
        }
      }
      rr = await new CodexCliReviewer(
        { workDir: wp, sessionDir: sd, allowRealReview: true, timeoutMs: this.config.reviewerConfig?.timeoutMs ?? 120000, command: this.config.reviewerConfig?.command, args: this.config.reviewerConfig?.args, env: this.config.privacyService?.buildProviderEnv('codex') },
        { processRunner: this.config.codexProcessRunner, ledgerSink: reviewLedgerSink, invocationContext: reviewInvocationCtx },
      ).reviewDiff(diff, tid);
    } else {
      rr = configuredReviewerType === 'local-rule'
        ? new LocalRuleReviewer().reviewDiff(diff, tid)
        : this.config.fakeReviewResult || { taskId: tid, status: 'approved', reviewSummary: 'fake ok', findings: [], requiredRework: [], qualityGateStatus: 'passed', mergeAllowed: true, reviewer: configuredReviewerType };
      console.log('[Scheduler] Local/fake review mode (resume): attempt ' + aid + ' using ' + configuredReviewerType + '.');
    }

    await this.store.updateReviewResult(rv.id, { status: (rr.status === 'rejected' ? 'rework_required' : rr.status) as any, reviewJson: JSON.stringify(rr), findingsJson: JSON.stringify(rr.findings || []), requiredReworkJson: JSON.stringify(rr.requiredRework || []), mergeAllowed: rr.mergeAllowed, finishedAt: new Date().toISOString() });
    if (await this.stopIfCanceled(runId, stage.id, tid, aid, 'before_approve_resume')) {
      await this.releaseLocks(tid, runId);
      return;
    }
    if (rr.status === 'approved' && rr.mergeAllowed) { await this.store.updateAttemptStatus(aid, 'approved', new Date().toISOString()); await this.store.updateTaskStatus(tid, 'approved', new Date().toISOString()); }
    else { await this.store.updateAttemptStatus(aid, 'rework_required', new Date().toISOString()); await this.store.updateTaskStatus(tid, 'rework_required', new Date().toISOString()); await this.store.updateAttemptResult(aid, { exitReason: 'review: ' + rr.reviewSummary }); }

    // ── M4: Post-check after Codex review ──
    if (this.config.governanceEnabled && reviewInvocationCtx) {
      const reviewTokens = diff ? diff.split('\n').length * 2 + 500 : 500;
      const rpc = await postCheckBudget(this.store, runId, 'codex_review_stage', reviewTokens).catch(() => null);
      if (rpc && rpc.exceeded) {
        console.log('[Scheduler] Codex review budget exceeded for resumed stage ' + stage.stageNumber + ': ' + rpc.remaining + '/' + rpc.limit);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-review-exceeded'), runId, stageId: stage.id, taskId: tid, attemptId: aid,
          eventType: 'token_budget_exceeded',
          eventData: { policyType: 'codex_review_stage', remaining: rpc.remaining, limit: rpc.limit },
        });
        await this.store.updateStageStatus(stage.id, 'paused', new Date().toISOString());
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-pause-review'), runId, stageId: stage.id,
          eventType: 'stage_paused',
          eventData: { reason: 'token_budget_exceeded', policyType: 'codex_review_stage' },
        });
      }
    }

    await this.releaseLocks(tid, runId);
    console.log('[Scheduler] Resume complete for attempt ' + aid + ' (status: ' + (rr.status === 'approved' ? 'approved' : 'rework_required') + ')');
  }

  private expectedLockId(runId: string, taskId: string, filePath: string): string {
    const normalized = this.normalizeLockPath(filePath);
    return runId + '-lk-' + taskId + '-' + normalized.replace(/[^a-zA-Z0-9]/g, '_');
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
    await this.store.updateStageStatus(stageId, 'paused', now);
    await this.store.updateAttemptResult(attemptId, { exitReason: 'resume_path_lock_invalid: ' + reason });
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-resume-lock-invalid'),
      runId, stageId, taskId, attemptId,
      eventType: 'stage_paused',
      eventData: {
        reason: 'resume_path_lock_invalid',
        detail: reason,
        filePath,
        conflictCount,
      },
    });
    console.log('[Scheduler] Resume paused for attempt ' + attemptId + ': invalid path lock (' + reason + ').');
  }

  private async integrate(stage: StageRecord, runId: string, wtm: WorktreeManager, base: string): Promise<void> {
    const now = new Date().toISOString();
    const ib = 'brainctl/int/' + runId + '/stage-' + stage.stageNumber;
    await this.store.updateStageIntegrationBranch(stage.id, ib);
    await this.store.updateStageStatus(stage.id, 'integration', now);
    const batch = await this.store.createIntegrationBatch({ id: runId + '-batch-' + stage.id, stageId: stage.id, runId, integrationBranch: ib });
    const stageTasks = await this.tasksForStage(stage, runId);

    const gs = this.config.stageQualityGates ?? this.config.qualityGates ?? [];
    if (gs.length === 0) {
      console.log('[Scheduler] Cannot integrate stage ' + stage.stageNumber + ': no quality gates configured.');
      await this.store.updateIntegrationBatch(batch.id, { status: 'failed', finishedAt: now });
      await this.store.updateStageStatus(stage.id, 'paused', now);
      await this.mergeBlockApprovedTasks(stageTasks, now);
      await this.store.createEvent({ id: runId + '-ev-int-nogate-' + Date.now(), runId, stageId: stage.id, eventType: 'error', eventData: { reason: 'no_quality_gates_configured', stage: stage.stageNumber } });
      return;
    }
    const unapprovedTasks = stageTasks.filter((task) => task.status !== 'approved' && task.status !== 'review_skipped');
    if (unapprovedTasks.length > 0) {
      await this.store.updateIntegrationBatch(batch.id, { status: 'failed', conflictsJson: JSON.stringify({ reason: 'integration_with_unapproved_tasks', taskIds: unapprovedTasks.map((task) => task.id) }), finishedAt: now });
      await this.store.updateStageStatus(stage.id, 'paused', now);
      await this.mergeBlockApprovedTasks(stageTasks, now);
      await this.store.createEvent({ id: this.nextEventId(runId, 'ev-unapproved-integration'), runId, stageId: stage.id, eventType: 'stage_paused', eventData: { reason: 'integration_with_unapproved_tasks', taskIds: unapprovedTasks.map((task) => task.id) } });
      console.log('[Scheduler] Refusing integration: task approval invariant failed.');
      return;
    }

    if (this.config.governanceEnabled) {
      const pendingG2: string[] = [];
      for (const task of stageTasks) {
        const g2 = await checkG2Approvable(this.store, runId, task.id);
        if (!g2.approvable) pendingG2.push(task.id);
      }
      if (pendingG2.length > 0) {
        await this.store.updateIntegrationBatch(batch.id, { status: 'failed', conflictsJson: JSON.stringify({ reason: 'pending_g2_before_integration', taskIds: pendingG2 }), finishedAt: now });
        await this.store.updateStageStatus(stage.id, 'paused', now);
        await this.mergeBlockApprovedTasks(stageTasks, now);
        await this.store.createEvent({ id: this.nextEventId(runId, 'ev-pending-g2-integration'), runId, stageId: stage.id, eventType: 'stage_paused', eventData: { reason: 'pending_g2_before_integration', taskIds: pendingG2 } });
        console.log('[Scheduler] Refusing integration: pending G2 approval exists.');
        return;
      }
    }

    try {
      wtm.createBranch(ib, base);
      const ir = this.config.worktreeBaseDir + '/' + runId + '/int/stage-' + stage.stageNumber;
      const ip = resolve(this.config.projectRoot, ir);
      mkdirSync(dirname(ip), { recursive: true });
      wtm.createWorktree(ib, ir);

      const atts = await this.store.listAttemptsByStage(stage.id);
      const bs: string[] = [];
      const skippedTaskBranches: Array<{ taskId: string; branchName: string; diff: string }> = [];
      for (const a of atts) {
        if ((a.status === 'approved' || a.status === 'review_skipped') && a.branchName) {
          bs.push(a.branchName);
          if (a.status === 'review_skipped') {
            try {
              const aDiff = git(this.config.projectRoot, ['diff', `${base}..${a.branchName}`]);
              skippedTaskBranches.push({ taskId: a.taskId, branchName: a.branchName, diff: aDiff });
            } catch { /* skip */ }
          }
        }
      }

      for (const b of bs) {
        try { git(ip, ['merge', '--no-ff', '--no-edit', '--', b]); }
        catch (e: any) {
          const ev = { branch: b, message: e.message || String(e) };
          const pausedAt = new Date().toISOString();
          await this.store.updateIntegrationBatch(batch.id, { status: 'conflict', conflictsJson: JSON.stringify(ev), finishedAt: pausedAt });
          await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({ id: runId + '-ev-conflict-' + Date.now(), runId, stageId: stage.id, eventType: 'integration_conflict', eventData: ev });
          console.log('[Scheduler] Integration conflict ' + b + '.'); return;
        }
      }

      if (await this.stopIfCanceled(runId, stage.id, null, null, 'before_stage_quality_gate')) return;

      const qg = new QualityGateRunner(ip);
      const qgResult = await qg.runGates(gs, true);
      await this.store.createEvent({ id: runId + '-ev-int-qg-' + Date.now(), runId, stageId: stage.id, eventType: 'review_completed', eventData: { kind: 'stage_quality_gate', passed: qgResult.passed, summary: qgResult.summary, results: qgResult.results } });
      if (!qgResult.passed) {
        const pausedAt = new Date().toISOString();
        console.log('[Scheduler] Stage-level quality gates failed for stage ' + stage.stageNumber + ': ' + qgResult.summary);
        await this.store.updateIntegrationBatch(batch.id, { status: 'failed', finishedAt: pausedAt });
        await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
        await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
        await this.store.createEvent({ id: runId + '-ev-qg-fail-' + Date.now(), runId, stageId: stage.id, eventType: 'stage_failed', eventData: { reason: 'stage_quality_gates_failed', summary: qgResult.summary } });
        return;
      }

      const mh = git(ip, ['rev-parse', 'HEAD']);
      await this.store.updateIntegrationBatch(batch.id, { status: 'completed', mergeCommitHash: mh, baseCommit: base, finishedAt: new Date().toISOString() });

      // ── M4: G3 Merge Gate check before target branch merge ──
      if (await this.stopIfCanceled(runId, stage.id, null, null, 'before_integration_merge')) return;

      if (this.config.governanceEnabled) {
        const g3Check = await checkG3Approvable(this.store, runId, stage.id);
        if (!g3Check.approvable) {
          const pausedAt = new Date().toISOString();
          console.log('[Scheduler] G3 blocked integration for stage ' + stage.stageNumber + ' (' + g3Check.pendingDecisions.length + ' pending)');
          await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-g3-block'), runId, stageId: stage.id,
            eventType: 'stage_paused',
            eventData: { reason: 'g3_pending_approval', stageNumber: stage.stageNumber },
          });
          return;
        }

        // Check for large diff (estimate: count total lines from all attempts' diffs)
        let totalDiffLines = 0;
        for (const att of atts) {
          if (att.status === 'approved' && att.branchName) {
            try {
              const diffOut = git(this.config.projectRoot, ['diff', `${base}..${att.branchName}`, '--stat']);
              const lastLine = diffOut.trim().split('\n').pop() || '';
              const match = lastLine.match(/(\d+) insertion/);
              const insertions = match ? parseInt(match[1], 10) : 0;
              const delMatch = lastLine.match(/(\d+) deletion/);
              const deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
              totalDiffLines += insertions + deletions;
            } catch { /* skip */ }
          }
        }

        if (totalDiffLines > 500) {
          const pausedAt = new Date().toISOString();
          await createG3Approval(this.store, runId, stage.id, 'large_merge',
            `Merge diff exceeds 500 lines (${totalDiffLines} total)`);
          console.log('[Scheduler] Large merge diff for stage ' + stage.stageNumber + ' — G3 approval created.');
          await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-large-merge'), runId, stageId: stage.id,
            eventType: 'stage_paused',
            eventData: { reason: 'large_merge_diff', diffLines: totalDiffLines },
          });
          return;
        }

        // Token budget post-check for stage
        const budgetCheck = await preCheckBudget(this.store, runId, 'codex_review_stage', 10000);
        if (!budgetCheck.allowed) {
          const pausedAt = new Date().toISOString();
          await createG3Approval(this.store, runId, stage.id, 'stage_budget_override',
            budgetCheck.reason || 'stage_budget_exceeded');
          console.log('[Scheduler] Stage budget exceeded for stage ' + stage.stageNumber + ' — G3 approval created.');
          await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({
            id: runId + '-ev-budget-merge-' + Date.now(), runId, stageId: stage.id,
            eventType: 'token_budget_exceeded',
            eventData: { policyType: 'codex_review_stage', remaining: budgetCheck.remaining, limit: budgetCheck.limit },
          });
          return;
        }
      }

      // ── Token-Efficient: Stage-level aggregated Codex review ──
      if (skippedTaskBranches.length > 0 && isTokenEfficientMode(this.modeConfig.mode)) {
        console.log('[Scheduler] Running stage-level aggregated review for ' + skippedTaskBranches.length + ' skipped tasks in stage ' + stage.stageNumber);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-stage-review-start'),
          runId, stageId: stage.id,
          eventType: 'stage_review_started',
          eventData: { taskCount: skippedTaskBranches.length, stageNumber: stage.stageNumber },
        });

        const aggregatedDiff = skippedTaskBranches.map(t => t.diff).join('\n\n');
        const taskGateResults = stageTasks
          .filter(t => skippedTaskBranches.some(s => s.taskId === t.id))
          .map(t => ({ taskId: t.id, passed: true, summary: 'quality gate passed' }));
        const reviewInput = prepareStageReviewInput(stage, aggregatedDiff, taskGateResults);

        let stageReviewLedgerSink: SqliteLedgerSink | null = null;
        let stageReviewCtx: import('../core/token-telemetry.js').InvocationContext | null = null;
        if (this.config.governanceEnabled) {
          stageReviewLedgerSink = new SqliteLedgerSink(this.store);
          stageReviewCtx = {
            runId, stageId: stage.id,
            callType: 'stage_review', callId: `${runId}-stage-review-${stage.stageNumber}`,
            model: 'codex-cli', synthetic: !this.config.allowRealReviewer,
          };
        }

        const stageReviewResult = await runStageReview(
          reviewInput, base, this.reviewCache, this.store, runId, stage.id,
          {
            workDir: ip,
            sessionDir: resolve(this.config.projectRoot, this.config.sessionDir),
            allowRealReview: this.config.allowRealReviewer,
            timeoutMs: this.config.reviewerConfig?.timeoutMs ?? 120000,
            command: this.config.reviewerConfig?.command,
            args: this.config.reviewerConfig?.args,
            codexProcessRunner: this.config.codexProcessRunner,
            ledgerSink: stageReviewLedgerSink ?? undefined,
            invocationContext: stageReviewCtx ?? undefined,
          },
        );

        if (!stageReviewResult.passed) {
          const pausedAt = new Date().toISOString();
          console.log('[Scheduler] Stage-level review FAILED for stage ' + stage.stageNumber + '. Promoting to task-level reviews.');
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-stage-review-fail'),
            runId, stageId: stage.id,
            eventType: 'stage_review_failed',
            eventData: { findings: stageReviewResult.reviewResult.findings },
          });
          await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          return;
        }

        // Stage review passed — approve all skipped tasks
        const approvedAt = new Date().toISOString();
        if (await this.stopIfCanceled(runId, stage.id, null, null, 'before_stage_review_approve')) return;
        for (const st of skippedTaskBranches) {
          await this.store.updateAttemptStatus(
            (await this.store.getLatestAttempt(st.taskId))?.id || '',
            'approved', approvedAt,
          );
          await this.store.updateTaskStatus(st.taskId, 'approved', approvedAt);
        }
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-stage-review-ok'),
          runId, stageId: stage.id,
          eventType: 'stage_review_completed',
          eventData: { cacheHit: stageReviewResult.cacheHit, approvedTasks: skippedTaskBranches.map(s => s.taskId) },
        });
        console.log('[Scheduler] Stage-level review PASSED for stage ' + stage.stageNumber + ' (' + (stageReviewResult.cacheHit ? 'cache hit' : 'fresh review') + ')');
      }

      let targetBranch = this.config.targetBranch;
      try {
        const currentBranch = git(this.config.projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        try { git(this.config.projectRoot, ['rev-parse', '--verify', '--end-of-options', targetBranch]); }
        catch { console.log('[Scheduler] Target branch ' + targetBranch + ' not found. Using current branch: ' + currentBranch); targetBranch = currentBranch; }
        const worktreeList = git(this.config.projectRoot, ['worktree', 'list', '--porcelain']);
        const checkedOutBranches = worktreeList.split('\n').filter((line) => line.startsWith('branch ')).map((line) => line.replace(/^branch refs\/heads\//, '').trim());
        if (currentBranch !== targetBranch) {
          if (checkedOutBranches.some((b) => b === targetBranch || b === 'refs/heads/' + targetBranch)) {
            console.log('[Scheduler] WARNING: target branch ' + targetBranch + ' checked out in another worktree. Attempting checkout in main worktree.');
          }
          git(this.config.projectRoot, ['checkout', targetBranch]);
        }
        git(this.config.projectRoot, ['merge', '--no-ff', '--no-edit', '--', ib]);
        const targetMergeCommit = git(this.config.projectRoot, ['rev-parse', 'HEAD']);
        await this.store.updateIntegrationBatch(batch.id, { mergeCommitHash: targetMergeCommit, targetMergeCommit: targetMergeCommit, finishedAt: new Date().toISOString() });
        await this.store.createEvent({ id: runId + '-ev-target-merge-' + Date.now(), runId, stageId: stage.id, eventType: 'integration_completed', eventData: { targetBranch, targetMergeCommit, integrationBranch: ib } });
        console.log('[Scheduler] Target branch merge complete: ' + ib + ' -> ' + targetBranch + ' (' + targetMergeCommit + ')');
      } catch (mergeErr: any) {
        const errMsg = mergeErr.message || String(mergeErr);
        const pausedAt = new Date().toISOString();
        console.log('[Scheduler] Target branch merge conflict: ' + errMsg);
        await this.store.updateIntegrationBatch(batch.id, { status: 'conflict', conflictsJson: JSON.stringify({ error: errMsg, integrationBranch: ib, targetBranch }), finishedAt: pausedAt });
        await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
        await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
        await this.store.createEvent({ id: runId + '-ev-target-conflict-' + Date.now(), runId, stageId: stage.id, eventType: 'integration_conflict', eventData: { integrationBranch: ib, targetBranch, error: errMsg } });
        return;
      }

      const mergedAt = new Date().toISOString();
      for (const task of stageTasks) {
        await this.store.updateTaskStatus(task.id, 'merged', mergedAt);
      }
      await this.store.updateStageStatus(stage.id, 'completed', mergedAt);
      await this.store.createEvent({ id: runId + '-ev-int-ok-' + Date.now(), runId, stageId: stage.id, eventType: 'stage_completed', eventData: { stageNumber: stage.stageNumber, targetBranch, targetMergeCommit: git(this.config.projectRoot, ['rev-parse', 'HEAD']) } });
      console.log('[Scheduler] Stage ' + stage.stageNumber + ' integrated + merged to ' + targetBranch + '.');
      if (this.config.cleanupMergedWorktrees || this.config.allowRealWorker || this.config.allowRealReviewer) {
        await this.cleanupMergedStageWorktrees(runId, stage.id, wtm, atts, ib, ip);
      }
    } catch (e: any) {
      const pausedAt = new Date().toISOString();
      await this.store.updateIntegrationBatch(batch.id, { status: 'failed', conflictsJson: JSON.stringify({ error: e.message }), finishedAt: pausedAt });
      await this.store.updateStageStatus(stage.id, 'paused', pausedAt);
      await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
    }
  }

  private async cleanupMergedStageWorktrees(
    runId: string,
    stageId: string,
    wtm: WorktreeManager,
    attempts: Awaited<ReturnType<StateStore['listAttemptsByStage']>>,
    integrationBranch: string,
    integrationWorktreePath: string,
  ): Promise<void> {
    const warnings: string[] = [];
    const cleanupBranch = async (branchName: string, worktreePath?: string | null): Promise<void> => {
      try {
        await wtm.cleanupWorktree(branchName, worktreePath || undefined);
        wtm.deleteBranch(branchName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(branchName + ': ' + message.split('\n')[0]);
      }
    };

    await cleanupBranch(integrationBranch, integrationWorktreePath);
    for (const attempt of attempts) {
      if (attempt.status !== 'approved' || !attempt.branchName) continue;
      await cleanupBranch(attempt.branchName, attempt.worktreePath);
    }

    if (warnings.length > 0) {
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-cleanup-warning'),
        runId, stageId,
        eventType: 'cleanup_warning',
        eventData: { warnings },
      });
      console.log('[Scheduler] Cleanup warning after merge: ' + warnings.join('; '));
    }
  }

  /**
   * When integration fails (conflict/failed batch), mark all approved tasks
   * as merge_blocked so downstream consumers never mistake approved for merged.
   */
  private async mergeBlockApprovedTasks(
    stageTasks: Array<{ id: string; status: string }>,
    timestamp: string,
  ): Promise<void> {
    for (const task of stageTasks) {
      if (task.status === 'approved' || task.status === 'review_skipped') {
        await this.store.updateTaskStatus(task.id, 'merge_blocked', timestamp);
      }
    }
  }

  private async releaseLocks(taskId: string, runId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const l of await this.store.getActiveLocksForRun(runId)) { if (l.taskId === taskId) await this.store.releasePathLock(l.id, now); }
  }
}
