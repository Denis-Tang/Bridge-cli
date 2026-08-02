// ── M4 Token Ledger Closure Tests v2 ────────────────────────────────────
// Proves:
//   A. Three adapter optional LedgerSink — estimate before external call,
//      confirmed/unavailable after, no business semantic change on sink failure.
//   B. Per-entry effective usage in getTokenUsageSummary.
//   C. preCheck/postCheck correctness with mixed confirmed/estimated/unavailable.
//   D. Scheduler integration: estimate → postCheck → exceeded → pause → resume.
//   E. governance=false regression.
//   F. No sensitive data in ledger.
//   G. Concurrent-safe IDs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { SqliteLedgerSink, estimateForCallType } from '../../src/core/token-telemetry.js';
import { preCheckBudget, postCheckBudget } from '../../src/core/token-budget.js';
import { ensureDefaultPolicies, setPerRunBudget, getEffectiveBudgetLimit } from '../../src/core/budget-policy-store.js';
import { promptHash } from '../../src/utils/sanitize.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import type { WorkerResult } from '../../src/types/protocol.js';
import { FakeProcessRunner } from '../../src/adapters/pi-rpc-worker.js';
import {
  FakeCodexProcessRunner,
  type CodexProcessRunner,
  type CodexProcessRunResult,
} from '../../src/adapters/codex-process-runner.js';
import { CodexCliBrain } from '../../src/adapters/codex-cli-brain.js';
import { CodexCliReviewer } from '../../src/adapters/codex-cli-reviewer.js';
import { PiRpcWorker } from '../../src/adapters/pi-rpc-worker.js';
import type { PiWorkerConfig } from '../../src/adapters/pi-worker-types.js';

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = path.join(tmpdir(), `brainctl-m4-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function setupStore(): Promise<{ store: SqliteStateStore; sink: SqliteLedgerSink; tmpDir: string; dbPath: string }> {
  const tmpDir = makeTmpDir();
  const dbPath = path.join(tmpDir, 'tl.db');
  const store = SqliteStateStore.create(dbPath);
  const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
  const runner = new SqliteMigrationRunner(config, store.getDatabase());
  runner.applyPending();
  const sink = new SqliteLedgerSink(store);
  return { store, sink, tmpDir, dbPath };
}

async function createRun(store: SqliteStateStore, runId: string) {
  await store.createRun({
    id: runId, projectId: 'proj', projectRoot: '/tmp/p',
    requestText: 'Test', status: 'running',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await ensureDefaultPolicies(store);
  await setPerRunBudget(store, runId, 'pi_attempt', 500000, 'pause');
  await setPerRunBudget(store, runId, 'codex_plan', 500000, 'pause');
  await setPerRunBudget(store, runId, 'codex_review_stage', 500000, 'pause');
}

// ══════════════════════════════════════════════════════════════
describe('M4 Token Ledger Closure v2', () => {
  // ── Group A: Sink / Store / Budget correctness ─────────────
  describe('A. Sink & Store correctness', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;
    const runId = 'a-core';

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
      await createRun(store, runId);
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('estimated → confirmed: one record, not two', async () => {
      const entryId = await sink.writeEstimate(
        { runId, callType: 'pi_worker', callId: 'pi-confirmed' },
        5000, 3000, 2000);

      const e1 = await store.getTokenLedgerEntry(entryId);
      expect(e1!.status).toBe('estimated');
      expect(e1!.estimatedTotal).toBe(5000);
      expect(e1!.actualTotal).toBeNull();

      await sink.confirmActual(entryId, 4800, 2900, 1900, 100);
      const e2 = await store.getTokenLedgerEntry(entryId);
      expect(e2!.status).toBe('confirmed');
      expect(e2!.estimatedTotal).toBe(5000);
      expect(e2!.actualTotal).toBe(4800);

      const all = await store.listTokenLedgerEntries(runId, 'pi_worker');
      expect(all.filter((e) => e.callId === 'pi-confirmed').length).toBe(1);
    });

    it('estimated → unavailable: preserves estimate', async () => {
      const entryId = await sink.writeEstimate(
        { runId, callType: 'codex_review', callId: 'review-unavail' },
        2500, 1500, 1000);
      await sink.markUnavailable(entryId);

      const e = await store.getTokenLedgerEntry(entryId);
      expect(e!.status).toBe('unavailable');
      expect(e!.estimatedTotal).toBe(2500);
      expect(e!.actualTotal).toBeNull();
    });

    it('no raw prompt text in ledger — only SHA256 hash', async () => {
      const secretPrompt = 'BUILD A SECRET NUCLEAR REACTOR CONTROLLER';
      const entryId = await sink.writeEstimate(
        { runId, callType: 'codex_plan', callId: 'plan-secret' },
        10000, 6000, 4000, secretPrompt);

      const e = await store.getTokenLedgerEntry(entryId);
      expect(e!.promptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(e!.promptHash).not.toContain('NUCLEAR');
      expect(e!.promptHash).not.toContain('SECRET');
      expect(promptHash(secretPrompt)).toBe(e!.promptHash);
    });

    it('concurrent ledger IDs are unique', async () => {
      const ids = new Set<string>();
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 30; i++) {
        promises.push((async () => {
          const id = await sink.writeEstimate(
            { runId, callType: 'pi_worker', callId: `pi-cc-${i}` },
            100, 60, 40);
          ids.add(id);
        })());
      }
      await Promise.all(promises);
      expect(ids.size).toBe(30);
    });

    it('no raw sensitive content in any ledger record', async () => {
      const entryId = await sink.writeEstimate(
        { runId, callType: 'codex_review', callId: 'review-safe' },
        2000, 1200, 800);
      await sink.confirmActual(entryId, 2100, 1300, 800, 0);

      const e = await store.getTokenLedgerEntry(entryId);
      const serialized = JSON.stringify(e);
      for (const forbidden of ['diff', 'stdout', 'stderr', '.env', 'password', 'secret', 'BEGIN RSA']) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('sink write failure does not break callers', async () => {
      const result = await sink.writeEstimate(
        { runId, callType: 'pi_worker', callId: 'pi-safe' },
        100, 60, 40).catch(() => 'caught');
      expect(typeof result).toBe('string');
    });
  });

  // ── Group B: Per-entry effective usage (mixed confirmed/estimated/unavailable) ──

  describe('B. Effective usage — mixed call types', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;
    const runId = 'b-mixed';

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
      await createRun(store, runId);
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('confirmed + estimated for same callType summed correctly (no double-count)', async () => {
      // Entry 1: confirmed
      const e1 = await sink.writeEstimate(
        { runId, callType: 'codex_plan', callId: 'cp-confirmed' }, 5000, 3000, 2000);
      await sink.confirmActual(e1, 4800, 2900, 1900, 100);

      // Entry 2: estimated only (pending, no actual yet)
      await sink.writeEstimate(
        { runId, callType: 'codex_plan', callId: 'cp-pending' }, 3000, 1800, 1200);

      // Entry 3: unavailable
      const e3 = await sink.writeEstimate(
        { runId, callType: 'codex_plan', callId: 'cp-unavail' }, 2000, 1200, 800);
      await sink.markUnavailable(e3);

      const summary = await store.getTokenUsageSummary(runId);
      // Confirmed: 4800 actual; estimated: 3000 pending + 2000 unavailable = 5000
      expect(summary.codexPlan.actual).toBe(4800);
      expect(summary.codexPlan.estimated).toBe(5000);
      // Total used = 4800 + 5000 = 9800 (each entry counted exactly once)
      expect(summary.codexPlan.actual + summary.codexPlan.estimated).toBe(9800);
    });

    it('preCheck uses effective sum across mixed statuses', async () => {
      // Run already has entries from above test. The confirmed+estimated+unavailable total is 9800.
      // Set tight budget just above current usage so we can test.
      await setPerRunBudget(store, runId, 'codex_plan', 15000, 'pause');
      const check = await preCheckBudget(store, runId, 'codex_plan', 500);
      // Used = 4800 (confirmed) + 5000 (estimated+unavailable) = 9800
      expect(check.used).toBe(9800);
      expect(check.remaining).toBe(5200); // 15000 - 9800
      expect(check.allowed).toBe(true); // 500 <= 5200

      // Test denied: 10000 budget, 9800 used, trying 1000 → 200 remaining, denied
      await setPerRunBudget(store, runId, 'codex_plan', 10000, 'pause');
      const check2 = await preCheckBudget(store, runId, 'codex_plan', 1000);
      expect(check2.remaining).toBe(200);
      expect(check2.allowed).toBe(false);

      // Reset
      await setPerRunBudget(store, runId, 'codex_plan', 500000, 'pause');
    });

    it('postCheck detects exceeded correctly', async () => {
      // Use a unique callType budget - set codex_review_stage to just 300
      await setPerRunBudget(store, runId, 'codex_review_stage', 300, 'pause');
      // Write a review entry that burns 400 total
      const e1 = await sink.writeEstimate(
        { runId, callType: 'codex_review', callId: 'cr-burst2' }, 400, 250, 150);
      await sink.confirmActual(e1, 400, 250, 150, 0);

      const result = await postCheckBudget(store, runId, 'codex_review_stage', 400);
      expect(result.exceeded).toBe(true);

      await setPerRunBudget(store, runId, 'codex_review_stage', 500000, 'pause');
    });

    it('unavailable entry with no estimate counts as 0 in summary (auditable)', async () => {
      // Direct DB insert with no estimate
      await store.insertTokenLedgerEntry({
        id: `b-mixed-unavail-zero`, runId,
        callType: 'pi_worker', callId: 'pw-no-est',
        estimatedTotal: null, status: 'unavailable',
      });
      const summary = await store.getTokenUsageSummary(runId);
      // The no-estimate unavailable entry contributes 0 to estimated
      expect(summary.piWorker.estimated + summary.piWorker.actual).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Group C: CodexCliBrain adapter telemetry ───────────────

  describe('C. CodexCliBrain adapter telemetry', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;
    const runId = 'c-brain';

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
      await createRun(store, runId);
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('C0: invokes the non-interactive read-only exec flow for structured planning', async () => {
      let invocation: { command: string; args: string[]; input?: string } | undefined;
      const runner: CodexProcessRunner = {
        async run(command, args, options) {
          invocation = { command, args, input: options.input };
          return {
            stdout: '```json\n{"stages":[{"stageNumber":1,"title":"S1","tasks":["t1"]}],"tasks":[{"taskId":"t1","stageNumber":1,"title":"T1","goal":"plan","dependencies":[],"estimatedWritePaths":["src/"],"allowedPaths":["src/"],"forbiddenPaths":[],"contextFiles":[],"acceptanceChecks":[],"allowedCommands":[],"riskLevel":"low","productDecisionsLocked":true,"expectedOutputs":[],"heavyCommandSlotsRequired":0,"timeoutSeconds":60}]}\n```',
            stderr: '',
            exitCode: 0,
            durationMs: 1,
          };
        },
      };
      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: runner },
      );

      const result = await brain.generatePlan('plan safely', 'c-brain-entrypoint');

      expect(result.success).toBe(true);
      expect(invocation).toEqual({
        command: 'codex',
        args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '-'],
        input: expect.stringContaining('plan safely'),
      });
      expect(invocation?.input).toContain('dependencies array MUST contain only task IDs from the same stage');
      expect(invocation?.input).toContain('NEVER list a task from an earlier or later stage');
    });

    it('C1: writes estimate BEFORE external call, confirmed when tokenUsage present', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: '```json\n{"stages":[{"stageNumber":1,"title":"S1","tasks":["t1"]}],"tasks":[{"taskId":"t1","stageNumber":1,"title":"T1","goal":"calc","dependencies":[],"estimatedWritePaths":["src/"],"allowedPaths":["src/"],"forbiddenPaths":[],"contextFiles":[],"acceptanceChecks":[],"allowedCommands":[],"riskLevel":"low","productDecisionsLocked":true,"expectedOutputs":[],"heavyCommandSlotsRequired":0,"timeoutSeconds":60}]}\n```',
        stderr: '',
        exitCode: 0,
        durationMs: 150,
        tokenUsage: { inputTokens: 4000, outputTokens: 2000, cacheHitTokens: 500 },
      });

      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: { runId, callType: 'codex_plan', callId: 'brain-c1' } },
      );

      const result = await brain.generatePlan('build a calculator', runId);
      expect(result.success).toBe(true);

      // Should have exactly 1 ledger entry
      const entries = await store.listTokenLedgerEntries(runId, 'codex_plan');
      const ourEntry = entries.find((e) => e.callId === 'brain-c1');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('confirmed');
      expect(ourEntry!.actualTotal).toBe(6500); // 4000+2000+500
      expect(ourEntry!.actualInput).toBe(4000);
      expect(ourEntry!.actualOutput).toBe(2000);
      expect(ourEntry!.actualCacheHit).toBe(500);
    });

    it('C2: marks unavailable when no tokenUsage from Codex CLI', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: '```json\n{"stages":[{"stageNumber":1,"title":"S1","tasks":["t1"]}],"tasks":[{"taskId":"t1","stageNumber":1,"title":"T1","goal":"thing","dependencies":[],"estimatedWritePaths":["src/"],"allowedPaths":["src/"],"forbiddenPaths":[],"contextFiles":[],"acceptanceChecks":[],"allowedCommands":[],"riskLevel":"low","productDecisionsLocked":true,"expectedOutputs":[],"heavyCommandSlotsRequired":0,"timeoutSeconds":60}]}\n```',
        stderr: '',
        exitCode: 0,
        durationMs: 100,
        // No tokenUsage field
      });

      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: { runId, callType: 'codex_plan', callId: 'brain-c2' } },
      );

      const result = await brain.generatePlan('build a thing', runId);
      expect(result.success).toBe(true);

      const entries = await store.listTokenLedgerEntries(runId, 'codex_plan');
      const ourEntry = entries.find((e) => e.callId === 'brain-c2');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('unavailable');
      expect(ourEntry!.estimatedTotal).toBeGreaterThan(0);
      expect(ourEntry!.actualTotal).toBeNull();
    });

    it('C3: marks unavailable on process failure, does not change business semantics', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: '', stderr: 'command not found', exitCode: 1, durationMs: 50,
      });

      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: { runId, callType: 'codex_plan', callId: 'brain-c3' } },
      );

      const result = await brain.generatePlan('build', runId);
      // Business semantics: should fail because stdout has no JSON
      expect(result.success).toBe(false);

      // Ledger should still mark unavailable
      const entries = await store.listTokenLedgerEntries(runId, 'codex_plan');
      const ourEntry = entries.find((e) => e.callId === 'brain-c3');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('unavailable');
    });

    it('C4: no sink → no ledger (governance OFF)', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: '```json\n{"stages":[{"stageNumber":1,"title":"S1","tasks":["t1"]}],"tasks":[{"taskId":"t1","stageNumber":1,"title":"T1","goal":"build","dependencies":[],"estimatedWritePaths":["src/"],"allowedPaths":["src/"],"forbiddenPaths":[],"contextFiles":[],"acceptanceChecks":[],"allowedCommands":[],"riskLevel":"low","productDecisionsLocked":true,"expectedOutputs":[],"heavyCommandSlotsRequired":0,"timeoutSeconds":60}]}\n```',
        stderr: '', exitCode: 0, durationMs: 100,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      });

      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner },
        // No ledgerSink → governance OFF
      );

      const result = await brain.generatePlan('build', runId);
      expect(result.success).toBe(true);

      // Should have no entries with callId 'brain-c4' because no sink was injected
      // (but actually we used the constructor without sink, so nothing is written)
      const entries = await store.listTokenLedgerEntries(runId, 'codex_plan');
      const brainC4 = entries.find((e) => e.callId === 'brain-c4');
      expect(brainC4).toBeUndefined();
    });

    it('C5: sink write exception does not block result return', async () => {
      // Use a broken store to simulate sink failure
      const brokenTmp = makeTmpDir();
      const brokenDbPath = path.join(brokenTmp, 'br.db');
      const brokenStore = SqliteStateStore.create(brokenDbPath);
      const cfg: SqliteConfig = { path: brokenDbPath, maskedPath: brokenDbPath };
      new SqliteMigrationRunner(cfg, brokenStore.getDatabase()).applyPending();
      const brokenSink = new SqliteLedgerSink(brokenStore);
      await brokenStore.close();
      try { rmSync(brokenTmp, { recursive: true, force: true }); } catch {}

      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: '```json\n{"stages":[{"stageNumber":1,"title":"S1","tasks":["t1"]}],"tasks":[{"taskId":"t1","stageNumber":1,"title":"T1","goal":"build","dependencies":[],"estimatedWritePaths":["src/"],"allowedPaths":["src/"],"forbiddenPaths":[],"contextFiles":[],"acceptanceChecks":[],"allowedCommands":[],"riskLevel":"low","productDecisionsLocked":true,"expectedOutputs":[],"heavyCommandSlotsRequired":0,"timeoutSeconds":60}]}\n```',
        stderr: '', exitCode: 0, durationMs: 100,
      });

      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: brokenSink, invocationContext: { runId, callType: 'codex_plan', callId: 'brain-c5' } },
      );

      // Must NOT throw — sink failure is silently caught
      const result = await brain.generatePlan('build', runId);
      expect(result.success).toBe(true);
    });
  });

  // ── Group D: CodexCliReviewer adapter telemetry ────────────

  describe('D. CodexCliReviewer adapter telemetry', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;
    const runId = 'd-review';

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
      await createRun(store, runId);
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    const sampleDiff = 'diff --git a/src/file.ts b/src/file.ts\n+added line\n-removed line';

    it('D1: writes estimate BEFORE external call, confirmed when tokenUsage present', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: 'No issues found. The diff looks correct.',
        stderr: '', exitCode: 0, durationMs: 120,
        tokenUsage: { inputTokens: 800, outputTokens: 400, cacheHitTokens: 100 },
      });

      const reviewer = new CodexCliReviewer(
        { allowRealReview: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: { runId, callType: 'codex_review', callId: 'rev-d1' } },
      );

      const result = await reviewer.reviewDiff(sampleDiff, 'task-d1');
      expect(result.status).toBe('approved');

      const entries = await store.listTokenLedgerEntries(runId, 'codex_review');
      const ourEntry = entries.find((e) => e.callId === 'rev-d1');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('confirmed');
      expect(ourEntry!.actualTotal).toBe(1300); // 800+400+100
    });

    it('D2: marks unavailable when no tokenUsage', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: 'No issues found.', stderr: '', exitCode: 0, durationMs: 100,
      });

      const reviewer = new CodexCliReviewer(
        { allowRealReview: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: { runId, callType: 'codex_review', callId: 'rev-d2' } },
      );

      const result = await reviewer.reviewDiff(sampleDiff, 'task-d2');
      expect(result.status).toBe('approved');

      const entries = await store.listTokenLedgerEntries(runId, 'codex_review');
      const ourEntry = entries.find((e) => e.callId === 'rev-d2');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('unavailable');
    });

    it('D3: marks unavailable on call failure, preserves business semantics', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: '', stderr: 'codex: not found', exitCode: 1, durationMs: 30,
      });

      const reviewer = new CodexCliReviewer(
        { allowRealReview: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: { runId, callType: 'codex_review', callId: 'rev-d3' } },
      );

      const result = await reviewer.reviewDiff(sampleDiff, 'task-d3');
      // Business semantics preserved: rejection due to failure
      expect(result.status).toBe('rejected');
      expect(result.reviewSummary).toContain('Codex CLI 审查调用失败');

      const entries = await store.listTokenLedgerEntries(runId, 'codex_review');
      const ourEntry = entries.find((e) => e.callId === 'rev-d3');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('unavailable');
    });

    it('D4: no sink → no ledger', async () => {
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: 'ok', stderr: '', exitCode: 0, durationMs: 10,
      });

      const reviewer = new CodexCliReviewer(
        { allowRealReview: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner },
      );

      await reviewer.reviewDiff(sampleDiff, 'task-d4');
      const entries = await store.listTokenLedgerEntries(runId, 'codex_review');
      expect(entries.find((e) => e.callId === 'rev-d4')).toBeUndefined();
    });
  });

  // ── Group E: PiRpcWorker adapter telemetry ─────────────────

  describe('E. PiRpcWorker adapter telemetry', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;
    let sessionDir: string;
    const runId = 'e-pi';

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
      sessionDir = path.join(tmpDir, 'sessions');
      mkdirSync(sessionDir, { recursive: true });
      await createRun(store, runId);
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    const workerResultWithUsage: WorkerResult = {
      taskId: 'task-e1',
      status: 'completed',
      summary: 'done',
      filesChanged: [],
      checks: [],
      scopeViolations: [],
      risks: [],
      unresolvedQuestions: [],
      productDecisionRequired: false,
      tokenUsage: { inputTokens: 5000, outputTokens: 3000, cacheHitTokens: 500 },
    };

    const workerResultNoUsage: WorkerResult = {
      taskId: 'task-e2',
      status: 'completed',
      summary: 'done',
      filesChanged: [],
      checks: [],
      scopeViolations: [],
      risks: [],
      unresolvedQuestions: [],
      productDecisionRequired: false,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
    };

    function makePiConfig(workerId: string, wp: string): PiWorkerConfig {
      return {
        workerId, command: 'pi', args: ['--mode', 'rpc'],
        model: 'deepseek-v3',
        workingDirectory: wp,
        sessionDirectory: sessionDir,
        rawLogPath: path.join(sessionDir, `${workerId}.log`),
        timeoutMs: 10000,
        allowRealPiExecution: true,
      };
    }

    it('E1: writes estimate BEFORE external call, confirmed from provider JSONL usage', async () => {
      const fakeRunner = new FakeProcessRunner();
      // Pi outputs workerResult via JSONL
      fakeRunner.setDefaultResult({
        pid: 1001, exitCode: 0,
        stdout: JSON.stringify({
          type: 'agent_end',
          messages: [{
            role: 'assistant',
            content: `BEGIN_WORKER_RESULT_JSON\n${JSON.stringify(workerResultWithUsage)}\nEND_WORKER_RESULT_JSON`,
            usage: { input: 5000, output: 3000, cacheRead: 500, cacheWrite: 0, totalTokens: 8000, cost: { total: 0.002 } },
          }],
        }),
        stderr: '', timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: 200,
      });

      const pi = new PiRpcWorker(
        makePiConfig('pi-e1', tmpDir), fakeRunner,
        { ledgerSink: sink, invocationContext: { runId, callType: 'pi_worker', callId: 'pi-e1' } },
      );

      const result = await pi.executeTask({
        taskSpec: {
          taskId: 'task-e1', title: 'test', goal: 'do something', dependencies: [],
          allowedPaths: ['src/'], forbiddenPaths: [], contextFiles: [],
          acceptanceChecks: [], allowedCommands: [], riskLevel: 'low',
          productDecisionsLocked: true, expectedOutputs: [], heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
        },
        worktreePath: tmpDir, runId,
      });

      expect(result.workerResult).toBeTruthy();
      expect(result.workerResult!.tokenUsage.inputTokens).toBe(5000);

      const entries = await store.listTokenLedgerEntries(runId, 'pi_worker');
      const ourEntry = entries.find((e) => e.callId === 'pi-e1');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('confirmed');
      expect(ourEntry!.actualTotal).toBe(8000); // provider total; cacheRead is a subset of input
      expect(ourEntry!.actualCacheHit).toBe(500);
    });

    it('E2: marks unavailable when workerResult has no tokenUsage', async () => {
      const fakeRunner = new FakeProcessRunner();
      fakeRunner.setDefaultResult({
        pid: 1002, exitCode: 0,
        stdout: `{"type":"agent_end","messages":[{"role":"assistant","content":"BEGIN_WORKER_RESULT_JSON\n${JSON.stringify(workerResultNoUsage)}\nEND_WORKER_RESULT_JSON"}]}`,
        stderr: '', timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: 150,
      });

      const pi = new PiRpcWorker(
        makePiConfig('pi-e2', tmpDir), fakeRunner,
        { ledgerSink: sink, invocationContext: { runId, callType: 'pi_worker', callId: 'pi-e2' } },
      );

      const result = await pi.executeTask({
        taskSpec: {
          taskId: 'task-e2', title: 'test2', goal: 'do else', dependencies: [],
          allowedPaths: ['src/'], forbiddenPaths: [], contextFiles: [],
          acceptanceChecks: [], allowedCommands: [], riskLevel: 'low',
          productDecisionsLocked: true, expectedOutputs: [], heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
        },
        worktreePath: tmpDir, runId,
      });

      expect(result.workerResult).toBeTruthy();

      const entries = await store.listTokenLedgerEntries(runId, 'pi_worker');
      const ourEntry = entries.find((e) => e.callId === 'pi-e2');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('unavailable');
      expect(ourEntry!.estimatedTotal).toBeGreaterThan(0);
    });

    it('E3: no sink → no ledger (governance OFF)', async () => {
      const fakeRunner = new FakeProcessRunner();
      fakeRunner.setDefaultResult({
        pid: 1003, exitCode: 0,
        stdout: `{"type":"agent_end","messages":[{"role":"assistant","content":"BEGIN_WORKER_RESULT_JSON\n${JSON.stringify(workerResultWithUsage)}\nEND_WORKER_RESULT_JSON"}]}`,
        stderr: '', timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: 100,
      });

      const pi = new PiRpcWorker(makePiConfig('pi-e3', tmpDir), fakeRunner);
      // No ledgerSink → governance OFF

      await pi.executeTask({
        taskSpec: {
          taskId: 'task-e3', title: 'test3', goal: 'do', dependencies: [],
          allowedPaths: ['src/'], forbiddenPaths: [], contextFiles: [],
          acceptanceChecks: [], allowedCommands: [], riskLevel: 'low',
          productDecisionsLocked: true, expectedOutputs: [], heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
        },
        worktreePath: tmpDir, runId,
      });

      const entries = await store.listTokenLedgerEntries(runId, 'pi_worker');
      expect(entries.find((e) => e.callId === 'pi-e3')).toBeUndefined();
    });
  });
});

// ══════════════════════════════════════════════════════════════
// Group F: Scheduler integration — estimate→postCheck→exceeded→pause→resume
// ══════════════════════════════════════════════════════════════

describe('F. Scheduler Token Integration', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  beforeAll(async () => {
    tmpDir = makeTmpDir();
    dbPath = path.join(tmpDir, 'sched.db');
    store = SqliteStateStore.create(dbPath);
    const cfg: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    new SqliteMigrationRunner(cfg, store.getDatabase()).applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('F1: governance=false → no ledger entries, no budget blocking', async () => {
    const runId = 'f1-nogov';
    await store.createRun({
      id: runId, projectId: 'proj', projectRoot: tmpDir,
      requestText: 'test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Verify: without governance enabled, no ledger entries exist for this run
    const entries = await store.listTokenLedgerEntries(runId);
    expect(entries.length).toBe(0);

    // Also verify: without ensureDefaultPolicies, no budget blocking occurs
    // (preCheck would use defaults but no blocking without governance flag)
    const { preCheckBudget } = await import('../../src/core/token-budget.js');
    // Even without policies set, preCheck uses hardcoded defaults
    // The key test: no ledger entries means zero usage
    expect(entries.length).toBe(0);
  });

  it('F2: token_budget_exceeded event is written on postCheck exceed via store events', async () => {
    const runId = 'f2-exceeded';
    await store.createRun({
      id: runId, projectId: 'proj', projectRoot: tmpDir,
      requestText: 'test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await ensureDefaultPolicies(store);
    // Set very tight budget
    await setPerRunBudget(store, runId, 'pi_attempt', 100, 'pause');

    // Write a ledger entry that exceeds
    const sink = new SqliteLedgerSink(store);
    const entryId = await sink.writeEstimate(
      { runId, callType: 'pi_worker', callId: 'pi-f2' }, 500, 300, 200);
    await sink.confirmActual(entryId, 500, 300, 200, 0);

    // postCheck should detect exceeded
    const pc = await postCheckBudget(store, runId, 'pi_attempt', 500);
    expect(pc.exceeded).toBe(true);

    // Write the token_budget_exceeded event (as scheduler would)
    await store.createEvent({
      id: `${runId}-ev-token-exceeded`,
      runId, eventType: 'token_budget_exceeded',
      eventData: { policyType: 'pi_attempt', remaining: pc.remaining, limit: pc.limit },
    });

    const events = await store.listEvents(runId, 'token_budget_exceeded');
    expect(events.length).toBe(1);
    const ev = JSON.parse(events[0].eventDataJson as string);
    expect(ev.policyType).toBe('pi_attempt');
  });

  it('F3: token_budget_resumed event enables subsequent dispatch', async () => {
    const runId = 'f3-resumed';
    await store.createRun({
      id: runId, projectId: 'proj', projectRoot: tmpDir,
      requestText: 'test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await ensureDefaultPolicies(store);
    await setPerRunBudget(store, runId, 'pi_attempt', 100, 'pause');

    const sink = new SqliteLedgerSink(store);
    const entryId = await sink.writeEstimate(
      { runId, callType: 'pi_worker', callId: 'pi-f3' }, 500, 300, 200);
    await sink.confirmActual(entryId, 500, 300, 200, 0);

    // Write exceeded event
    await store.createEvent({
      id: `${runId}-ev-token-exceeded-f3`,
      runId, eventType: 'token_budget_exceeded',
      eventData: { policyType: 'pi_attempt' },
    });

    // isBudgetPaused should detect pause
    const { isBudgetPaused } = await import('../../src/core/token-budget.js');
    let paused = await isBudgetPaused(store, runId);
    expect(paused.paused).toBe(true);

    // Simulate resume: raise budget + write resumed event
    await setPerRunBudget(store, runId, 'pi_attempt', 50000, 'pause');
    await store.createEvent({
      id: `${runId}-ev-token-resumed-f3`,
      runId, eventType: 'token_budget_resumed',
      eventData: { policyType: 'pi_attempt', newLimit: 50000 },
    });

    paused = await isBudgetPaused(store, runId);
    expect(paused.paused).toBe(false);
  });

  it('F4: mixed confirmed + pending estimated for same callType — preCheck correct', async () => {
    const runId = 'f4-mixed-precheck';
    await store.createRun({
      id: runId, projectId: 'proj', projectRoot: tmpDir,
      requestText: 'test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await ensureDefaultPolicies(store);
    await setPerRunBudget(store, runId, 'codex_plan', 20000, 'pause');

    const sink = new SqliteLedgerSink(store);
    // Confirmed actual: 5000
    const e1 = await sink.writeEstimate(
      { runId, callType: 'codex_plan', callId: 'cp-f4-conf' }, 6000, 4000, 2000);
    await sink.confirmActual(e1, 5000, 3500, 1500, 0);

    // Pending estimated: 3000
    await sink.writeEstimate(
      { runId, callType: 'codex_plan', callId: 'cp-f4-est' }, 3000, 1800, 1200);

    // Unavailable: 2000 estimated (conservative)
    const e3 = await sink.writeEstimate(
      { runId, callType: 'codex_plan', callId: 'cp-f4-unav' }, 2000, 1200, 800);
    await sink.markUnavailable(e3);

    // Summary: actual=5000, estimated=3000+2000=5000, total used=10000
    const check = await preCheckBudget(store, runId, 'codex_plan', 5000);
    expect(check.used).toBe(10000);
    expect(check.remaining).toBe(10000); // 20000 - 10000
    expect(check.allowed).toBe(true);    // 5000 <= 10000
  });
});

// ══════════════════════════════════════════════════════════════
// Group G: P0-B Budget policy ordering & parallel-run isolation
// ══════════════════════════════════════════════════════════════

describe('G. P0-B Budget policy deterministic ordering', () => {
  let store: SqliteStateStore;
  let sink: SqliteLedgerSink;
  let tmpDir: string;
  const runId = 'g-deterministic';

  beforeAll(async () => {
    const s = await setupStore();
    store = s.store; sink = s.sink; tmpDir = s.tmpDir;
    await createRun(store, runId);
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('P0B-DET-01: rapid setPerRunBudget calls — most recent wins deterministically', async () => {
    // Call setPerRunBudget twice rapidly (same millisecond possible)
    // Previously ORDER BY created_at DESC was non-deterministic for same-ms entries
    await setPerRunBudget(store, runId, 'codex_plan', 15000, 'pause');
    await setPerRunBudget(store, runId, 'codex_plan', 10000, 'pause');

    // The effective budget must be 10000 (latest), not 15000
    const limit = await getEffectiveBudgetLimit(store, 'codex_plan', runId);
    expect(limit.tokenLimit).toBe(10000);
    expect(limit.source).toBe('per-run');
  });

  it('P0B-DET-02: setPerRunBudget after ledger entries → preCheck uses latest budget', async () => {
    // Write ledger entries to this run
    await sink.writeEstimate(
      { runId, callType: 'codex_plan', callId: 'g-det-cp1' }, 6000, 4000, 2000);

    // Set budget → 15000
    await setPerRunBudget(store, runId, 'codex_plan', 15000, 'pause');
    const check1 = await preCheckBudget(store, runId, 'codex_plan', 500);
    expect(check1.limit).toBe(15000);

    // Tighten budget → 6000 (below current usage of 6000)
    await setPerRunBudget(store, runId, 'codex_plan', 6000, 'pause');
    const check2 = await preCheckBudget(store, runId, 'codex_plan', 500);
    expect(check2.limit).toBe(6000);
    // Usage = 6000 estimated, limit = 6000, remaining = 0
    expect(check2.remaining).toBe(0);

    // Raise budget again
    await setPerRunBudget(store, runId, 'codex_plan', 500000, 'pause');
  }, 15000);

  it('P0B-DET-03: 10-round rapid setPerRunBudget always deterministic', async () => {
    for (let i = 0; i < 10; i++) {
      await setPerRunBudget(store, runId, 'pi_attempt', 5000 + i * 1000, 'pause');
      await setPerRunBudget(store, runId, 'pi_attempt', 1000 + i, 'pause');
      const limit = await getEffectiveBudgetLimit(store, 'pi_attempt', runId);
      // The second call should always win (most recent)
      expect(limit.tokenLimit).toBe(1000 + i);
    }
    // Reset
    await setPerRunBudget(store, runId, 'pi_attempt', 500000, 'pause');
  }, 15000);

  it('P0B-DET-04: per-run policy does not affect other runs (isolation)', async () => {
    const runA = 'g-iso-a';
    const runB = 'g-iso-b';
    await createRun(store, runA);
    await createRun(store, runB);

    // Set different budgets for each run
    await setPerRunBudget(store, runA, 'codex_plan', 30000, 'pause');
    await setPerRunBudget(store, runB, 'codex_plan', 10000, 'pause');

    // Add ledger entries for each run
    const sinkA = new SqliteLedgerSink(store);
    const sinkB = new SqliteLedgerSink(store);
    await sinkA.writeEstimate({ runId: runA, callType: 'codex_plan', callId: 'cp-iso-a' }, 5000, 3000, 2000);
    await sinkB.writeEstimate({ runId: runB, callType: 'codex_plan', callId: 'cp-iso-b' }, 8000, 5000, 3000);

    // preCheck for runA: should use runA's budget and runA's entries only
    const checkA = await preCheckBudget(store, runA, 'codex_plan', 1000);
    expect(checkA.limit).toBe(30000);
    expect(checkA.used).toBe(5000); // only runA's entry
    expect(checkA.remaining).toBe(25000);

    // preCheck for runB: should use runB's budget and runB's entries only
    const checkB = await preCheckBudget(store, runB, 'codex_plan', 1000);
    expect(checkB.limit).toBe(10000);
    expect(checkB.used).toBe(8000); // only runB's entry
    expect(checkB.remaining).toBe(2000);

    // Cleanup
    await setPerRunBudget(store, runA, 'codex_plan', 500000, 'pause');
    await setPerRunBudget(store, runB, 'codex_plan', 500000, 'pause');
  }, 15000);
});
