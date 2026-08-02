// ── M3 Resource Sampling & Status Visualization Types ──────────────────

import type { ReconciliationStatusSummary } from './m5-types.js';

// ══════════════════════════════════════════════════════════════
// Resource Sample
// ══════════════════════════════════════════════════════════════

export interface ResourceSample {
  cpu: { usagePercent: number; cores: number };
  memory: { totalMb: number; usedMb: number; freeMb: number; usagePercent: number };
  piCount: number;
  source: 'os' | 'cim' | 'tasklist' | 'fallback' | 'portable_noop';
  degraded: boolean;
  degradeReason?: string;
}

export interface ResourceSampler {
  sample(): Promise<ResourceSample>;
}

// ══════════════════════════════════════════════════════════════
// Budget
// ══════════════════════════════════════════════════════════════

export interface BudgetState {
  current: number;
  userMax: number;
  hardCap: number;
  dispatchPaused: boolean;
  pauseReason?: string;
}

/**
 * Compute the effective budget from a resource sample.
 * Returns the budget state without mutating any scheduler state.
 */
export function computeBudget(
  sample: ResourceSample,
  userMaxParallel: number,
  hardCap: number,
): BudgetState {
  if (sample.degraded) {
    // All sampling failed: budget = 1, serial only
    return {
      current: 1,
      userMax: userMaxParallel,
      hardCap,
      dispatchPaused: false,
      pauseReason: `degraded: ${sample.degradeReason || 'unknown'}`,
    };
  }

  const cpuPressure = sample.cpu.usagePercent / 100;
  const memPressure = sample.memory.totalMb > 0 ? sample.memory.usagePercent / 100 : 0;
  const piPressure = hardCap > 0 ? sample.piCount / hardCap : 0;

  let budgetMultiplier = 1.0;
  const reasons: string[] = [];

  // CPU pressure
  if (cpuPressure > 0.92) {
    budgetMultiplier *= 0.25;
    reasons.push(`cpu_high:${(cpuPressure * 100).toFixed(0)}%`);
  } else if (cpuPressure > 0.80) {
    budgetMultiplier *= 0.5;
    reasons.push(`cpu_elevated:${(cpuPressure * 100).toFixed(0)}%`);
  }

  // Memory pressure
  if (memPressure > 0.92) {
    budgetMultiplier = 0;
    reasons.push(`mem_critical:${(memPressure * 100).toFixed(0)}%`);
  } else if (memPressure > 0.85) {
    budgetMultiplier *= 0.5;
    reasons.push(`mem_high:${(memPressure * 100).toFixed(0)}%`);
  }

  // Pi count pressure
  if (piPressure > 0.90) {
    budgetMultiplier = 0;
    reasons.push(`pi_critical:${sample.piCount}/${hardCap}`);
  } else if (piPressure > 0.75) {
    budgetMultiplier *= 0.6;
    reasons.push(`pi_high:${sample.piCount}/${hardCap}`);
  }

  const dispatchPaused = budgetMultiplier === 0;
  const pending = Math.max(1, Math.floor(userMaxParallel * budgetMultiplier));
  const current = Math.min(Math.max(pending, dispatchPaused ? 0 : 1), userMaxParallel, hardCap);

  return {
    current,
    userMax: userMaxParallel,
    hardCap,
    dispatchPaused,
    pauseReason: reasons.length > 0 ? reasons.join(',') : undefined,
  };
}

/**
 * Derive hardCap from total CPU cores.
 */
export function deriveHardCap(totalCores: number): number {
  return Math.max(2, Math.floor(totalCores * 0.5));
}

// ══════════════════════════════════════════════════════════════
// Status Snapshot (for CLI status --json output)
// ══════════════════════════════════════════════════════════════

export interface StatusSnapshot {
  timestamp: string;
  system: SystemSnapshot;
  governance: GovernanceSnapshot;
  runs: RunSnapshot[];
  reconciliation?: ReconciliationStatusSummary;
}

export interface GovernanceSnapshot {
  enabled: boolean;
  pendingApprovals: number;
}

export interface SystemSnapshot {
  cpu: { usagePercent: number; cores: number };
  memory: { totalMb: number; usedMb: number; freeMb: number; usagePercent: number };
  piProcesses: { activeCount: number; hardCap: number };
  budget: { current: number; userMax: number; dispatchPaused: boolean; pauseReason?: string };
  sampled: boolean;
  degraded: boolean;
  degradeReason?: string;
}

export interface RunSnapshot {
  id: string;
  projectRoot: string;
  status: string;
  requestText: string;
  createdAt: string;
  finishedAt: string | null;
  stages: StageSnapshot[];
  pausedReason: string | null;
  nextAction: string | null;
  cost: { currency: 'CNY' | 'USD'; limit: number; committed: number; remaining: number; unavailableCalls: number } | null;
  events: EventSnapshot[];
}

export interface StageSnapshot {
  id: string;
  stageNumber: number;
  title: string;
  status: string;
  baseCommit: string | null;
  integrationBranch: string | null;
  tasks: TaskSnapshot[];
  integration: IntegrationSnapshot | null;
  activeLocks: LockSnapshot[];
}

export interface TaskSnapshot {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  estimatedWritePaths: string[];
  attempts: AttemptSnapshot[];
  latestReview: ReviewSnapshot | null;
  reworkCount: number;
  maxReworks: number;
}

export interface AttemptSnapshot {
  id: string;
  attemptNumber: number;
  status: string;
  piPid: number | null;
  pidAlive: 'alive' | 'gone' | 'unknown';
  startedAt: string | null;
  stoppedAt: string | null;
  worktreePath: string | null;
  exitReason: string | null;
  workerResultSummary: string | null;
  durationMs: number | null;
  reviewStatus: string | null;
  qualityGatePassed: boolean | null;
  resultSource: string;
  adoptedCommit: string | null;
}

export interface IntegrationSnapshot {
  branch: string;
  status: string;
  mergeCommitHash: string | null;
  targetMergeCommit: string | null;
  targetBranch: string | null;
  conflictSummary: string | null;
  qualityGatePassed: boolean | null;
  reviewedThroughCommit: string | null;
  finalCommit: string | null;
  reviewCoverageStatus: 'partial' | 'complete';
  reviewerUnavailable: boolean;
}

export interface LockSnapshot {
  filePath: string;
  heldByTaskId: string;
  lockType: 'exclusive' | 'shared';
  acquiredAt: string;
}

export interface EventSnapshot {
  timestamp: string;
  type: string;
  summary: string;
}

export interface ReviewSnapshot {
  reviewerType: string;
  status: string;
  mergeAllowed: boolean;
  summary: string;
  finishedAt: string | null;
  reviewedThroughCommit: string | null;
  finalCommit: string | null;
  coverageStatus: 'partial' | 'complete';
  reviewerUnavailable: boolean;
}

// ══════════════════════════════════════════════════════════════
// Persisted Records
// ══════════════════════════════════════════════════════════════

export interface ResourceSampleRecord {
  id: string;
  runId: string | null;
  timestamp: string;
  cpuPct: number;
  memTotalMb: number | null;
  memUsedMb: number | null;
  memPct: number | null;
  piActive: number;
  budget: number;
  dispatchPaused: number; // 0 or 1
  pauseReason: string | null;
  degraded: number; // 0 or 1
  degradeReason: string | null;
  source: string;
  createdAt: string;
}

export interface DispatchDecisionRecord {
  id: string;
  runId: string | null;
  timestamp: string;
  decisionType: string; // 'scale_down' | 'scale_up' | 'pause' | 'resume' | 'degrade'
  reason: string;
  previousBudget: number;
  newBudget: number;
  sampleJson: string | null;
  createdAt: string;
}
