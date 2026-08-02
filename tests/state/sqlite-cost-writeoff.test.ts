// ── R2: unavailable cost reservation write-off (store layer) ──────────────
// Red-light tests first. Covers: write-off only accepts 'unavailable',
// --decision-note fail-closed, remaining recovers, written_off is distinct
// from released, and the stale-reclaimer evidence standard is NOT relaxed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';

describe('R2 cost reservation write-off', () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeEach(() => {
    dir = path.join(tmpdir(), `bridge-writeoff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    dbPath = path.join(dir, 'state.db');
    store = SqliteStateStore.create(dbPath);
    new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedRun(runId = 'run-w'): Promise<string> {
    const now = new Date().toISOString();
    await store.createRun({ id: runId, projectId: 'p', projectRoot: dir, requestText: 'x', status: 'running', createdAt: now, updatedAt: now });
    return runId;
  }

  async function makeUnavailable(id: string, runId: string, reservedCost: number, budgetLimit: number): Promise<void> {
    const now = new Date().toISOString();
    const r = await store.reserveCost({
      id, runId, callType: 'pi_worker', callId: id, currency: 'CNY',
      budgetLimit, reservedCost, pricingVersion: 'test-v1',
      heartbeatAt: now, leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(r.allowed).toBe(true);
    expect(await store.settleCostReservation(id, null)).toBe(true); // → unavailable
  }

  it('T4: write-off rejects reserved and spawned reservations (amount unchanged)', async () => {
    const runId = await seedRun();
    const now = new Date().toISOString();
    await store.reserveCost({
      id: 'r1', runId, callType: 'pi_worker', callId: 'r1', currency: 'CNY',
      budgetLimit: 50, reservedCost: 10, pricingVersion: 'test-v1', heartbeatAt: now,
    });
    // reserved: refuse
    expect(await store.writeOffCostReservation({ id: 'r1', decisionNote: 'x' })).toBe(false);
    let [row] = await store.listCostReservations(runId);
    expect(row.status).toBe('reserved');
    expect(row.reservedCost).toBe(10);

    // spawned: refuse
    await store.markCostReservationSpawned('r1', 'owner', new Date().toISOString());
    expect(await store.writeOffCostReservation({ id: 'r1', decisionNote: 'x' })).toBe(false);
    [row] = await store.listCostReservations(runId);
    expect(row.status).toBe('reserved');
    expect(row.phase).toBe('spawned');
    expect(row.reservedCost).toBe(10);
  });

  it('T5: write-off without a decision note fails closed (throws, status unchanged)', async () => {
    const runId = await seedRun();
    await makeUnavailable('u1', runId, 8, 50);
    await expect(store.writeOffCostReservation({ id: 'u1', decisionNote: '   ' }))
      .rejects.toThrow(/decision-note/i);
    const [row] = await store.listCostReservations(runId);
    expect(row.status).toBe('unavailable');
  });

  it('T6: write-off recovers remaining budget and is a DISTINCT terminal status from released', async () => {
    const runId = await seedRun();
    await makeUnavailable('u1', runId, 12, 20); // committed 12, remaining 8

    // Before write-off: 10 cannot be reserved (only 8 left).
    const denied = await store.reserveCost({
      id: 'blocked', runId, callType: 'pi_worker', callId: 'blocked', currency: 'CNY',
      budgetLimit: 20, reservedCost: 10, pricingVersion: 'test-v1',
    });
    expect(denied.allowed).toBe(false);

    // Write off u1 → 12 returns to the pool.
    expect(await store.writeOffCostReservation({ id: 'u1', decisionNote: 'manual audit decision' })).toBe(true);
    const allowed = await store.reserveCost({
      id: 'now-ok', runId, callType: 'pi_worker', callId: 'now-ok', currency: 'CNY',
      budgetLimit: 20, reservedCost: 10, pricingVersion: 'test-v1',
    });
    expect(allowed.allowed).toBe(true);

    // Distinguishable from released: released has termination evidence proving
    // no money spent; written_off must NOT look like released.
    const [u1] = (await store.listCostReservations(runId)).filter((x) => x.id === 'u1');
    expect(u1.status).toBe('written_off');
    expect(u1.phase).toBe('settled');
    expect(u1.terminationEvidence).toContain('write_off');
    // Audit event carries amount + note + time.
    const events = await store.listEvents(runId, 'cost_reservation_written_off');
    expect(events.length).toBeGreaterThan(0);
    const ev = events[0];
    expect(ev.eventDataJson).toContain('manual audit decision');
    expect(ev.eventDataJson).toContain('12');
  });

  it('T7 (regression guard): stale reclaimer does NOT auto-release a spawned reservation — spawned_at != null stays unavailable', async () => {
    const runId = await seedRun('run-g7');
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    await store.createStage({ id: 's-g7', runId, stageNumber: 1, title: 's', status: 'running' });
    await store.createTask({ id: 't-g7', runId, title: 't', status: 'running', specJson: {}, createdAt: now, updatedAt: now });
    await store.createAttempt({ id: 'a-g7', taskId: 't-g7', stageId: 's-g7', attemptNumber: 1, status: 'failed' });
    const r = await store.reserveCost({
      id: 'g7', runId, stageId: 's-g7', taskId: 't-g7', attemptId: 'a-g7',
      callType: 'pi_worker', callId: 'g7', currency: 'CNY', budgetLimit: 50, reservedCost: 6,
      pricingVersion: 'test-v1', ownerId: 'run-g7:a-g7', heartbeatAt: now, leaseExpiresAt: past,
    });
    expect(r.allowed).toBe(true);
    // spawned (money may have been spent; PID alone is not proof of non-spend)
    expect(await store.markCostReservationSpawned('g7', 'run-g7:a-g7', now)).toBe(true);

    const settled = await store.reconcileStaleCostReservations(runId, new Date().toISOString());
    expect(settled).toBe(1);
    const [row] = await store.listCostReservations(runId);
    expect(row.status).toBe('unavailable'); // NOT auto-released
    expect(row.phase).toBe('settled');
  });
});

describe('B guard probe cache (014)', () => {
  let dir2: string;
  let store2: SqliteStateStore;
  beforeEach(() => {
    dir2 = path.join(tmpdir(), `bridge-probecache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir2, { recursive: true });
    store2 = SqliteStateStore.create(path.join(dir2, 'state.db'));
    new SqliteMigrationRunner({ path: path.join(dir2, 'state.db'), maskedPath: path.join(dir2, 'state.db') }, store2.getDatabase()).applyPending();
  });
  afterEach(async () => {
    await store2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
  it('persists and updates the block-probe cache keyed by full Pi version', async () => {
    const now = new Date().toISOString();
    expect(await store2.getGuardProbeCache('0.82.1')).toBeNull();
    await store2.setGuardProbeCache('0.82.1', 'pass', null, now);
    const row = await store2.getGuardProbeCache('0.82.1');
    expect(row?.outcome).toBe('pass');
    expect(row?.checkedAt).toBe(now);
    // Update overwrites (upsert)
    await store2.setGuardProbeCache('0.82.1', 'guard_ineffective', 'guard_ineffective', now);
    expect((await store2.getGuardProbeCache('0.82.1'))?.outcome).toBe('guard_ineffective');
    // Distinct versions are independent keys
    expect(await store2.getGuardProbeCache('9.9.9')).toBeNull();
  });
});
