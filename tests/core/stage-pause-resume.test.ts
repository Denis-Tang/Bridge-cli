import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pauseStage, resolveStagePause } from '../../src/core/pause-service.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';

let root: string;
let store: SqliteStateStore;

beforeEach(async () => {
  root = join(tmpdir(), `bridge-stage-pause-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, 'state.sqlite');
  store = SqliteStateStore.create(dbPath);
  new SqliteMigrationRunner({ path: dbPath }, store.getDatabase()).applyPending();
  const now = new Date().toISOString();
  await store.createRun({
    id: 'run-pause', projectId: 'project', projectRoot: root,
    requestText: 'pause test', status: 'running', createdAt: now, updatedAt: now,
  });
  await store.createStage({
    id: 'stage-pause', runId: 'run-pause', stageNumber: 1,
    title: 'Pause stage', status: 'running',
  });
});

afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('persisted Stage pause lifecycle', () => {
  it('atomically records a transient pause and resolves paused -> ready', async () => {
    const pause = await pauseStage(store, {
      id: 'pause-transient', eventId: 'event-pause-transient',
      runId: 'run-pause', stageId: 'stage-pause',
      reasonCode: 'lock_conflict', category: 'transient', recoverable: true,
      evidenceSummary: 'sha256:evidence',
    });

    expect((await store.getStage('stage-pause'))?.status).toBe('paused');
    expect((await store.getActivePauseForStage('stage-pause'))?.id).toBe(pause.id);
    const events = await store.listEvents('run-pause', 'stage_paused');
    expect(events).toHaveLength(1);
    expect(events[0].eventDataJson).toContain('pause-transient');

    await expect(resolveStagePause(store, {
      pauseId: pause.id,
      stageId: 'stage-pause',
      resolutionNote: 'lock conflict cleared and revalidated',
    })).resolves.toBe(true);

    expect((await store.getStage('stage-pause'))?.status).toBe('ready');
    expect(await store.getActivePauseForStage('stage-pause')).toBeNull();
    expect((await store.getPauseRecord(pause.id))?.resolvedAt).not.toBeNull();
  });

  it('rejects a wrong or stale pause id without changing Stage state', async () => {
    await pauseStage(store, {
      id: 'pause-current', eventId: 'event-pause-current',
      runId: 'run-pause', stageId: 'stage-pause',
      reasonCode: 'reviewer_unavailable', category: 'reviewer', recoverable: true,
      evidenceSummary: 'sha256:reviewer',
    });

    await expect(resolveStagePause(store, {
      pauseId: 'pause-stale', stageId: 'stage-pause', resolutionNote: 'wrong pause',
    })).resolves.toBe(false);
    expect((await store.getStage('stage-pause'))?.status).toBe('paused');
    expect((await store.getActivePauseForStage('stage-pause'))?.id).toBe('pause-current');
  });

  it('requires a still-valid dedicated approval for a protected pause', async () => {
    const pause = await pauseStage(store, {
      id: 'pause-scope', eventId: 'event-pause-scope',
      runId: 'run-pause', stageId: 'stage-pause',
      reasonCode: 'scope_expansion', category: 'scope', recoverable: true,
      requiredApprovalType: 'scope_expansion',
      evidenceSummary: 'sha256:scope',
    });
    expect(pause.decisionId).not.toBeNull();

    await expect(resolveStagePause(store, {
      pauseId: pause.id, stageId: 'stage-pause', resolutionNote: 'not approved',
    })).resolves.toBe(false);
    expect((await store.getStage('stage-pause'))?.status).toBe('paused');

    await store.updateApprovalDecisionStatus(pause.decisionId!, 'approved', new Date().toISOString());
    await expect(resolveStagePause(store, {
      pauseId: pause.id, stageId: 'stage-pause', resolutionNote: 'approved scope decision',
      approvalDecisionId: pause.decisionId!,
    })).resolves.toBe(true);
    expect((await store.getStage('stage-pause'))?.status).toBe('ready');
  });

  it('allows only one concurrent resolver to consume the active pause', async () => {
    const pause = await pauseStage(store, {
      id: 'pause-race', eventId: 'event-pause-race',
      runId: 'run-pause', stageId: 'stage-pause',
      reasonCode: 'temporary_failure', category: 'transient', recoverable: true,
      evidenceSummary: 'sha256:race',
    });

    const results = await Promise.all([
      resolveStagePause(store, { pauseId: pause.id, stageId: 'stage-pause', resolutionNote: 'resolver-a' }),
      resolveStagePause(store, { pauseId: pause.id, stageId: 'stage-pause', resolutionNote: 'resolver-b' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.getStage('stage-pause'))?.status).toBe('ready');
  });

  it('completes the fake/disposable paused -> ready -> running -> integration -> completed lifecycle', async () => {
    const pause = await pauseStage(store, {
      id: 'pause-e2e', eventId: 'event-pause-e2e',
      runId: 'run-pause', stageId: 'stage-pause',
      reasonCode: 'temporary_failure', category: 'transient', recoverable: true,
      evidenceSummary: 'sha256:e2e',
    });
    expect(await resolveStagePause(store, {
      pauseId: pause.id, stageId: 'stage-pause', resolutionNote: 'cause revalidated in disposable test',
    })).toBe(true);
    const now = new Date().toISOString();
    await store.updateStageStatus('stage-pause', 'running', now);
    await store.updateStageStatus('stage-pause', 'integration', now);
    await store.updateStageStatus('stage-pause', 'completed', now);
    await expect(store.updateRunStatus('run-pause', 'completed', now)).resolves.toBe(true);
    expect((await store.getRun('run-pause'))?.status).toBe('completed');
  });

  it('does not allow a Run to complete while a Stage remains paused', async () => {
    await pauseStage(store, {
      id: 'pause-run-guard', eventId: 'event-pause-run-guard',
      runId: 'run-pause', stageId: 'stage-pause',
      reasonCode: 'temporary_failure', category: 'transient', recoverable: true,
      evidenceSummary: 'sha256:run-guard',
    });
    await expect(store.updateRunStatus('run-pause', 'completed', new Date().toISOString()))
      .rejects.toThrow(/cannot complete.*paused/i);
    expect((await store.getRun('run-pause'))?.status).toBe('running');
  });

  it('rejects illegal Stage transitions instead of continuing after a false predicate', async () => {
    await expect(store.updateStageStatus('stage-pause', 'completed', new Date().toISOString()))
      .rejects.toThrow(/Invalid state transition|running.*completed/i);
    expect((await store.getStage('stage-pause'))?.status).toBe('running');
  });
});
