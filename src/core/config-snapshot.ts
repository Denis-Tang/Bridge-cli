import type { SchedulerResolvedConfig } from './config-resolver.js';

export interface ExecutionConfigSnapshot {
  snapshotVersion: number;
  createdAt: string;
  config: SanitizedResolvedConfig;
}

export interface SanitizedResolvedConfig {
  projectId: string;
  projectRoot: string;
  targetBranch: string;
  worker: { type: string; command: string; args: string[]; model: string; timeoutMs: number; maxConcurrency: number };
  reviewer: { type: string; command: string; args: string[]; model: string; timeoutMs: number };
  qualityGatesTask: Array<{
    name: string;
    command: string;
    args: string[];
    cwd?: string;
    timeoutMs?: number;
    stopOnFail?: boolean;
  }>;
  qualityGatesStage: Array<{
    name: string;
    command: string;
    args: string[];
    cwd?: string;
    timeoutMs?: number;
    stopOnFail?: boolean;
  }>;
  forbiddenPaths: string[];
  allowedPaths: string[];
  sharedLocks: string[];
  resourceSampling: { enabled: boolean; intervalMs: number; maxParallelTasks: number };
  maxParallelTasks: number;
  workerTimeoutMs: number;
  reviewerTimeoutMs: number;
  outputDir: string;
  logsDir: string;
  retentionDays: number;
}

const SENSITIVE_KEYS = new Set([
  'apikey', 'api_key', 'api-key', 'token', 'secret', 'password', 'passwd',
  'credential', 'auth', 'private_key', 'privatekey', 'access_key', 'accesskey',
]);

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const pattern of SENSITIVE_KEYS) {
    if (lower.includes(pattern)) return true;
  }
  return false;
}

function redactEnvRefs(value: string): string {
  // Replace anything that looks like an env variable assignment: KEY=VALUE
  return value.replace(/(\b[A-Za-z_][A-Za-z0-9_]*=)[^\s]*/g, '$1<redacted>');
}

function sanitizeArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (typeof arg !== 'string') return String(arg);
    const lower = arg.toLowerCase();
    if (redactNext) {
      redactNext = false;
      return '<redacted>';
    }
    if (isSensitiveKey(lower) || lower.startsWith('api_key=') || lower.startsWith('token=')) {
      return '<redacted>';
    }
    if (/^--?(?:api[-_]?key|token|secret|password|passwd|credential|auth)(?:=|$)/i.test(arg)) {
      if (!arg.includes('=')) redactNext = true;
      return arg.includes('=') ? `${arg.slice(0, arg.indexOf('='))}=<redacted>` : arg;
    }
    return redactEnvRefs(arg);
  });
}

export function sanitizeResolvedConfig(config: SchedulerResolvedConfig): SanitizedResolvedConfig {
  return {
    projectId: config.projectId,
    projectRoot: config.projectRoot,
    targetBranch: config.targetBranch,
    worker: {
      type: config.worker.type,
      command: config.worker.command,
      args: sanitizeArgs(config.worker.args),
      model: config.worker.model,
      timeoutMs: config.worker.timeoutMs,
      maxConcurrency: config.worker.maxConcurrency,
    },
    reviewer: {
      type: config.reviewer.type,
      command: config.reviewer.command,
      args: sanitizeArgs(config.reviewer.args),
      model: config.reviewer.model,
      timeoutMs: config.reviewer.timeoutMs,
    },
    qualityGatesTask: config.qualityGatesTask.map((g) => ({
      name: g.name,
      command: g.command,
      args: sanitizeArgs(g.args),
      cwd: g.cwd,
      timeoutMs: g.timeoutMs,
      stopOnFail: g.stopOnFail,
    })),
    qualityGatesStage: config.qualityGatesStage.map((g) => ({
      name: g.name,
      command: g.command,
      args: sanitizeArgs(g.args),
      cwd: g.cwd,
      timeoutMs: g.timeoutMs,
      stopOnFail: g.stopOnFail,
    })),
    forbiddenPaths: config.forbiddenPaths,
    allowedPaths: config.allowedPaths,
    sharedLocks: config.sharedLocks,
    resourceSampling: config.resourceSampling,
    maxParallelTasks: config.maxParallelTasks,
    workerTimeoutMs: config.workerTimeoutMs,
    reviewerTimeoutMs: config.reviewerTimeoutMs,
    outputDir: config.outputDir,
    logsDir: config.logsDir,
    retentionDays: config.retentionDays,
  };
}

export function createExecutionConfigSnapshot(config: SchedulerResolvedConfig): string {
  const snapshot: ExecutionConfigSnapshot = {
    snapshotVersion: 1,
    createdAt: new Date().toISOString(),
    config: sanitizeResolvedConfig(config),
  };
  return JSON.stringify(snapshot);
}

export interface DeserializedSnapshot {
  snapshotVersion: number;
  createdAt: string;
  config: Partial<SchedulerResolvedConfig>;
}

export function deserializeExecutionConfigSnapshot(snapshot: string | null | undefined): DeserializedSnapshot | null {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot) as ExecutionConfigSnapshot;
    if (typeof parsed.snapshotVersion !== 'number' || parsed.snapshotVersion < 1) {
      throw new Error('invalid snapshotVersion');
    }
    if (!parsed.config || typeof parsed.config !== 'object') {
      throw new Error('missing config object');
    }
    return {
      snapshotVersion: parsed.snapshotVersion,
      createdAt: parsed.createdAt,
      config: parsed.config as Partial<SchedulerResolvedConfig>,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid execution config snapshot: ${msg}`);
  }
}
