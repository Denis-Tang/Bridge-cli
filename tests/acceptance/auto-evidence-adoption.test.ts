// ── Scheduler Auto-Adoption Integration (task 02B) ────────────────────────
// End-to-end: a fake Pi that commits in the worktree but returns NO WorkerResult
// must be auto-adopted by the scheduler from the verifiable worktree HEAD commit
// (no human `recover attempt --commit` step). A fake Pi that commits nothing
// must still fail closed (never fake completion).
//
// Zero real Pi/Codex/network. Fake/disposable providers only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import { FakeProcessRunner } from '../../src/adapters/pi-rpc-worker.js';
import {
  FakeCodexProcessRunner,
  formatApprovedCodexReviewMarker,
  extractCodexReviewTaskId,
} from '../../src/adapters/codex-process-runner.js';
import type { ProcessRunInput, ProcessRunResult } from '../../src/adapters/pi-worker-types.js';
import type { CodexProcessRunResult } from '../../src/adapters/codex-process-runner.js';
import {
  makeRecoveryGitRepo, makeRecoveryStore, teardownRecovery, uid,
  makeRecoveryTaskSpec,
} from './helpers/recovery-fixtures.js';

/** Pi that writes a file, commits it, but returns NO WorkerResult. */
class CommitOnlyPiRunner extends FakeProcessRunner {
  calls = 0;

  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.calls++;
    const file = 'src/commit_only.ts';
    mkdirSync(path.join(input.cwd, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(input.cwd, file), `export const v${this.calls} = ${this.calls};\n`, 'utf-8');
    try {
      execSync(`git add ${file}`, { cwd: input.cwd, stdio: 'pipe' });
      execSync('git commit -qm "commit-only pi"', { cwd: input.cwd, stdio: 'pipe' });
    } catch { /* ignore */ }
    return {
      pid: 8100 + this.calls, exitCode: 0,
      stdout: 'committed but no WorkerResult emitted',
      stderr: '',
      timedOut: false, aborted: false, terminatedAfterWorkerResult: false,
      durationMs: 5,
    };
  }
}

/** Pi that writes a file but never commits (no verifiable commit). */
class NoCommitPiRunner extends FakeProcessRunner {
  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    const file = 'src/no_commit.ts';
    mkdirSync(path.join(input.cwd, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(input.cwd, file), 'export const noCommit = 1;\n', 'utf-8');
    return {
      pid: 8200, exitCode: 0,
      stdout: 'no commit, no WorkerResult',
      stderr: '',
      timedOut: false, aborted: false, terminatedAfterWorkerResult: false,
      durationMs: 5,
    };
  }
}

class ApprovingCodexRunner extends FakeCodexProcessRunner {
  override async run(
    _command: string,
    _args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<CodexProcessRunResult> {
    const taskId = extractCodexReviewTaskId(opts.input) ?? 'unknown';
    return {
      stdout: formatApprovedCodexReviewMarker(taskId),
      stderr: '',
      exitCode: 0,
      durationMs: 5,
      tokenUsage: { inputTokens: 50, outputTokens: 20, cacheHitTokens: 0 },
    };
  }
}

function writeTaskGate(projectRoot: string): void {
  const dir = path.join(projectRoot, '.brainctl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectId: 'sched-auto-adopt',
    projectRoot: '.',
    defaultBaseBranch: 'main',
    allowedPaths: ['src/'],
    qualityGates: {
      task: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
      stage: [],
    },
  }, null, 2), 'utf-8');
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git commit -qm "add task quality gate"', { cwd: projectRoot, stdio: 'pipe' });
}

describe('Scheduler auto-adoption when Pi commits but WorkerResult is lost', () => {
  it('adopts the verifiable worktree commit and pauses for review (no manual recover)', async () => {
    const { tmp, projectRoot } = makeRecoveryGitRepo();
    writeTaskGate(projectRoot);
    const store = await makeRecoveryStore(tmp);
    const runId = uid('sched-auto');
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    const now = new Date().toISOString();

    await store.createRun({ id: runId, projectId: 'p', projectRoot, requestText: 'auto', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' });
    const spec = makeRecoveryTaskSpec(taskId, 1, 'src/commit_only.ts');
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: spec, createdAt: now, updatedAt: now });

    const scheduler = new StageScheduler(store, {
      projectRoot, sessionDir: '.brainctl-dev/sessions', logDir: '.brainctl-dev/logs',
      worktreeBaseDir: '.brainctl-dev/worktrees', defaultLockedPaths: [], targetBranch: 'main',
      maxParallelTasks: 1, maxReworkCount: 1,
      qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
      governanceEnabled: false, allowRealWorker: true, allowRealReviewer: true,
      resourceSamplingEnabled: false,
      piProcessRunner: new CommitOnlyPiRunner(),
      codexProcessRunner: new ApprovingCodexRunner(),
    });

    try {
      await scheduler.startRun(runId);

      const attempt = (await store.listAttempts(taskId))[0];
      expect(attempt, 'attempt must exist').toBeTruthy();
      // Auto-adoption must mark the attempt worker_completed with an adopted commit.
      expect(attempt!.status).toBe('worker_completed');
      expect(attempt!.resultSource).toBe('worker_auto_recovery');
      expect(attempt!.adoptedCommit).toBeTruthy();
      const wr = attempt!.workerResultJson ? JSON.parse(attempt!.workerResultJson) as { commitHash?: string } : null;
      expect(wr?.commitHash).toBe(attempt!.adoptedCommit);
      // The stage must be paused with a recovery pause — resume continues review → integration → merge.
      const stage = await store.getStage(stageId);
      expect(stage!.status).toBe('paused');
      const pause = await store.getActivePauseForStage(stageId);
      expect(pause?.reasonCode).toBe('recovery_adopted');
      // The audit event must exist.
      const events = await store.listEvents(runId, 'recovery_adopted');
      expect(events.length).toBeGreaterThan(0);
    } finally {
      await teardownRecovery({ tmp, store });
    }
  });

  it('still fails closed when Pi never committed (no verifiable commit → no adoption)', async () => {
    const { tmp, projectRoot } = makeRecoveryGitRepo();
    writeTaskGate(projectRoot);
    const store = await makeRecoveryStore(tmp);
    const runId = uid('sched-nocommit');
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    const now = new Date().toISOString();

    await store.createRun({ id: runId, projectId: 'p', projectRoot, requestText: 'auto', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' });
    const spec = makeRecoveryTaskSpec(taskId, 1, 'src/no_commit.ts');
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: spec, createdAt: now, updatedAt: now });

    const scheduler = new StageScheduler(store, {
      projectRoot, sessionDir: '.brainctl-dev/sessions', logDir: '.brainctl-dev/logs',
      worktreeBaseDir: '.brainctl-dev/worktrees', defaultLockedPaths: [], targetBranch: 'main',
      maxParallelTasks: 1, maxReworkCount: 1,
      qualityGates: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
      governanceEnabled: false, allowRealWorker: true, allowRealReviewer: true,
      resourceSamplingEnabled: false,
      piProcessRunner: new NoCommitPiRunner(),
      codexProcessRunner: new ApprovingCodexRunner(),
    });

    try {
      await scheduler.startRun(runId);

      const attempt = (await store.listAttempts(taskId))[0];
      expect(attempt, 'attempt must exist').toBeTruthy();
      // No verifiable commit → the scheduler must NOT auto-adopt → attempt failed.
      expect(attempt!.status).toBe('failed');
      expect(attempt!.adoptedCommit).toBeNull();
      expect(attempt!.exitReason).toContain('worker_result_missing');
      // No recovery_adopted pause/event.
      const pause = await store.getActivePauseForStage(stageId);
      expect(pause?.reasonCode).toBe('worker_result_missing_recovery_available');
      const events = await store.listEvents(runId, 'recovery_adopted');
      expect(events).toHaveLength(0);
    } finally {
      await teardownRecovery({ tmp, store });
    }
  });
});
