import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAutomaticReconciliation } from '../../src/cli/commands/reconcile.js';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';

describe('009 cost and review integrity', () => {
  let dir: string;
  let store: SqliteStateStore;

  beforeAll(async () => {
    dir = path.join(tmpdir(), `brainctl-cost-integrity-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'state.db');
    store = SqliteStateStore.create(dbPath);
    new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
    const now = new Date().toISOString();
    await store.createRun({ id: 'run-cost', projectId: 'p', projectRoot: dir, requestText: 'test', status: 'planning', createdAt: now, updatedAt: now });
  });

  afterAll(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds recovery provenance and review coverage columns', () => {
    const columns = (table: string) => (store.getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns('task_attempts')).toEqual(expect.arrayContaining(['result_source', 'adopted_commit', 'adoption_metadata_json']));
    expect(columns('reviews')).toEqual(expect.arrayContaining(['reviewed_through_commit', 'final_commit', 'coverage_status', 'reviewer_unavailable', 'stderr_hash']));
    expect(columns('integration_batches')).toEqual(expect.arrayContaining(['reviewed_through_commit', 'final_commit', 'review_coverage_status']));
  });

  it('atomically refuses a reservation beyond the run budget', async () => {
    const first = await store.reserveCost({
      id: 'cost-1', runId: 'run-cost', callType: 'pi_worker', callId: 'call-1',
      currency: 'CNY', budgetLimit: 20, reservedCost: 12, pricingVersion: 'test-v1',
    });
    const second = await store.reserveCost({
      id: 'cost-2', runId: 'run-cost', callType: 'codex_review', callId: 'call-2',
      currency: 'CNY', budgetLimit: 20, reservedCost: 9, pricingVersion: 'test-v1',
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(8);
    expect(await store.listCostReservations('run-cost')).toHaveLength(1);
  });

  it('keeps the worst-case reservation when provider money usage is unavailable', async () => {
    await store.settleCostReservation('cost-1', null);
    const [entry] = await store.listCostReservations('run-cost');
    expect(entry.status).toBe('unavailable');
    expect(entry.usageStatus).toBe('unavailable');
    expect(entry.reservedCost).toBe(12);
    expect(entry.actualCost).toBeNull();
  });

  it('records a trusted over-reservation actual and blocks every later call', async () => {
    const now = new Date().toISOString();
    await store.createRun({ id: 'run-overrun', projectId: 'p', projectRoot: dir, requestText: 'test', status: 'running', createdAt: now, updatedAt: now });
    const reserved = await store.reserveCost({
      id: 'cost-overrun-1', runId: 'run-overrun', callType: 'pi_worker', callId: 'call-overrun-1',
      currency: 'CNY', budgetLimit: 20, reservedCost: 10, pricingVersion: 'test-v1',
    });
    expect(reserved.allowed).toBe(true);
    await store.settleCostReservation('cost-overrun-1', 25);

    const denied = await store.reserveCost({
      id: 'cost-overrun-2', runId: 'run-overrun', callType: 'codex_review', callId: 'call-overrun-2',
      currency: 'CNY', budgetLimit: 20, reservedCost: 1, pricingVersion: 'test-v1',
    });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect((await store.listCostReservations('run-overrun'))[0]).toMatchObject({ status: 'confirmed', actualCost: 25 });
  });

  it('rejects invalid trusted actual-cost values', async () => {
    await expect(store.settleCostReservation('cost-1', -1)).rejects.toThrow('finite non-negative');
    await expect(store.settleCostReservation('cost-1', Number.NaN)).rejects.toThrow('finite non-negative');
  });

  it('releases only a reservation proven never spawned and records lifecycle evidence', async () => {
    const reserved = await store.reserveCost({
      id: 'cost-never-spawned', runId: 'run-cost', callType: 'pi_worker', callId: 'call-never-spawned',
      currency: 'CNY', budgetLimit: 40, reservedCost: 5, pricingVersion: 'test-v1', ownerId: 'owner-a',
    });
    expect(reserved.allowed).toBe(true);
    await expect(store.finalizeCostReservation({
      id: 'cost-never-spawned', outcome: 'released', ownerId: 'owner-a',
      terminationEvidence: 'prompt_build_failed_before_spawn',
    })).resolves.toBe(true);
    expect((await store.listCostReservations('run-cost')).find((entry) => entry.id === 'cost-never-spawned'))
      .toMatchObject({ status: 'released', phase: 'settled', spawnedAt: null });
  });

  it('never releases after spawn evidence and concurrent settlement consumes the reservation once', async () => {
    const reserved = await store.reserveCost({
      id: 'cost-spawned', runId: 'run-cost', callType: 'codex_review', callId: 'call-spawned',
      currency: 'CNY', budgetLimit: 40, reservedCost: 5, pricingVersion: 'test-v1', ownerId: 'owner-b',
    });
    expect(reserved.allowed).toBe(true);
    expect(await store.markCostReservationSpawned('cost-spawned', 'owner-b', new Date().toISOString())).toBe(true);
    await expect(store.finalizeCostReservation({
      id: 'cost-spawned', outcome: 'released', ownerId: 'owner-b', terminationEvidence: 'runner_failed',
    })).resolves.toBe(false);

    const results = await Promise.all([
      store.finalizeCostReservation({ id: 'cost-spawned', outcome: 'unavailable', ownerId: 'owner-b', terminationEvidence: 'runner_failed_after_spawn' }),
      store.finalizeCostReservation({ id: 'cost-spawned', outcome: 'unavailable', ownerId: 'owner-b', terminationEvidence: 'duplicate_reconcile' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.listCostReservations('run-cost')).find((entry) => entry.id === 'cost-spawned'))
      .toMatchObject({ status: 'unavailable', phase: 'settled' });
    const events = await store.listEvents('run-cost', 'cost_reservation_settled');
    expect(events.filter((event) => event.eventDataJson?.includes('cost-spawned'))).toHaveLength(1);
  });

  it('reconciles expired leases through the automatic CLI path conservatively and idempotently', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const reserved = await store.reserveCost({
      id: 'cost-stale-unknown', runId: 'run-cost', callType: 'pi_worker', callId: 'call-stale',
      currency: 'CNY', budgetLimit: 60, reservedCost: 3, pricingVersion: 'test-v1',
      ownerId: 'owner-stale', leaseExpiresAt: past,
    });
    expect(reserved.allowed).toBe(true);
    expect((await runAutomaticReconciliation(store, 'run-cost')).appliedCount).toBe(1);
    expect((await store.listCostReservations('run-cost')).find((entry) => entry.id === 'cost-stale-unknown'))
      .toMatchObject({ status: 'unavailable', terminationEvidence: 'expired_lease_spawn_or_owner_state_unknown' });
    expect((await runAutomaticReconciliation(store, 'run-cost')).appliedCount).toBe(0);
  });

  it('persists final integrated-tree review coverage', async () => {
    await store.createStage({ id: 'stage-review', runId: 'run-cost', stageNumber: 1, title: 'review', status: 'integration' });
    const batch = await store.createIntegrationBatch({ id: 'batch-review', stageId: 'stage-review', runId: 'run-cost', integrationBranch: 'brainctl/int/review' });
    await store.updateIntegrationBatch(batch.id, {
      reviewedThroughCommit: 'integration-commit', finalCommit: 'target-merge-commit',
      reviewCoverageStatus: 'complete', reviewerUnavailable: false,
      reviewMetadataJson: JSON.stringify({ reviewer: 'codex-cli' }),
    });
    expect(await store.getIntegrationBatch(batch.id)).toMatchObject({
      reviewedThroughCommit: 'integration-commit', finalCommit: 'target-merge-commit',
      reviewCoverageStatus: 'complete', reviewerUnavailable: false,
    });
  });
});
