import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';

describe('SQLite state transition CAS and audited exceptions', () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(() => {
    dir = path.join(tmpdir(), `bridge-state-cas-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    dbPath = path.join(dir, 'state.db');
    store = SqliteStateStore.create(dbPath);
    new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedRunTask(taskStatus: 'running' | 'failed' | 'merge_blocked' | 'reviewing' = 'running'): Promise<void> {
    const now = new Date().toISOString();
    await store.createRun({ id: 'r', projectId: 'p', projectRoot: dir, requestText: 'x', status: 'running', createdAt: now, updatedAt: now });
    await store.createStage({ id: 's', runId: 'r', stageNumber: 1, title: 's', status: 'running' });
    await store.createTask({ id: 't', runId: 'r', title: 't', status: taskStatus, specJson: {}, createdAt: now, updatedAt: now });
  }

  it('allows only one competing legal transition from the same old state', async () => {
    await seedRunTask();
    const contender = SqliteStateStore.create(dbPath);
    try {
      const now = new Date().toISOString();
      const results = await Promise.all([
        store.updateTaskStatus('t', 'failed', now),
        contender.updateTaskStatus('t', 'canceled', now),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(['failed', 'canceled']).toContain((await store.getTask('t'))?.status);
    } finally {
      await contender.close();
    }
  });

  it('does not revive a terminal task through the generic update API', async () => {
    await seedRunTask('failed');
    await expect(store.updateTaskStatus('t', 'ready', new Date().toISOString())).resolves.toBe(false);
    expect((await store.getTask('t'))?.status).toBe('failed');
  });

  it('treats merge_blocked as recoverable rather than terminal', async () => {
    await seedRunTask('merge_blocked');
    await expect(store.updateTaskStatus('t', 'approved', new Date().toISOString())).resolves.toBe(true);
    expect((await store.getTask('t'))?.status).toBe('approved');
  });

  it('keeps paused Stage recovery behind the dedicated pause API', async () => {
    await seedRunTask();
    await store.createStagePause({
      id: 'pause-1', eventId: 'pause-event-1', runId: 'r', stageId: 's', reasonCode: 'manual_check', category: 'quality',
      recoverable: true, evidenceSummary: 'hash', createdAt: new Date().toISOString(),
    });
    await expect(store.updateStageStatus('s', 'ready', new Date().toISOString()))
      .rejects.toThrow(/resolveStagePause/);
  });

  it('audits the dedicated review retry transaction', async () => {
    await seedRunTask('reviewing');
    await store.createAttempt({ id: 'a', taskId: 't', stageId: 's', attemptNumber: 1, status: 'reviewing' });
    await expect(store.retryReviewAtomically({
      runId: 'r', stageId: 's', taskId: 't', attemptId: 'a', reason: 'reviewer_unavailable', updatedAt: new Date().toISOString(),
    })).resolves.toBe(true);
    expect((await store.getAttempt('a'))?.status).toBe('worker_completed');
    expect((await store.getTask('t'))?.status).toBe('worker_completed');
    expect(await store.listEvents('r', 'review_retry_scheduled')).toHaveLength(1);
  });

  it('allows completed-to-failed only through the audited convergence transaction', async () => {
    const now = new Date().toISOString();
    await store.createRun({ id: 'done', projectId: 'p', projectRoot: dir, requestText: 'x', status: 'completed', createdAt: now, updatedAt: now });
    await expect(store.updateRunStatus('done', 'failed', now)).resolves.toBe(false);
    await expect(store.failRunForConvergenceAtomically({ runId: 'done', reason: 'late invariant', failedAt: now })).resolves.toBe(true);
    expect((await store.getRun('done'))?.status).toBe('failed');
    const events = await store.listEvents('done', 'run_convergence_failed');
    expect(events).toHaveLength(1);
    expect(events[0]?.eventDataJson).toContain('"terminalOverride":true');
  });
});
