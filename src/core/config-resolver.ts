import type {
  ProjectConfig,
  QualityGateItem,
  WorkerConfig,
  ReviewerConfig,
  ResourceSamplingConfig,
} from '../adapters/project-adapter.js';
import type { ExecutionMode } from '../types/m2-types.js';
import type { CostBudgetConfig } from '../types/m4-types.js';

export interface SchedulerResolvedConfig {
  projectId: string;
  projectRoot: string;
  targetBranch: string;
  executionMode: ExecutionMode;
  worker: WorkerConfig;
  reviewer: ReviewerConfig;
  qualityGatesTask: QualityGateItem[];
  qualityGatesStage: QualityGateItem[];
  forbiddenPaths: string[];
  allowedPaths: string[];
  sharedLocks: string[];
  resourceSampling: ResourceSamplingConfig;
  maxParallelTasks: number;
  workerTimeoutMs: number;
  reviewerTimeoutMs: number;
  outputDir: string;
  logsDir: string;
  retentionDays: number;
  costBudget: CostBudgetConfig | null;
}

export interface ConfigResolverOptions {
  projectConfig: ProjectConfig;
  cliOverrides?: {
    worker?: string;
    reviewer?: string;
    targetBranch?: string;
    maxParallelTasks?: number;
    workerTimeoutMs?: number;
    reviewerTimeoutMs?: number;
    resourceSamplingEnabled?: boolean;
    executionMode?: string;
  };
  snapshot?: Partial<SchedulerResolvedConfig> | null;
  detectedBranch?: string;
}

function pickWorkerType(value: string | undefined, fallback: WorkerConfig['type']): WorkerConfig['type'] {
  if (!value) return fallback;
  // Only fake and real-pi are implemented. Unknown types fail closed.
  if (value === 'fake' || value === 'real-pi') return value;
  throw new Error(`Unsupported worker type: ${value}. Supported: fake, real-pi.`);
}

function pickReviewerType(value: string | undefined, fallback: ReviewerConfig['type']): ReviewerConfig['type'] {
  if (!value) return fallback;
  // Only local-rule and codex-cli are implemented. Unknown types fail closed.
  if (value === 'local-rule' || value === 'codex-cli') return value;
  throw new Error(`Unsupported reviewer type: ${value}. Supported: local-rule, codex-cli.`);
}

function pickExecutionMode(value: string | undefined, fallback: ExecutionMode): ExecutionMode {
  if (!value) return fallback;
  if (value === 'default' || value === 'simple' || value === 'token-efficient') return value;
  throw new Error(`Unsupported execution mode: ${value}. Supported: default, simple, token-efficient.`);
}

function coalesce<T>(...values: Array<T | undefined | null>): T {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  throw new Error('config-resolver: no value provided');
}

/**
 * Reviewers are read-only by design (review independence). When the effective
 * reviewer is codex-cli, its args MUST contain `--sandbox` immediately
 * followed by `read-only`; anything else means a misconfigured project.json
 * could silently hand write access to the reviewer — reject at startup.
 */
function assertReviewerReadOnly(reviewer: ReviewerConfig): void {
  if (reviewer.type !== 'codex-cli') return;
  const args = reviewer.args ?? [];
  const hasReadOnlySandbox = args.some((arg, index) => arg === '--sandbox' && args[index + 1] === 'read-only');
  if (!hasReadOnlySandbox) {
    throw new Error(
      `Reviewer type 'codex-cli' requires args containing '--sandbox read-only' (reviewer must stay read-only); got: ${JSON.stringify(args)}`,
    );
  }
}

export function resolveConfig(options: ConfigResolverOptions): SchedulerResolvedConfig {
  const { projectConfig, cliOverrides = {}, snapshot = null, detectedBranch = '' } = options;

  const base: SchedulerResolvedConfig = {
    projectId: projectConfig.projectId,
    projectRoot: projectConfig.projectRoot,
    targetBranch: projectConfig.defaultBaseBranch || detectedBranch || '',
    executionMode: projectConfig.executionMode,
    worker: { ...projectConfig.worker },
    reviewer: { ...projectConfig.reviewer },
    qualityGatesTask: projectConfig.qualityGates.task ?? [],
    qualityGatesStage: projectConfig.qualityGates.stage ?? [],
    forbiddenPaths: projectConfig.forbiddenPaths,
    allowedPaths: projectConfig.allowedPaths,
    sharedLocks: projectConfig.sharedLocks,
    resourceSampling: { ...projectConfig.resourceSampling },
    maxParallelTasks: projectConfig.worker.maxConcurrency,
    workerTimeoutMs: projectConfig.worker.timeoutMs,
    reviewerTimeoutMs: projectConfig.reviewer.timeoutMs,
    outputDir: projectConfig.artifactRetention.outputDir ?? '.brainctl-dev/output',
    logsDir: projectConfig.artifactRetention.logsDir ?? '.brainctl-dev/logs',
    retentionDays: projectConfig.artifactRetention.retentionDays ?? 7,
    costBudget: projectConfig.costBudget,
  };

  // Run snapshot layer: it wins over the current project file during resume.
  if (snapshot) {
    if (snapshot.targetBranch !== undefined) base.targetBranch = snapshot.targetBranch;
    if (snapshot.executionMode !== undefined) base.executionMode = snapshot.executionMode;
    if (snapshot.worker) base.worker = { ...base.worker, ...snapshot.worker };
    if (snapshot.reviewer) base.reviewer = { ...base.reviewer, ...snapshot.reviewer };
    if (snapshot.qualityGatesTask) base.qualityGatesTask = snapshot.qualityGatesTask;
    if (snapshot.qualityGatesStage) base.qualityGatesStage = snapshot.qualityGatesStage;
    if (snapshot.forbiddenPaths) base.forbiddenPaths = snapshot.forbiddenPaths;
    if (snapshot.allowedPaths) base.allowedPaths = snapshot.allowedPaths;
    if (snapshot.sharedLocks) base.sharedLocks = snapshot.sharedLocks;
    if (snapshot.resourceSampling) base.resourceSampling = { ...base.resourceSampling, ...snapshot.resourceSampling };
    if (snapshot.maxParallelTasks !== undefined) base.maxParallelTasks = snapshot.maxParallelTasks;
    if (snapshot.workerTimeoutMs !== undefined) base.workerTimeoutMs = snapshot.workerTimeoutMs;
    if (snapshot.reviewerTimeoutMs !== undefined) base.reviewerTimeoutMs = snapshot.reviewerTimeoutMs;
    if (snapshot.costBudget !== undefined) base.costBudget = snapshot.costBudget;
  }

  // CLI explicit parameters are the highest-priority layer.
  if (cliOverrides.worker) {
    base.worker.type = pickWorkerType(cliOverrides.worker, base.worker.type);
  }
  if (cliOverrides.reviewer) {
    base.reviewer.type = pickReviewerType(cliOverrides.reviewer, base.reviewer.type);
  }
  if (cliOverrides.targetBranch !== undefined && cliOverrides.targetBranch !== '') {
    base.targetBranch = cliOverrides.targetBranch;
  }
  if (cliOverrides.maxParallelTasks !== undefined) {
    base.maxParallelTasks = cliOverrides.maxParallelTasks;
    base.resourceSampling.maxParallelTasks = cliOverrides.maxParallelTasks;
  }
  if (cliOverrides.workerTimeoutMs !== undefined) {
    base.workerTimeoutMs = cliOverrides.workerTimeoutMs;
    base.worker.timeoutMs = cliOverrides.workerTimeoutMs;
  }
  if (cliOverrides.reviewerTimeoutMs !== undefined) {
    base.reviewerTimeoutMs = cliOverrides.reviewerTimeoutMs;
    base.reviewer.timeoutMs = cliOverrides.reviewerTimeoutMs;
  }
  if (cliOverrides.resourceSamplingEnabled !== undefined) {
    base.resourceSampling.enabled = cliOverrides.resourceSamplingEnabled;
  }
  if (cliOverrides.executionMode !== undefined) {
    base.executionMode = pickExecutionMode(cliOverrides.executionMode, base.executionMode);
  }

  // Final fallbacks: ensure targetBranch is never empty if we can help it
  if (!base.targetBranch && detectedBranch) {
    base.targetBranch = detectedBranch;
  }

  // L6: reviewer read-only sandbox is a code gate, not just a doc promise.
  // Validate the FINAL assembled reviewer (after snapshot/CLI layers), so a
  // misconfigured project.json, snapshot or CLI override cannot silently give
  // the reviewer write access.
  assertReviewerReadOnly(base.reviewer);

  return base;
}

export function resolveTargetBranch(projectRoot: string, configuredBranch: string, detectedBranch: string): string {
  if (configuredBranch) return configuredBranch;
  if (detectedBranch) return detectedBranch;
  return '';
}
