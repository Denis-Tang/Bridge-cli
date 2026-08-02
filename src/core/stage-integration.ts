import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CodexProcessRunner } from '../adapters/codex-process-runner.js';
import type { ReviewerConfig } from '../adapters/project-adapter.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import type { StateStore } from '../state/state-store.js';
import type { AttemptRecord, StageRecord, StructuredTaskSpec } from '../types/m2-types.js';
import type { CallType } from '../types/m4-types.js';
import type { PauseCategory } from '../types/pause-types.js';
import type { PrivacyService } from '../privacy/privacy-service.js';
import { QualityGateRunner, type QualityGateConfig } from '../quality/quality-gate-runner.js';
import { checkG2Approvable, checkG3Approvable, createG3Approval } from './decision-gate.js';
import { tasksHaveSerialOwnership } from './path-ownership.js';
import { ReviewResultCache } from './review-cache.js';
import {
  assessStageReviewInputCoverage,
  prepareStageReviewInput,
  runStageReview,
  type StageReviewInputLimits,
} from './stage-review.js';
import { preCheckBudget } from './token-budget.js';
import { SqliteLedgerSink } from './token-telemetry.js';
import { startCostReservationHeartbeat, stopCostReservationHeartbeat } from './cost-heartbeat.js';
import { isBranchMerged } from './reconciliation/git-fact-checker.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export interface StageIntegrationConfig {
  projectRoot: string;
  worktreeBaseDir: string;
  targetBranch: string;
  sessionDir: string;
  allowRealReviewer: boolean;
  allowRealWorker: boolean;
  cleanupMergedWorktrees?: boolean;
  governanceEnabled?: boolean;
  privacyService?: PrivacyService;
  qualityGates?: QualityGateConfig[];
  stageQualityGates?: QualityGateConfig[];
  reviewerConfig?: ReviewerConfig;
  codexProcessRunner?: CodexProcessRunner;
  stageReviewInputLimits?: Partial<StageReviewInputLimits>;
  /** R2: lease window basis for cost-reservation heartbeats (default 180000). */
  workerTimeoutMs?: number;
  /** R2: cost reservation heartbeat interval (ms); default lease window / 3. */
  costReservationHeartbeatMs?: number;
}

export interface StagePauseRequest {
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
}

export interface ProviderCostRequest {
  runId: string;
  stageId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  callType: CallType;
  callId: string;
  provider: 'pi' | 'codex';
}

export interface ProviderCostGate {
  allowed: boolean;
  reservationId: string | null;
  ownerId: string | null;
  reason?: string;
  remaining?: number;
}

interface StageTaskRow {
  id: string;
  status: string;
  specJson: unknown;
}

export interface StageIntegrationHooks {
  nextEventId(runId: string, prefix: string): string;
  recordStagePause(input: StagePauseRequest): Promise<unknown>;
  reserveProviderCost(input: ProviderCostRequest): Promise<ProviderCostGate>;
  stopIfCanceled(
    runId: string,
    stageId: string,
    taskId: string | null,
    attemptId: string | null,
    checkpoint: string,
  ): Promise<boolean>;
  tasksForStage(stage: StageRecord, runId: string): Promise<StageTaskRow[]>;
  getAttemptDiffBase(runId: string, attemptId: string, fallback: string): Promise<string>;
  pathsOverlap(left: string, right: string): boolean;
  getAbortSignal(): AbortSignal | undefined;
}

export class StageIntegrationCoordinator {
  constructor(
    private readonly store: StateStore,
    private readonly config: StageIntegrationConfig,
    private readonly reviewCache: ReviewResultCache,
    private readonly hooks: StageIntegrationHooks,
  ) {}

  private get abortController(): { signal: AbortSignal } | null {
    const signal = this.hooks.getAbortSignal();
    return signal ? { signal } : null;
  }

  private nextEventId(runId: string, prefix: string): string {
    return this.hooks.nextEventId(runId, prefix);
  }

  private recordStagePause(input: StagePauseRequest): Promise<unknown> {
    return this.hooks.recordStagePause(input);
  }

  private reserveProviderCost(input: ProviderCostRequest): Promise<ProviderCostGate> {
    return this.hooks.reserveProviderCost(input);
  }

  private stopIfCanceled(
    runId: string,
    stageId: string,
    taskId: string | null,
    attemptId: string | null,
    checkpoint: string,
  ): Promise<boolean> {
    return this.hooks.stopIfCanceled(runId, stageId, taskId, attemptId, checkpoint);
  }

  private tasksForStage(stage: StageRecord, runId: string): Promise<StageTaskRow[]> {
    return this.hooks.tasksForStage(stage, runId);
  }

  private getAttemptDiffBase(runId: string, attemptId: string, fallback: string): Promise<string> {
    return this.hooks.getAttemptDiffBase(runId, attemptId, fallback);
  }

  private pathsOverlap(left: string, right: string): boolean {
    return this.hooks.pathsOverlap(left, right);
  }

  async integrate(stage: StageRecord, runId: string, wtm: WorktreeManager, base: string): Promise<boolean> {
    // ── R4: idempotent entry ──────────────────────────────────────────────
    // If a previous integration for this stage TRULY completed before a crash
    // (batch completed + git-proven merge landed), do NOT re-run integration —
    // re-running would re-run the PAID stage Codex review and the merge. Just
    // finish the state tail (tasks merged / stage completed / claims released /
    // event / residual cleanup).
    const idem = await this.checkIdempotentIntegration(stage, runId);
    if (idem.mode === 'complete') {
      return this.completeIdempotentIntegration(stage, runId, wtm, idem.batch);
    }
    if (idem.mode === 'fail_closed') {
      // DB says completed but git cannot prove the merge landed — a real state
      // inconsistency. Never silently re-run integration; hand it to a human.
      const pausedAt = new Date().toISOString();
      await this.recordStagePause({
        runId, stageId: stage.id, reasonCode: 'integration_state_inconsistent',
        category: 'integration',
        eventData: {
          batchId: idem.batch?.id ?? null,
          targetMergeCommit: idem.batch?.targetMergeCommit ?? null,
          detail: 'DB 记录 batch completed 但 merge commit 不是目标分支祖先，禁止静默重跑集成',
        }, createdAt: pausedAt,
      });
      await this.store.createEvent({
        id: this.nextEventId(runId, 'ev-int-state-inconsistent'), runId, stageId: stage.id,
        eventType: 'integration_state_inconsistent',
        eventData: { batchId: idem.batch?.id ?? null, targetMergeCommit: idem.batch?.targetMergeCommit ?? null },
      });
      return false;
    }

    const now = new Date().toISOString();
    const integrationAttempt = (await this.store.listIntegrationBatches(stage.id)).length + 1;
    const ib = 'brainctl/int/' + runId + '/stage-' + stage.stageNumber + '/a' + integrationAttempt;
    await this.store.updateStageIntegrationBranch(stage.id, ib);
    await this.store.updateStageStatus(stage.id, 'integration', now);
    const batch = await this.store.createIntegrationBatch({ id: runId + '-batch-' + stage.id + '-a' + integrationAttempt, stageId: stage.id, runId, integrationBranch: ib });
    const stageTasks = await this.tasksForStage(stage, runId);

    const gs = this.config.stageQualityGates ?? this.config.qualityGates ?? [];
    if (gs.length === 0) {
      console.log('[Scheduler] Cannot integrate stage ' + stage.stageNumber + ': no quality gates configured.');
      await this.store.updateIntegrationBatch(batch.id, { status: 'failed', finishedAt: now });
      await this.recordStagePause({
        runId, stageId: stage.id, reasonCode: 'no_quality_gates_configured',
        category: 'quality', createdAt: now,
      });
      await this.mergeBlockApprovedTasks(stageTasks, now);
      await this.store.createEvent({ id: runId + '-ev-int-nogate-' + Date.now(), runId, stageId: stage.id, eventType: 'error', eventData: { reason: 'no_quality_gates_configured', stage: stage.stageNumber } });
      return false;
    }
    const unapprovedTasks = stageTasks.filter((task) => task.status !== 'approved' && task.status !== 'review_skipped');
    if (unapprovedTasks.length > 0) {
      await this.store.updateIntegrationBatch(batch.id, { status: 'failed', conflictsJson: JSON.stringify({ reason: 'integration_with_unapproved_tasks', taskIds: unapprovedTasks.map((task) => task.id) }), finishedAt: now });
      await this.recordStagePause({
        runId, stageId: stage.id, reasonCode: 'integration_with_unapproved_tasks',
        category: 'integration', eventData: { taskIds: unapprovedTasks.map((task) => task.id) }, createdAt: now,
      });
      await this.mergeBlockApprovedTasks(stageTasks, now);
      console.log('[Scheduler] Refusing integration: task approval invariant failed.');
      return false;
    }

    if (this.config.governanceEnabled) {
      const pendingG2: string[] = [];
      for (const task of stageTasks) {
        const g2 = await checkG2Approvable(this.store, runId, task.id);
        if (!g2.approvable) pendingG2.push(task.id);
      }
      if (pendingG2.length > 0) {
        await this.store.updateIntegrationBatch(batch.id, { status: 'failed', conflictsJson: JSON.stringify({ reason: 'pending_g2_before_integration', taskIds: pendingG2 }), finishedAt: now });
        const decisions = await this.store.getPendingApprovals(runId);
        const dedicated = decisions.find((decision) =>
          pendingG2.includes(String((decision.metadata as { taskId?: string }).taskId)),
        ) ?? null;
        await this.recordStagePause({
          runId, stageId: stage.id, reasonCode: 'pending_g2_before_integration',
          category: 'product_decision',
          requiredApprovalType: dedicated?.decisionType ?? 'product_decision',
          decisionId: dedicated?.id ?? null,
          eventData: { taskIds: pendingG2 }, createdAt: now,
        });
        await this.mergeBlockApprovedTasks(stageTasks, now);
        console.log('[Scheduler] Refusing integration: pending G2 approval exists.');
        return false;
      }
    }

    try {
      wtm.createBranch(ib, base);
      const ir = this.config.worktreeBaseDir + '/' + runId + '/int/stage-' + stage.stageNumber + '/a' + integrationAttempt;
      const ip = resolve(this.config.projectRoot, ir);
      mkdirSync(dirname(ip), { recursive: true });
      wtm.createWorktree(ib, ir);

      const atts = await this.store.listAttemptsByStage(stage.id);
      const integrationSpecs = new Map<string, StructuredTaskSpec>();
      for (const task of stageTasks) {
        integrationSpecs.set(task.id, { ...((task.specJson || {}) as StructuredTaskSpec), taskId: task.id });
      }
      const actualDiffs: Array<{ taskId: string; attemptId: string; branchName: string; changedFiles: string[] }> = [];
      for (const task of stageTasks) {
        const attempt = await this.store.getLatestAttempt(task.id);
        if (!attempt || !['approved', 'review_skipped'].includes(attempt.status) || !attempt.branchName) {
          throw new Error(`actual diff unavailable for integration task ${task.id}`);
        }
        const diffBase = await this.getAttemptDiffBase(runId, attempt.id, base);
        const changedFiles = git(this.config.projectRoot, ['diff', '--name-only', `${diffBase}..${attempt.branchName}`, '--'])
          .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        actualDiffs.push({ taskId: task.id, attemptId: attempt.id, branchName: attempt.branchName, changedFiles });
      }
      const actualConflicts: Array<{ firstTaskId: string; secondTaskId: string; firstPath: string; secondPath: string }> = [];
      for (let i = 0; i < actualDiffs.length; i++) {
        for (let j = i + 1; j < actualDiffs.length; j++) {
          const first = actualDiffs[i];
          const second = actualDiffs[j];
          if (tasksHaveSerialOwnership(first.taskId, second.taskId, integrationSpecs)) continue;
          for (const firstPath of first.changedFiles) {
            for (const secondPath of second.changedFiles) {
              if (this.pathsOverlap(firstPath, secondPath)) {
                actualConflicts.push({ firstTaskId: first.taskId, secondTaskId: second.taskId, firstPath, secondPath });
              }
            }
          }
        }
      }
      if (actualConflicts.length > 0) {
        const pausedAt = new Date().toISOString();
        const conflictData = { reason: 'runtime_undeclared_actual_path_conflict', conflictLayer: 'runtime_undeclared', conflicts: actualConflicts };
        await this.store.updateIntegrationBatch(batch.id, { status: 'conflict', conflictsJson: JSON.stringify(conflictData), finishedAt: pausedAt });
        await this.recordStagePause({
          runId, stageId: stage.id, reasonCode: 'runtime_undeclared_actual_path_conflict', category: 'integration',
          eventData: conflictData, createdAt: pausedAt,
        });
        await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-actual-path-conflict'), runId, stageId: stage.id,
          eventType: 'integration_conflict', eventData: conflictData,
        });
        return false;
      }
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
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'integration_branch_conflict',
            category: 'integration', eventData: ev, createdAt: pausedAt,
          });
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({ id: runId + '-ev-conflict-' + Date.now(), runId, stageId: stage.id, eventType: 'integration_conflict', eventData: ev });
          console.log('[Scheduler] Integration conflict ' + b + '.'); return false;
        }
      }

      if (await this.stopIfCanceled(runId, stage.id, null, null, 'before_stage_quality_gate')) return false;

      const qg = new QualityGateRunner(ip);
      const qgResult = await qg.runGates(gs, true);
      await this.store.createEvent({ id: runId + '-ev-int-qg-' + Date.now(), runId, stageId: stage.id, eventType: 'review_completed', eventData: { kind: 'stage_quality_gate', passed: qgResult.passed, summary: qgResult.summary, results: qgResult.results } });
      if (!qgResult.passed) {
        const pausedAt = new Date().toISOString();
        console.log('[Scheduler] Stage-level quality gates failed for stage ' + stage.stageNumber + ': ' + qgResult.summary);
        await this.store.updateIntegrationBatch(batch.id, { status: 'failed', finishedAt: pausedAt });
        await this.recordStagePause({
          runId, stageId: stage.id, reasonCode: 'stage_quality_gates_failed',
          category: 'quality', eventData: { summary: qgResult.summary }, createdAt: pausedAt,
        });
        await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
        await this.store.createEvent({ id: runId + '-ev-qg-fail-' + Date.now(), runId, stageId: stage.id, eventType: 'stage_failed', eventData: { reason: 'stage_quality_gates_failed', summary: qgResult.summary } });
        return false;
      }

      const mh = git(ip, ['rev-parse', 'HEAD']);
      await this.store.updateIntegrationBatch(batch.id, { status: 'integrating', mergeCommitHash: mh, baseCommit: base });

      // ── M4: G3 Merge Gate check before target branch merge ──
      if (await this.stopIfCanceled(runId, stage.id, null, null, 'before_integration_merge')) return false;

      if (this.config.governanceEnabled) {
        const g3Check = await checkG3Approvable(this.store, runId, stage.id);
        if (!g3Check.approvable) {
          const pausedAt = new Date().toISOString();
          console.log('[Scheduler] G3 blocked integration for stage ' + stage.stageNumber + ' (' + g3Check.pendingDecisions.length + ' pending)');
          const dedicated = g3Check.pendingDecisions[0] ?? null;
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'g3_pending_approval',
            category: 'integration',
            requiredApprovalType: dedicated?.decisionType ?? 'conflict_resolution',
            decisionId: dedicated?.id ?? null,
            eventData: { stageNumber: stage.stageNumber }, createdAt: pausedAt,
          });
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          return false;
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
          const mergeDecision = await createG3Approval(this.store, runId, stage.id, 'large_merge',
            `Merge diff exceeds 500 lines (${totalDiffLines} total)`);
          console.log('[Scheduler] Large merge diff for stage ' + stage.stageNumber + ' — G3 approval created.');
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'large_merge_diff',
            category: 'integration', requiredApprovalType: 'large_merge', decisionId: mergeDecision.id,
            eventData: { diffLines: totalDiffLines }, createdAt: pausedAt,
          });
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          return false;
        }

        // Token budget post-check for stage
        const budgetCheck = await preCheckBudget(this.store, runId, 'codex_review_stage', 10000);
        if (!budgetCheck.allowed) {
          const pausedAt = new Date().toISOString();
          const budgetDecision = await createG3Approval(this.store, runId, stage.id, 'stage_budget_override',
            budgetCheck.reason || 'stage_budget_exceeded');
          console.log('[Scheduler] Stage budget exceeded for stage ' + stage.stageNumber + ' — G3 approval created.');
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'stage_budget_exceeded',
            category: 'budget', requiredApprovalType: 'stage_budget_override', decisionId: budgetDecision.id,
            eventData: { remaining: budgetCheck.remaining, limit: budgetCheck.limit }, createdAt: pausedAt,
          });
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({
            id: runId + '-ev-budget-merge-' + Date.now(), runId, stageId: stage.id,
            eventType: 'token_budget_exceeded',
            eventData: { policyType: 'codex_review_stage', remaining: budgetCheck.remaining, limit: budgetCheck.limit },
          });
          return false;
        }
      }

      // Final integrated-tree review is mandatory in every execution mode.
      // Token-efficient mode still saves per-task reviews, but never skips this
      // review of the exact integration commit that is about to merge.
      {
        const aggregatedDiff = git(ip, ['diff', `${base}..${mh}`, '--']);
        const taskGateResults = stageTasks.map(t => ({ taskId: t.id, passed: true, summary: 'task and stage quality gates passed' }));
        const reviewInput = prepareStageReviewInput(stage, aggregatedDiff, taskGateResults);
        const inputCoverage = assessStageReviewInputCoverage(reviewInput, this.config.stageReviewInputLimits);
        if (!inputCoverage.complete) {
          const pausedAt = new Date().toISOString();
          const metadata = {
            reason: inputCoverage.reason,
            inputBytes: inputCoverage.inputBytes,
            inputLines: inputCoverage.inputLines,
            limits: inputCoverage.limits,
            metricKind: inputCoverage.metricKind,
          };
          console.log('[Scheduler] Final integrated-tree review input exceeded the operational proxy ceiling; coverage remains partial.');
          await this.store.updateIntegrationBatch(batch.id, {
            status: 'failed', reviewedThroughCommit: mh, reviewCoverageStatus: 'partial', reviewerUnavailable: false,
            reviewMetadataJson: JSON.stringify(metadata), finishedAt: pausedAt,
          });
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-stage-review-input-limit'), runId, stageId: stage.id,
            eventType: 'stage_review_input_limit_exceeded', eventData: { ...metadata, reviewedCommit: mh },
          });
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'stage_review_input_limit_exceeded', category: 'reviewer',
            eventData: { ...metadata, reviewedCommit: mh }, createdAt: pausedAt,
          });
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          return false;
        }

        console.log('[Scheduler] Running final integrated-tree review for stage ' + stage.stageNumber + '.');
        await this.store.createEvent({
          id: this.nextEventId(runId, 'ev-stage-review-start'),
          runId, stageId: stage.id,
          eventType: 'stage_review_started',
          eventData: {
            taskCount: stageTasks.length, stageNumber: stage.stageNumber, reviewedCommit: mh,
            inputBytes: inputCoverage.inputBytes, inputLines: inputCoverage.inputLines,
            metricKind: inputCoverage.metricKind,
          },
        });

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

        let stageCostReservationId: string | null = null;
        let stageCostOwnerId: string | null = null;
        if (this.config.allowRealReviewer && !this.config.codexProcessRunner) {
          const costGate = await this.reserveProviderCost({
            runId, stageId: stage.id, callType: 'stage_review',
            callId: `${runId}-stage-review-${stage.stageNumber}-${mh.slice(0, 12)}`, provider: 'codex',
          });
          if (!costGate.allowed) {
            const pausedAt = new Date().toISOString();
            const reason = costGate.reason || 'cost_budget_exceeded';
            await this.store.updateIntegrationBatch(batch.id, { status: 'failed', reviewedThroughCommit: mh, reviewCoverageStatus: 'partial', reviewerUnavailable: true, reviewMetadataJson: JSON.stringify({ reason }), finishedAt: pausedAt });
            await this.recordStagePause({
              runId, stageId: stage.id, reasonCode: reason, category: 'budget',
              requiredApprovalType: 'stage_budget_override',
              eventData: { provider: 'codex', remaining: costGate.remaining ?? null }, createdAt: pausedAt,
            });
            return false;
          }
          stageCostReservationId = costGate.reservationId;
          stageCostOwnerId = costGate.ownerId;
        }

        if (stageCostReservationId && this.store.markCostReservationSpawned) {
          await this.store.markCostReservationSpawned(stageCostReservationId, stageCostOwnerId ?? '', new Date().toISOString());
        }
        // R2: refresh the one-shot lease while a long stage review runs.
        const stageReviewHeartbeat = stageCostReservationId && this.store.heartbeatCostReservation
          ? startCostReservationHeartbeat({
              reservationId: stageCostReservationId,
              ownerId: stageCostOwnerId ?? '',
              workerTimeoutMs: this.config.workerTimeoutMs ?? 180_000,
              overrideIntervalMs: this.config.costReservationHeartbeatMs,
              heartbeat: (id, owner, at, lease) => this.store.heartbeatCostReservation!(id, owner, at, lease),
            })
          : null;
        let stageReviewResult: Awaited<ReturnType<typeof runStageReview>>;
        try {
          stageReviewResult = await runStageReview(
            reviewInput, base, this.reviewCache, this.store, runId, stage.id,
            {
              workDir: ip,
              sessionDir: resolve(this.config.projectRoot, this.config.sessionDir),
              allowRealReview: this.config.allowRealReviewer,
              timeoutMs: this.config.reviewerConfig?.timeoutMs ?? 120000,
              command: this.config.reviewerConfig?.command,
              args: this.config.reviewerConfig?.args,
              env: this.config.privacyService?.buildProviderEnv('codex'),
              signal: this.abortController?.signal,
              codexProcessRunner: this.config.codexProcessRunner,
              ledgerSink: stageReviewLedgerSink ?? undefined,
              invocationContext: stageReviewCtx ?? undefined,
            },
          );
        } finally {
          stopCostReservationHeartbeat(stageReviewHeartbeat);
          if (stageCostReservationId && this.store.finalizeCostReservation) {
            await this.store.finalizeCostReservation({
              id: stageCostReservationId, outcome: 'unavailable', ownerId: stageCostOwnerId,
              terminationEvidence: 'stage_review_money_usage_unavailable',
            });
          }
        }

        if (!stageReviewResult.passed) {
          const pausedAt = new Date().toISOString();
          const feedback = [
            stageReviewResult.reviewResult.reviewSummary,
            ...(stageReviewResult.reviewResult.findings || []),
            ...(stageReviewResult.reviewResult.requiredRework || []),
          ].filter(Boolean).join('; ').slice(0, 2_000);
          const reviewerUnavailable = stageReviewResult.reviewResult.reviewerUnavailable === true;
          console.log('[Scheduler] Final integrated-tree review FAILED for stage ' + stage.stageNumber + (reviewerUnavailable ? ' because the reviewer was unavailable.' : '.'));
          await this.store.createEvent({
            id: this.nextEventId(runId, 'ev-stage-review-fail'),
            runId, stageId: stage.id,
            eventType: 'stage_review_failed',
            eventData: { findings: stageReviewResult.reviewResult.findings, reviewerUnavailable, reviewedCommit: mh },
          });
          await this.store.updateIntegrationBatch(batch.id, {
            status: 'failed',
            conflictsJson: JSON.stringify({ reason: 'stage_review_failed', findings: stageReviewResult.reviewResult.findings }),
            reviewedThroughCommit: mh, reviewCoverageStatus: 'partial', reviewerUnavailable,
            reviewMetadataJson: JSON.stringify(stageReviewResult.reviewResult.executionMetadata ?? {}),
            finishedAt: pausedAt,
          });
          if (!reviewerUnavailable) {
            for (const skipped of skippedTaskBranches) {
              const attempt = await this.store.getLatestAttempt(skipped.taskId);
              if (!attempt || attempt.status !== 'review_skipped') continue;
              await this.store.updateAttemptStatus(attempt.id, 'rework_required', pausedAt);
              await this.store.updateAttemptResult(attempt.id, { exitReason: 'stage_review_failed: ' + feedback, stoppedAt: pausedAt });
              await this.store.updateTaskStatus(skipped.taskId, 'rework_required', pausedAt);
            }
          }
          await this.recordStagePause({
            runId, stageId: stage.id,
            reasonCode: reviewerUnavailable ? 'stage_reviewer_unavailable' : 'stage_review_failed',
            category: reviewerUnavailable ? 'reviewer' : 'quality',
            eventData: { reviewedCommit: mh, feedback }, createdAt: pausedAt,
          });
          return false;
        }

        // Stage review passed — approve all skipped tasks
        const approvedAt = new Date().toISOString();
        await this.store.updateIntegrationBatch(batch.id, {
          reviewedThroughCommit: mh, reviewCoverageStatus: 'complete', reviewerUnavailable: false,
          reviewMetadataJson: JSON.stringify({ cacheHit: stageReviewResult.cacheHit, reviewer: stageReviewResult.reviewResult.reviewer ?? 'unknown' }),
        });
        if (await this.stopIfCanceled(runId, stage.id, null, null, 'before_stage_review_approve')) return false;
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
        console.log('[Scheduler] Final integrated-tree review PASSED for stage ' + stage.stageNumber + ' (' + (stageReviewResult.cacheHit ? 'cache hit' : 'fresh review') + ')');
      }

      let targetBranch = this.config.targetBranch;
      try {
        // P0-2: fail closed when the real project worktree is dirty before any
        // checkout/merge. `brainctl init` only *suggests* gitignoring
        // .brainctl-dev/, so raw `git status` entries under those prefixes are
        // Bridge's own artifacts and are filtered; ANY other entry (tracked
        // M/A/D/R edits or user untracked files) pauses the stage. Privacy:
        // only counts are recorded, never file names or contents.
        const porcelain = git(this.config.projectRoot, ['status', '--porcelain']).split('\n');
        const statusCounts: Record<string, number> = {};
        let dirtyEntryCount = 0;
        for (const line of porcelain) {
          if (!line.trim()) continue;
          const entry = line.slice(3).trim().replace(/^"/, '');
          if (entry === '.brainctl-dev' || entry.startsWith('.brainctl-dev/')
            || entry === '.brainctl' || entry.startsWith('.brainctl/')) continue;
          dirtyEntryCount += 1;
          const code = (line.slice(0, 2).trim() || '?').toUpperCase();
          statusCounts[code] = (statusCounts[code] || 0) + 1;
        }
        if (dirtyEntryCount > 0) {
          const pausedAt = new Date().toISOString();
          await this.store.updateIntegrationBatch(batch.id, { status: 'conflict', conflictsJson: JSON.stringify({ reason: 'target_worktree_dirty', dirtyEntryCount }), finishedAt: pausedAt });
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'target_worktree_dirty',
            category: 'integration', eventData: { dirtyEntryCount, statusCounts }, createdAt: pausedAt,
          });
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({ id: this.nextEventId(runId, 'ev-target-dirty'), runId, stageId: stage.id, eventType: 'integration_conflict', eventData: { reason: 'target_worktree_dirty', dirtyEntryCount, statusCounts } });
          return false;
        }

        const currentBranch = git(this.config.projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        try { git(this.config.projectRoot, ['rev-parse', '--verify', '--end-of-options', targetBranch]); }
        catch { console.log('[Scheduler] Target branch ' + targetBranch + ' not found. Using current branch: ' + currentBranch); targetBranch = currentBranch; }
        const targetHeadBeforeMerge = git(this.config.projectRoot, ['rev-parse', targetBranch]);
        if (targetHeadBeforeMerge !== base) {
          const pausedAt = new Date().toISOString();
          await this.store.updateIntegrationBatch(batch.id, { status: 'conflict', conflictsJson: JSON.stringify({ reason: 'target_advanced_after_final_review', expectedBase: base, actualTargetHead: targetHeadBeforeMerge }), finishedAt: pausedAt });
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'target_advanced_after_final_review',
            category: 'integration', eventData: { expectedBase: base, actualTargetHead: targetHeadBeforeMerge }, createdAt: pausedAt,
          });
          await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
          await this.store.createEvent({ id: this.nextEventId(runId, 'ev-target-advanced'), runId, stageId: stage.id, eventType: 'integration_conflict', eventData: { reason: 'target_advanced_after_final_review', expectedBase: base, actualTargetHead: targetHeadBeforeMerge } });
          return false;
        }
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
        const reviewedTree = git(this.config.projectRoot, ['rev-parse', `${mh}^{tree}`]);
        const finalTree = git(this.config.projectRoot, ['rev-parse', `${targetMergeCommit}^{tree}`]);
        if (reviewedTree !== finalTree) throw new Error('final merge tree differs from the reviewed integration tree');
        await this.store.updateIntegrationBatch(batch.id, { status: 'completed', mergeCommitHash: targetMergeCommit, targetMergeCommit: targetMergeCommit, finalCommit: targetMergeCommit, reviewCoverageStatus: 'complete', finishedAt: new Date().toISOString() });
        await this.store.createEvent({ id: runId + '-ev-target-merge-' + Date.now(), runId, stageId: stage.id, eventType: 'integration_completed', eventData: { targetBranch, targetMergeCommit, integrationBranch: ib } });
        console.log('[Scheduler] Target branch merge complete: ' + ib + ' -> ' + targetBranch + ' (' + targetMergeCommit + ')');
      } catch (mergeErr: any) {
        const errMsg = mergeErr.message || String(mergeErr);
        const pausedAt = new Date().toISOString();
        console.log('[Scheduler] Target branch merge conflict: ' + errMsg);
        await this.store.updateIntegrationBatch(batch.id, { status: 'conflict', conflictsJson: JSON.stringify({ error: errMsg, integrationBranch: ib, targetBranch }), finishedAt: pausedAt });
        await this.recordStagePause({
          runId, stageId: stage.id, reasonCode: 'target_branch_merge_conflict',
          category: 'integration', eventData: { integrationBranch: ib, targetBranch, error: errMsg }, createdAt: pausedAt,
        });
        await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
        await this.store.createEvent({ id: runId + '-ev-target-conflict-' + Date.now(), runId, stageId: stage.id, eventType: 'integration_conflict', eventData: { integrationBranch: ib, targetBranch, error: errMsg } });
        return false;
      }

      const mergedAt = new Date().toISOString();
      for (const task of stageTasks) {
        await this.store.updateTaskStatus(task.id, 'merged', mergedAt);
      }
      await this.store.updateStageStatus(stage.id, 'completed', mergedAt);
      await this.store.releaseActualPathClaimsForStage(stage.id, mergedAt);
      await this.store.createEvent({ id: runId + '-ev-int-ok-' + Date.now(), runId, stageId: stage.id, eventType: 'stage_completed', eventData: { stageNumber: stage.stageNumber, targetBranch, targetMergeCommit: git(this.config.projectRoot, ['rev-parse', 'HEAD']) } });
      console.log('[Scheduler] Stage ' + stage.stageNumber + ' integrated + merged to ' + targetBranch + '.');
      if (this.config.cleanupMergedWorktrees || this.config.allowRealWorker || this.config.allowRealReviewer) {
        await this.cleanupMergedStageWorktrees(runId, stage.id, wtm, atts, ib, ip);
      }
      return true;
    } catch (e: any) {
      const pausedAt = new Date().toISOString();
      await this.store.updateIntegrationBatch(batch.id, { status: 'failed', conflictsJson: JSON.stringify({ error: e.message }), finishedAt: pausedAt });
      await this.recordStagePause({
        runId, stageId: stage.id, reasonCode: 'integration_failed',
        category: 'integration', eventData: { error: e.message }, createdAt: pausedAt,
      });
      await this.mergeBlockApprovedTasks(stageTasks, pausedAt);
      return false;
    }
  }

  /** R4: decide whether a previous integration truly completed (idempotent).
   *  - mode 'none': no completed batch, or an idempotency condition (coverage /
   *    reviewer / targetMergeCommit) is not met → run the FULL integration.
   *  - mode 'fail_closed': DB says completed but git cannot prove the merge
   *    landed → real state inconsistency, hand to a human.
   *  - mode 'complete': truly completed → finish the state tail only.
   */
  private async checkIdempotentIntegration(
    stage: StageRecord,
    runId: string,
  ): Promise<{ mode: 'none' } | { mode: 'fail_closed'; batch: import('../types/m2-types.js').IntegrationBatchRecord | null } | { mode: 'complete'; batch: import('../types/m2-types.js').IntegrationBatchRecord }> {
    const batches = await this.store.listIntegrationBatches(stage.id);
    const completed = batches
      .filter((b) => b.status === 'completed')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
    if (completed.length === 0) return { mode: 'none' };
    const latest = completed[completed.length - 1];
    // Hard conditions 1–4: non-empty merge commit, complete coverage, reviewer available.
    if (!latest.targetMergeCommit || latest.reviewCoverageStatus !== 'complete' || latest.reviewerUnavailable) {
      return { mode: 'none' };
    }
    // Hard condition 5 (the core): git must prove the merge landed on the
    // TARGET branch (never HEAD — same trap as round 1).
    let targetBranch = this.config.targetBranch;
    try {
      const currentBranch = git(this.config.projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      try { git(this.config.projectRoot, ['rev-parse', '--verify', '--end-of-options', targetBranch]); }
      catch { targetBranch = currentBranch; }
    } catch { /* keep configured targetBranch */ }
    const mergeLanded = isBranchMerged(this.config.projectRoot, latest.targetMergeCommit, targetBranch);
    if (!mergeLanded) {
      return { mode: 'fail_closed', batch: latest };
    }
    return { mode: 'complete', batch: latest };
  }

  /** R4: finish the state tail of an already-truly-completed integration.
   *  - tasks → merged (already-merged tasks return false from the terminal
   *    guard — expected, ignore; NOT-yet-merged tasks must actually update).
   *  - stage → completed, claims released, audited event with reason
   *    'idempotent_resume', residual worktree/branch cleanup (same trigger).
   */
  private async completeIdempotentIntegration(
    stage: StageRecord,
    runId: string,
    wtm: WorktreeManager,
    batch: import('../types/m2-types.js').IntegrationBatchRecord,
  ): Promise<boolean> {
    const mergedAt = new Date().toISOString();
    const stageTasks = await this.tasksForStage(stage, runId);
    for (const task of stageTasks) {
      const ok = await this.store.updateTaskStatus(task.id, 'merged', mergedAt);
      if (!ok) {
        const cur = await this.store.getTask(task.id);
        if (cur?.status !== 'merged') {
          const pausedAt = new Date().toISOString();
          await this.recordStagePause({
            runId, stageId: stage.id, reasonCode: 'integration_state_inconsistent',
            category: 'integration',
            eventData: { taskId: task.id, taskStatus: cur?.status ?? null, detail: '幂等收尾：任务既非 merged 也无法转为 merged' },
            createdAt: pausedAt,
          });
          return false;
        }
      }
    }
    await this.store.updateStageStatus(stage.id, 'completed', mergedAt);
    await this.store.releaseActualPathClaimsForStage(stage.id, mergedAt);
    let targetBranch: string | null = this.config.targetBranch || null;
    if (!targetBranch) {
      try { targetBranch = git(this.config.projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']); } catch { /* keep null */ }
    }
    await this.store.createEvent({
      id: this.nextEventId(runId, 'ev-int-idempotent'), runId, stageId: stage.id,
      eventType: 'stage_completed',
      eventData: {
        stageNumber: stage.stageNumber,
        targetBranch,
        targetMergeCommit: batch.targetMergeCommit,
        reason: 'idempotent_resume',
      },
    });
    console.log('[Scheduler] Stage ' + stage.stageNumber + ' idempotent resume (integration already landed as ' + batch.targetMergeCommit + ').');
    if (this.config.cleanupMergedWorktrees || this.config.allowRealWorker || this.config.allowRealReviewer) {
      const atts = await this.store.listAttemptsByStage(stage.id);
      const m = batch.integrationBranch.match(/\/a(\d+)$/);
      const attempt = m ? parseInt(m[1], 10) : 1;
      const ip = resolve(this.config.projectRoot, this.config.worktreeBaseDir + '/' + runId + '/int/stage-' + stage.stageNumber + '/a' + attempt);
      await this.cleanupMergedStageWorktrees(runId, stage.id, wtm, atts, batch.integrationBranch, ip);
    }
    return true;
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
    const cleanupBranch = async (
      branchName: string,
      worktreePath?: string | null,
      expectedBranch?: string,
    ): Promise<void> => {
      try {
        if (expectedBranch && branchName !== expectedBranch) {
          throw new Error(`branch identity mismatch; expected ${expectedBranch}`);
        }
        await wtm.cleanupRedundantWorktree(branchName, worktreePath || undefined, 'HEAD');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(branchName + ': ' + message.split('\n')[0]);
      }
    };

    await cleanupBranch(
      integrationBranch,
      integrationWorktreePath,
      `brainctl/int/${runId}/stage-${(await this.store.getStage(stageId))?.stageNumber}/a${(await this.store.listIntegrationBatches(stageId)).length}`,
    );
    for (const attempt of attempts) {
      if (!['approved', 'failed', 'interrupted', 'canceled', 'rework_required'].includes(attempt.status) || !attempt.branchName) continue;
      await cleanupBranch(
        attempt.branchName,
        attempt.worktreePath,
        `brainctl/${runId}/${attempt.taskId}/a${attempt.attemptNumber}`,
      );
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
      // A review_skipped task is deliberately not approved yet. Moving it to
      // merge_blocked would later allow merge_blocked -> approved without the
      // mandatory final review, so leave it review_skipped while the Stage is
      // paused and only block tasks that were already individually approved.
      if (task.status === 'approved') await this.store.updateTaskStatus(task.id, 'merge_blocked', timestamp);
    }
  }

}

