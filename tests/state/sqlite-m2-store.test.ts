import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { readSqliteConfigFromEnv } from '../../src/state/sqlite-config.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('SqliteM2Store', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m2-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'test-m2.db');
    store = SqliteStateStore.create(dbPath);
    const config = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  async function createTestRun(runId = 'm2-test-run') {
    return store.createRun({
      id: runId, projectId: 'proj-m2', projectRoot: '/tmp/m2-project',
      requestText: 'M2 test request', status: 'planning',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }

  describe('Stage CRUD', () => {
    it('creates and retrieves a stage', async () => {
      await createTestRun('stage-test-run');
      const stage = await store.createStage({
        id: 'stage-001', runId: 'stage-test-run', stageNumber: 1, title: 'Setup',
      });
      expect(stage.id).toBe('stage-001');
      expect(stage.stageNumber).toBe(1);
      expect(stage.status).toBe('pending');
      const fetched = await store.getStage('stage-001');
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('Setup');
    });

    it('lists stages for a run ordered', async () => {
      await createTestRun('stage-list-run');
      await store.createStage({ id: 'sl-1', runId: 'stage-list-run', stageNumber: 1, title: 'P1' });
      await store.createStage({ id: 'sl-2', runId: 'stage-list-run', stageNumber: 2, title: 'P2' });
      const stages = await store.listStages('stage-list-run');
      expect(stages.length).toBe(2);
      expect(stages[0].stageNumber).toBe(1);
      expect(stages[1].stageNumber).toBe(2);
    });
  });

  describe('Attempt CRUD', () => {
    it('creates and updates attempt result', async () => {
      await createTestRun('att-run');
      await store.createStage({ id: 'att-stage', runId: 'att-run', stageNumber: 1, title: 'S1' });
      await store.createTask({
        id: 'att-task', runId: 'att-run', title: 'T1',
        status: 'ready', specJson: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      const attempt = await store.createAttempt({ id: 'att-1', taskId: 'att-task', stageId: 'att-stage', attemptNumber: 1 });
      expect(attempt.status).toBe('pending');

      await store.updateAttemptResult('att-1', { piPid: 12345, exitReason: 'ok' });
      const fetched = await store.getAttempt('att-1');
      expect(fetched!.piPid).toBe(12345);
      expect(fetched!.exitReason).toBe('ok');
    });

    it('gets latest attempt for task', async () => {
      await createTestRun('att-latest');
      await store.createStage({ id: 'lt-stage', runId: 'att-latest', stageNumber: 1, title: 'S1' });
      await store.createTask({
        id: 'lt-task', runId: 'att-latest', title: 'T1',
        status: 'ready', specJson: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await store.createAttempt({ id: 'lt-1', taskId: 'lt-task', stageId: 'lt-stage', attemptNumber: 1 });
      await store.createAttempt({ id: 'lt-2', taskId: 'lt-task', stageId: 'lt-stage', attemptNumber: 2 });
      const latest = await store.getLatestAttempt('lt-task');
      expect(latest!.attemptNumber).toBe(2);
    });
  });

  describe('Path Locks', () => {
    it('creates and detects conflicting locks', async () => {
      await createTestRun('lock-run');
      await store.createStage({ id: 'lk-stage', runId: 'lock-run', stageNumber: 1, title: 'S1' });
      await store.createTask({ id: 'lk-t1', runId: 'lock-run', title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await store.createTask({ id: 'lk-t2', runId: 'lock-run', title: 'T2', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      await store.createPathLock({ id: 'lk-1', runId: 'lock-run', taskId: 'lk-t1', filePath: 'package.json' });
      const conflicts = await store.getConflictingLocks('lk-t2', ['package.json'], 'lock-run');
      expect(conflicts.length).toBe(1);
      expect(conflicts[0].taskId).toBe('lk-t1');

      await store.releasePathLock('lk-1', new Date().toISOString());
      const conflictsAfter = await store.getConflictingLocks('lk-t2', ['package.json'], 'lock-run');
      expect(conflictsAfter.length).toBe(0);
    });

    it('LOCK-01 blocks two tasks for the same file', async () => {
      await createTestRun('lock-same-file-run');
      await store.createStage({ id: 'lk-same-stage', runId: 'lock-same-file-run', stageNumber: 1, title: 'S1' });
      await store.createTask({ id: 'lk-same-t1', runId: 'lock-same-file-run', title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await store.createTask({ id: 'lk-same-t2', runId: 'lock-same-file-run', title: 'T2', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      const first = await store.acquirePathLocksAtomic({ runId: 'lock-same-file-run', taskId: 'lk-same-t1', filePaths: ['SRC\\A.ts'] });
      const second = await store.acquirePathLocksAtomic({ runId: 'lock-same-file-run', taskId: 'lk-same-t2', filePaths: ['src/a.ts'] });

      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(false);
      expect(second.conflicts).toHaveLength(1);
      expect(second.conflicts[0].taskId).toBe('lk-same-t1');
    });

    it('LOCK-02 treats directory and child file locks as overlapping', async () => {
      await createTestRun('lock-overlap-run');
      await store.createStage({ id: 'lk-overlap-stage', runId: 'lock-overlap-run', stageNumber: 1, title: 'S1' });
      await store.createTask({ id: 'lk-overlap-t1', runId: 'lock-overlap-run', title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await store.createTask({ id: 'lk-overlap-t2', runId: 'lock-overlap-run', title: 'T2', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      expect((await store.acquirePathLocksAtomic({ runId: 'lock-overlap-run', taskId: 'lk-overlap-t1', filePaths: ['src/'] })).acquired).toBe(true);
      const child = await store.acquirePathLocksAtomic({ runId: 'lock-overlap-run', taskId: 'lk-overlap-t2', filePaths: ['src/a.ts'] });

      expect(child.acquired).toBe(false);
      expect(child.conflicts).toHaveLength(1);
    });

    it('LOCK-03 writes no partial locks when a group acquisition fails', async () => {
      await createTestRun('lock-atomic-run');
      await store.createStage({ id: 'lk-atomic-stage', runId: 'lock-atomic-run', stageNumber: 1, title: 'S1' });
      await store.createTask({ id: 'lk-atomic-t1', runId: 'lock-atomic-run', title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await store.createTask({ id: 'lk-atomic-t2', runId: 'lock-atomic-run', title: 'T2', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      await store.acquirePathLocksAtomic({ runId: 'lock-atomic-run', taskId: 'lk-atomic-t1', filePaths: ['src/a.ts'] });
      const failed = await store.acquirePathLocksAtomic({ runId: 'lock-atomic-run', taskId: 'lk-atomic-t2', filePaths: ['docs/readme.md', 'src/a.ts'] });
      const locks = await store.getActiveLocksForRun('lock-atomic-run');

      expect(failed.acquired).toBe(false);
      expect(locks.filter((lock) => lock.taskId === 'lk-atomic-t2')).toHaveLength(0);
    });

    it('rejects unsafe lock paths without writing any lock', async () => {
      await createTestRun('lock-unsafe-run');
      await store.createStage({ id: 'lk-unsafe-stage', runId: 'lock-unsafe-run', stageNumber: 1, title: 'S1' });
      await store.createTask({ id: 'lk-unsafe-t1', runId: 'lock-unsafe-run', title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      const result = await store.acquirePathLocksAtomic({ runId: 'lock-unsafe-run', taskId: 'lk-unsafe-t1', filePaths: ['src/ok.ts', '../escape.ts'] });
      expect(result.acquired).toBe(false);
      expect(result.violations.join('\n')).toContain('.. escape');
      expect(await store.getActiveLocksForRun('lock-unsafe-run')).toHaveLength(0);
    });

    it('LOCK-04 no id collision for paths differing only in non-alphanumeric chars', async () => {
      await createTestRun('lock-collide-run');
      await store.createStage({ id: 'lk-collide-stage', runId: 'lock-collide-run', stageNumber: 1, title: 'S1' });
      await store.createTask({ id: 'lk-collide-t1', runId: 'lock-collide-run', title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      // The old lossy id (`[^a-zA-Z0-9]` -> `_`) collapsed both of these onto
      // one lock row id and silently overwrote the first path's lock.
      const result = await store.acquirePathLocksAtomic({
        runId: 'lock-collide-run', taskId: 'lk-collide-t1',
        filePaths: ['src/api-v2/x', 'src/api_v2/x'],
      });
      expect(result.acquired).toBe(true);
      expect(result.locks).toHaveLength(2);
      expect(new Set(result.locks.map((lock) => lock.id)).size).toBe(2);
      const active = await store.getActiveLocksForRun('lock-collide-run');
      expect(active).toHaveLength(2);
      expect(active.map((lock) => lock.filePath).sort()).toEqual(['src/api-v2/x', 'src/api_v2/x']);
    });

    it('fail-closes on corrupt task spec_json instead of silently degrading', async () => {
      await createTestRun('spec-corrupt-run');
      const tid = 'spec-corrupt-task';
      await store.createTask({ id: tid, runId: 'spec-corrupt-run', title: 'T', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      store.getDatabase().prepare('UPDATE tasks SET spec_json = ? WHERE id = ?').run('{not valid json', tid);
      // One corrupt spec_json must surface loudly (fail closed), never silently
      // degrade to null where `?? []` would disable the allowedPaths guard.
      await expect(store.getTask(tid)).rejects.toThrow(/spec_json/);
    });
  });

  describe('Review CRUD', () => {
    it('creates review and updates result', async () => {
      await createTestRun('rev-run');
      await store.createStage({ id: 'rv-stage', runId: 'rev-run', stageNumber: 1, title: 'S1' });
      await store.createTask({ id: 'rv-task', runId: 'rev-run', title: 'T1', status: 'running', specJson: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      await store.createAttempt({ id: 'rv-att', taskId: 'rv-task', stageId: 'rv-stage', attemptNumber: 1 });

      const review = await store.createReview({ id: 'rv-1', attemptId: 'rv-att', taskId: 'rv-task', reviewerType: 'codex-cli' });
      expect(review.reviewerType).toBe('codex-cli');

      await store.updateReviewResult('rv-1', { status: 'approved', mergeAllowed: true });
      const fetched = await store.getReview('rv-1');
      expect(fetched!.status).toBe('approved');
      expect(fetched!.mergeAllowed).toBe(true);
    });
  });

  describe('Integration Batch', () => {
    it('creates and completes integration', async () => {
      await createTestRun('int-run');
      await store.createStage({ id: 'int-stage', runId: 'int-run', stageNumber: 1, title: 'S1' });
      const batch = await store.createIntegrationBatch({ id: 'int-b1', stageId: 'int-stage', runId: 'int-run', integrationBranch: 'brainctl/int/b1' });
      expect(batch.status).toBe('pending');
      await store.updateIntegrationBatch('int-b1', { status: 'completed', mergeCommitHash: 'abc' });
      const fetched = await store.getIntegrationBatch('int-b1');
      expect(fetched!.status).toBe('completed');
      expect(fetched!.mergeCommitHash).toBe('abc');
    });
  });

  describe('Events', () => {
    it('creates and filters events', async () => {
      await createTestRun('ev-run');
      await store.createEvent({ id: 'ev-1', runId: 'ev-run', eventType: 'run_created', eventData: { msg: 'hi' } });
      await store.createEvent({ id: 'ev-2', runId: 'ev-run', eventType: 'stage_started' });
      const all = await store.listEvents('ev-run');
      expect(all.length).toBe(2);
      const filtered = await store.listEvents('ev-run', 'run_created');
      expect(filtered.length).toBe(1);
      expect(filtered[0].id).toBe('ev-1');
    });
  });

  describe('Active Run Check', () => {
    it('finds active run and ignores completed', async () => {
      await createTestRun('active-test');
      const active = await store.getActiveRunByProject('/tmp/m2-project');
      expect(active).not.toBeNull();
      expect(active!.id).toBe('active-test');

      const inactive = await store.getActiveRunByProject('/tmp/nonexistent');
      expect(inactive).toBeNull();
    });
  });
});
