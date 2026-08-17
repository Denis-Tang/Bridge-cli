// ── Recovery Integrity Acceptance Fixtures ──────────────────────────────
// Shared helpers for crash recovery, PID ownership, cancel race, and
// worktree/SQLite state consistency acceptance tests.
//
// All fixtures use temp directories, fake providers, and disposable Git
// repos. Zero real Pi/Codex, network, .env, or user data access.

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../../src/state/sqlite-migration-runner.js';
import { ensureDefaultPolicies, setPerRunBudget } from '../../../src/core/budget-policy-store.js';
import { resetGovernanceConfigCache, setGovernanceEnabled } from '../../../src/core/decision-gate.js';
import { StageScheduler } from '../../../src/core/stage-scheduler.js';
import { FakeProcessRunner } from '../../../src/adapters/pi-rpc-worker.js';
import type { ProcessRunInput, ProcessRunResult } from '../../../src/adapters/pi-worker-types.js';
import {
  FakeCodexProcessRunner,
  extractCodexReviewTaskId,
  formatApprovedCodexReviewMarker,
} from '../../../src/adapters/codex-process-runner.js';
import type { CodexProcessRunResult } from '../../../src/adapters/codex-process-runner.js';
import type { SqliteConfig } from '../../../src/state/sqlite-config.js';
import type { StructuredTaskSpec } from '../../../src/types/m2-types.js';
import type { WorkerResult } from '../../../src/types/protocol.js';

// ══════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════

/** Deterministic fake worker output marker */
export function recoveryContent(taskId: string): string {
  return `// recovery-acceptance ${taskId} — marker ${Date.now()}\n`;
}

// ══════════════════════════════════════════════════════════════
// Temporary directory & Git helpers
// ══════════════════════════════════════════════════════════════

export function makeTmpDir(): string {
  const dir = path.join(tmpdir(), `brainctl-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface GitRepo {
  tmp: string;
  projectRoot: string;
}

/** Create a fresh temporary Git repo with seed files. */
export function makeRecoveryGitRepo(): GitRepo {
  const tmp = makeTmpDir();
  const projectRoot = path.join(tmp, 'project');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
  execSync('git init', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config core.autocrlf false', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.email recovery-test@test', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.name "Recovery Test"', { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(path.join(projectRoot, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'lib', 'util.ts'), 'export const util = 2;\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'README.md'), '# Recovery Test\n', 'utf-8');
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git commit -m "initial seed"', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: projectRoot, stdio: 'pipe' });
  return { tmp, projectRoot };
}

// ══════════════════════════════════════════════════════════════
// Store setup
// ══════════════════════════════════════════════════════════════

export async function makeRecoveryStore(tmpDir: string): Promise<SqliteStateStore> {
  const dbPath = path.join(tmpDir, '.brainctl', 'state', 'recovery.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = SqliteStateStore.create(dbPath);
  const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
  const runner = new SqliteMigrationRunner(config, store.getDatabase());
  runner.applyPending();
  await ensureDefaultPolicies(store);
  return store;
}

// ══════════════════════════════════════════════════════════════
// Controllable Runners — for cancel race testing
// ══════════════════════════════════════════════════════════════

/**
 * Pi runner that blocks on a user-controlled barrier.
 * Used for cancel-race testing: suspend the worker, cancel the run,
 * then release to verify cancel detection.
 */
export class ControllablePiRunner extends FakeProcessRunner {
  private _barrier: Promise<void> | null = null;
  private _barrierResolve: (() => void) | null = null;
  private _callCount = 0;
  /** Whether to simulate PID-gone (interrupted) on next run. */
  simulateInterrupted = false;

  get callCount(): number { return this._callCount; }

  /** Install a barrier: next run() invocation will block until release() is called. */
  installBarrier(): void {
    this._barrier = new Promise<void>((resolve) => { this._barrierResolve = resolve; });
  }

  /** Release the barrier and let blocked run() proceed. */
  release(): void {
    if (this._barrierResolve) {
      this._barrierResolve();
      this._barrierResolve = null;
      this._barrier = null;
    }
  }

  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this._callCount++;
    // Wait on barrier if installed
    if (this._barrier) {
      await this._barrier;
    }
    // If simulating interrupted, return immediately with no worker result
    if (this.simulateInterrupted) {
      return {
        pid: null, exitCode: null,
        stdout: '', stderr: '',
        timedOut: true, aborted: true,
        terminatedAfterWorkerResult: false,
        durationMs: 5,
      };
    }

    // Normal fake worker: write a file and return WorkerResult
    const taskId = path.basename(input.cwd);
    const file = `src/recovery_${taskId}.ts`;
    mkdirSync(path.join(input.cwd, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(input.cwd, file), recoveryContent(taskId), 'utf-8');
    let commitHash = '';
    try {
      execSync(`git add ${file}`, { cwd: input.cwd, stdio: 'pipe' });
      execSync(`git commit -qm "recovery pi ${taskId}"`, { cwd: input.cwd, stdio: 'pipe' });
      commitHash = execSync('git rev-parse HEAD', { cwd: input.cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch { /* worktree may not have git yet */ }

    const result: WorkerResult = {
      taskId, status: 'completed', summary: `fake recovery Pi wrote ${file}`,
      filesChanged: [file],
      commitHash,
      checks: [{ name: 'recovery-fake', status: 'passed', summary: 'ok' }],
      scopeViolations: [], risks: [], unresolvedQuestions: [],
      productDecisionRequired: false,
      tokenUsage: { inputTokens: 400, outputTokens: 300, cacheHitTokens: 0 },
    };

    return {
      pid: 9000 + this._callCount, exitCode: 0,
      stdout: ['BEGIN_WORKER_RESULT_JSON', JSON.stringify(result), 'END_WORKER_RESULT_JSON'].join('\n'),
      stderr: '',
      timedOut: false, aborted: false, terminatedAfterWorkerResult: false,
      durationMs: 10,
    };
  }
}

/**
 * Codex runner that blocks on a user-controlled barrier.
 * Used for cancel-race testing.
 */
export class ControllableCodexRunner extends FakeCodexProcessRunner {
  private _barrier: Promise<void> | null = null;
  private _barrierResolve: (() => void) | null = null;
  private _callCount = 0;

  get callCount(): number { return this._callCount; }

  installBarrier(): void {
    this._barrier = new Promise<void>((resolve) => { this._barrierResolve = resolve; });
  }

  release(): void {
    if (this._barrierResolve) {
      this._barrierResolve();
      this._barrierResolve = null;
      this._barrier = null;
    }
  }

  override async run(
    _command: string,
    _args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<CodexProcessRunResult> {
    this._callCount++;
    if (this._barrier) {
      await this._barrier;
    }
    const taskId = extractCodexReviewTaskId(opts.input) ?? 'unknown-task';
    return {
      stdout: formatApprovedCodexReviewMarker(taskId),
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      tokenUsage: { inputTokens: 100, outputTokens: 40, cacheHitTokens: 0 },
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Fast fake runners (non-blocking, for normal recovery tests)
// ══════════════════════════════════════════════════════════════

/** Fast Pi runner — writes a file, returns WorkerResult, no delay. */
export class FastRecoveryPiRunner extends FakeProcessRunner {
  calls = 0;

  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.calls++;
    const taskId = path.basename(input.cwd);
    const file = `src/recovery_${taskId}.ts`;
    mkdirSync(path.join(input.cwd, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(input.cwd, file), recoveryContent(taskId), 'utf-8');
    let commitHash = '';
    try {
      execSync(`git add ${file}`, { cwd: input.cwd, stdio: 'pipe' });
      execSync(`git commit -qm "recovery pi ${taskId}"`, { cwd: input.cwd, stdio: 'pipe' });
      commitHash = execSync('git rev-parse HEAD', { cwd: input.cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch { /* ignore */ }

    const result: WorkerResult = {
      taskId, status: 'completed', summary: `fake recovery Pi wrote ${file}`,
      filesChanged: [file],
      commitHash,
      checks: [{ name: 'recovery-fake', status: 'passed', summary: 'ok' }],
      scopeViolations: [], risks: [], unresolvedQuestions: [],
      productDecisionRequired: false,
      tokenUsage: { inputTokens: 400, outputTokens: 300, cacheHitTokens: 0 },
    };

    return {
      pid: 7000 + this.calls, exitCode: 0,
      stdout: ['BEGIN_WORKER_RESULT_JSON', JSON.stringify(result), 'END_WORKER_RESULT_JSON'].join('\n'),
      stderr: '',
      timedOut: false, aborted: false, terminatedAfterWorkerResult: false,
      durationMs: 5,
    };
  }
}

/** Fast Codex runner — approves everything, no delay. */
export class FastRecoveryCodexRunner extends FakeCodexProcessRunner {
  calls = 0;

  override async run(
    _command: string,
    _args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<CodexProcessRunResult> {
    this.calls++;
    const taskId = extractCodexReviewTaskId(opts.input) ?? 'unknown-task';
    return {
      stdout: formatApprovedCodexReviewMarker(taskId),
      stderr: '',
      exitCode: 0,
      durationMs: 2,
      tokenUsage: { inputTokens: 100, outputTokens: 40, cacheHitTokens: 0 },
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Scheduler setup for end-to-end recovery tests
// ══════════════════════════════════════════════════════════════

export interface RecoveryBenchContext {
  tmp: string;
  projectRoot: string;
  store: SqliteStateStore;
  runId: string;
  piRunner: FastRecoveryPiRunner;
  codexRunner: FastRecoveryCodexRunner;
  scheduler: StageScheduler;
}

/**
 * Set up a full end-to-end recovery test context with scheduler.
 * Creates a real Git repo, SQLite store, and StageScheduler.
 * The caller is responsible for creating run/stage/task/attempt entities
 * before calling scheduler.startRun().
 */
export async function setupRecoveryScheduler(
  maxParallel: number,
  label: string,
  opts?: {
    governanceEnabled?: boolean;
    maxReworkCount?: number;
    /** Use controllable runners instead of fast ones (for cancel race tests) */
    controllable?: boolean;
  },
): Promise<RecoveryBenchContext & {
  controllablePi: ControllablePiRunner | null;
  controllableCodex: ControllableCodexRunner | null;
}> {
  const governanceEnabled = opts?.governanceEnabled ?? false;
  const maxReworkCount = opts?.maxReworkCount ?? 1;
  const controllable = opts?.controllable ?? false;

  const { tmp, projectRoot } = makeRecoveryGitRepo();
  setGovernanceEnabled(projectRoot, governanceEnabled);
  resetGovernanceConfigCache();
  const store = await makeRecoveryStore(tmp);
  const runId = `rec-${label}`;
  const now = new Date().toISOString();

  await store.createRun({
    id: runId, projectId: 'rec-bench', projectRoot,
    requestText: 'recovery-acceptance',
    status: 'running',
    createdAt: now, updatedAt: now,
  });

  await setPerRunBudget(store, runId, 'pi_attempt', 300_000, 'pause');
  await setPerRunBudget(store, runId, 'codex_review_stage', 300_000, 'pause');

  let piRunner: FastRecoveryPiRunner | ControllablePiRunner;
  let codexRunner: FastRecoveryCodexRunner | ControllableCodexRunner;
  let controllablePi: ControllablePiRunner | null = null;
  let controllableCodex: ControllableCodexRunner | null = null;

  if (controllable) {
    controllablePi = new ControllablePiRunner();
    controllableCodex = new ControllableCodexRunner();
    piRunner = controllablePi;
    codexRunner = controllableCodex;
  } else {
    piRunner = new FastRecoveryPiRunner();
    codexRunner = new FastRecoveryCodexRunner();
  }

  const scheduler = new StageScheduler(store, {
    projectRoot, sessionDir: '.brainctl-dev/sessions', logDir: '.brainctl-dev/logs',
    worktreeBaseDir: '.brainctl-dev/worktrees', defaultLockedPaths: [], targetBranch: 'main',
    maxParallelTasks: maxParallel, maxReworkCount,
    qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    governanceEnabled, allowRealWorker: true, allowRealReviewer: true,
    resourceSamplingEnabled: false,
    piProcessRunner: piRunner, codexProcessRunner: codexRunner,
  });

  return { tmp, projectRoot, store, runId,
    piRunner: piRunner as FastRecoveryPiRunner,
    codexRunner: codexRunner as FastRecoveryCodexRunner,
    scheduler,
    controllablePi, controllableCodex,
  };
}

// ══════════════════════════════════════════════════════════════
// Pipeline-only context (no scheduler, for direct reconciliation tests)
// ══════════════════════════════════════════════════════════════

export interface RecoveryPipelineContext {
  tmp: string;
  store: SqliteStateStore;
  runId: string;
}

/**
 * Set up a minimal pipeline context — no scheduler, no Git repo.
 * Suitable for classifyFacts / applySafeActions pipeline testing.
 */
export async function setupRecoveryPipeline(label: string): Promise<RecoveryPipelineContext> {
  const tmp = makeTmpDir();
  const store = await makeRecoveryStore(tmp);
  const runId = `rec-pl-${label}`;
  const now = new Date().toISOString();
  await store.createRun({
    id: runId, projectId: 'rec-pl', projectRoot: `/tmp/${runId}`,
    requestText: 'recovery-pipeline',
    status: 'running',
    createdAt: now, updatedAt: now,
  });
  return { tmp, store, runId };
}

// ══════════════════════════════════════════════════════════════
// Cleanup
// ══════════════════════════════════════════════════════════════

export async function teardownRecovery(ctx: { tmp: string; store: SqliteStateStore }): Promise<void> {
  try { await ctx.store.close(); } catch {}
  try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

// ══════════════════════════════════════════════════════════════
// Unique ID helper
// ══════════════════════════════════════════════════════════════

export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ══════════════════════════════════════════════════════════════
// Git helpers for verification
// ══════════════════════════════════════════════════════════════

/** Get the HEAD commit hash of a branch */
export function getBranchHead(projectRoot: string, branch: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', branch], {
      cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Get file content from a branch */
export function getFileFromBranch(projectRoot: string, branch: string, filePath: string): string | null {
  try {
    const out = execFileSync('git', ['show', `${branch}:${filePath}`], {
      cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
    });
    return out;
  } catch {
    return null;
  }
}

/** Verify a file exists with expected content in the working tree */
export function verifyFileContent(projectRoot: string, file: string, marker: string): boolean {
  const fullPath = path.join(projectRoot, file);
  if (!existsSync(fullPath)) return false;
  try {
    const content = execFileSync('git', ['show', `HEAD:${file}`], {
      cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
    });
    return content.includes(marker);
  } catch {
    return false;
  }
}

/**
 * Assert no duplicate ledger callIds within a run.
 * Returns count of duplicates (0 = clean).
 */
export async function assertNoDuplicateLedgerCallIds(store: SqliteStateStore, runId: string): Promise<number> {
  const entries = await store.listTokenLedgerEntries(runId);
  const seen = new Set<string>();
  let dupes = 0;
  for (const e of entries) {
    if (seen.has(e.callId)) { dupes++; }
    seen.add(e.callId);
  }
  return dupes;
}

/**
 * Build a minimal StructuredTaskSpec for recovery testing.
 */
export function makeRecoveryTaskSpec(taskId: string, stageNumber: number, file: string): StructuredTaskSpec {
  return {
    taskId, stageNumber,
    title: `Recovery ${taskId}`,
    goal: `Write ${file}`,
    dependencies: [],
    estimatedWritePaths: [file],
    allowedPaths: [path.dirname(file) + '/'],
    forbiddenPaths: [],
    contextFiles: [],
    acceptanceChecks: ['noop'],
    allowedCommands: ['node -e process.exit(0)'],
    riskLevel: 'low',
    productDecisionsLocked: true,
    expectedOutputs: [file],
    heavyCommandSlotsRequired: 0,
    timeoutSeconds: 60,
  };
}
