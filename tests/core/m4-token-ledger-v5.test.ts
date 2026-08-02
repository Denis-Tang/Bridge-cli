import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import { ensureDefaultPolicies, setPerRunBudget } from '../../src/core/budget-policy-store.js';
import { resetGovernanceConfigCache, setGovernanceEnabled } from '../../src/core/decision-gate.js';
import { FakeProcessRunner } from '../../src/adapters/pi-rpc-worker.js';
import type { ProcessRunInput, ProcessRunResult } from '../../src/adapters/pi-worker-types.js';
import { FakeCodexProcessRunner, type CodexProcessRunResult } from '../../src/adapters/codex-process-runner.js';
import type { StructuredTaskSpec } from '../../src/types/m2-types.js';
import type { WorkerResult } from '../../src/types/protocol.js';

function makeTmpDir(): string {
  const dir = path.join(tmpdir(), `brainctl-m4-v5-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeGitRepo(): { tmp: string; projectRoot: string; baseHead: string } {
  const tmp = makeTmpDir();
  const projectRoot = path.join(tmp, 'project');
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  execSync('git init', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.email test@test', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git config user.name test', { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(path.join(projectRoot, 'src', 'seed.ts'), 'export const seed = 1;\n', 'utf-8');
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: projectRoot, stdio: 'pipe' });
  const baseHead = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
  return { tmp, projectRoot, baseHead };
}

function workerResult(taskId: string): WorkerResult {
  return {
    taskId,
    status: 'completed',
    summary: 'fake Pi wrote allowed file',
    filesChanged: ['src/allowed.ts'],
    checks: [{ name: 'fake', status: 'passed', summary: 'ok' }],
    scopeViolations: [],
    risks: [],
    unresolvedQuestions: [],
    productDecisionRequired: false,
    tokenUsage: { inputTokens: 12_000, outputTokens: 9_000, cacheHitTokens: 0 },
  };
}

function recoveryPathHash(paths: string[]): string {
  const canonical = [...new Set(paths.map((value) => value.replace(/\\/g, '/').replace(/^\.\//, '')))].sort();
  return createHash('sha256').update(canonical.join('\n')).digest('hex');
}

class WritingFakePiRunner extends FakeProcessRunner {
  calls = 0;

  constructor(private readonly taskId: string) {
    super();
  }

  async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.calls++;
    mkdirSync(path.join(input.cwd, 'src'), { recursive: true });
    writeFileSync(path.join(input.cwd, 'src', 'allowed.ts'), `export const v${this.calls} = ${this.calls};\n`, 'utf-8');
    execSync('git add src/allowed.ts', { cwd: input.cwd, stdio: 'pipe' });
    execSync(`git commit -m "fake pi ${this.calls}"`, { cwd: input.cwd, stdio: 'pipe' });
    const result = workerResult(this.taskId);
    return {
      pid: 4242,
      exitCode: 0,
      stdout: JSON.stringify({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          content: [
            'BEGIN_WORKER_RESULT_JSON',
            JSON.stringify(result),
            'END_WORKER_RESULT_JSON',
          ].join('\n'),
          usage: {
            input: 12_000,
            output: 9_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 21_000,
            cost: { total: 0.01 },
          },
        }],
      }),
      stderr: '',
      timedOut: false,
      aborted: false,
      terminatedAfterWorkerResult: false,
      durationMs: 25,
    };
  }
}

class CountingFakeCodexRunner extends FakeCodexProcessRunner {
  calls = 0;

  async run(command: string, args: string[], opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number }): Promise<CodexProcessRunResult> {
    this.calls++;
    return {
      stdout: 'No actionable issues found.',
      stderr: '',
      exitCode: 0,
      durationMs: 20,
      tokenUsage: { inputTokens: 300, outputTokens: 120, cacheHitTokens: 0 },
    };
  }
}

async function makeStore(tmp: string): Promise<SqliteStateStore> {
  const dbPath = path.join(tmp, '.brainctl', 'state', 'v5.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = SqliteStateStore.create(dbPath);
  const cfg: SqliteConfig = { path: dbPath, maskedPath: dbPath };
  new SqliteMigrationRunner(cfg, store.getDatabase()).applyPending();
  await ensureDefaultPolicies(store);
  return store;
}

async function createSingleTaskRun(store: SqliteStateStore, projectRoot: string, runId: string): Promise<{ stageId: string; taskId: string; spec: StructuredTaskSpec }> {
  const now = new Date().toISOString();
  const stageId = `${runId}-stage-1`;
  const taskId = `${runId}-task-1`;
  const spec: StructuredTaskSpec = {
    taskId,
    stageNumber: 1,
    title: 'Write allowed file',
    goal: 'Write one allowed source file.',
    dependencies: [],
    estimatedWritePaths: ['src/allowed.ts'],
    allowedPaths: ['src/'],
    forbiddenPaths: [],
    contextFiles: [],
    acceptanceChecks: ['fake gate passes'],
    allowedCommands: ['node -e process.exit(0)'],
    riskLevel: 'low',
    productDecisionsLocked: true,
    expectedOutputs: ['src/allowed.ts'],
    heavyCommandSlotsRequired: 0,
    timeoutSeconds: 60,
  };

  await store.createRun({ id: runId, projectId: 'proj', projectRoot, requestText: 'v5 test', status: 'running', createdAt: now, updatedAt: now });
  await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'Stage 1', status: 'ready' });
  await store.createTask({ id: taskId, runId, title: spec.title, status: 'pending', specJson: spec, createdAt: now, updatedAt: now });
  await store.createEvent({ id: `${runId}-ev-plan`, runId, eventType: 'plan_created' });
  return { stageId, taskId, spec };
}

function makeScheduler(store: SqliteStateStore, projectRoot: string, piRunner: WritingFakePiRunner, codexRunner: CountingFakeCodexRunner): StageScheduler {
  return new StageScheduler(store, {
    projectRoot,
    sessionDir: '.brainctl-dev/sessions',
    logDir: '.brainctl-dev/logs',
    worktreeBaseDir: '.brainctl-dev/worktrees',
    defaultLockedPaths: [],
    targetBranch: 'main',
    maxParallelTasks: 1,
    maxReworkCount: 1,
    qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    governanceEnabled: true,
    allowRealWorker: true,
    allowRealReviewer: true,
    piProcessRunner: piRunner,
    codexProcessRunner: codexRunner,
  });
}

async function resumeBudget(store: SqliteStateStore, runId: string, stageId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await setPerRunBudget(store, runId, 'pi_attempt', 50_000, 'pause');
  await store.createEvent({
    id: `${runId}-ev-budget-resumed-${Date.now()}`,
    runId,
    eventType: 'token_budget_resumed',
    eventData: { policyType: 'pi_attempt', newLimit: 50_000 },
  });
  await store.createEvent({
    id: `${runId}-ev-run-resumed-${Date.now()}`,
    runId,
    eventType: 'run_resumed',
    eventData: { resumedAt: new Date().toISOString() },
  });
  await store.updateRunStatus(runId, 'running', new Date().toISOString());
  const activePause = await store.getActivePauseForStage(stageId);
  if (!activePause) throw new Error(`Stage ${stageId} is paused without an active PauseRecord`);
  if (activePause.decisionId) {
    const approved = await store.updateApprovalDecisionStatus(
      activePause.decisionId,
      'approved',
      new Date().toISOString(),
    );
    if (!approved) throw new Error(`Failed to approve ${activePause.decisionId}`);
  }
  const resolved = await store.resolveStagePause({
    pauseId: activePause.id,
    stageId,
    approvalDecisionId: activePause.decisionId,
    resolutionNote: `Synthetic test confirmed PauseRecord ${activePause.id}`,
  });
  if (!resolved) throw new Error(`Failed to resolve active PauseRecord ${activePause.id}`);
}

async function preparePausedRun(runId: string): Promise<{
  tmp: string;
  projectRoot: string;
  baseHead: string;
  store: SqliteStateStore;
  stageId: string;
  taskId: string;
  piRunner: WritingFakePiRunner;
  codexRunner: CountingFakeCodexRunner;
  scheduler: StageScheduler;
}> {
  const { tmp, projectRoot, baseHead } = makeGitRepo();
  setGovernanceEnabled(projectRoot, true);
  resetGovernanceConfigCache();
  const store = await makeStore(tmp);
  const { stageId, taskId } = await createSingleTaskRun(store, projectRoot, runId);
  await setPerRunBudget(store, runId, 'pi_attempt', 6_000, 'pause');
  await setPerRunBudget(store, runId, 'codex_review_stage', 50_000, 'pause');
  const piRunner = new WritingFakePiRunner(taskId);
  const codexRunner = new CountingFakeCodexRunner();
  const scheduler = makeScheduler(store, projectRoot, piRunner, codexRunner);

  await scheduler.startRun(runId);

  expect(piRunner.calls).toBe(1);
  expect(codexRunner.calls).toBe(0);
  const attempt = await store.getLatestAttempt(taskId);
  expect(attempt?.status).toBe('worker_completed');
  expect((await store.getStage(stageId))?.status).toBe('paused');
  expect((await store.listEvents(runId, 'token_budget_exceeded')).length).toBe(1);
  expect((await store.listReviewsByAttempt(attempt!.id)).length).toBe(0);
  expect((await store.listIntegrationBatches(stageId)).length).toBe(0);
  expect(execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim()).toBe(baseHead);
  const activeLocks = await store.getActiveLocksForRun(runId);
  expect(activeLocks.some((lock) => lock.taskId === taskId && lock.filePath === 'src/allowed.ts' && lock.status === 'locked')).toBe(true);

  return { tmp, projectRoot, baseHead, store, stageId, taskId, piRunner, codexRunner, scheduler };
}

describe('M4 Token Ledger v5 StageScheduler fake integration', () => {
  it('hard pauses after fake Pi, then resumes same worker_completed attempt through review and merge without double ledger', async () => {
    const runId = 'v5-e2e';
    const ctx = await preparePausedRun(runId);
    try {
      await resumeBudget(ctx.store, runId, ctx.stageId);
      await ctx.scheduler.startRun(runId);

      expect(ctx.piRunner.calls).toBe(1);
      // One task review plus the mandatory final integrated-tree review.
      expect(ctx.codexRunner.calls).toBe(2);

      const attempt = await ctx.store.getLatestAttempt(ctx.taskId);
      expect(attempt?.status).toBe('approved');
      const locks = await ctx.store.getActiveLocksForRun(runId);
      expect(locks.filter((lock) => lock.taskId === ctx.taskId)).toHaveLength(0);

      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('completed');
      expect((await ctx.store.getRun(runId))?.status).toBe('completed');
      const batches = await ctx.store.listIntegrationBatches(ctx.stageId);
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe('completed');
      expect(batches[0].reviewCoverageStatus).toBe('complete');
      expect(batches[0].targetMergeCommit).toBeTruthy();
      expect(execSync('git rev-parse HEAD', { cwd: ctx.projectRoot, encoding: 'utf-8' }).trim()).not.toBe(ctx.baseHead);

      const piLedger = await ctx.store.listTokenLedgerEntries(runId, 'pi_worker');
      const reviewLedger = await ctx.store.listTokenLedgerEntries(runId, 'codex_review');
      expect(piLedger).toHaveLength(1);
      expect(piLedger[0].status).toBe('confirmed');
      expect(piLedger[0].actualTotal).toBe(21_000);
      expect(reviewLedger).toHaveLength(1);
      expect(reviewLedger[0].status).toBe('confirmed');
      expect(reviewLedger[0].actualTotal).toBe(420);
    } finally {
      await ctx.store.close();
      try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('resumes an integrity-proven recovery expansion without reopening the frozen TaskSpec decision', async () => {
    const runId = 'v5-recovery-expansion';
    const ctx = await preparePausedRun(runId);
    try {
      const attempt = await ctx.store.getLatestAttempt(ctx.taskId);
      const worktree = attempt!.worktreePath!;
      mkdirSync(path.join(worktree, 'tests'), { recursive: true });
      writeFileSync(path.join(worktree, 'tests', 'approved.test.ts'), 'export const recovered = true;\n', 'utf-8');
      execSync('git add tests/approved.test.ts', { cwd: worktree, stdio: 'pipe' });
      execSync('git commit -m "approved recovery expansion"', { cwd: worktree, stdio: 'pipe' });
      const adoptedCommit = execSync('git rev-parse HEAD', { cwd: worktree, encoding: 'utf-8' }).trim();
      const changedFiles = ['src/allowed.ts', 'tests/approved.test.ts'];
      const expansionFiles = ['tests/approved.test.ts'];
      const result = JSON.parse(attempt!.workerResultJson!) as WorkerResult;
      result.filesChanged = changedFiles;
      result.commitHash = adoptedCommit;
      await ctx.store.updateAttemptResult(attempt!.id, {
        workerResultJson: JSON.stringify(result),
        resultSource: 'manual',
        adoptedCommit,
        adoptionMetadataJson: JSON.stringify({
          changedFilesHash: recoveryPathHash(changedFiles),
          changedFileCount: changedFiles.length,
          scopeExpansionFilesHash: recoveryPathHash(expansionFiles),
          scopeExpansionFileCount: expansionFiles.length,
        }),
      });
      const lockResult = await ctx.store.acquirePathLocksAtomic({
        runId, taskId: ctx.taskId, filePaths: expansionFiles, lockType: 'exclusive',
      });
      expect(lockResult.acquired).toBe(true);

      await resumeBudget(ctx.store, runId, ctx.stageId);
      await ctx.scheduler.startRun(runId);

      expect(ctx.piRunner.calls).toBe(1);
      expect(ctx.codexRunner.calls).toBe(2);
      expect((await ctx.store.getLatestAttempt(ctx.taskId))?.status).toBe('approved');
      expect((await ctx.store.getRun(runId))?.status).toBe('completed');
      expect(await ctx.store.listEvents(runId, 'scope_expansion')).toHaveLength(0);
    } finally {
      await ctx.store.close();
      try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('safe-pauses resume when the worker_completed active lock is missing', async () => {
    const runId = 'v5-lock-missing';
    const ctx = await preparePausedRun(runId);
    try {
      const activeLocks = await ctx.store.getActiveLocksForRun(runId);
      for (const lock of activeLocks.filter((lock) => lock.taskId === ctx.taskId)) {
        await ctx.store.releasePathLock(lock.id, new Date().toISOString());
      }

      await resumeBudget(ctx.store, runId, ctx.stageId);
      await ctx.scheduler.startRun(runId);

      expect(ctx.piRunner.calls).toBe(1);
      expect(ctx.codexRunner.calls).toBe(0);
      expect((await ctx.store.getLatestAttempt(ctx.taskId))?.status).toBe('worker_completed');
      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('paused');
      const pausedEvents = await ctx.store.listEvents(runId, 'stage_paused');
      expect(pausedEvents.some((event) => event.eventDataJson?.includes('resume_path_lock_invalid') && event.eventDataJson.includes('not_active'))).toBe(true);
      expect(await ctx.store.listIntegrationBatches(ctx.stageId)).toHaveLength(0);
    } finally {
      await ctx.store.close();
      try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('safe-pauses recovery resume when an approved expanded-path lock is missing', async () => {
    const runId = 'v5-recovery-lock-missing';
    const ctx = await preparePausedRun(runId);
    try {
      const attempt = await ctx.store.getLatestAttempt(ctx.taskId);
      const adoptedCommit = execSync('git rev-parse HEAD', { cwd: attempt!.worktreePath!, encoding: 'utf-8' }).trim();
      const changedFiles = ['src/allowed.ts', 'tests/approved.test.ts'];
      const expansionFiles = ['tests/approved.test.ts'];
      const result = JSON.parse(attempt!.workerResultJson!) as WorkerResult;
      result.filesChanged = changedFiles;
      result.commitHash = adoptedCommit;
      await ctx.store.updateAttemptResult(attempt!.id, {
        workerResultJson: JSON.stringify(result),
        resultSource: 'manual',
        adoptedCommit,
        adoptionMetadataJson: JSON.stringify({
          changedFilesHash: recoveryPathHash(changedFiles),
          changedFileCount: changedFiles.length,
          scopeExpansionFilesHash: recoveryPathHash(expansionFiles),
          scopeExpansionFileCount: expansionFiles.length,
        }),
      });
      const acquired = await ctx.store.acquirePathLocksAtomic({
        runId, taskId: ctx.taskId, filePaths: expansionFiles, lockType: 'exclusive',
      });
      expect(acquired.acquired).toBe(true);
      for (const lock of acquired.locks) {
        await ctx.store.releasePathLock(lock.id, new Date().toISOString());
      }

      await resumeBudget(ctx.store, runId, ctx.stageId);
      await ctx.scheduler.startRun(runId);

      expect(ctx.piRunner.calls).toBe(1);
      expect(ctx.codexRunner.calls).toBe(0);
      expect((await ctx.store.getLatestAttempt(ctx.taskId))?.status).toBe('worker_completed');
      const pausedEvents = await ctx.store.listEvents(runId, 'stage_paused');
      expect(pausedEvents.some((event) => event.eventDataJson?.includes('resume_path_lock_invalid')
        && event.eventDataJson.includes('not_active')
        && event.eventDataJson.includes('tests/approved.test.ts'))).toBe(true);
    } finally {
      await ctx.store.close();
      try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('safe-pauses resume when another task owns a conflicting active lock', async () => {
    const runId = 'v5-lock-conflict';
    const ctx = await preparePausedRun(runId);
    try {
      await ctx.store.createTask({
        id: `${runId}-other-task`,
        runId,
        title: 'Other',
        status: 'pending',
        specJson: { taskId: `${runId}-other-task`, stageNumber: 1, title: 'Other', goal: 'other', dependencies: [ctx.taskId], estimatedWritePaths: ['src/allowed.ts'], allowedPaths: ['src/'], forbiddenPaths: [], contextFiles: [], acceptanceChecks: [], allowedCommands: [], riskLevel: 'low', productDecisionsLocked: true, expectedOutputs: [], heavyCommandSlotsRequired: 0, timeoutSeconds: 60 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await ctx.store.createPathLock({
        id: `${runId}-other-lock`,
        runId,
        taskId: `${runId}-other-task`,
        filePath: 'src/allowed.ts',
      });

      await resumeBudget(ctx.store, runId, ctx.stageId);
      await ctx.scheduler.startRun(runId);

      expect(ctx.piRunner.calls).toBe(1);
      expect(ctx.codexRunner.calls).toBe(0);
      expect((await ctx.store.getLatestAttempt(ctx.taskId))?.status).toBe('worker_completed');
      expect((await ctx.store.getStage(ctx.stageId))?.status).toBe('paused');
      const pausedEvents = await ctx.store.listEvents(runId, 'stage_paused');
      expect(pausedEvents.some((event) => event.eventDataJson?.includes('resume_path_lock_invalid') && event.eventDataJson.includes('conflicting_owner'))).toBe(true);
      expect(await ctx.store.listIntegrationBatches(ctx.stageId)).toHaveLength(0);
    } finally {
      await ctx.store.close();
      try { rmSync(ctx.tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('governance=false submit-style scheduler behavior still produces no token ledger', async () => {
    const { tmp, projectRoot } = makeGitRepo();
    const runId = 'v5-gov-off';
    try {
      setGovernanceEnabled(projectRoot, false);
      resetGovernanceConfigCache();
      const store = await makeStore(tmp);
      try {
        const { stageId, taskId } = await createSingleTaskRun(store, projectRoot, runId);
        const piRunner = new WritingFakePiRunner(taskId);
        const codexRunner = new CountingFakeCodexRunner();
        const scheduler = new StageScheduler(store, {
          projectRoot,
          sessionDir: '.brainctl-dev/sessions',
          logDir: '.brainctl-dev/logs',
          worktreeBaseDir: '.brainctl-dev/worktrees',
          defaultLockedPaths: [],
          targetBranch: 'main',
          maxParallelTasks: 1,
          maxReworkCount: 1,
          qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
          governanceEnabled: false,
          allowRealWorker: true,
          allowRealReviewer: true,
          piProcessRunner: piRunner,
          codexProcessRunner: codexRunner,
        });

        await scheduler.startRun(runId);

        expect(piRunner.calls).toBe(1);
        // Governance telemetry may be off, but final integrated-tree review is not optional.
        expect(codexRunner.calls).toBe(2);
        expect((await store.getLatestAttempt(taskId))?.status).toBe('approved');
        expect((await store.getStage(stageId))?.status).toBe('completed');
        expect(await store.listTokenLedgerEntries(runId)).toHaveLength(0);
        expect(await store.listEvents(runId, 'token_budget_exceeded')).toHaveLength(0);
      } finally {
        await store.close();
      }
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });
});
