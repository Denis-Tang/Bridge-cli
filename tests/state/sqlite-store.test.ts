import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('SqliteStateStore', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-sqlite-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'test.db');
    store = SqliteStateStore.create(dbPath);

    // Create tables via raw migration
    const db = store.getDatabase();
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        request_text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        spec_json TEXT,
        branch_name TEXT,
        worktree_path TEXT,
        worker_id TEXT,
        commit_hash TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
    `);
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('createRun / getRun', () => {
    it('creates and retrieves a run', async () => {
      const run = await store.createRun({
        id: 'test-run-001',
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        requestText: 'test request',
        status: 'planning',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      expect(run.id).toBe('test-run-001');
      expect(run.status).toBe('planning');

      const fetched = await store.getRun('test-run-001');
      expect(fetched).not.toBeNull();
      expect(fetched!.projectRoot).toBe('/tmp/project');
    });

    it('returns null for non-existent run', async () => {
      const result = await store.getRun('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('updateRunStatus', () => {
    it('updates status successfully', async () => {
      const run = await store.createRun({
        id: 'test-run-status',
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        requestText: 'status test',
        status: 'planning',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const updated = await store.updateRunStatus('test-run-status', 'running', new Date().toISOString());
      expect(updated).toBe(true);

      const fetched = await store.getRun('test-run-status');
      expect(fetched!.status).toBe('running');
    });

    it('protects terminal status (completed)', async () => {
      const run = await store.createRun({
        id: 'test-run-terminal',
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        requestText: 'terminal test',
        status: 'completed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await store.updateRunStatus('test-run-terminal', 'running', new Date().toISOString());
      expect(result).toBe(false);
    });

    it('protects terminal status (failed)', async () => {
      const run = await store.createRun({
        id: 'test-run-failed',
        projectId: 'proj-1',
        projectRoot: '/tmp/project',
        requestText: 'failed test',
        status: 'failed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await store.updateRunStatus('test-run-failed', 'running', new Date().toISOString());
      expect(result).toBe(false);
    });
  });

  describe('createTask / getTask / listTasks', () => {
    it('creates and retrieves a task', async () => {
      const task = await store.createTask({
        id: 'test-task-001',
        runId: 'test-run-001',
        title: 'test task',
        status: 'pending',
        specJson: { action: 'edit', file: 'test.txt' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      expect(task.id).toBe('test-task-001');
      expect(task.title).toBe('test task');

      const fetched = await store.getTask('test-task-001');
      expect(fetched).not.toBeNull();
      expect(fetched!.specJson).toEqual({ action: 'edit', file: 'test.txt' });
    });

    it('lists tasks for a run', async () => {
      const runId = 'test-run-list';

      // Create parent run first (required by FOREIGN KEY)
      await store.createRun({
        id: runId,
        projectId: 'proj-list',
        projectRoot: '/tmp/list',
        requestText: 'list test',
        status: 'planning',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await store.createTask({
        id: 'task-list-1', runId, title: 'task 1',
        status: 'pending', specJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await store.createTask({
        id: 'task-list-2', runId, title: 'task 2',
        status: 'running', specJson: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const tasks = await store.listTasks(runId);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      expect(tasks.some((t) => t.id === 'task-list-1')).toBe(true);
      expect(tasks.some((t) => t.id === 'task-list-2')).toBe(true);
    });

    it('returns null for non-existent task', async () => {
      const result = await store.getTask('non-existent');
      expect(result).toBeNull();
    });
  });
});
