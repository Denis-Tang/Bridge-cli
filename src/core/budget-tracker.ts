import type { StateStore } from '../state/state-store.js';
import type { ResourceSampler, ResourceSample, BudgetState } from '../types/m3-types.js';
import { computeBudget, deriveHardCap } from '../types/m3-types.js';

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

export class BudgetTracker {
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

