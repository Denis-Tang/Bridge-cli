import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pauseStage, resolveStagePause } from '../../src/core/pause-service.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import {
  StageScheduler,
  shouldAllowApprovedProductDecisionRetry,
  shouldCreateTokenBudgetPause,
} from '../../src/core/stage-scheduler.js';
import type { PauseRecord } from '../../src/types/pause-types.js';

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

async function createResolvedProductDecisionPause(
  attemptId: string,
  note: string,
  taskId: string,
  createdAt: string,
): Promise<PauseRecord> {
  await store.updateStageStatus('stage-pause', 'running', createdAt);
  const pauseId = `pause-pd-${attemptId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const decisionId = `decision-${pauseId}`;
  await store.createApprovalDecision({
    id: decisionId,
    runId: 'run-pause',
    gate: 'G2',
    decisionType: 'product_decision',
    scope: 'stage',
    status: 'pending',
  });
  await store.updateApprovalDecisionStatus(decisionId, 'approved', createdAt);
  await store.createStagePause({
    id: pauseId,
    eventId: `ev-${pauseId}`,
    runId: 'run-pause',
    stageId: 'stage-pause',
    reasonCode: 'product_decision_required',
    category: 'product_decision',
    recoverable: true,
    requiredApprovalType: 'product_decision',
    decisionId,
    evidenceSummary: 'sha256:pd',
    taskId,
    attemptId,
    createdAt,
  });
  await store.resolveStagePause({
    pauseId,
    stageId: 'stage-pause',
    resolutionNote: note,
    approvalDecisionId: decisionId,
  });
  const record = await store.getPauseRecord(pauseId);
  if (!record) throw new Error(`pause ${pauseId} not persisted`);
  return record;
}

function insertRawStagePausedEvent(
  attemptId: string,
  eventDataJson: string,
  createdAt: string,
): void {
  const db = store.getDatabase();
  db.prepare(`
    INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'stage_paused', ?, ?)
  `).run(
    `ev-raw-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    'run-pause',
    'stage-pause',
    'task-pd',
    attemptId,
    eventDataJson,
    createdAt,
  );
}

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

describe('getLatestResolvedPauseForAttempt', () => {
  it('binds lookup to the attempt and returns the latest resolved product_decision note', async () => {
    const now = new Date().toISOString();
    await store.createTask({
      id: 'task-pd', runId: 'run-pause', title: 'product decision',
      status: 'ready', specJson: {}, createdAt: now, updatedAt: now,
    });
    await store.createAttempt({
      id: 'att-a', taskId: 'task-pd', stageId: 'stage-pause', attemptNumber: 1, status: 'rework_required',
    });
    await store.createAttempt({
      id: 'att-b', taskId: 'task-pd', stageId: 'stage-pause', attemptNumber: 2, status: 'rework_required',
    });

    const firstA = await createResolvedProductDecisionPause(
      'att-a', 'first-a', 'task-pd', '2026-08-02T00:00:01.000Z',
    );
    const secondA = await createResolvedProductDecisionPause(
      'att-a', 'second-a', 'task-pd', '2026-08-02T00:00:02.000Z',
    );
    const b = await createResolvedProductDecisionPause(
      'att-b', 'note-b', 'task-pd', '2026-08-02T00:00:03.000Z',
    );

    await expect(store.getLatestResolvedPauseForAttempt('att-a'))
      .resolves.toMatchObject({ id: secondA.id, resolutionNote: 'second-a' });
    await expect(store.getLatestResolvedPauseForAttempt('att-b'))
      .resolves.toMatchObject({ id: b.id, resolutionNote: 'note-b' });
    await expect(store.getLatestResolvedPauseForAttempt('att-none')).resolves.toBeNull();
  });

  it('persists the trimmed decision note in resolution_note', async () => {
    const now = new Date().toISOString();
    await store.createTask({
      id: 'task-trim', runId: 'run-pause', title: 'trim',
      status: 'ready', specJson: {}, createdAt: now, updatedAt: now,
    });
    await store.createAttempt({
      id: 'att-trim', taskId: 'task-trim', stageId: 'stage-pause', attemptNumber: 1, status: 'rework_required',
    });

    const record = await createResolvedProductDecisionPause(
      'att-trim', '  explicit trimmed note  ', 'task-trim', '2026-08-02T00:00:01.000Z',
    );
    expect(record.resolutionNote).toBe('explicit trimmed note');
  });

  it('ignores malformed or unrelated stage_paused events', async () => {
    const now = new Date().toISOString();
    await store.createTask({
      id: 'task-malformed', runId: 'run-pause', title: 'malformed',
      status: 'ready', specJson: {}, createdAt: now, updatedAt: now,
    });
    await store.createAttempt({
      id: 'att-malformed', taskId: 'task-malformed', stageId: 'stage-pause', attemptNumber: 1, status: 'rework_required',
    });

    const valid = await createResolvedProductDecisionPause(
      'att-malformed', 'valid-note', 'task-malformed', '2026-08-02T00:00:01.000Z',
    );
    insertRawStagePausedEvent('att-malformed', '{bad json', '2026-08-02T00:00:02.000Z');
    insertRawStagePausedEvent('att-malformed', JSON.stringify({ pauseId: 123 }), '2026-08-02T00:00:03.000Z');
    insertRawStagePausedEvent('att-malformed', JSON.stringify({ pauseId: 'pause-missing' }), '2026-08-02T00:00:04.000Z');

    await expect(store.getLatestResolvedPauseForAttempt('att-malformed'))
      .resolves.toMatchObject({ id: valid.id });
  });
});

describe('locked product_decision retry semantics', () => {
  const resolvedPause: PauseRecord = {
    id: 'pause-pd-resolved', runId: 'run-pause', stageId: 'stage-pause',
    reasonCode: 'product_decision_required', category: 'product_decision', recoverable: true,
    requiredApprovalType: 'product_decision', decisionId: 'decision-pd',
    evidenceSummary: 'sha256:pd', createdAt: '2026-08-02T00:00:00.000Z',
    resolvedAt: '2026-08-02T00:00:01.000Z', resolutionNote: 'approved answer',
  };

  it('blocks a real product_decision exitReason before resolution', () => {
    expect(shouldAllowApprovedProductDecisionRetry(
      { allowed: false, exhausted: false, failureCategory: 'product_decision' },
      'product_decision: needs product choice',
      null,
    )).toBe(false);
  });

  it('allows only the exact approved resolved-note case', () => {
    expect(shouldAllowApprovedProductDecisionRetry(
      { allowed: false, exhausted: false, failureCategory: 'product_decision' },
      'product_decision: needs product choice',
      resolvedPause,
    )).toBe(true);
  });

  it('still enforces max-attempt exhaustion with an approved note', () => {
    expect(shouldAllowApprovedProductDecisionRetry(
      { allowed: false, exhausted: true, failureCategory: 'product_decision' },
      'product_decision: needs product choice',
      resolvedPause,
    )).toBe(false);
  });

  it('does not bypass unrelated non-retriable failures', () => {
    expect(shouldAllowApprovedProductDecisionRetry(
      { allowed: false, exhausted: false, failureCategory: 'security' },
      'security: blocked',
      resolvedPause,
    )).toBe(false);
  });
});

describe('token-budget post-check precedence', () => {
  it('does not create a token pause when product decision is required', () => {
    expect(shouldCreateTokenBudgetPause(true, true)).toBe(false);
  });

  it('creates a token pause when no product decision is required', () => {
    expect(shouldCreateTokenBudgetPause(true, false)).toBe(true);
  });
});

describe('resolved product_decision retry prompt', () => {
  it('preserves the original failure and includes the bounded approved answer', async () => {
    const now = new Date().toISOString();
    await store.createTask({
      id: 'task-retry', runId: 'run-pause', title: 'retry prompt',
      status: 'rework_required', specJson: {}, createdAt: now, updatedAt: now,
    });
    await store.createAttempt({
      id: 'att-retry', taskId: 'task-retry', stageId: 'stage-pause', attemptNumber: 1, status: 'rework_required',
    });
    await store.updateAttemptResult('att-retry', {
      exitReason: 'product_decision: needs product choice',
    });
    await createResolvedProductDecisionPause(
      'att-retry', 'APPROVED ANSWER 123', 'task-retry', '2026-08-02T00:00:01.000Z',
    );

    const scheduler = new StageScheduler(store, {
      projectRoot: root,
      executionMode: 'token-efficient',
      maxReworkCount: 2,
      allowRealWorker: false,
    });
    const spec = {
      taskId: 'task-retry',
      title: 'retry',
      goal: 'Original goal',
      estimatedWritePaths: ['src/'],
      allowedPaths: ['src/'],
      forbiddenPaths: [],
      dependencies: [],
      contextFiles: [],
    };
    const { prompt } = await (scheduler as any).buildImplementationPrompt(
      spec,
      join(root, 'missing-worktree'),
      await store.getAttempt('att-retry'),
      'base-commit',
      'run-pause',
      'stage-pause',
      'att-retry-next',
    );

    expect(prompt).toContain('product_decision: needs product choice');
    expect(prompt).toContain('APPROVED ANSWER 123');
  });
});
