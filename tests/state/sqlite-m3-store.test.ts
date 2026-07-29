import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('SqliteM3Store', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m3-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'test-m3.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('resource_samples', () => {
    it('inserts and retrieves a resource sample', async () => {
      const sample = await store.insertResourceSample({
        id: 'rs-001',
        runId: null,
        timestamp: new Date().toISOString(),
        cpuPct: 23.5,
        memTotalMb: 16384,
        memUsedMb: 8192,
        memPct: 50.0,
        piActive: 2,
        budget: 3,
        dispatchPaused: 0,
        source: 'os',
      });

      expect(sample.id).toBe('rs-001');
      expect(sample.cpuPct).toBe(23.5);
      expect(sample.memTotalMb).toBe(16384);
      expect(sample.piActive).toBe(2);
      expect(sample.budget).toBe(3);
      expect(sample.degraded).toBe(0);
    });

    it('inserts degraded sample', async () => {
      const sample = await store.insertResourceSample({
        id: 'rs-degraded',
        runId: 'test-run',
        timestamp: new Date().toISOString(),
        cpuPct: 0,
        piActive: 0,
        budget: 1,
        degraded: 1,
        degradeReason: 'tasklist_unavailable;os_cpus_empty',
        source: 'fallback',
      });

      expect(sample.degraded).toBe(1);
      expect(sample.degradeReason).toContain('tasklist_unavailable');
      expect(sample.source).toBe('fallback');
    });

    it('retrieves recent samples in reverse chronological order', async () => {
      // Insert with explicit timestamps to ensure ordering
      await store.insertResourceSample({
        id: 'rs-a', timestamp: '2026-01-01T00:00:00Z', cpuPct: 10, piActive: 0, budget: 3, source: 'os',
      });
      // Small delay to ensure different created_at values
      await new Promise((r) => setTimeout(r, 10));
      await store.insertResourceSample({
        id: 'rs-b', timestamp: '2026-01-02T00:00:00Z', cpuPct: 20, piActive: 1, budget: 2, source: 'cim',
      });
      await new Promise((r) => setTimeout(r, 10));
      await store.insertResourceSample({
        id: 'rs-c', timestamp: '2026-01-03T00:00:00Z', cpuPct: 30, piActive: 2, budget: 1, source: 'tasklist',
      });

      const recent = await store.getRecentResourceSamples(2);
      expect(recent.length).toBe(2);
      expect(recent[0].id).toBe('rs-c'); // newest first
      expect(recent[1].id).toBe('rs-b');
    });

    it('cleans up samples older than retention', async () => {
      // Insert a very old sample
      const db = store.getDatabase();
      db.prepare(
        "INSERT INTO resource_samples (id, timestamp, cpu_pct, pi_active, budget, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('rs-old', '2020-01-01T00:00:00Z', 50, 1, 4, 'os', '2020-01-01T00:00:00Z');

      const deleted = await store.cleanupResourceSamples(7);
      expect(deleted).toBeGreaterThanOrEqual(1);

      // Old sample should be gone
      const recent = await store.getRecentResourceSamples(100);
      expect(recent.find((r) => r.id === 'rs-old')).toBeUndefined();
    });
  });

  describe('dispatch_decisions', () => {
    it('inserts and retrieves a dispatch decision', async () => {
      const d = await store.insertDispatchDecision({
        id: 'dd-001',
        runId: 'test-run',
        timestamp: new Date().toISOString(),
        decisionType: 'scale_down',
        reason: 'cpu_elevated:85%',
        previousBudget: 4,
        newBudget: 2,
        sampleJson: JSON.stringify({ cpu: { usagePercent: 85 } }),
      });

      expect(d.id).toBe('dd-001');
      expect(d.decisionType).toBe('scale_down');
      expect(d.previousBudget).toBe(4);
      expect(d.newBudget).toBe(2);
      expect(d.sampleJson).toContain('usagePercent');
    });

    it('retrieves recent decisions', async () => {
      await store.insertDispatchDecision({
        id: 'dd-a', timestamp: '2026-01-01T00:00:00Z', decisionType: 'pause', reason: 'mem_critical',
        previousBudget: 2, newBudget: 0,
      });
      await new Promise((r) => setTimeout(r, 10));
      await store.insertDispatchDecision({
        id: 'dd-b', timestamp: '2026-01-02T00:00:00Z', decisionType: 'resume', reason: 'recovered',
        previousBudget: 0, newBudget: 4,
      });

      const recent = await store.getRecentDispatchDecisions(1);
      expect(recent.length).toBe(1);
      expect(recent[0].id).toBe('dd-b');
    });
  });
});
