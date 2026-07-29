import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PrivacyArtifactStore } from '../../src/privacy/artifact-store.js';
import { createDefaultProfile } from '../../src/privacy/profile.js';
import {
  cleanupPrivacyFixture,
  createDebugPrivacyService,
  createMinimalPrivacyService,
  createPrivacyCanaries,
  createPrivacyFixture,
  createPrivacyStore,
  scanFixtureForCanary,
} from './helpers/privacy-fixtures.js';

describe('PRIVACY-ACCEPT-01 — real Provider gate is fail-closed', () => {
  it('blocks minimal mode without a key and allows minimal mode with a synthetic key', () => {
    const canaries = createPrivacyCanaries();
    expect(createMinimalPrivacyService().canSpawnRealProvider().allowed).toBe(false);
    expect(createMinimalPrivacyService(canaries.testKey).canSpawnRealProvider().allowed).toBe(true);
  });

  it('does not retain plaintext when minimal persistence has no key', () => {
    const canaries = createPrivacyCanaries();
    const prepared = createMinimalPrivacyService().prepareForPersistence(canaries.request, 'request_text');
    expect(prepared.status).toBe('unavailable');
    expect(prepared.plaintext).toBeNull();
    expect(prepared.encrypted).toBeNull();
  });
});

describe('PRIVACY-ACCEPT-02 — synthetic canaries do not leak to SQLite or artifacts', () => {
  it('encrypts recoverable fields, sanitizes events/logs, and suppresses raw prompts', async () => {
    const fixture = createPrivacyFixture();
    const canaries = createPrivacyCanaries();
    const privacy = createMinimalPrivacyService(canaries.testKey, fixture.root);
    const store = createPrivacyStore(fixture, privacy);
    const now = new Date().toISOString();
    const runId = 'privacy-accept-run';
    const stageId = 'privacy-accept-stage';
    const taskId = 'privacy-accept-task';
    const attemptId = 'privacy-accept-attempt';

    try {
      await store.createRun({
        id: runId,
        projectId: 'synthetic-project',
        projectRoot: fixture.root,
        requestText: canaries.request,
        status: 'planning',
        createdAt: now,
        updatedAt: now,
      });
      await store.createTask({
        id: taskId,
        runId,
        title: 'synthetic task',
        status: 'pending',
        specJson: {},
        createdAt: now,
        updatedAt: now,
      });
      await store.createStage({
        id: stageId,
        runId,
        stageNumber: 1,
        title: 'synthetic stage',
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      });
      await store.createAttempt({
        id: attemptId,
        taskId,
        stageId,
        attemptNumber: 1,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      });
      await store.updateAttemptResult(attemptId, {
        workerResultJson: JSON.stringify({ status: 'completed', summary: canaries.workerResult }),
      });
      await store.createEvent({
        id: 'privacy-accept-event',
        runId,
        taskId,
        attemptId,
        eventType: 'synthetic_event',
        eventData: {
          prompt: canaries.prompt,
          stdout: canaries.event,
          stderr: canaries.event,
          diff: canaries.event,
          status: 'synthetic',
        },
      });

      const artifacts = new PrivacyArtifactStore({ baseDir: fixture.artifactsDir, defaultRetentionDays: 1 });
      const options = { profile: createDefaultProfile(), projectRoot: fixture.root };
      artifacts.writeLog('provider.log', `token=${canaries.logSecret}`, options);
      artifacts.writePromptIfDebug('prompt.txt', canaries.prompt, options);
      expect(existsSync(join(fixture.artifactsDir, 'prompt.txt'))).toBe(false);

      const run = await store.getRun(runId);
      const attempt = await store.getAttempt(attemptId);
      expect(run?.requestText).toBe('[ENCRYPTED]');
      expect(run?.encryptedRequestText).toBeTruthy();
      expect(attempt?.workerResultJson).toBe('[ENCRYPTED]');
      expect(attempt?.encryptedWorkerResultJson).toBeTruthy();

      await store.close();
      for (const canary of [
        canaries.request,
        canaries.workerResult,
        canaries.event,
        canaries.prompt,
        canaries.logSecret,
      ]) {
        expect(scanFixtureForCanary(fixture.root, canary)).toEqual([]);
      }
    } finally {
      try { await store.close(); } catch { /* already closed */ }
      expect(cleanupPrivacyFixture(fixture)).toBe(true);
      expect(existsSync(fixture.root)).toBe(false);
    }
  });
});

describe('PRIVACY-ACCEPT-03 — subprocess environments expose names only by policy', () => {
  it('keeps Provider variable names out of quality-gate environments', () => {
    const envNames = Object.keys(createMinimalPrivacyService().buildProviderEnv('quality_gate'));
    expect(envNames).toContain('PATH');
    for (const name of [
      'DEEPSEEK_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
      'COHERE_API_KEY',
    ]) {
      expect(envNames).not.toContain(name);
    }
  });
});

describe('PRIVACY-ACCEPT-04 — debug mode expires back to minimal', () => {
  it('accepts a future expiry and rejects an expired debug window', () => {
    const canaries = createPrivacyCanaries();
    const active = createDebugPrivacyService(canaries.testKey, new Date(Date.now() + 60_000).toISOString());
    const expired = createDebugPrivacyService(canaries.testKey, new Date(Date.now() - 60_000).toISOString());
    expect(active.isDebug).toBe(true);
    expect(active.isMinimal).toBe(false);
    expect(expired.isDebug).toBe(false);
    expect(expired.isMinimal).toBe(true);
  });
});

describe('PRIVACY-ACCEPT-05 — legacy plaintext is preserved but not re-displayed', () => {
  it('keeps legacy data intact while minimal display returns only a marker', async () => {
    const fixture = createPrivacyFixture();
    const canaries = createPrivacyCanaries();
    const store = createPrivacyStore(fixture, null);
    const now = new Date().toISOString();
    try {
      await store.createRun({
        id: 'legacy-run',
        projectId: 'legacy-project',
        projectRoot: fixture.root,
        requestText: canaries.request,
        status: 'completed',
        createdAt: now,
        updatedAt: now,
      });
      const run = await store.getRun('legacy-run');
      expect(run?.requestText).toBe(canaries.request);
      expect(createMinimalPrivacyService(canaries.testKey).getDisplayText(run?.requestText ?? null, null))
        .toBe('[legacy_plaintext]');
    } finally {
      await store.close();
      expect(cleanupPrivacyFixture(fixture)).toBe(true);
    }
  });
});

describe('PRIVACY-ACCEPT-06 — teardown is restricted to owned temporary fixtures', () => {
  it('refuses a directory outside the owned privacy fixture prefix', () => {
    expect(cleanupPrivacyFixture({
      root: process.cwd(),
      sqlitePath: join(process.cwd(), 'do-not-delete.sqlite'),
      artifactsDir: join(process.cwd(), 'do-not-delete-artifacts'),
    })).toBe(false);
  });
});
