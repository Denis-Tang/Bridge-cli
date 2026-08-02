import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { ExecutionMode } from '../types/m2-types.js';
import type { CostBudgetConfig } from '../types/m4-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface QualityGateItem {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  stopOnFail?: boolean;
}

export interface ProjectQualityGates {
  task?: QualityGateItem[];
  stage?: QualityGateItem[];
}

export interface WorkerConfig {
  type: 'fake' | 'real-pi';
  command: string;
  args: string[];
  model: string;
  timeoutMs: number;
  maxConcurrency: number;
  /** R3: verified Pi CLI version for the read-only guard; mismatch → warning + mandatory self-check. */
  verifiedPiVersion?: string;
  /** B (authorized): allow the ONE-inference block-semantics probe (persistently cached per Pi version). */
  allowInferenceProbe?: boolean;
}

export interface ReviewerConfig {
  type: 'local-rule' | 'codex-cli';
  command: string;
  args: string[];
  model: string;
  timeoutMs: number;
}

export interface ResourceSamplingConfig {
  enabled: boolean;
  intervalMs: number;
  maxParallelTasks: number;
}

export interface ArtifactRetentionConfig {
  outputDir?: string;
  logsDir?: string;
  retentionDays?: number;
}

export interface ProjectConfig {
  schemaVersion: number;
  projectId: string;
  /** Project root — may be '.' (portable), relative, or absolute. Resolved at load time relative to config file location. */
  projectRoot: string;
  defaultBaseBranch: string;
  executionMode: ExecutionMode;
  qualityGates: ProjectQualityGates;
  forbiddenPaths: string[];
  sharedLocks: string[];
  allowedPaths: string[];
  worker: WorkerConfig;
  reviewer: ReviewerConfig;
  resourceSampling: ResourceSamplingConfig;
  artifactRetention: ArtifactRetentionConfig;
  costBudget: CostBudgetConfig | null;
}

export interface ProjectConfigFile {
  schemaVersion: number;
  projectId: string;
  projectRoot: string;
  defaultBaseBranch: string;
  executionMode?: ExecutionMode;
  qualityGates?: ProjectQualityGates;
  forbiddenPaths?: string[];
  sharedLocks?: string[];
  allowedPaths?: string[];
  worker?: Partial<WorkerConfig>;
  reviewer?: Partial<ReviewerConfig>;
  resourceSampling?: Partial<ResourceSamplingConfig>;
  artifactRetention?: Partial<ArtifactRetentionConfig>;
  artifact?: Partial<ArtifactRetentionConfig>;
  costBudget?: CostBudgetConfig | null;
}

export interface ProjectAdapterLoadError {
  ok: false;
  reason: string;
  fieldErrors?: Array<{ path: string; message: string }>;
}

export interface ProjectAdapterLoadSuccess {
  ok: true;
  config: ProjectConfig;
}

export type ProjectAdapterLoadResult = ProjectAdapterLoadSuccess | ProjectAdapterLoadError;

function loadSchema(): object {
  const candidates = [
    resolve(__dirname, '../schemas/project-brainctl.schema.json'),
    resolve(__dirname, '../../src/schemas/project-brainctl.schema.json'),
    resolve(process.cwd(), 'src/schemas/project-brainctl.schema.json'),
  ];
  const schemaPath = candidates.find((candidate) => existsSync(candidate));
  if (!schemaPath) throw new Error('project-brainctl schema file not found');
  return JSON.parse(readFileSync(schemaPath, 'utf-8'));
}

function buildAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv;
}

export function resolveProjectPath(value: string, baseDir?: string): string {
  // If the value is already an absolute path, resolve it (for backward compat)
  if (isAbsolute(value)) return resolve(value);
  if (!baseDir) {
    throw new Error('Relative project path requires an explicit base directory');
  }
  return resolve(baseDir, value || '.');
}

function projectIdFromRoot(projectRoot: string): string {
  const name = basename(normalize(projectRoot)).trim();
  return name || 'project';
}

function isUnsafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  return normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => part === '..');
}

function samePath(left: string, right: string): boolean {
  const a = normalize(resolve(left));
  const b = normalize(resolve(right));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function defaults(projectRoot: string): ProjectConfig {
  const root = resolveProjectPath(projectRoot, process.cwd());
  return {
    schemaVersion: 1,
    projectId: projectIdFromRoot(root || projectRoot),
    // Store '.' for portability — the loading path is resolved at load time
    projectRoot: '.',
    defaultBaseBranch: detectBranch(root),
    executionMode: 'token-efficient',
    qualityGates: { task: [], stage: [] },
    forbiddenPaths: ['.env', '.env.*', '**/*secret*', '**/*key*'],
    sharedLocks: ['package.json', 'package-lock.json', 'tsconfig.json'],
    allowedPaths: [],
    worker: {
      type: 'fake',
      command: 'pi',
      args: ['--mode', 'rpc'],
      model: '',
      timeoutMs: 180000,
      maxConcurrency: 4,
      verifiedPiVersion: '0.82.1',
    },
    reviewer: {
      type: 'local-rule',
      command: 'codex',
      args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '-'],
      model: '',
      timeoutMs: 120000,
    },
    resourceSampling: {
      enabled: false,
      intervalMs: 5000,
      maxParallelTasks: 4,
    },
    artifactRetention: {
      outputDir: '.brainctl-dev/output',
      logsDir: '.brainctl-dev/logs',
      retentionDays: 7,
    },
    costBudget: null,
  };
}

function mergeDefaults(file: ProjectConfigFile, projectRoot: string, configFileDir?: string): ProjectConfig {
  const base = defaults(projectRoot);
  const rawProjectRoot = file.projectRoot ?? '.';
  // Resolve projectRoot: '.' means portable — resolve to the directory
  // containing the config file (the project root), not the .brainctl dir.
  // Absolute paths are kept for backward compatibility.
  const resolvedRoot = rawProjectRoot === '.' || rawProjectRoot === ''
    ? (configFileDir ? resolve(configFileDir, '..') : resolveProjectPath(projectRoot, process.cwd()))
    : resolveProjectPath(rawProjectRoot, configFileDir);
  return {
    schemaVersion: file.schemaVersion ?? base.schemaVersion,
    projectId: file.projectId ?? base.projectId,
    projectRoot: resolvedRoot,
    defaultBaseBranch: file.defaultBaseBranch ?? base.defaultBaseBranch,
    executionMode: file.executionMode ?? base.executionMode,
    qualityGates: {
      task: file.qualityGates?.task ?? base.qualityGates.task,
      stage: file.qualityGates?.stage ?? base.qualityGates.stage,
    },
    forbiddenPaths: file.forbiddenPaths ?? base.forbiddenPaths,
    sharedLocks: file.sharedLocks ?? base.sharedLocks,
    allowedPaths: file.allowedPaths ?? base.allowedPaths,
    worker: { ...base.worker, ...file.worker },
    reviewer: { ...base.reviewer, ...file.reviewer },
    resourceSampling: { ...base.resourceSampling, ...file.resourceSampling },
    artifactRetention: { ...base.artifactRetention, ...(file.artifactRetention ?? file.artifact) },
    costBudget: file.costBudget ?? base.costBudget,
  };
}

export function detectBranch(projectRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: resolveProjectPath(projectRoot, process.cwd()),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function readPackageScripts(projectRoot: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as { scripts?: Record<string, unknown> };
    return raw.scripts ?? {};
  } catch {
    return {};
  }
}

/** Build a read-only, local-file-based configuration proposal for `brainctl init`. */
export function suggestProjectConfig(projectRoot: string): ProjectConfig {
  const config = defaults(projectRoot);
  const resolvedRoot = resolveProjectPath(projectRoot, process.cwd());
  config.projectRoot = resolvedRoot;
  const scripts = readPackageScripts(resolvedRoot);
  const gates: QualityGateItem[] = [];
  if (typeof scripts.test === 'string') gates.push({ name: 'node-test', command: 'npm', args: ['test'], timeoutMs: 120000, stopOnFail: true });
  if (typeof scripts.build === 'string') gates.push({ name: 'node-build', command: 'npm', args: ['run', 'build'], timeoutMs: 120000, stopOnFail: true });
  if (existsSync(resolve(resolvedRoot, 'pyproject.toml')) || existsSync(resolve(resolvedRoot, 'pytest.ini'))) {
    gates.push({ name: 'python-test', command: 'python', args: ['-m', 'pytest'], timeoutMs: 120000, stopOnFail: true });
  } else if (existsSync(resolve(resolvedRoot, 'Cargo.toml'))) {
    gates.push({ name: 'rust-test', command: 'cargo', args: ['test'], timeoutMs: 120000, stopOnFail: true });
  }
  config.qualityGates = { task: gates, stage: gates.map((gate) => ({ ...gate })) };
  return config;
}

function formatAjvErrors(validate: ValidateFunction): Array<{ path: string; message: string }> {
  return (validate.errors || []).map((err) => {
    const basePath = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : '';
    const params = err.params as Record<string, unknown>;
    const path = err.keyword === 'additionalProperties'
      ? [basePath, String(params.additionalProperty ?? 'unknown')].filter(Boolean).join('.')
      : err.keyword === 'required'
        ? [basePath, String(params.missingProperty ?? 'unknown')].filter(Boolean).join('.')
        : basePath || err.keyword || 'root';
    const message = err.keyword === 'additionalProperties'
      ? `unknown field ${String(params.additionalProperty ?? '')}`
      : err.message || 'invalid value';
    return { path, message };
  });
}

function validateMergedConfig(config: ProjectConfig, expectedRoot: string): Array<{ path: string; message: string }> {
  const errors: Array<{ path: string; message: string }> = [];
  if (!samePath(config.projectRoot, expectedRoot)) {
    errors.push({ path: 'projectRoot', message: 'must resolve to the project being loaded' });
  }

  const pathLists: Array<[string, string[]]> = [
    ['forbiddenPaths', config.forbiddenPaths],
    ['allowedPaths', config.allowedPaths],
    ['sharedLocks', config.sharedLocks],
  ];
  for (const [field, values] of pathLists) {
    values.forEach((value, index) => {
      if (!value.trim()) errors.push({ path: `${field}.${index}`, message: 'path must not be empty' });
      else if (isUnsafeRelativePath(value)) errors.push({ path: `${field}.${index}`, message: 'path must stay within project root' });
    });
  }

  for (const scope of ['task', 'stage'] as const) {
    for (const [index, gate] of (config.qualityGates[scope] ?? []).entries()) {
      if (!gate.command.trim()) errors.push({ path: `qualityGates.${scope}.${index}.command`, message: 'command must not be empty' });
      if (gate.cwd && isUnsafeRelativePath(gate.cwd)) errors.push({ path: `qualityGates.${scope}.${index}.cwd`, message: 'cwd must stay within project root' });
      if (gate.command.toLowerCase() === 'npx' && !gate.args.includes('--no-install')) {
        errors.push({ path: `qualityGates.${scope}.${index}.args`, message: 'npx requires --no-install; unpinned downloads are forbidden' });
      }
    }
  }

  if (!config.worker.command.trim()) errors.push({ path: 'worker.command', message: 'command must not be empty' });
  if (!config.reviewer.command.trim()) errors.push({ path: 'reviewer.command', message: 'command must not be empty' });
  for (const [field, value] of [['artifactRetention.outputDir', config.artifactRetention.outputDir], ['artifactRetention.logsDir', config.artifactRetention.logsDir] ] as const) {
    if (value && isUnsafeRelativePath(value)) errors.push({ path: field, message: 'path must stay within project root' });
  }
  return errors;
}

export class ProjectAdapter {
  private config: ProjectConfig | null = null;
  private schema: object;
  private ajv: Ajv;

  constructor() {
    this.schema = loadSchema();
    this.ajv = buildAjv();
  }

  load(projectRoot: string): ProjectConfig {
    const root = resolveProjectPath(projectRoot, process.cwd());
    const configPath = resolve(root, '.brainctl', 'project.json');

    if (!existsSync(configPath)) {
      const cfg = defaults(root);
      // When no config file exists, resolve '.' to the actual cwd root
      cfg.projectRoot = root;
      this.config = cfg;
      return cfg;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse project config: ${err instanceof Error ? err.message : String(err)}`);
    }

    const validate = this.ajv.compile(this.schema);
    const valid = validate(raw);
    if (!valid) {
      const fieldErrors = formatAjvErrors(validate);
      const summary = fieldErrors.map((e) => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Project config validation failed: ${summary}`);
    }

    // Pass config file directory so relative projectRoot can be resolved
    const configFileDir = dirname(configPath);
    const merged = mergeDefaults(raw as ProjectConfigFile, root, configFileDir);
    const runtimeErrors = validateMergedConfig(merged, root);
    if (runtimeErrors.length > 0) {
      const summary = runtimeErrors.map((e) => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Project config validation failed: ${summary}`);
    }
    this.config = merged;
    return merged;
  }

  loadSafe(projectRoot: string): ProjectAdapterLoadResult {
    try {
      return { ok: true, config: this.load(projectRoot) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg };
    }
  }

  getConfig(): ProjectConfig | null {
    return this.config;
  }
}

export function createProjectAdapter(): ProjectAdapter {
  return new ProjectAdapter();
}
