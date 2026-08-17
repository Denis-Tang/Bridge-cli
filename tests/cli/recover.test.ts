import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import {
  adoptRecoveryAtomically,
  readRecoveryContextReadOnly,
  validateRecoveryScope,
} from '../../src/cli/commands/recover.js';

describe('recover attempt atomic adoption', () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    dir = path.join(tmpdir(), `bridge-recover-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = path.join(dir, 'state.db');
    store = SqliteStateStore.create(dbPath);
    new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
    const now = new Date().toISOString();
    await store.createRun({ id: 'r', projectId: 'p', projectRoot: dir, requestText: 'x', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: 's', runId: 'r', stageNumber: 1, title: 's', status: 'running', baseCommit: 'base' });
    await store.createTask({
      id: 't', runId: 'r', title: 't', status: 'failed',
      specJson: { taskId: 't', stageNumber: 1, dependencies: [], estimatedWritePaths: ['src/a.ts'], allowedPaths: ['src/'], forbiddenPaths: [] },
      createdAt: now, updatedAt: now,
    });
    await store.createAttempt({ id: 'a', taskId: 't', stageId: 's', attemptNumber: 1, status: 'failed' });
    await store.recordAttemptProvenance({
      attemptId: 'a', runId: 'r', stageId: 's', taskId: 't', baseCommit: 'base',
      expectedBranch: 'recovery/a', expectedWorktree: dir, taskPacketHash: 'a'.repeat(64),
      implementationPromptHash: 'b'.repeat(64), workerId: 'bc-a', sessionId: 'r:a',
    });
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedReworkAttemptWithReview(
    status: 'rework_required' | 'rejected' | 'needs_user_decision',
    requiredRework: unknown[],
  ): Promise<void> {
    store.getDatabase().prepare("UPDATE task_attempts SET status='rework_required' WHERE id='a'").run();
    const reviewId = `rev-${status}-${Math.random()}`;
    await store.createReview({ id: reviewId, attemptId: 'a', taskId: 't', reviewerType: 'codex', status });
    await store.updateReviewResult(reviewId, {
      status,
      reviewJson: JSON.stringify({ taskId: 't', status, requiredRework }),
    });
  }

  function workerResult(): import('../../src/types/protocol.js').WorkerResult {
    return {
      taskId: 't', status: 'completed', summary: 'adopted', filesChanged: ['src/a.ts'], commitHash: 'abc123',
      checks: [], scopeViolations: [], risks: [], unresolvedQuestions: [],
      productDecisionRequired: false, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
    };
  }

  function adoptBase(overrides: Record<string, unknown> = {}) {
    return {
      runId: 'r', stageId: 's', taskId: 't', attemptId: 'a', worktree: dir, branch: 'recovery/a',
      commit: 'abc123', source: 'codex_recovery', changedFiles: ['src/a.ts'], lockPaths: ['src/'],
      workerResult: workerResult(), decisionNote: null, ...overrides,
    };
  }

  it('records provenance, locks and worker_completed without claiming completion', async () => {
    adoptRecoveryAtomically(store, {
      runId: 'r', stageId: 's', taskId: 't', attemptId: 'a', worktree: dir, branch: 'recovery/a',
      commit: 'abc123', source: 'codex_recovery', changedFiles: ['src/a.ts'], lockPaths: ['src/'],
      workerResult: { taskId: 't', status: 'completed', summary: 'adopted', filesChanged: ['src/a.ts'], commitHash: 'abc123', checks: [], scopeViolations: [], risks: [], unresolvedQuestions: [], productDecisionRequired: false, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 } },
      decisionNote: 'approved legacy scope expansion', scopeExpansionFiles: ['src/a.ts'],
    });

    const attempt = await store.getAttempt('a');
    expect(attempt).toMatchObject({ status: 'worker_completed', resultSource: 'codex_recovery', adoptedCommit: 'abc123' });
    expect(attempt?.adoptionMetadataJson).toContain('"scopeExpansionFileCount":1');
    expect(await store.getTask('t')).toMatchObject({ status: 'worker_completed' });
    expect(await store.getStage('s')).toMatchObject({ status: 'paused' });
    expect(await store.getActivePauseForStage('s')).toMatchObject({ reasonCode: 'recovery_adopted', category: 'recovery' });
    expect(await store.getRun('r')).toMatchObject({ status: 'running' });
    expect(await store.getActiveLocksForRun('r')).toHaveLength(1);
    const event = (await store.listEvents('r', 'recovery_adopted'))[0]?.eventDataJson;
    expect(event).toContain('resume_for_review_and_integration');
    expect(event).toContain('"expandedFileCount":1');
  });

  it('restores rework_required to worker_completed when latest review is rework_required with empty requiredRework', async () => {
    await seedReworkAttemptWithReview('rework_required', []);

    adoptRecoveryAtomically(store, adoptBase());

    expect(await store.getAttempt('a')).toMatchObject({ status: 'worker_completed', resultSource: 'codex_recovery' });
    expect(await store.getTask('t')).toMatchObject({ status: 'worker_completed' });
    expect(await store.getStage('s')).toMatchObject({ status: 'paused' });
  });

  it('allows rework_required recovery when latest review requiredRework is non-empty (parser guarantees non-empty)', async () => {
    await seedReworkAttemptWithReview('rework_required', ['src/a.ts']);

    adoptRecoveryAtomically(store, adoptBase());

    expect(await store.getAttempt('a')).toMatchObject({ status: 'worker_completed', resultSource: 'codex_recovery' });
    expect(await store.getTask('t')).toMatchObject({ status: 'worker_completed' });
    expect(await store.getStage('s')).toMatchObject({ status: 'paused' });
  });

  it('rejects rework_required recovery when latest review status is rejected even with empty requiredRework', async () => {
    await seedReworkAttemptWithReview('rejected', []);

    expect(() => adoptRecoveryAtomically(store, adoptBase()))
      .toThrow(/rework_required recovery requires latest review/);
    expect(await store.getAttempt('a')).toMatchObject({ status: 'rework_required', adoptedCommit: null });
    expect(await store.getActiveLocksForRun('r')).toHaveLength(0);
  });

  it('rejects rework_required recovery when latest review status is needs_user_decision even with empty requiredRework', async () => {
    await seedReworkAttemptWithReview('needs_user_decision', []);

    expect(() => adoptRecoveryAtomically(store, adoptBase()))
      .toThrow(/rework_required recovery requires latest review/);
    expect(await store.getAttempt('a')).toMatchObject({ status: 'rework_required', adoptedCommit: null });
  });

  it('allows rework_required recovery in read-only context when the attempt has no task review', async () => {
    store.getDatabase().prepare("UPDATE task_attempts SET status='rework_required' WHERE id='a'").run();

    const context = readRecoveryContextReadOnly(dbPath, 'a');
    expect(context.attempt).toMatchObject({ id: 'a', status: 'rework_required' });
  });

  it('adopts rework_required recovery when the attempt has no task review', async () => {
    store.getDatabase().prepare("UPDATE task_attempts SET status='rework_required' WHERE id='a'").run();

    adoptRecoveryAtomically(store, adoptBase());

    expect(await store.getAttempt('a')).toMatchObject({ status: 'worker_completed', resultSource: 'codex_recovery' });
    expect(await store.getTask('t')).toMatchObject({ status: 'worker_completed' });
    expect(await store.getStage('s')).toMatchObject({ status: 'paused' });
  });

  it('allows an explicitly approved frozen TaskSpec expansion only within the run project scope', () => {
    const common = {
      changedFiles: ['src/a.ts', 'tests/a.test.ts'],
      estimatedWritePaths: ['src/a.ts'],
      taskAllowedPaths: ['src/'],
      taskForbiddenPaths: [],
      projectAllowedPaths: ['src/', 'tests/'],
      projectForbiddenPaths: ['.env', 'verification/'],
      sharedLocks: ['package.json', 'src/a.ts'],
      repositoryRoot: dir,
    };

    expect(() => validateRecoveryScope({ ...common, allowScopeExpansion: false }))
      .toThrow(/expands frozen TaskSpec scope/);

    const decision = validateRecoveryScope({ ...common, allowScopeExpansion: true });
    expect(decision).toEqual({
      requiresDecision: true,
      expandedFiles: ['tests/a.test.ts'],
      lockPaths: ['src/a.ts', 'tests/a.test.ts'],
    });
  });

  it('keeps project and task forbidden paths as hard recovery boundaries', () => {
    const base = {
      estimatedWritePaths: ['src/a.ts'],
      taskAllowedPaths: ['src/'],
      projectAllowedPaths: ['src/', 'tests/'],
      projectForbiddenPaths: ['verification/'],
      sharedLocks: [],
      repositoryRoot: dir,
      allowScopeExpansion: true,
    };
    expect(() => validateRecoveryScope({
      ...base, changedFiles: ['verification/private.txt'], taskForbiddenPaths: [],
    })).toThrow(/project scope validation failed/);
    expect(() => validateRecoveryScope({
      ...base, changedFiles: ['src/private/key.ts'], taskForbiddenPaths: ['src/private/'],
    })).toThrow(/project scope validation failed/);
  });

  it('fails closed for legacy recovery context without provenance and does not change database bytes', () => {
    const legacyPath = path.join(dir, 'legacy.db');
    const legacyStore = SqliteStateStore.create(legacyPath);
    const legacy = legacyStore.getDatabase();
    legacy.exec(`
      CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, name TEXT, filename TEXT, checksum TEXT, applied_at TEXT);
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT, project_root TEXT, execution_config_snapshot TEXT);
      CREATE TABLE stages (id TEXT PRIMARY KEY, run_id TEXT, status TEXT, base_commit TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, status TEXT, spec_json TEXT);
      CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT, stage_id TEXT, attempt_number INTEGER, status TEXT, worktree_path TEXT, branch_name TEXT);
    `);
    legacy.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run('legacy-run', 'running', dir, null);
    legacy.prepare('INSERT INTO stages VALUES (?, ?, ?, ?)').run('legacy-stage', 'legacy-run', 'paused', 'base');
    legacy.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run('legacy-task', 'legacy-run', 'waiting_decision', JSON.stringify({ allowedPaths: ['src/'] }));
    legacy.prepare('INSERT INTO task_attempts VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy-attempt', 'legacy-task', 'legacy-stage', 3, 'failed', dir, 'recovery/a');
    legacyStore.getDatabase().close();

    const before = createHash('sha256').update(readFileSync(legacyPath)).digest('hex');
    expect(() => readRecoveryContextReadOnly(legacyPath, 'legacy-attempt')).toThrow(/provenance missing/);
    const after = createHash('sha256').update(readFileSync(legacyPath)).digest('hex');
    expect(after).toBe(before);
  });

  it('rejects another branch or worktree impersonating the attempt', async () => {
    expect(() => adoptRecoveryAtomically(store, {
      runId: 'r', stageId: 's', taskId: 't', attemptId: 'a', worktree: dir, branch: 'recovery/forged',
      commit: 'abc123', source: 'manual', changedFiles: ['src/a.ts'], lockPaths: ['src/a.ts'],
      workerResult: { taskId: 't', status: 'completed', summary: 'forged', filesChanged: ['src/a.ts'], commitHash: 'abc123', checks: [], scopeViolations: [], risks: [], unresolvedQuestions: [], productDecisionRequired: false, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 } },
      decisionNote: null,
    })).toThrow(/immutable attempt provenance/);
    expect(await store.getAttempt('a')).toMatchObject({ status: 'failed', adoptedCommit: null });
    expect(await store.listActualPathClaims('s')).toHaveLength(0);
  });

  it('rolls back adoption if state changed after read-only validation', async () => {
    expect(() => adoptRecoveryAtomically(store, {
      runId: 'r', stageId: 's', taskId: 't', attemptId: 'a', worktree: dir, branch: 'recovery/a',
      commit: 'abc123', source: 'manual', changedFiles: ['src/a.ts'], lockPaths: ['src/a.ts'],
      workerResult: { taskId: 't', status: 'completed', summary: 'adopted', filesChanged: ['src/a.ts'], commitHash: 'abc123', checks: [], scopeViolations: [], risks: [], unresolvedQuestions: [], productDecisionRequired: false, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 } },
      decisionNote: null,
      expectedState: { runStatus: 'running', stageStatus: 'paused', taskStatus: 'failed', attemptStatus: 'failed' },
    })).toThrow(/recovery state changed after read-only validation/);
    expect(await store.getAttempt('a')).toMatchObject({ status: 'failed', adoptedCommit: null });
    expect(await store.listEvents('r', 'recovery_adopted')).toHaveLength(0);
  });

  it('rejects adoption of a stale attempt after a newer attempt exists', async () => {
    await store.createAttempt({ id: 'a2', taskId: 't', stageId: 's', attemptNumber: 2, status: 'failed' });

    expect(() => adoptRecoveryAtomically(store, {
      runId: 'r', stageId: 's', taskId: 't', attemptId: 'a', worktree: dir, branch: 'recovery/a',
      commit: 'abc123', source: 'manual', changedFiles: ['src/a.ts'], lockPaths: ['src/a.ts'],
      workerResult: { taskId: 't', status: 'completed', summary: 'adopted', filesChanged: ['src/a.ts'], commitHash: 'abc123', checks: [], scopeViolations: [], risks: [], unresolvedQuestions: [], productDecisionRequired: false, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 } },
      decisionNote: null,
    })).toThrow(/no longer latest/);
    expect(await store.getAttempt('a')).toMatchObject({ status: 'failed', adoptedCommit: null });
    expect(await store.getActiveLocksForRun('r')).toHaveLength(0);
    expect(await store.listEvents('r', 'recovery_adopted')).toHaveLength(0);
  });
});
