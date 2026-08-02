import { resolve } from 'node:path';
import { ProjectAdapter, detectBranch, type ProjectConfig } from '../adapters/project-adapter.js';
import { assertValidQualityGates, qualityGatesToRunnerConfig } from '../quality/quality-gate-config.js';
import { createPlatformSampler } from './resource-sampler.js';
import { deserializeExecutionConfigSnapshot } from './config-snapshot.js';
import { resolveConfig, type ConfigResolverOptions, type SchedulerResolvedConfig } from './config-resolver.js';
import type { SchedulerConfig } from './stage-scheduler.js';

export interface RuntimeConfigOptions extends Omit<ConfigResolverOptions, 'projectConfig' | 'detectedBranch' | 'snapshot'> {
  snapshotText?: string | null;
  detectedBranch?: string;
}

export interface RuntimeProjectConfig {
  projectConfig: ProjectConfig;
  resolved: SchedulerResolvedConfig;
  source: 'project' | 'defaults' | 'snapshot';
}

export function loadRuntimeProjectConfig(projectRoot: string, options: RuntimeConfigOptions = {}): RuntimeProjectConfig {
  const root = resolve(projectRoot);
  const projectConfig = new ProjectAdapter().load(root);
  const snapshot = options.snapshotText ? deserializeExecutionConfigSnapshot(options.snapshotText)?.config ?? null : null;
  const resolved = resolveConfig({
    ...options,
    projectConfig,
    detectedBranch: options.detectedBranch ?? detectBranch(root),
    snapshot,
  });
  assertValidQualityGates(projectConfig.qualityGates);
  return { projectConfig, resolved, source: snapshot ? 'snapshot' : 'project' };
}

export function schedulerConfigFromResolved(resolved: SchedulerResolvedConfig, governanceEnabled = false): Partial<SchedulerConfig> & { projectRoot: string } {
  const taskQualityGates = qualityGatesToRunnerConfig(resolved.qualityGatesTask);
  const stageQualityGates = qualityGatesToRunnerConfig(resolved.qualityGatesStage);
  return {
    projectRoot: resolved.projectRoot,
    sessionDir: resolve(resolved.projectRoot, '.brainctl-dev/sessions'),
    logDir: resolve(resolved.projectRoot, resolved.logsDir),
    worktreeBaseDir: resolve(resolved.projectRoot, '.brainctl-dev/worktrees'),
    allowRealWorker: resolved.worker.type !== 'fake',
    allowRealReviewer: resolved.reviewer.type !== 'local-rule',
    workerTimeoutMs: resolved.workerTimeoutMs,
    maxParallelTasks: resolved.maxParallelTasks,
    maxReworkCount: 2,
    executionMode: resolved.executionMode,
    defaultLockedPaths: resolved.sharedLocks,
    targetBranch: resolved.targetBranch,
    qualityGates: stageQualityGates,
    taskQualityGates,
    stageQualityGates,
    workerConfig: resolved.worker,
    reviewerConfig: resolved.reviewer,
    resourceSamplingEnabled: resolved.resourceSampling.enabled,
    resourceSampler: createPlatformSampler(),
    samplingIntervalMs: resolved.resourceSampling.intervalMs,
    governanceEnabled,
    costBudget: resolved.costBudget,
  };
}
