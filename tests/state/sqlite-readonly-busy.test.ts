import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function waitFor(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes(marker)) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => { if (!output.includes(marker)) reject(new Error(`lock child exited ${code}`)); });
  });
}

async function waitExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`)));
  });
}

function holdWriteLock(dbPath: string, holdMs: number): ChildProcessWithoutNullStreams {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('READY\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[2]));
  `;
  return spawn(process.execPath, ['-e', script, dbPath, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
}

async function seededDb(): Promise<{ root: string; dbPath: string }> {
  const root = join(tmpdir(), `bridge-sqlite-ro-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, 'state.sqlite');
  const store = SqliteStateStore.create(dbPath);
  new SqliteMigrationRunner({ path: dbPath }, store.getDatabase()).applyPending();
  const now = new Date().toISOString();
  await store.createRun({ id: 'run-ro', projectId: 'p', projectRoot: root, requestText: 'readonly', status: 'planning', createdAt: now, updatedAt: now });
  await store.close();
  return { root, dbPath };
}

describe('SQLite read-only and busy timeout boundaries', () => {
  it('opens a query-only store without changing DB bytes or sidecar set', async () => {
    const { root, dbPath } = await seededDb();
    const beforeFiles = readdirSync(root).sort();
    const before = new Map(beforeFiles.map((name) => [name, digest(join(root, name))]));

    const readonly = SqliteStateStore.openReadonly(dbPath, { busyTimeoutMs: 100 });
    expect((await readonly.getRun('run-ro'))?.id).toBe('run-ro');
    await expect((readonly as any).updateRunStatus('run-ro', 'running', new Date().toISOString()))
      .rejects.toThrow(/read.?only|SQLITE_READONLY/i);
    await readonly.close();

    expect(readdirSync(root).sort()).toEqual(beforeFiles);
    for (const [name, hash] of before) expect(digest(join(root, name))).toBe(hash);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('waits through a short write lock and classifies a lock beyond timeout', async () => {
    const { dbPath } = await seededDb();
    const contender = SqliteStateStore.create(dbPath, null, { busyTimeoutMs: 1_000 });
    const shortLock = holdWriteLock(dbPath, 150);
    await waitFor(shortLock, 'READY');
    const started = Date.now();
    await expect(contender.updateRunStatus('run-ro', 'running', new Date().toISOString())).resolves.toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    await waitExit(shortLock);
    await contender.close();

    const impatient = SqliteStateStore.create(dbPath, null, { busyTimeoutMs: 40 });
    const longLock = holdWriteLock(dbPath, 300);
    await waitFor(longLock, 'READY');
    await expect(impatient.updateRunStatus('run-ro', 'waiting_decision', new Date().toISOString()))
      .rejects.toThrow(/busy|locked|SQLITE_BUSY/i);
    await waitExit(longLock);
    await impatient.close();
  });
});
