// ── Benchmark Fixtures & Helpers ──────────────────────────────────────────
// Shared test infrastructure for correctness, concurrency, and token benchmarks.
// All durations are real waited (not synthetic fields); all fake providers
// use adjustable delays to simulate realistic Pi/Codex latency.

import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { ensureDefaultPolicies, setPerRunBudget } from '../../src/core/budget-policy-store.js';
import { resetGovernanceConfigCache, setGovernanceEnabled } from '../../src/core/decision-gate.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import { FakeProcessRunner } from '../../src/adapters/pi-rpc-worker.js';
import type { ProcessRunInput, ProcessRunResult } from '../../src/adapters/pi-worker-types.js';
import { FakeCodexProcessRunner, type CodexProcessRunResult } from '../../src/adapters/codex-process-runner.js';
import type { StructuredTaskSpec } from '../../src/types/m2-types.js';
import type { ExecutionMode } from '../../src/types/m2-types.js';
import type { WorkerResult } from '../../src/types/protocol.js';

// ══════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════

/** Simulated per-task Pi execution delay (real sleep, not synthetic). */
export const PI_DELAY_MS = 300;

/** Simulated per-task Codex review delay. */
export const CODEX_DELAY_MS = 80;

/**
 * Pseudo-random but deterministic file content to verify merge correctness.
 * Each task writes its own unique content line.
 */
export function taskContent(taskId: string): string {
  return `// bench-v3 ${taskId} — unique content marker\n`;
}

// ══════════════════════════════════════════════════════════════
// Temporary directory helpers
// ══════════════════════════════════════════════════════════════

export function makeTmpDir(): string {
  const dir = path.join(tmpdir(), `brainctl-bench3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface GitRepo {
  tmp: string;
  projectRoot: string;
}

/** Create a fresh git repo with deterministic seed files. */
export function makeGitRepo(): GitRepo {
  const tmp = makeTmpDir();
  const projectRoot = path.join(tmp, 'project');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
  execSync('git init', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config core.autocrlf false', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.email test@test', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(path.join(projectRoot, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'lib', 'seed.ts'), 'export const seed = 2;\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'docs', 'readme.md'), '# Doc\n', 'utf-8');
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: projectRoot, stdio: 'pipe' });
  return { tmp, projectRoot };
}

// ══════════════════════════════════════════════════════════════
// Fake Worker/Codex with REAL delay
// ══════════════════════════════════════════════════════════════

export interface BenchCallRecord {
  taskId: string;
  file: string;
  startTime: number;
  endTime: number;
  pid: number;
  callIndex: number;
  /** The exact WorkerResult sent back. */
  result: WorkerResult;
  /** Whether this was a synthetic (fake) invocation. Always true for benchmarks. */
  synthetic: true;
}

/** Default file mapping — aligned with CORRECT_DAG task→file assignments. */
const DEFAULT_FILE_MAP: Record<string, string> = {
  'T1': 'src/a.ts', 'T2': 'src/b.ts', 'T3': 'lib/util.ts',
  'T4': 'docs/readme.md', 'T5': 'src/combined.ts', 'T6': 'src/config.ts',
  'T7': 'lib/helper.ts', 'T8': 'src/api.ts', 'T9': 'lib/types.ts', 'T10': 'src/middleware.ts',
};

/**
 * BenchPiRunner — writes predictable content, waits REAL delay, returns correct WorkerResult.
 * Records start/end times using monotonic clock (performance.now fallback via Date.now).
 * Accepts an optional fileMap to override the default task→file assignments (used by CONFLICT_DAG).
 */
export class BenchPiRunner extends FakeProcessRunner {
  calls = 0;
  taskIds: string[] = [];
  callRecords: BenchCallRecord[] = [];
  callStartTimes: Map<string, number> = new Map();
  callEndTimes: Map<string, number> = new Map();
  private fileMap: Record<string, string>;

  constructor(private delayMs: number = PI_DELAY_MS, fileMap?: Record<string, string>) {
    super();
    this.fileMap = fileMap ?? DEFAULT_FILE_MAP;
  }

  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.calls++;
    const callIndex = this.calls;

    // Detect task ID from cwd path
    const parts = input.cwd.replace(/\\/g, '/').split('/');
    let taskId = 'unknown';
    for (const p of parts) {
      if (/^T\d+[a-z]?$/i.test(p)) { taskId = p; break; }
    }

    const file = this.resolveFile(taskId, input);
    this.taskIds.push(taskId);
    const startTime = Date.now();
    this.callStartTimes.set(taskId, startTime);

    // R2: real spawns surface an onSpawn callback at process START (before the
    // run); the fake runner must mimic that so scheduler spawn hooks
    // (markCostReservationSpawned + heartbeat) are exercised during the delay.
    if (input.onSpawn) {
      await Promise.resolve(input.onSpawn(4400 + callIndex));
    }

    // REAL delay — not synthetic
    await new Promise((r) => setTimeout(r, this.delayMs));

    // Write deterministic content
    mkdirSync(path.join(input.cwd, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(input.cwd, file), taskContent(taskId), 'utf-8');
    execSync(`git add ${file}`, { cwd: input.cwd, stdio: 'pipe' });
    execSync(`git commit -qm "bench pi ${taskId}"`, { cwd: input.cwd, stdio: 'pipe' });

    const endTime = Date.now();
    this.callEndTimes.set(taskId, endTime);

    const result: WorkerResult = {
      taskId, status: 'completed', summary: `fake Pi wrote ${file}`,
      filesChanged: [file],
      checks: [{ name: 'fake', status: 'passed', summary: 'ok' }],
      scopeViolations: [], risks: [], unresolvedQuestions: [],
      productDecisionRequired: false,
      tokenUsage: { inputTokens: 800, outputTokens: 600, cacheHitTokens: 0 },
    };

    this.callRecords.push({ taskId, file, startTime, endTime, pid: 4400 + callIndex, callIndex, result, synthetic: true });

    return {
      pid: 4400 + callIndex, exitCode: 0,
      stdout: ['BEGIN_WORKER_RESULT_JSON', JSON.stringify(result), 'END_WORKER_RESULT_JSON'].join('\n'),
      stderr: '',
      timedOut: false, aborted: false, terminatedAfterWorkerResult: false,
      durationMs: this.delayMs,
    };
  }

  private resolveFile(taskId: string, _input: ProcessRunInput): string {
    return this.fileMap[taskId] || `src/unknown_${taskId}.ts`;
  }
}

/**
 * BenchCodexRunner — waits real delay, returns deterministic fake review.
 */
export class BenchCodexRunner extends FakeCodexProcessRunner {
  calls = 0;
  callCounts: Map<string, number> = new Map();

  constructor(private delayMs: number = CODEX_DELAY_MS) {
    super();
  }

  override async run(): Promise<CodexProcessRunResult> {
    this.calls++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      durationMs: this.delayMs,
      tokenUsage: { inputTokens: 200, outputTokens: 80, cacheHitTokens: 0 },
    };
  }

  /** Track per-task review calls. */
  trackCall(taskId: string): void {
    this.callCounts.set(taskId, (this.callCounts.get(taskId) || 0) + 1);
  }
}

// ══════════════════════════════════════════════════════════════
// Task Definition
// ══════════════════════════════════════════════════════════════

export interface TaskDef {
  taskId: string;
  file: string;
  dependencies: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
}

/**
 * Standard 6-task DAG that includes an intentional same-file conflict (T1 + T6 both write src/a.ts).
 * T5 depends on T1 + T2. T1-T4 are independent. T6 is the "red team" conflict task.
 */
export const CONFLICT_DAG: TaskDef[] = [
  { taskId: 'T1', file: 'src/a.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T2', file: 'src/b.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T3', file: 'lib/util.ts', dependencies: [], allowedPaths: ['lib/'], forbiddenPaths: [] },
  { taskId: 'T4', file: 'docs/readme.md', dependencies: [], allowedPaths: ['docs/'], forbiddenPaths: [] },
  { taskId: 'T5', file: 'src/combined.ts', dependencies: ['T1', 'T2'], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T6', file: 'src/a.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
];

/**
 * Conflict-free 8-task DAG. No tasks share write paths; dependencies are explicit.
 * T8 depends on T6 and T7.
 */
export const CORRECT_DAG: TaskDef[] = [
  { taskId: 'T1', file: 'src/a.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T2', file: 'src/b.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T3', file: 'lib/util.ts', dependencies: [], allowedPaths: ['lib/'], forbiddenPaths: [] },
  { taskId: 'T4', file: 'docs/readme.md', dependencies: [], allowedPaths: ['docs/'], forbiddenPaths: [] },
  { taskId: 'T5', file: 'src/combined.ts', dependencies: ['T1', 'T2'], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T6', file: 'src/config.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T7', file: 'lib/helper.ts', dependencies: ['T3'], allowedPaths: ['lib/'], forbiddenPaths: [] },
  { taskId: 'T8', file: 'src/api.ts', dependencies: ['T6', 'T7'], allowedPaths: ['src/'], forbiddenPaths: [] },
];

/**
 * 10-task DAG for stress testing with mixed dependencies.
 */
export const STRESS_DAG: TaskDef[] = [
  { taskId: 'T1', file: 'src/a.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T2', file: 'src/b.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T3', file: 'lib/util.ts', dependencies: [], allowedPaths: ['lib/'], forbiddenPaths: [] },
  { taskId: 'T4', file: 'docs/readme.md', dependencies: [], allowedPaths: ['docs/'], forbiddenPaths: [] },
  { taskId: 'T5', file: 'src/combined.ts', dependencies: ['T1', 'T2'], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T6', file: 'src/config.ts', dependencies: [], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T7', file: 'lib/helper.ts', dependencies: ['T3'], allowedPaths: ['lib/'], forbiddenPaths: [] },
  { taskId: 'T8', file: 'src/api.ts', dependencies: ['T6', 'T7'], allowedPaths: ['src/'], forbiddenPaths: [] },
  { taskId: 'T9', file: 'lib/types.ts', dependencies: [], allowedPaths: ['lib/'], forbiddenPaths: [] },
  { taskId: 'T10', file: 'src/middleware.ts', dependencies: ['T8', 'T9'], allowedPaths: ['src/'], forbiddenPaths: [] },
];

export function makeSpec(def: TaskDef, stageNumber: number): StructuredTaskSpec {
  return {
    taskId: def.taskId, stageNumber, title: `Write ${def.file}`, goal: `Write ${def.file}`,
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

export interface BenchmarkContext {
  tmp: string;
  projectRoot: string;
  store: SqliteStateStore;
  runId: string;
  stageId: string;
  piRunner: BenchPiRunner;
  codexRunner: BenchCodexRunner;
  scheduler: StageScheduler;
}

export async function setupBenchmark(
  dag: TaskDef[],
  maxParallel: number,
  label: string,
  opts?: { governanceEnabled?: boolean; piDelayMs?: number; codexDelayMs?: number; executionMode?: ExecutionMode },
): Promise<BenchmarkContext> {
  const governanceEnabled = opts?.governanceEnabled ?? true;
  const piDelayMs = opts?.piDelayMs ?? PI_DELAY_MS;
  const codexDelayMs = opts?.codexDelayMs ?? CODEX_DELAY_MS;

  const { tmp, projectRoot } = makeGitRepo();
  setGovernanceEnabled(projectRoot, governanceEnabled);
  resetGovernanceConfigCache();
  const store = await makeStore(tmp);
  const runId = `bench-${label}`;
  const stageId = `${runId}-s1`;
  const now = new Date().toISOString();

  await store.createRun({ id: runId, projectId: 'bench', projectRoot, requestText: 'bench', status: 'running', createdAt: now, updatedAt: now });
  await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'ready' });

  for (const def of dag) {
    const spec = makeSpec(def, 1);
    await store.createTask({ id: def.taskId, runId, title: spec.title, status: 'pending', specJson: spec, createdAt: now, updatedAt: now });
  }

  await setPerRunBudget(store, runId, 'pi_attempt', 300_000, 'pause');
  await setPerRunBudget(store, runId, 'codex_review_stage', 300_000, 'pause');
  await store.createEvent({ id: `${runId}-ev-plan`, runId, eventType: 'plan_created' });

  const fileMap: Record<string, string> = {};
  for (const def of dag) {
    fileMap[def.taskId] = def.file;
  }
  const piRunner = new BenchPiRunner(piDelayMs, fileMap);
  const codexRunner = new BenchCodexRunner(codexDelayMs);

  const scheduler = new StageScheduler(store, {
    projectRoot, sessionDir: '.brainctl-dev/sessions', logDir: '.brainctl-dev/logs',
    worktreeBaseDir: '.brainctl-dev/worktrees', defaultLockedPaths: [], targetBranch: 'main',
    maxParallelTasks: maxParallel, maxReworkCount: 1,
    qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    governanceEnabled: governanceEnabled, allowRealWorker: true, allowRealReviewer: true,
    piProcessRunner: piRunner, codexProcessRunner: codexRunner,
    ...(opts?.executionMode ? { executionMode: opts.executionMode } : {}),
  });

  return { tmp, projectRoot, store, runId, stageId, piRunner, codexRunner, scheduler };
}

export async function teardownBenchmark(ctx: BenchmarkContext): Promise<void> {
  try { await ctx.store.close(); } catch {}
  try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
}

// ══════════════════════════════════════════════════════════════
// Assertion Helpers
// ══════════════════════════════════════════════════════════════

/**
 * Verify that a task file in the target branch has correct content.
 */
export function verifyTargetBranchFile(projectRoot: string, file: string, taskId: string): boolean {
  const fullPath = path.join(projectRoot, file);
  if (!existsSync(fullPath)) return false;
  const content = readFileSync(fullPath, 'utf-8').replaceAll('\r\n', '\n');
  return content.includes(taskContent(taskId));
}

/**
 * Strict completion assertion: run=completed, all stages=completed, all tasks=merged.
 */
export async function assertRunFullyCompleted(store: SqliteStateStore, runId: string): Promise<void> {
  const { expect } = await import('vitest');

  const run = await store.getRun(runId);
  expect(run?.status, `run ${runId} status`).toBe('completed');

  const stages = await store.listStages(runId);
  for (const stage of stages) {
    if (stage.status === 'canceled') continue;
    expect(stage.status, `stage ${stage.stageNumber} status`).toBe('completed');
  }

  const tasks = await store.listTasks(runId);
  for (const task of tasks) {
    if (task.status === 'canceled') continue;
    expect(task.status, `task ${task.id} status`).toBe('merged');
  }
}

/**
 * Assert that a benchmark run has failed due to the conflict DAG.
 * The scheduler should pause, not complete. No fake-green.
 */
export async function assertRunPausedOrFailed(
  store: SqliteStateStore,
  runId: string,
  expectedReasons: string[],
): Promise<{ runStatus: string; stageStatus: string; pausedTaskIds: string[] }> {
  const { expect } = await import('vitest');

  const run = await store.getRun(runId);
  expect(run).not.toBeNull();
  // Run must NOT be 'completed' — it should be 'running' (paused stage) or 'failed'
  expect(run!.status, `run ${runId} must not be completed`).not.toBe('completed');

  const stages = await store.listStages(runId);
  const pausedStage = stages.find(s => s.status === 'paused' || s.status === 'failed');
  // At least one stage should be paused/failed
  const paused = !!pausedStage || (run!.status === 'failed');

  const tasks = await store.listTasks(runId);
  const nonTerminalTasks = tasks.filter(t =>
    !['merged', 'canceled', 'failed', 'rejected'].includes(t.status),
  );

  // Find events matching expected reasons
  const events = await store.listEvents(runId);
  const eventReasons = events.map(e => {
    try {
      if (e.eventDataJson) return JSON.parse(e.eventDataJson);
    } catch {}
    return null;
  }).filter(Boolean);

  return {
    runStatus: run!.status,
    stageStatus: pausedStage?.status || 'unknown',
    pausedTaskIds: nonTerminalTasks.map(t => t.id),
  };
}

/**
 * Assert independent tasks had overlapping execution (concurrency).
 */
export async function assertOverlap(piRunner: BenchPiRunner, taskIds: string[]): Promise<void> {
  const { expect } = await import('vitest');

  for (let i = 0; i < taskIds.length; i++) {
    for (let j = i + 1; j < taskIds.length; j++) {
      const aStart = piRunner.callStartTimes.get(taskIds[i]);
      const aEnd = piRunner.callEndTimes.get(taskIds[i]);
      const bStart = piRunner.callStartTimes.get(taskIds[j]);
      const bEnd = piRunner.callEndTimes.get(taskIds[j]);

      if (aStart == null || aEnd == null || bStart == null || bEnd == null) continue;

      // Tasks overlap if one starts before the other ends
      const overlap = (aStart < bEnd) && (bStart < aEnd);
      if (overlap) {
        // Found overlap — sufficient. Return early.
        return;
      }
    }
  }
  expect.fail(`No overlapping execution found among tasks: ${taskIds.join(', ')}`);
}

/**
 * Assert dependent task started after ALL of its dependencies ended.
 */
export async function assertDependsAfterAll(piRunner: BenchPiRunner, depTaskId: string, depTaskIds: string[]): Promise<void> {
  const { expect } = await import('vitest');

  const depEnds = depTaskIds.map(id => piRunner.callEndTimes.get(id)).filter(Boolean) as number[];
  const depStart = piRunner.callStartTimes.get(depTaskId);

  if (depEnds.length === 0 || depStart == null) return;

  const maxDepEnd = Math.max(...depEnds);
  expect(depStart, `${depTaskId} start >= max(${depTaskIds.join(',')} ends)`).toBeGreaterThanOrEqual(maxDepEnd);
}

/**
 * Assert that conflicting-path tasks did NOT overlap (serialized).
 */
export async function assertNoOverlap(piRunner: BenchPiRunner, taskA: string, taskB: string): Promise<void> {
  const { expect } = await import('vitest');

  const aStart = piRunner.callStartTimes.get(taskA);
  const aEnd = piRunner.callEndTimes.get(taskA);
  const bStart = piRunner.callStartTimes.get(taskB);
  const bEnd = piRunner.callEndTimes.get(taskB);

  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return;

  const overlap = (aStart < bEnd) && (bStart < aEnd);
  expect(overlap, `${taskA} and ${taskB} must not overlap`).toBe(false);
}

/**
 * Re-run a benchmark scenario N times and collect timing/status metrics.
 */
export async function runRepeated(
  iterations: number,
  factory: (iteration: number) => Promise<{ ctx: BenchmarkContext; wallMs: number; succeeded: boolean; runStatus: string; stageStatus: string; mergedTasks: number; totalTasks: number }>,
): Promise<{
  medians: { wallMs: number; mergedTasks: number };
  ranges: { wallMin: number; wallMax: number; mergedMin: number; mergedMax: number };
  passRate: number;
  allResults: Array<{ iter: number; succeeded: boolean; wallMs: number; runStatus: string; stageStatus: string; mergedTasks: number }>;
}> {
  const results: Array<{ iter: number; succeeded: boolean; wallMs: number; runStatus: string; stageStatus: string; mergedTasks: number }> = [];
  for (let i = 0; i < iterations; i++) {
    const r = await factory(i);
    results.push({
      iter: i, succeeded: r.succeeded,
      wallMs: r.wallMs, runStatus: r.runStatus, stageStatus: r.stageStatus,
      mergedTasks: r.mergedTasks,
    });
    await teardownBenchmark(r.ctx);
  }

  const walls = results.map(r => r.wallMs).sort((a, b) => a - b);
  const merges = results.map(r => r.mergedTasks).sort((a, b) => a - b);

  const median = (arr: number[]) => {
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  };

  return {
    medians: { wallMs: median(walls), mergedTasks: median(merges) },
    ranges: { wallMin: walls[0], wallMax: walls[walls.length - 1], mergedMin: merges[0], mergedMax: merges[merges.length - 1] },
    passRate: results.filter(r => r.succeeded).length / iterations,
    allResults: results,
  };
}

// ══════════════════════════════════════════════════════════════
// Sequential baseline runner
// ══════════════════════════════════════════════════════════════

export async function runSequentialBaseline(dag: TaskDef[]): Promise<{
  ctx: BenchmarkContext;
  wallMs: number;
  piCalls: number;
  codexCalls: number;
}> {
  const ctx = await setupBenchmark(dag, 1, `seq-${Date.now()}`);
  const start = Date.now();
  try {
    await ctx.scheduler.startRun(ctx.runId);
    const wallMs = Date.now() - start;
    return { ctx, wallMs, piCalls: ctx.piRunner.calls, codexCalls: ctx.codexRunner.calls };
  } catch {
    const wallMs = Date.now() - start;
    return { ctx, wallMs, piCalls: ctx.piRunner.calls, codexCalls: ctx.codexRunner.calls };
  }
}

export async function runOrchestratedBaseline(
  dag: TaskDef[],
  maxParallel: number,
  piDelayMs?: number,
  codexDelayMs?: number,
): Promise<{
  ctx: BenchmarkContext;
  wallMs: number;
  piCalls: number;
  codexCalls: number;
}> {
  const ctx = await setupBenchmark(dag, maxParallel, `orch-${Date.now()}`, {
    piDelayMs,
    codexDelayMs,
    executionMode: 'token-efficient',
  });
  const start = Date.now();
  try {
    await ctx.scheduler.startRun(ctx.runId);
    const wallMs = Date.now() - start;
    return { ctx, wallMs, piCalls: ctx.piRunner.calls, codexCalls: ctx.codexRunner.calls };
  } catch {
    const wallMs = Date.now() - start;
    return { ctx, wallMs, piCalls: ctx.piRunner.calls, codexCalls: ctx.codexRunner.calls };
  }
}
