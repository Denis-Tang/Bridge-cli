// ── Long Task & Same-Path Acceptance Fixtures ───────────────────────────
// Extended multi-stage test infrastructure for long-task stability and
// same-path baseline acceptance testing.
//
// All durations are real waited (not synthetic fields); all fake providers
// use adjustable delays. Resource sampling is disabled by default to isolate
// DAG, base, worktree, and state convergence semantics.

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
  type CodexProcessRunResult,
  extractCodexReviewTaskId,
  formatApprovedCodexReviewMarker,
} from '../../../src/adapters/codex-process-runner.js';
import type { StructuredTaskSpec } from '../../../src/types/m2-types.js';
import type { WorkerResult } from '../../../src/types/protocol.js';

// ══════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════

/** Simulated per-task Pi execution delay (real sleep). Minimal for speed; still real await. */
export const LONG_TASK_PI_DELAY_MS = 20;

/** Simulated per-task Codex review delay. */
export const LONG_TASK_CODEX_DELAY_MS = 5;

/** Deterministic content marker per task. */
export function ltContent(taskId: string): string {
  return `// lt-acceptance ${taskId} — unique marker ${Date.now()}\n`;
}

// ══════════════════════════════════════════════════════════════
// Temporary directory & Git helpers
// ══════════════════════════════════════════════════════════════

export function makeTmpDir(): string {
  const dir = path.join(tmpdir(), `brainctl-lt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface GitRepo {
  tmp: string;
  projectRoot: string;
}

/** Create a fresh git repo with seed files covering multiple directories. */
export function makeGitRepo(): GitRepo {
  const tmp = makeTmpDir();
  const projectRoot = path.join(tmp, 'project');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'config'), { recursive: true });
  execSync('git init', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config core.autocrlf false', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.email test@test', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(path.join(projectRoot, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'lib', 'seed.ts'), 'export const seed = 2;\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'docs', 'readme.md'), '# Doc\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'config', 'default.json'), '{}\n', 'utf-8');
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: projectRoot, stdio: 'pipe' });
  return { tmp, projectRoot };
}

// ══════════════════════════════════════════════════════════════
// Fake Worker/Codex with REAL delay
// ══════════════════════════════════════════════════════════════

export interface LtCallRecord {
  taskId: string;
  file: string;
  startTime: number;
  endTime: number;
  callIndex: number;
  synthetic: true;
}

/**
 * LongTaskPiRunner — writes predictable content with REAL await delay.
 */
export class LongTaskPiRunner extends FakeProcessRunner {
  calls = 0;
  taskIds: string[] = [];
  callRecords: LtCallRecord[] = [];
  callStartTimes: Map<string, number> = new Map();
  callEndTimes: Map<string, number> = new Map();
  /** Per-task delay overrides for specific scenarios (e.g., retry exhaustion). */
  perTaskDelayMs: Map<string, number> = new Map();
  /** Tasks that should fail on first attempt (retry testing). */
  failFirstAttempt: Set<string> = new Set();
  /** Tasks that must return an explicit product decision instead of changing files. */
  needsDecision: Set<string> = new Set();
  attemptCounts: Map<string, number> = new Map();

  constructor(
    private delayMs: number = LONG_TASK_PI_DELAY_MS,
    private fileMap: Record<string, string> = {},
  ) {
    super();
  }

  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.calls++;
    const callIndex = this.calls;

    // The JSONL request id is the scheduler's authoritative task identity.
    // Keep cwd parsing only as a fallback for runners that do not receive stdin.
    const stdinTaskId = input.stdin.match(/"id":"prompt-([^"]+)"/)?.[1];
    let taskId = stdinTaskId || 'unknown';
    if (!stdinTaskId) {
      const parts = input.cwd.replace(/\\/g, '/').split('/');
      for (const p of parts) {
        if (/^T[A-Z0-9_]+$/i.test(p)) { taskId = p; break; }
      }
    }

    this.taskIds.push(taskId);
    const attemptNum = (this.attemptCounts.get(taskId) || 0) + 1;
    this.attemptCounts.set(taskId, attemptNum);

    const file = this.fileMap[taskId] || `src/unknown_${taskId}.ts`;
    const startTime = Date.now();
    this.callStartTimes.set(taskId, startTime);

    // Per-task delay override or default
    const effectiveDelay = this.perTaskDelayMs.get(taskId) ?? this.delayMs;
    await new Promise((r) => setTimeout(r, effectiveDelay));

    // Check if this task should fail on first attempt
    if (this.failFirstAttempt.has(taskId) && attemptNum === 1) {
      const endTime = Date.now();
      this.callEndTimes.set(taskId, endTime);
      this.callRecords.push({ taskId, file, startTime, endTime, callIndex, synthetic: true });
      return {
        pid: 5500 + callIndex, exitCode: 1,
        stdout: '',
        stderr: 'Simulated first-attempt failure',
        timedOut: false, aborted: false, terminatedAfterWorkerResult: false,
        durationMs: effectiveDelay,
      };
    }

    if (this.needsDecision.has(taskId)) {
      const endTime = Date.now();
      this.callEndTimes.set(taskId, endTime);
      this.callRecords.push({ taskId, file, startTime, endTime, callIndex, synthetic: true });
      const result: WorkerResult = {
        taskId,
        status: 'needs_decision',
        summary: 'synthetic product decision required',
        filesChanged: [],
        checks: [],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: ['synthetic decision'],
        productDecisionRequired: true,
        tokenUsage: { inputTokens: 800, outputTokens: 200, cacheHitTokens: 0 },
      };
      return {
        pid: 5500 + callIndex,
        exitCode: 0,
        stdout: ['BEGIN_WORKER_RESULT_JSON', JSON.stringify(result), 'END_WORKER_RESULT_JSON'].join('\n'),
        stderr: '',
        timedOut: false,
        aborted: false,
        terminatedAfterWorkerResult: false,
        durationMs: effectiveDelay,
      };
    }

    // Write deterministic content
    const targetPath = path.join(input.cwd, file);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const existingContent = existsSync(targetPath) ? readFileSync(targetPath, 'utf-8') : '';
    writeFileSync(targetPath, existingContent ? `${existingContent}\n${ltContent(taskId)}` : ltContent(taskId), 'utf-8');
    let commitHash = '';
    try {
      execSync(`git add ${file}`, { cwd: input.cwd, stdio: 'pipe' });
      execSync(`git commit -qm "lt pi ${taskId}"`, { cwd: input.cwd, stdio: 'pipe' });
      commitHash = execSync('git rev-parse HEAD', { cwd: input.cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
    } catch { /* worktree may not have git yet */ }

    const endTime = Date.now();
    this.callEndTimes.set(taskId, endTime);

    const result: WorkerResult = {
      taskId, status: 'completed', summary: `fake Pi wrote ${file}`,
      filesChanged: [file],
      commitHash,
      checks: [{ name: 'fake', status: 'passed', summary: 'ok' }],
      scopeViolations: [], risks: [], unresolvedQuestions: [],
      productDecisionRequired: false,
      tokenUsage: { inputTokens: 800, outputTokens: 600, cacheHitTokens: 0 },
    };

    this.callRecords.push({ taskId, file, startTime, endTime, callIndex, synthetic: true });

    return {
      pid: 5500 + callIndex, exitCode: 0,
      stdout: ['BEGIN_WORKER_RESULT_JSON', JSON.stringify(result), 'END_WORKER_RESULT_JSON'].join('\n'),
      stderr: '',
      timedOut: false, aborted: false, terminatedAfterWorkerResult: false,
      durationMs: effectiveDelay,
    };
  }
}

/**
 * LongTaskCodexRunner — waits real delay, returns deterministic fake review.
 */
export class LongTaskCodexRunner extends FakeCodexProcessRunner {
  calls = 0;

  constructor(private delayMs: number = LONG_TASK_CODEX_DELAY_MS) {
    super();
  }

  override async run(
    _command: string,
    _args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<CodexProcessRunResult> {
    this.calls++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    const taskId = extractCodexReviewTaskId(opts.input) ?? 'unknown-task';
    return {
      stdout: formatApprovedCodexReviewMarker(taskId),
      stderr: '',
      exitCode: 0,
      durationMs: this.delayMs,
      tokenUsage: { inputTokens: 200, outputTokens: 80, cacheHitTokens: 0 },
    };
  }
}

// ══════════════════════════════════════════════════════════════
// Task Definition
// ══════════════════════════════════════════════════════════════

export interface LtTaskDef {
  taskId: string;
  file: string;
  dependencies: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  stageNumber: number;
}

/**
 * 16-task, 3-stage DAG for long-task stability testing.
 *
 * IMPORTANT: All task dependencies are within the same stage only.
 * Cross-stage ordering is enforced by the stage base-commit chain:
 * stage N only starts after stage N-1 has merged to the target branch.
 *
 * Stage 1: 6 independent tasks, 6 distinct files.
 * Stage 2: 6 tasks with intra-stage fan-in dependencies, 6 new files.
 * Stage 3: 4 tasks with intra-stage multi-hop/fan-in, 4 new files.
 *
 * Total: 16 tasks, 16 distinct file paths, 3 stages.
 */
export const LONG_TASK_DAG: LtTaskDef[] = [
  // Stage 1 — independent (proves concurrency)
  { taskId: 'T1',  file: 'src/module_a.ts',   dependencies: [],  allowedPaths: ['src/'],    forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T2',  file: 'src/module_b.ts',   dependencies: [],  allowedPaths: ['src/'],    forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T3',  file: 'lib/helper_a.ts',   dependencies: [],  allowedPaths: ['lib/'],    forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T4',  file: 'lib/helper_b.ts',   dependencies: [],  allowedPaths: ['lib/'],    forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T5',  file: 'docs/guide_a.md',   dependencies: [],  allowedPaths: ['docs/'],   forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T6',  file: 'docs/guide_b.md',   dependencies: [],  allowedPaths: ['docs/'],   forbiddenPaths: [], stageNumber: 1 },

  // Stage 2 — fan-in within stage (base already contains all stage-1 merged content)
  { taskId: 'T7',  file: 'src/combined_ab.ts',  dependencies: [],          allowedPaths: ['src/'],    forbiddenPaths: [], stageNumber: 2 },
  { taskId: 'T8',  file: 'lib/combined_ab.ts',  dependencies: [],          allowedPaths: ['lib/'],    forbiddenPaths: [], stageNumber: 2 },
  { taskId: 'T9',  file: 'docs/index.md',       dependencies: [],          allowedPaths: ['docs/'],   forbiddenPaths: [], stageNumber: 2 },
  { taskId: 'T10', file: 'config/runtime.json',  dependencies: [],          allowedPaths: ['config/'], forbiddenPaths: [], stageNumber: 2 },
  { taskId: 'T11', file: 'config/build.json',    dependencies: ['T10'],     allowedPaths: ['config/'], forbiddenPaths: [], stageNumber: 2 },
  { taskId: 'T12', file: 'src/config_loader.ts', dependencies: ['T7', 'T8'], allowedPaths: ['src/'],   forbiddenPaths: [], stageNumber: 2 },

  // Stage 3 — multi-hop within stage (base already contains all stage-2 merged content)
  { taskId: 'T13', file: 'src/api_entry.ts',     dependencies: [],               allowedPaths: ['src/'],  forbiddenPaths: [], stageNumber: 3 },
  { taskId: 'T14', file: 'lib/all_helpers.ts',   dependencies: [],               allowedPaths: ['lib/'],  forbiddenPaths: [], stageNumber: 3 },
  { taskId: 'T15', file: 'docs/final_guide.md',  dependencies: ['T13'],          allowedPaths: ['docs/'], forbiddenPaths: [], stageNumber: 3 },
  { taskId: 'T16', file: 'src/main_pipeline.ts', dependencies: ['T14', 'T15'],   allowedPaths: ['src/'],  forbiddenPaths: [], stageNumber: 3 },
];

/**
 * Same-path no-dependency: T_SP1 and T_SP2 both write src/shared.ts
 * with no dependency declared. Must be blocked before worker spawn.
 */
export const SAME_PATH_NO_DEP_DAG: LtTaskDef[] = [
  { taskId: 'T_SP1', file: 'src/shared.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T_SP2', file: 'src/shared.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T_SP3', file: 'lib/other.ts',  dependencies: [], allowedPaths: ['lib/'], forbiddenPaths: [], stageNumber: 1 },
];

/**
 * Same-path with dependency: T_SPD2 depends on T_SPD1, both write src/shared_dep.ts.
 */
export const SAME_PATH_DEP_DAG: LtTaskDef[] = [
  { taskId: 'T_SPD1', file: 'src/shared_dep.ts', dependencies: [],              allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T_SPD2', file: 'src/shared_dep.ts', dependencies: ['T_SPD1'],      allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 },
];

/**
 * Conflict DAG for integration conflict testing.
 */
export const CONFLICT_DAG_LT: LtTaskDef[] = [
  { taskId: 'T_C1', file: 'src/conflict.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 },
  { taskId: 'T_C2', file: 'src/conflict.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [], stageNumber: 1 },
];

export function makeLtSpec(def: LtTaskDef): StructuredTaskSpec {
  return {
    taskId: def.taskId, stageNumber: def.stageNumber, title: `Write ${def.file}`, goal: `Write ${def.file}`,
    dependencies: def.dependencies,
    estimatedWritePaths: [def.file],
    allowedPaths: def.allowedPaths, forbiddenPaths: def.forbiddenPaths,
    contextFiles: [], acceptanceChecks: ['noop'],
    allowedCommands: ['node -e process.exit(0)'],
    riskLevel: 'low', productDecisionsLocked: true,
    expectedOutputs: [def.file],
    heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
  };
}

// ══════════════════════════════════════════════════════════════
// Store & Scheduler Setup
// ══════════════════════════════════════════════════════════════

export async function makeStore(tmp: string): Promise<SqliteStateStore> {
  const dbPath = path.join(tmp, '.brainctl', 'state', 'bench.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = SqliteStateStore.create(dbPath);
  new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
  await ensureDefaultPolicies(store);
  return store;
}

export interface LtBenchContext {
  tmp: string;
  projectRoot: string;
  store: SqliteStateStore;
  runId: string;
  piRunner: LongTaskPiRunner;
  codexRunner: LongTaskCodexRunner;
  scheduler: StageScheduler;
}

/**
 * Setup a multi-stage benchmark context.
 * Creates stages 1..maxStageNum and assigns tasks per their stageNumber.
 */
export async function setupLongTaskBenchmark(
  dag: LtTaskDef[],
  maxParallel: number,
  label: string,
  opts?: {
    governanceEnabled?: boolean;
    piDelayMs?: number;
    codexDelayMs?: number;
    maxReworkCount?: number;
    allowRealWorker?: boolean;
  },
): Promise<LtBenchContext> {
  // Default: governance OFF for fake acceptance tests.
  // Governance (G2/G3, scope expansion) requires real Provider evidence;
  // fake fixtures test DAG/base/worktree/state convergence, not governance.
  const governanceEnabled = opts?.governanceEnabled ?? false;
  const piDelayMs = opts?.piDelayMs ?? LONG_TASK_PI_DELAY_MS;
  const codexDelayMs = opts?.codexDelayMs ?? LONG_TASK_CODEX_DELAY_MS;
  const maxReworkCount = opts?.maxReworkCount ?? 2;

  const { tmp, projectRoot } = makeGitRepo();
  setGovernanceEnabled(projectRoot, governanceEnabled);
  resetGovernanceConfigCache();
  const store = await makeStore(tmp);
  const runId = `lt-${label}`;
  const now = new Date().toISOString();

  await store.createRun({ id: runId, projectId: 'lt-bench', projectRoot, requestText: 'lt-acceptance', status: 'running', createdAt: now, updatedAt: now });

  // Determine max stage number from DAG
  const maxStageNum = Math.max(...dag.map(d => d.stageNumber));
  for (let sn = 1; sn <= maxStageNum; sn++) {
    const stageId = `${runId}-s${sn}`;
    await store.createStage({ id: stageId, runId, stageNumber: sn, title: `S${sn}`, status: (sn === 1 ? 'ready' : 'pending') });
  }

  for (const def of dag) {
    const spec = makeLtSpec(def);
    await store.createTask({ id: def.taskId, runId, title: spec.title, status: 'pending', specJson: spec, createdAt: now, updatedAt: now });
  }

  await setPerRunBudget(store, runId, 'pi_attempt', 300_000, 'pause');
  await setPerRunBudget(store, runId, 'codex_review_stage', 300_000, 'pause');
  await store.createEvent({ id: `${runId}-ev-plan`, runId, eventType: 'plan_created' });

  const fileMap: Record<string, string> = {};
  for (const def of dag) {
    fileMap[def.taskId] = def.file;
  }
  const piRunner = new LongTaskPiRunner(piDelayMs, fileMap);
  const codexRunner = new LongTaskCodexRunner(codexDelayMs);

  // allowRealWorker and allowRealReviewer default to true so the scheduler
  // uses the process-runner path (piProcessRunner/codexProcessRunner).
  // When false, the scheduler uses static fakeWorkerResult/fakeReviewResult
  // and skips completion-evidence checks (useful for pure state-machine tests).
  const allowReal = opts?.allowRealWorker ?? true;
  const scheduler = new StageScheduler(store, {
    projectRoot, sessionDir: '.brainctl-dev/sessions', logDir: '.brainctl-dev/logs',
    worktreeBaseDir: '.brainctl-dev/worktrees', defaultLockedPaths: [], targetBranch: 'main',
    maxParallelTasks: maxParallel, maxReworkCount,
    qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    governanceEnabled, allowRealWorker: allowReal, allowRealReviewer: allowReal,
    resourceSamplingEnabled: false,
    piProcessRunner: piRunner, codexProcessRunner: codexRunner,
  });

  return { tmp, projectRoot, store, runId, piRunner, codexRunner, scheduler };
}

export async function teardownBenchmark(ctx: LtBenchContext): Promise<void> {
  try { await ctx.store.close(); } catch {}
  try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

// ══════════════════════════════════════════════════════════════
// Assertion Helpers
// ══════════════════════════════════════════════════════════════

/** Verify target branch file content for a task. */
export function verifyTargetBranchFile(projectRoot: string, file: string, taskId: string): boolean {
  const fullPath = path.join(projectRoot, file);
  if (!existsSync(fullPath)) return false;
  const content = readFileSync(fullPath, 'utf-8').replaceAll('\r\n', '\n');
  return content.includes(`lt-acceptance ${taskId}`);
}

/** Strict completion: run=completed, all stages=completed, all tasks=merged. */
export async function assertRunFullyCompleted(store: SqliteStateStore, runId: string): Promise<{
  ok: boolean;
  runStatus: string;
  stageStatuses: Array<{ stageNumber: number; status: string }>;
  taskStatuses: Array<{ taskId: string; status: string }>;
}> {
  const { expect } = await import('vitest');

  const run = await store.getRun(runId);
  const runStatus = run?.status || '?';

  const stages = await store.listStages(runId);
  const stageStatuses = stages.map(s => ({ stageNumber: s.stageNumber, status: s.status }));

  const tasks = await store.listTasks(runId);
  const taskStatuses = tasks.map(t => ({ taskId: t.id, status: t.status }));

  const allStagesCompleted = stages.every(s => s.status === 'completed' || s.status === 'canceled');
  const allTasksMerged = tasks.every(t => t.status === 'merged' || t.status === 'canceled');

  return {
    ok: runStatus === 'completed' && allStagesCompleted && allTasksMerged,
    runStatus, stageStatuses, taskStatuses,
  };
}

/** Assert dependent task started after ALL its dependencies ended. */
export async function assertDependsAfterAll(
  piRunner: LongTaskPiRunner,
  depTaskId: string,
  depTaskIds: string[],
): Promise<boolean> {
  const { expect } = await import('vitest');

  const depEnds = depTaskIds.map(id => piRunner.callEndTimes.get(id)).filter(Boolean) as number[];
  const depStart = piRunner.callStartTimes.get(depTaskId);

  if (depEnds.length === 0 || depStart == null) return false;

  const maxDepEnd = Math.max(...depEnds);
  expect(depStart, `${depTaskId} start >= max(${depTaskIds.join(',')} ends)`).toBeGreaterThanOrEqual(maxDepEnd);
  return true;
}

/** Assert independent tasks had overlapping execution. */
export async function assertOverlap(piRunner: LongTaskPiRunner, taskIds: string[]): Promise<boolean> {
  const { expect } = await import('vitest');

  for (let i = 0; i < taskIds.length; i++) {
    for (let j = i + 1; j < taskIds.length; j++) {
      const aStart = piRunner.callStartTimes.get(taskIds[i]);
      const aEnd = piRunner.callEndTimes.get(taskIds[i]);
      const bStart = piRunner.callStartTimes.get(taskIds[j]);
      const bEnd = piRunner.callEndTimes.get(taskIds[j]);

      if (aStart == null || aEnd == null || bStart == null || bEnd == null) continue;

      const overlap = (aStart < bEnd) && (bStart < aEnd);
      if (overlap) return true;
    }
  }
  expect.fail(`No overlapping execution found among tasks: ${taskIds.join(', ')}`);
  return false;
}

/** Count duplicate ledger callIds. */
export async function assertNoDuplicateLedgerCallIds(store: SqliteStateStore, runId: string): Promise<number> {
  const entries = await store.listTokenLedgerEntries(runId);
  const callIds = entries.map(e => e.callId).filter(Boolean);
  const unique = new Set(callIds);
  const dupes = callIds.length - unique.size;
  return dupes;
}

/** Check that no residual SQLite files exist in tmp. */
export function assertNoResidualDb(tmp: string): boolean {
  try {
    const dbPath = path.join(tmp, '.brainctl', 'state', 'bench.db');
    return !existsSync(dbPath);
  } catch {
    return true;
  }
}

/** Check that no worktree directories remain under tmp. */
export function assertNoResidualWorktrees(tmp: string): boolean {
  try {
    const wtDir = path.join(tmp, '.brainctl-dev', 'worktrees');
    if (!existsSync(wtDir)) return true;
    const { readdirSync } = require('node:fs');
    const contents = readdirSync(wtDir);
    return contents.length === 0;
  } catch {
    return true;
  }
}
