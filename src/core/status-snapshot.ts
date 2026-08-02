// ── M3 Status Snapshot Builder ──────────────────────────────────────────
// Builds StatusSnapshot from StateStore + ResourceSampler for CLI output

import { execFileSync } from 'node:child_process';
import type { StateQueryStore, RunRecord } from '../state/state-store.js';
import type { ResourceSampler, BudgetState } from '../types/m3-types.js';
import { computeBudget, deriveHardCap } from '../types/m3-types.js';
import type {
  StatusSnapshot,
  GovernanceSnapshot,
  SystemSnapshot,
  RunSnapshot,
  StageSnapshot,
  TaskSnapshot,
  AttemptSnapshot,
  IntegrationSnapshot,
  LockSnapshot,
  EventSnapshot,
  ReviewSnapshot,
} from '../types/m3-types.js';
import type { StructuredTaskSpec } from '../types/m2-types.js';
import type { EventRecord } from '../types/m2-types.js';
import { getGovernanceConfig, resetGovernanceConfigCache } from './decision-gate.js';
import { resolveIntegrationTargetBranch } from './reconciliation/target-branch-resolver.js';

export interface BuildSnapshotOptions {
  store: StateQueryStore;
  sampler: ResourceSampler;
  userMaxParallel: number;
  dbPath?: string;
}

/**
 * Build a complete StatusSnapshot for status --json output.
 * When runId is provided, includes only that run's details.
 * When runId is null, includes all recent runs in summary form.
 */
export async function buildStatusSnapshot(
  options: BuildSnapshotOptions,
  runId?: string | null,
): Promise<StatusSnapshot> {
  const { store, sampler, userMaxParallel } = options;
  const timestamp = new Date().toISOString();

  // ── System snapshot (sample resources, safe degrade) ──
  let system: SystemSnapshot;
  let sampleResult: { sampled: boolean; degraded: boolean; degradeReason?: string };
  try {
    const sample = await sampler.sample();
    const hardCap = deriveHardCap(sample.cpu.cores);
    const budget = computeBudget(sample, userMaxParallel, hardCap);
    system = {
      cpu: sample.cpu,
      memory: sample.memory,
      piProcesses: { activeCount: sample.piCount, hardCap },
      budget: {
        current: budget.current,
        userMax: budget.userMax,
        dispatchPaused: budget.dispatchPaused,
        pauseReason: budget.pauseReason,
      },
      sampled: true,
      degraded: sample.degraded,
      degradeReason: sample.degradeReason,
    };
    sampleResult = { sampled: true, degraded: sample.degraded, degradeReason: sample.degradeReason };
  } catch {
    // Sampling failed completely → safe degrade
    system = {
      cpu: { usagePercent: 0, cores: 0 },
      memory: { totalMb: 0, usedMb: 0, freeMb: 0, usagePercent: 0 },
      piProcesses: { activeCount: 0, hardCap: 2 },
      budget: { current: 1, userMax: userMaxParallel, dispatchPaused: false, pauseReason: 'sampling_failed' },
      sampled: false,
      degraded: true,
      degradeReason: 'sampling_exception',
    };
    sampleResult = { sampled: false, degraded: true, degradeReason: 'sampling_exception' };
  }

  // ── Governance ──
  let governance: GovernanceSnapshot = { enabled: false, pendingApprovals: 0 };
  try {
    // Get governance config from the run's projectRoot, NOT cwd
    if (runId) {
      const run = await store.getRun(runId);
      if (run) {
        resetGovernanceConfigCache();
        const govCfg = getGovernanceConfig(run.projectRoot);
        governance.enabled = govCfg.enabled;
        if (govCfg.enabled) {
          const pending = await store.getPendingApprovals(runId);
          governance.pendingApprovals = pending.length;
        }
      }
    } else {
      // No runId — try cwd as fallback
      const cwd = process.cwd();
      resetGovernanceConfigCache();
      const govCfg = getGovernanceConfig(cwd);
      governance.enabled = govCfg.enabled;
    }
  } catch { /* governance unavailable — safe default */ }

  // ── Runs ──
  let runs: RunSnapshot[];
  if (runId) {
    const run = await store.getRun(runId);
    runs = run ? [await buildRunSnapshot(store, run, options.dbPath)] : [];
  } else {
    // Get recent runs — we need to query directly
    const allRuns = await getRecentRuns(store);
    const snapshots: RunSnapshot[] = [];
    for (const run of allRuns) {
      snapshots.push(await buildRunSnapshot(store, run, options.dbPath));
    }
    runs = snapshots;
  }

  return { timestamp, system, governance, runs };
}

/**
 * Helper to get recent runs. Uses a lightweight approach via the store.
 */
async function getRecentRuns(store: StateQueryStore): Promise<RunRecord[]> {
  // We'll collect runs by querying known IDs from events table or runs table.
  // The store doesn't have a "list all runs" method, so we use a workaround.
  // For M3, we'll read recent runs from the SQLite store's raw db.
  // But to keep things clean, we check if the store has a raw db property.
  const rawStore = store as any;
  if (rawStore.db && typeof rawStore.db.prepare === 'function') {
    try {
      const stmt = rawStore.db.prepare(
        'SELECT * FROM runs ORDER BY created_at DESC LIMIT 10'
      );
      const rows = stmt.all() as Record<string, unknown>[];
      return rows.map(mapRowToRunRecord);
    } catch {
      // fallback: return empty
    }
  }
  return [];
}

function mapRowToRunRecord(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectRoot: String(row.project_root),
    requestText: String(row.request_text),
    status: String(row.status) as any,
    codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

async function buildRunSnapshot(store: StateQueryStore, run: RunRecord, dbPath?: string): Promise<RunSnapshot> {
  const stages = await store.listStages(run.id);
  const events = await store.listEvents(run.id);
  const pausedEvents = events.filter((e) => e.eventType === 'stage_paused');
  const pausedReason = pausedEvents.length > 0
    ? (pausedEvents[pausedEvents.length - 1].eventDataJson
      ? (() => { try { return JSON.parse(pausedEvents[pausedEvents.length - 1].eventDataJson!).reason; } catch { return null; } })()
      : null)
    : null;

  const stageSnapshots: StageSnapshot[] = [];
  for (const stage of stages) {
    stageSnapshots.push(await buildStageSnapshot(store, stage, run.id, events));
  }

  const eventSnapshots: EventSnapshot[] = events.slice(-20).reverse().map((ev) => ({
    timestamp: ev.createdAt,
    type: ev.eventType,
    summary: ev.eventDataJson
      ? (() => { try { const d = JSON.parse(ev.eventDataJson!); return JSON.stringify(d); } catch { return ev.eventDataJson!; } })()
      : '',
  }));
  const costEntries = store.listCostReservations ? await store.listCostReservations(run.id) : [];
  const cost = costEntries.length > 0 ? (() => {
    const latest = costEntries[costEntries.length - 1];
    // written_off is an explicit release of the budget: it must NOT count as
    // committed (distinct from released which proves no money was spent).
    const committed = costEntries.reduce((sum, entry) => sum + (entry.status === 'confirmed' && entry.actualCost != null ? entry.actualCost : entry.status === 'released' || entry.status === 'written_off' ? 0 : entry.reservedCost), 0);
    const breakdown = {
      reserved: 0,     // status=reserved, phase=reserved (not yet spawned)
      spawned: 0,      // status=reserved, phase=spawned (running, heartbeated)
      unavailable: 0,  // status=unavailable (spent/unknown, awaiting write-off)
      written_off: 0,  // status=written_off (manually released)
      settled: 0,      // confirmed/released (real cost or proven no-spend)
    };
    for (const e of costEntries) {
      if (e.status === 'reserved') {
        if (e.phase === 'spawned') breakdown.spawned += e.reservedCost;
        else breakdown.reserved += e.reservedCost;
      } else if (e.status === 'unavailable') breakdown.unavailable += e.reservedCost;
      else if (e.status === 'written_off') breakdown.written_off += e.reservedCost;
      else breakdown.settled += (e.status === 'confirmed' && e.actualCost != null ? e.actualCost : 0);
    }
    // No `currency` field: quotas are unitless. Exposing a currency label here
    // is what made the Dashboard render this counter as if it were money.
    return { limit: latest.budgetLimit, committed, remaining: Math.max(0, latest.budgetLimit - committed), unavailableCalls: costEntries.filter((entry) => entry.usageStatus === 'unavailable').length, breakdown };
  })() : null;
  const nextAction = pausedReason || stages.some((stage) => stage.status === 'paused')
    ? `brainctl resume ${run.id} --allow-real-project${dbPath ? ` --db "${dbPath}"` : ''}`
    : null;

  return {
    id: run.id,
    projectRoot: run.projectRoot,
    status: run.status,
    requestText: (run.requestText || '').substring(0, 120),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt || null,
    stages: stageSnapshots,
    pausedReason,
    nextAction,
    cost,
    events: eventSnapshots,
  };
}

async function buildStageSnapshot(
  store: StateQueryStore,
  stage: any,
  runId: string,
  events: readonly EventRecord[],
): Promise<StageSnapshot> {
  // Try listTasksByStage first; fall back to listTasks filtered by stageNumber
  let tasks = await store.listTasksByStage(stage.id);
  if (tasks.length === 0) {
    const allTasks = await store.listTasks(runId);
    tasks = allTasks.filter((t) => {
      const spec = (t.specJson as StructuredTaskSpec) || {} as StructuredTaskSpec;
      return spec.stageNumber === stage.stageNumber;
    });
  }
  const attempts = await store.listAttemptsByStage(stage.id);
  const batches = await store.listIntegrationBatches(stage.id);
  const locks = await store.getActiveLocksForRun(runId);

  const taskSnapshots: TaskSnapshot[] = [];
  for (const task of tasks) {
    const spec = (task.specJson as StructuredTaskSpec) || {} as StructuredTaskSpec;
    const taskAttempts = attempts.filter((a) => a.taskId === task.id);
    const reviews = await store.listReviewsByTask(task.id);
    const latestReview = reviews.length > 0 ? reviews[reviews.length - 1] : null;
    const reworkCount = reviews.reduce((s, r) => s + r.reworkCount, 0);

    const attemptSnapshots: AttemptSnapshot[] = taskAttempts.map((att) => {
      let pidAlive: 'alive' | 'gone' | 'unknown' = 'unknown';
      if (att.piPid != null) {
        try {
          if (process.platform === 'win32') {
            const out = execFileSync('tasklist', ['/FI', `PID eq ${att.piPid}`, '/FO', 'CSV', '/NH'], {
              stdio: 'pipe', encoding: 'utf-8', timeout: 1000,
            });
            pidAlive = out.includes('"' + att.piPid + '"') ? 'alive' : 'gone';
          } else {
            try { process.kill(att.piPid, 0); pidAlive = 'alive'; } catch { pidAlive = 'gone'; }
          }
        } catch { pidAlive = 'unknown'; }
      }

      let workerResultSummary: string | null = null;
      if (att.workerResultJson) {
        try {
          const wr = JSON.parse(att.workerResultJson);
          workerResultSummary = wr.summary || wr.status || null;
        } catch { /* ignore */ }
      }

      const durationMs = att.startedAt && att.stoppedAt
        ? new Date(att.stoppedAt).getTime() - new Date(att.startedAt).getTime()
        : null;

      let qualityGatePassed: boolean | null = null;
      if (att.status === 'approved') qualityGatePassed = true;
      else if (att.exitReason && att.exitReason.includes('qg_failed')) qualityGatePassed = false;

      return {
        id: att.id,
        attemptNumber: att.attemptNumber,
        status: att.status,
        piPid: att.piPid,
        pidAlive,
        startedAt: att.startedAt,
        stoppedAt: att.stoppedAt,
        worktreePath: att.worktreePath,
        exitReason: att.exitReason,
        workerResultSummary,
        durationMs,
        reviewStatus: att.status === 'approved' || att.status === 'rework_required' ? att.status : null,
        qualityGatePassed,
        resultSource: att.resultSource,
        adoptedCommit: att.adoptedCommit,
      };
    });

    const reviewSnapshot: ReviewSnapshot | null = latestReview ? {
      reviewerType: latestReview.reviewerType,
      status: latestReview.status,
      mergeAllowed: latestReview.mergeAllowed,
      summary: latestReview.reviewJson
        ? (() => { try { const r = JSON.parse(latestReview.reviewJson!); return r.reviewSummary || ''; } catch { return ''; } })()
        : '',
      finishedAt: latestReview.finishedAt,
      reviewedThroughCommit: latestReview.reviewedThroughCommit,
      finalCommit: latestReview.finalCommit,
      coverageStatus: latestReview.coverageStatus,
      reviewerUnavailable: latestReview.reviewerUnavailable,
    } : null;

    taskSnapshots.push({
      id: task.id,
      title: task.title,
      status: task.status,
      dependencies: spec.dependencies || [],
      estimatedWritePaths: spec.estimatedWritePaths || [],
      attempts: attemptSnapshots,
      latestReview: reviewSnapshot,
      reworkCount,
      maxReworks: 2,
    });
  }

  const batch = batches.length > 0 ? batches[batches.length - 1] : null;
  const integrationSnapshot: IntegrationSnapshot | null = batch ? {
    branch: batch.integrationBranch,
    status: batch.status,
    mergeCommitHash: batch.mergeCommitHash,
    targetMergeCommit: batch.targetMergeCommit,
    targetBranch: resolveIntegrationTargetBranch(events, stage.id, batch.integrationBranch),
    conflictSummary: batch.conflictsJson
      ? (() => { try { return JSON.stringify(JSON.parse(batch.conflictsJson!)); } catch { return batch.conflictsJson!; } })()
      : null,
    qualityGatePassed: batch.status === 'completed' ? true : batch.status === 'failed' ? false : null,
    reviewedThroughCommit: batch.reviewedThroughCommit,
    finalCommit: batch.finalCommit,
    reviewCoverageStatus: batch.reviewCoverageStatus,
    reviewerUnavailable: batch.reviewerUnavailable,
  } : null;

  const stageLocks: LockSnapshot[] = locks
    .filter((l) => tasks.some((t) => t.id === l.taskId))
    .map((l) => ({
      filePath: l.filePath,
      heldByTaskId: l.taskId,
      lockType: l.lockType as 'exclusive' | 'shared',
      acquiredAt: l.acquiredAt,
    }));

  return {
    id: stage.id,
    stageNumber: stage.stageNumber,
    title: stage.title,
    status: stage.status,
    baseCommit: stage.baseCommit,
    integrationBranch: stage.integrationBranch,
    tasks: taskSnapshots,
    integration: integrationSnapshot,
    activeLocks: stageLocks,
  };
}
