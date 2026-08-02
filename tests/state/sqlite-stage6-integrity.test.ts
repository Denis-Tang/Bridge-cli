import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { StructuredTaskSpec } from '../../src/types/m2-types.js';

function spec(taskId: string, estimatedWritePaths: string[], dependencies: string[] = []): StructuredTaskSpec {
  return {
    taskId, stageNumber: 1, title: taskId, goal: taskId, dependencies, estimatedWritePaths,
    allowedPaths: ['src/', 'docs/'], forbiddenPaths: [], contextFiles: [], acceptanceChecks: [],
    allowedCommands: [], riskLevel: 'low', productDecisionsLocked: true, expectedOutputs: [],
    heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
  };
}

describe('Stage 6 SQLite actual path claims and immutable provenance', () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(async () => {
    dir = path.join(tmpdir(), `bridge-stage6-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = path.join(dir, 'state.db');
    store = SqliteStateStore.create(dbPath);
    new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
    const now = new Date().toISOString();
    await store.createRun({ id: 'r', projectId: 'p', projectRoot: dir, requestText: 'x', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: 's', runId: 'r', stageNumber: 1, title: 's', status: 'running' });
    const specs = [
      spec('t1', ['src/a.ts']), spec('t2', ['docs/b.ts']),
      spec('t3', ['src/c.ts']), spec('t4', ['docs/d.ts']),
      spec('t5', ['src/serial/']), spec('t6', ['src/serial/file.ts'], ['t5']),
    ];
    for (const task of specs) {
      await store.createTask({ id: task.taskId, runId: 'r', title: task.title, status: 'running', specJson: task, createdAt: now, updatedAt: now });
      await store.createAttempt({ id: `a-${task.taskId}`, taskId: task.taskId, stageId: 's', attemptNumber: 1, status: 'worker_completed' });
    }
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks undeclared same-file and parent/child actual writes while leaving disjoint writes concurrent', async () => {
    expect((await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't1', attemptId: 'a-t1', filePaths: ['src/shared.ts'] })).claimed).toBe(true);
    const sameFile = await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't2', attemptId: 'a-t2', filePaths: ['SRC\\shared.ts'] });
    expect(sameFile).toMatchObject({ claimed: false, conflicts: [{ conflictingTaskId: 't1', conflictLayer: 'actual' }] });

    expect((await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't3', attemptId: 'a-t3', filePaths: ['docs/tree'] })).claimed).toBe(true);
    const parentChild = await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't4', attemptId: 'a-t4', filePaths: ['docs/tree/file.md'] });
    expect(parentChild.claimed).toBe(false);
    expect(parentChild.conflicts.some((conflict) => conflict.conflictLayer === 'actual')).toBe(true);

    const claims = await store.listActualPathClaims('s');
    expect(claims.map((claim) => claim.taskId).sort()).toEqual(['t1', 't3']);
  });

  it('allows verified serial ownership and keeps claims until explicit stage release', async () => {
    expect((await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't5', attemptId: 'a-t5', filePaths: ['src/serial/a.ts'] })).claimed).toBe(true);
    expect((await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't6', attemptId: 'a-t6', filePaths: ['src/serial/a.ts'] })).claimed).toBe(true);
    expect((await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't6', attemptId: 'a-t6', filePaths: ['src/serial/a.ts'] })).claimed).toBe(true);

    expect(await store.releaseActualPathClaimsForStage('s', '2026-08-02T00:00:00.000Z')).toBe(2);
    expect((await store.listActualPathClaims('s')).every((claim) => claim.releasedAt !== null)).toBe(true);
  });

  it('rejects an actual write that overlaps another task estimated scope even when both are allowed', async () => {
    const result = await store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't2', attemptId: 'a-t2', filePaths: ['src/a.ts'] });
    expect(result).toMatchObject({ claimed: false, conflicts: [{ conflictingTaskId: 't1', conflictLayer: 'estimated' }] });
  });

  it('persists provenance idempotently and rejects any identity rewrite', async () => {
    const input = {
      attemptId: 'a-t1', runId: 'r', stageId: 's', taskId: 't1', baseCommit: 'a'.repeat(40),
      expectedBranch: 'brainctl/r/t1/a1', expectedWorktree: path.join(dir, 'wt'),
      taskPacketHash: 'b'.repeat(64), implementationPromptHash: 'c'.repeat(64),
      workerId: 'bc-a-t1', sessionId: 'r:a-t1',
    };
    const first = await store.recordAttemptProvenance(input);
    const second = await store.recordAttemptProvenance(input);
    expect(second).toEqual(first);
    await expect(store.recordAttemptProvenance({ ...input, expectedBranch: 'brainctl/forged' }))
      .rejects.toThrow(/provenance mismatch/);
    expect(await store.getAttemptProvenance('a-t1')).toMatchObject(input);
  });

  it('serializes concurrent claim writers so exactly one conflicting owner wins', async () => {
    const contender = SqliteStateStore.create(dbPath);
    try {
      const [first, second] = await Promise.all([
        store.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't1', attemptId: 'a-t1', filePaths: ['docs/concurrent.md'] }),
        contender.claimActualPathsAtomic({ runId: 'r', stageId: 's', taskId: 't2', attemptId: 'a-t2', filePaths: ['docs/concurrent.md'] }),
      ]);
      expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1);
      expect([first, second].find((result) => !result.claimed)?.conflicts.some((conflict) => conflict.conflictLayer === 'actual')).toBe(true);
    } finally {
      await contender.close();
    }
  });
});
