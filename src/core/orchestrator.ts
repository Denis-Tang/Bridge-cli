import path from 'node:path';
import type { JobRequest, RunSummary, TaskSpec, WorkerResult, ReviewResult } from '../types/protocol.js';
import { CodexBrainAdapter } from '../adapters/codex-brain.js';
import { PiRpcWorker } from '../adapters/pi-rpc-worker.js';
import { CodexReviewer } from '../adapters/codex-reviewer.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import { MergeManager } from '../git/merge-manager.js';
import { DiffScopeValidator } from '../git/diff-scope-validator.js';
import { QualityGateRunner, type QualityGateConfig } from '../quality/quality-gate-runner.js';
import { ObsidianRecorder } from '../recorder/obsidian-recorder.js';

/**
 * Result of a full orchestrated run.
 */
export interface OrchestrationResult {
  runId: string;
  success: boolean;
  summary: RunSummary;
  phases: Array<{ name: string; success: boolean; error?: string }>;
}

/**
 * Configuration for the Orchestrator.
 */
export interface OrchestratorConfig {
  projectRoot: string;
  defaultBaseBranch: string;
  obsidianRecordsRoot: string;
  obsidianProjectFolder: string;
  qualityGates?: QualityGateConfig[];
}

/**
 * Orchestrator — coordinates the end-to-end M1 workflow.
 * Manages the full lifecycle: submit → plan → execute → review → merge → record.
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private codexBrain: CodexBrainAdapter;
  private reviewer: CodexReviewer;
  private worktreeManager: WorktreeManager;
  private mergeManager: MergeManager;
  private scopeValidator: DiffScopeValidator;
  private qualityGateRunner: QualityGateRunner;
  private recorder: ObsidianRecorder;

  constructor(
    config: OrchestratorConfig,
    deps?: {
      codexBrain?: CodexBrainAdapter;
      reviewer?: CodexReviewer;
      worktreeManager?: WorktreeManager;
      mergeManager?: MergeManager;
      scopeValidator?: DiffScopeValidator;
      qualityGateRunner?: QualityGateRunner;
      recorder?: ObsidianRecorder;
    },
  ) {
    this.config = config;
    this.codexBrain = deps?.codexBrain ?? new CodexBrainAdapter();
    this.reviewer = deps?.reviewer ?? new CodexReviewer();
    this.worktreeManager = deps?.worktreeManager ?? new WorktreeManager(config.projectRoot);
    this.mergeManager = deps?.mergeManager ?? new MergeManager(this.worktreeManager);
    this.scopeValidator = deps?.scopeValidator ?? new DiffScopeValidator();
    this.qualityGateRunner = deps?.qualityGateRunner ?? new QualityGateRunner(config.projectRoot);
    this.recorder = deps?.recorder ?? new ObsidianRecorder({
      recordsRoot: config.obsidianRecordsRoot,
      projectFolder: config.obsidianProjectFolder,
    });
  }

  /**
   * Run the full orchestration for a job request.
   */
  async run(jobRequest: JobRequest): Promise<OrchestrationResult> {
    const runId = jobRequest.jobId;
    const phases: Array<{ name: string; success: boolean; error?: string }> = [];

    try {
      // Phase 1: Plan
      phases.push({ name: 'plan', success: false });
      const planResult = await this.codexBrain.planJob();
      phases[0].success = true;

      // Phase 2: Prepare worktree
      phases.push({ name: 'prepare-worktree', success: false });
      const branchName = `brainctl/${runId}`;
      this.worktreeManager.createBranch(branchName, this.config.defaultBaseBranch);
      const worktreePath = `.brainctl/worktrees/${runId}`;
      this.worktreeManager.createWorktree(branchName, worktreePath);
      phases[1].success = true;

      // Phase 3: Execute tasks (simplified to single task for M1)
      phases.push({ name: 'execute', success: false });
      // In M1, execution is handled externally (Pi Worker or fake);
      // the orchestrator records the intent and delegates
      // Make a change in the worktree so there's something to diff/merge
      const fullWtPath = path.resolve(this.config.projectRoot, worktreePath);
      phases[2].success = true;

      // Phase 4: Review
      phases.push({ name: 'review', success: false });
      const diff = this.worktreeManager.getDiff(fullWtPath, this.config.defaultBaseBranch);
      // Skip review if no changes (empty diff is valid for no-op runs)
      if (diff && diff.trim().length > 0) {
        const reviewResult = await this.reviewer.reviewDiff(diff, runId);
        if (!reviewResult.mergeAllowed) {
          throw new Error(`Review rejected: ${reviewResult.reviewSummary}`);
        }
      }
      phases[3].success = true;

      // Phase 5: Quality Gates
      phases.push({ name: 'quality-gates', success: false });
      if (this.config.qualityGates && this.config.qualityGates.length > 0) {
        const qgResult = await this.qualityGateRunner.runGates(this.config.qualityGates);
        if (!qgResult.passed) {
          throw new Error(`Quality gates failed: ${qgResult.summary}`);
        }
      }
      phases[4].success = true;

      // Phase 6: Merge
      phases.push({ name: 'merge', success: false });
      const mergeResult = this.mergeManager.merge(branchName, this.config.defaultBaseBranch);
      if (!mergeResult.success) {
        throw new Error(`Merge failed: ${mergeResult.message}`);
      }
      phases[5].success = true;

      // Phase 7: Record
      phases.push({ name: 'record', success: false });
      await this.recorder.recordProjectDescription(`自动化施工运行 ${runId}`);
      await this.recorder.recordCurrentPlan(runId, jobRequest.requestText, [
        { id: runId, title: 'M1 闭环任务', status: 'completed' },
      ]);
      await this.recorder.recordFinalResult(runId, '施工完成，已合并', [
        { taskId: runId, status: 'completed', summary: '自动化施工完成' },
      ]);
      phases[6].success = true;

      const summary: RunSummary = {
        jobId: runId,
        status: 'completed',
        summary: 'M1 闭环运行成功',
        tasksTotal: 1,
        tasksCompleted: 1,
        tasksFailed: 0,
        decisionsResolved: 0,
        mergedCommits: [],
        qualityGateSummary: 'passed',
        knownLimitations: ['M1 smoke test — not using real Codex/Pi'],
        finishedAt: new Date().toISOString(),
      };

      return { runId, success: true, summary, phases };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Mark current phase as failed if it exists
      const lastPhase = phases[phases.length - 1];
      if (lastPhase && lastPhase.success === false) {
        lastPhase.error = errorMsg;
      }

      const summary: RunSummary = {
        jobId: runId,
        status: 'failed',
        summary: `M1 运行失败: ${errorMsg}`,
        tasksTotal: 1,
        tasksCompleted: 0,
        tasksFailed: 1,
        decisionsResolved: 0,
        mergedCommits: [],
        qualityGateSummary: 'failed',
        knownLimitations: [],
        finishedAt: new Date().toISOString(),
      };

      return { runId, success: false, summary, phases };
    }
  }

  /**
   * Simple health check.
   */
  async healthCheck(): Promise<{ ok: boolean; version: string }> {
    return { ok: true, version: '0.1.0' };
  }
}
