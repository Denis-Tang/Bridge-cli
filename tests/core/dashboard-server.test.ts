import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDashboardServer } from '../../src/core/dashboard-server.js';
import { FakeResourceSampler } from '../../src/core/resource-sampler.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

describe('read-only dashboard server', () => {
  it('serves the UI and status API while rejecting writes', async () => {
    const root = join(tmpdir(), `bridge-dashboard-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, 'state.db');
    const writerStore = SqliteStateStore.create(dbPath);
    new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, writerStore.getDatabase()).applyPending();
    await writerStore.createRun({
      id: 'run-dashboard', projectId: 'project', projectRoot: root, requestText: 'dashboard test',
      status: 'planning', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const readonlyStore = SqliteStateStore.openReadonly(dbPath, { busyTimeoutMs: 1000 });
    const server: Server = createDashboardServer({ store: readonlyStore, sampler: new FakeResourceSampler(), userMaxParallel: 4 });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    cleanup.push(async () => {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await readonlyStore.close();
      await writerStore.close();
      rmSync(root, { recursive: true, force: true });
    });
    const port = (server.address() as AddressInfo).port;

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(html).toContain('Bridge 只读状态台');
    expect(html).toContain('data-copy');
    expect(html).not.toContain('<form');

    const api = await (await fetch(`http://127.0.0.1:${port}/api/status?runId=run-dashboard`)).json() as any;
    expect(api.runs[0].id).toBe('run-dashboard');

    const parallelReads = Array.from({ length: 4 }, async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/status?runId=run-dashboard`);
      expect(response.status).toBe(200);
      return response.json();
    });
    await Promise.all([
      writerStore.updateRunStatus('run-dashboard', 'running', new Date().toISOString()),
      ...parallelReads,
    ]);
    const afterWrite = await (await fetch(`http://127.0.0.1:${port}/api/status?runId=run-dashboard`)).json() as any;
    expect(afterWrite.runs[0].status).toBe('running');

    const writeResponse = await fetch(`http://127.0.0.1:${port}/api/status`, { method: 'POST' });
    expect(writeResponse.status).toBe(405);
  });
});
