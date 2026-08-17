// ── Auto evidence-based adoption (task 02B) ───────────────────────────────
// When Pi committed in the worktree but its WorkerResult/commitHash was lost,
// `autoAdoptVerifiableCommitEvidence` must verify the worktree HEAD commit and
// adopt it automatically (equivalent to `recover attempt --commit <HEAD>`
// without the human typing the command). Without a verifiable commit it must
// fail closed and never fake Pi completion.
//
// Zero real Pi/Codex/network: the "Pi commit" is created directly with git in
// a disposable worktree. Everything runs on fake/disposable data only.

import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { autoAdoptVerifiableCommitEvidence } from '../../src/cli/commands/recover.js';
import { makeRecoveryGitRepo, makeRecoveryStore, teardownRecovery, uid } from '../acceptance/helpers/recovery-fixtures.js';
import type { StructuredTaskSpec } from '../../src/types/m2-types.js';

const teardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = teardowns.splice(0);
  for (const t of pending.reverse()) { try { await t(); } catch { /* ignore */ } }
});

/** Give the repo a task quality gate so `autoAdoptVerifiableCommitEvidence`
 *  runs the same gates `recover attempt --commit` would (identical validation).
 *  Commits the config so the worktree stays clean afterwards. */
function writeTaskGate(projectRoot: string): void {
  const dir = path.join(projectRoot, '.brainctl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    projectId: 'auto-adopt-test',
    projectRoot: '.',
    defaultBaseBranch: 'main',
    allowedPaths: ['src/', 'docs/'],
    qualityGates: {
      task: [{ name: 'noop', command: 'node', args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
      stage: [],
    },
  }, null, 2), 'utf-8');
  execSync('git add -A', { cwd: projectRoot, stdio: 'pipe' });
  execSync('git commit -qm "add task quality gate"', { cwd: projectRoot, stdio: 'pipe' });
}

function makeTaskSpec(taskId: string, file: string): StructuredTaskSpec {
  return {
    taskId, stageNumber: 1,
    title: `Auto recovery ${taskId}`,
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

describe('autoAdoptVerifiableCommitEvidence', () => {
  it('auto-adopts a verifiable worktree HEAD commit when WorkerResult is missing', async () => {
    const { tmp, projectRoot } = makeRecoveryGitRepo();
    writeTaskGate(projectRoot);
    const store = await makeRecoveryStore(tmp);
    teardowns.push(() => teardownRecovery({ tmp, store }));

    const runId = uid('auto-adopt');
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    const attemptId = runId + '-a1';
    const file = 'src/auto_adopt.ts';
    const now = new Date().toISOString();

    await store.createRun({ id: runId, projectId: 'p', projectRoot, requestText: 'auto', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' });
    const spec = makeTaskSpec(taskId, file);
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: spec, createdAt: now, updatedAt: now });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' });
    // No workerResultJson — this is the "Pi committed but result lost" case.
    await store.updateAttemptResult(attemptId, { worktreePath: projectRoot, branchName: 'main' });

    // Provenance must match the actual worktree/branch/base.
    const baseCommit = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
    await store.recordAttemptProvenance({
      attemptId, runId, stageId, taskId, baseCommit,
      expectedBranch: 'main', expectedWorktree: projectRoot,
      taskPacketHash: 'a'.repeat(64), implementationPromptHash: 'b'.repeat(64),
      workerId: 'bc-auto', sessionId: `${runId}:${attemptId}`,
    });

    // "Pi" commits in the worktree (a real, verifiable new commit).
    mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
    writeFileSync(path.join(projectRoot, file), 'export const autoAdopted = 1;\n', 'utf-8');
    execSync(`git add ${file}`, { cwd: projectRoot, stdio: 'pipe' });
    execSync('git commit -qm "auto-adoption pi commit"', { cwd: projectRoot, stdio: 'pipe' });
    const headCommit = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();

    const outcome = await autoAdoptVerifiableCommitEvidence({ store, attemptId, projectRoot });

    expect(outcome.adopted).toBe(true);
    expect(outcome.commit).toBe(headCommit);
    expect(outcome.pauseId).toBeTruthy();
    const attempt = await store.getAttempt(attemptId);
    expect(attempt).toMatchObject({
      status: 'worker_completed',
      resultSource: 'worker_auto_recovery',
      adoptedCommit: headCommit,
    });
    const parsed = attempt ? JSON.parse(attempt.workerResultJson!) as { commitHash?: string } : null;
    expect(parsed?.commitHash).toBe(headCommit);
    expect(await store.getTask(taskId)).toMatchObject({ status: 'worker_completed' });
    expect(await store.getStage(stageId)).toMatchObject({ status: 'paused' });
    expect(await store.getActivePauseForStage(stageId)).toMatchObject({ reasonCode: 'recovery_adopted' });
  });

  it('fails closed when the worktree HEAD is the base commit (Pi never committed)', async () => {
    const { tmp, projectRoot } = makeRecoveryGitRepo();
    const store = await makeRecoveryStore(tmp);
    teardowns.push(() => teardownRecovery({ tmp, store }));

    const runId = uid('auto-noop');
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    const attemptId = runId + '-a1';
    const file = 'src/auto_noop.ts';
    const now = new Date().toISOString();

    await store.createRun({ id: runId, projectId: 'p', projectRoot, requestText: 'auto', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' });
    const spec = makeTaskSpec(taskId, file);
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: spec, createdAt: now, updatedAt: now });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'worker_completed' });
    await store.updateAttemptResult(attemptId, { worktreePath: projectRoot, branchName: 'main' });

    const baseCommit = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
    await store.recordAttemptProvenance({
      attemptId, runId, stageId, taskId, baseCommit,
      expectedBranch: 'main', expectedWorktree: projectRoot,
      taskPacketHash: 'a'.repeat(64), implementationPromptHash: 'b'.repeat(64),
      workerId: 'bc-auto', sessionId: `${runId}:${attemptId}`,
    });

    // No commit made: worktree HEAD == base commit → no verifiable new commit.
    const outcome = await autoAdoptVerifiableCommitEvidence({ store, attemptId, projectRoot });

    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toBeTruthy();
    // Nothing adopted: attempt unchanged, no pause, no adopted commit.
    expect(await store.getAttempt(attemptId)).toMatchObject({ status: 'worker_completed', adoptedCommit: null });
    expect(await store.getActivePauseForStage(stageId)).toBeNull();
    expect(await store.getActiveLocksForRun(runId)).toHaveLength(0);
  });

  it('fails closed when the worktree is dirty (unverifiable evidence)', async () => {
    const { tmp, projectRoot } = makeRecoveryGitRepo();
    const store = await makeRecoveryStore(tmp);
    teardowns.push(() => teardownRecovery({ tmp, store }));

    const runId = uid('auto-dirty');
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    const attemptId = runId + '-a1';
    const file = 'src/auto_dirty.ts';
    const now = new Date().toISOString();

    await store.createRun({ id: runId, projectId: 'p', projectRoot, requestText: 'auto', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' });
    const spec = makeTaskSpec(taskId, file);
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: spec, createdAt: now, updatedAt: now });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' });
    await store.updateAttemptResult(attemptId, { worktreePath: projectRoot, branchName: 'main' });

    const baseCommit = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
    await store.recordAttemptProvenance({
      attemptId, runId, stageId, taskId, baseCommit,
      expectedBranch: 'main', expectedWorktree: projectRoot,
      taskPacketHash: 'a'.repeat(64), implementationPromptHash: 'b'.repeat(64),
      workerId: 'bc-auto', sessionId: `${runId}:${attemptId}`,
    });

    // Pi committed, but left the worktree dirty (untracked file) → not verifiable.
    writeFileSync(path.join(projectRoot, file), 'export const dirty = 1;\n', 'utf-8');
    execSync(`git add ${file}`, { cwd: projectRoot, stdio: 'pipe' });
    execSync('git commit -qm "auto dirty pi commit"', { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(path.join(projectRoot, 'untracked.txt'), 'residue\n', 'utf-8');

    const outcome = await autoAdoptVerifiableCommitEvidence({ store, attemptId, projectRoot });

    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toContain('not clean');
    expect(await store.getAttempt(attemptId)).toMatchObject({ status: 'running', adoptedCommit: null });
  });

  it('never auto-approves a scope expansion beyond the frozen TaskSpec', async () => {
    const { tmp, projectRoot } = makeRecoveryGitRepo();
    const store = await makeRecoveryStore(tmp);
    teardowns.push(() => teardownRecovery({ tmp, store }));

    const runId = uid('auto-scope');
    const stageId = runId + '-s1';
    const taskId = runId + '-t1';
    const attemptId = runId + '-a1';
    const now = new Date().toISOString();

    await store.createRun({ id: runId, projectId: 'p', projectRoot, requestText: 'auto', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: stageId, runId, stageNumber: 1, title: 'S1', status: 'running' });
    // Allowed paths are src/ only; the "Pi" commit touches docs/ → scope expansion.
    const spec = makeTaskSpec(taskId, 'src/only.ts');
    await store.createTask({ id: taskId, runId, title: 'T1', status: 'running', specJson: spec, createdAt: now, updatedAt: now });
    await store.createAttempt({ id: attemptId, taskId, stageId, attemptNumber: 1, status: 'running' });
    await store.updateAttemptResult(attemptId, { worktreePath: projectRoot, branchName: 'main' });

    const baseCommit = execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim();
    await store.recordAttemptProvenance({
      attemptId, runId, stageId, taskId, baseCommit,
      expectedBranch: 'main', expectedWorktree: projectRoot,
      taskPacketHash: 'a'.repeat(64), implementationPromptHash: 'b'.repeat(64),
      workerId: 'bc-auto', sessionId: `${runId}:${attemptId}`,
    });

    mkdirSync(path.join(projectRoot, 'docs'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'docs', 'extra.md'), '# out of scope\n', 'utf-8');
    execSync('git add docs/extra.md', { cwd: projectRoot, stdio: 'pipe' });
    execSync('git commit -qm "auto scope pi commit"', { cwd: projectRoot, stdio: 'pipe' });

    const outcome = await autoAdoptVerifiableCommitEvidence({ store, attemptId, projectRoot });

    expect(outcome.adopted).toBe(false);
    expect(outcome.reason).toMatch(/scope|expands|frozen|not/i);
    expect(await store.getAttempt(attemptId)).toMatchObject({ status: 'running', adoptedCommit: null });
  });
});
