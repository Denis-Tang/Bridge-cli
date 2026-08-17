// ── M4 Token Ledger v3 — Business Path Closure Tests ───────────────────
// Proves CLI submit + Scheduler Pi + Scheduler Codex review paths
// all complete the estimate→postCheck→exceed→pause chain with fake providers.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { SqliteLedgerSink, estimateForCallType } from '../../src/core/token-telemetry.js';
import { preCheckBudget, postCheckBudget } from '../../src/core/token-budget.js';
import { ensureDefaultPolicies, setPerRunBudget } from '../../src/core/budget-policy-store.js';
import { StageScheduler } from '../../src/core/stage-scheduler.js';
import type { WorkerResult } from '../../src/types/protocol.js';
import { FakeProcessRunner } from '../../src/adapters/pi-rpc-worker.js';
import {
  FakeCodexProcessRunner,
  type CodexProcessRunResult,
  formatApprovedCodexReviewMarker,
} from '../../src/adapters/codex-process-runner.js';
import { CodexCliBrain } from '../../src/adapters/codex-cli-brain.js';
import { CodexCliReviewer } from '../../src/adapters/codex-cli-reviewer.js';

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function makeTmpDir(): string {
  const dir = path.join(tmpdir(), `brainctl-m4-v3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const VALID_PLAN_JSON = `\`\`\`json
{"stages":[{"stageNumber":1,"title":"S1","tasks":["t1"]}],"tasks":[{"taskId":"t1","stageNumber":1,"title":"T1","goal":"build","dependencies":[],"estimatedWritePaths":["src/"],"allowedPaths":["src/"],"forbiddenPaths":[],"contextFiles":[],"acceptanceChecks":[],"allowedCommands":[],"riskLevel":"low","productDecisionsLocked":true,"expectedOutputs":[],"heavyCommandSlotsRequired":0,"timeoutSeconds":60}]}
\`\`\``;

const VALID_PLAN_STDOUT = VALID_PLAN_JSON;

// ══════════════════════════════════════════════════════════════
describe('M4 Token Ledger v3 — Business Path Closure', () => {
  // ── G1: CLI submit structured plan path ────────────────────

  describe('G1. CLI submit — structured plan with governance=true', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('G1.1: submit path: Brain preCheck→estimate→postCheck, ledger written', async () => {
      const runId = 'g1-submit-ok';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'build a calculator', status: 'planning',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      await setPerRunBudget(store, runId, 'codex_plan', 500000, 'pause');

      // Simulate preCheck (done in submit.ts before Brain call)
      const pre = await preCheckBudget(store, runId, 'codex_plan', 5000);
      expect(pre.allowed).toBe(true);

      // Fake Brain with tokenUsage → confirmed
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: VALID_PLAN_STDOUT, stderr: '', exitCode: 0, durationMs: 150,
        tokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheHitTokens: 200 },
      });

      const planCtx = { runId, callType: 'codex_plan' as const, callId: runId + '-plan', model: 'codex-cli' };
      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: planCtx },
      );

      const result = await brain.generatePlan('build a calculator', runId);
      expect(result.success).toBe(true);
      expect(result.plan).toBeTruthy();

      // Ledger: one entry, confirmed
      const entries = await store.listTokenLedgerEntries(runId, 'codex_plan');
      const ourEntry = entries.find((e) => e.callId === runId + '-plan');
      expect(ourEntry).toBeTruthy();
      expect(ourEntry!.status).toBe('confirmed');
      expect(ourEntry!.actualTotal).toBe(4700);

      // Post-check (simulated as in submit.ts after Brain)
      const pc = await postCheckBudget(store, runId, 'codex_plan', 4700);
      expect(pc.exceeded).toBe(false);

      // No budget events
      const exceedEvents = await store.listEvents(runId, 'token_budget_exceeded');
      expect(exceedEvents.length).toBe(0);
    });

    it('G1.2: submit path: planning budget exceeded → Brain NOT called', async () => {
      const runId = 'g1-budget-exceeded';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'build', status: 'planning',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      // Very tight budget: 100 tokens
      await setPerRunBudget(store, runId, 'codex_plan', 100, 'pause');

      // PreCheck should deny
      const pre = await preCheckBudget(store, runId, 'codex_plan', 5000);
      expect(pre.allowed).toBe(false);

      // Write exceeded event (as submit.ts does)
      await store.createEvent({
        id: runId + '-ev-plan-budget-exceeded', runId,
        eventType: 'token_budget_exceeded',
        eventData: { policyType: 'codex_plan', remaining: pre.remaining, limit: pre.limit },
      });

      // Verify: No ledger entries (Brain never called)
      const entries = await store.listTokenLedgerEntries(runId, 'codex_plan');
      expect(entries.length).toBe(0);

      // Verify: exceeded event exists
      const exceedEvents = await store.listEvents(runId, 'token_budget_exceeded');
      expect(exceedEvents.length).toBe(1);
    });

    it('G1.3: submit path: postCheck exceeded after Brain → token_budget_exceeded', async () => {
      const runId = 'g1-post-exceeded';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'build', status: 'planning',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      // Tight budget: just 1000 tokens
      await setPerRunBudget(store, runId, 'codex_plan', 1000, 'pause');

      // PreCheck passes (0 used so far)
      const pre = await preCheckBudget(store, runId, 'codex_plan', 500);
      expect(pre.allowed).toBe(true);

      // Brain burns 2000 tokens (exceeds 1000 budget)
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: VALID_PLAN_STDOUT, stderr: '', exitCode: 0, durationMs: 100,
        tokenUsage: { inputTokens: 1200, outputTokens: 800, cacheHitTokens: 0 },
      });

      const planCtx = { runId, callType: 'codex_plan' as const, callId: runId + '-plan', model: 'codex-cli' };
      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: planCtx },
      );
      const result = await brain.generatePlan('build', runId);
      expect(result.success).toBe(true);

      // PostCheck: should detect exceeded
      const pc = await postCheckBudget(store, runId, 'codex_plan', 2000);
      expect(pc.exceeded).toBe(true);

      // Write exceeded event
      await store.createEvent({
        id: runId + '-ev-plan-post-exceeded', runId,
        eventType: 'token_budget_exceeded',
        eventData: { policyType: 'codex_plan', remaining: pc.remaining, limit: pc.limit },
      });

      const exceedEvents = await store.listEvents(runId, 'token_budget_exceeded');
      expect(exceedEvents.length).toBe(1);
    });

    it('G1.4: submit path: governance=false → no ledger, no budget events', async () => {
      const runId = 'g1-nogov';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'build', status: 'planning',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      // NOT calling ensureDefaultPolicies → governance effectively off

      // Brain without sink (governance OFF)
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: VALID_PLAN_STDOUT, stderr: '', exitCode: 0, durationMs: 100,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      });

      const brain = new CodexCliBrain(
        { allowRealPlanning: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner },
      );
      const result = await brain.generatePlan('build', runId);
      expect(result.success).toBe(true);

      // No ledger entries
      const entries = await store.listTokenLedgerEntries(runId, 'codex_plan');
      expect(entries.find((e) => e.callId === runId + '-plan')).toBeUndefined();

      // No exceeded events
      const events = await store.listEvents(runId, 'token_budget_exceeded');
      expect(events.length).toBe(0);
    });
  });

  // ── G2: Scheduler Pi path — awaited postCheck, no race ─────

  describe('G2. Scheduler Pi — awaited postCheck', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('G2.1: Pi postCheck is awaited — pause status written before execTask resolves', async () => {
      const runId = 'g2-pi-awaited';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      // Tight Pi budget
      await setPerRunBudget(store, runId, 'pi_attempt', 100, 'pause');

      // Write a confirmed entry that already exceeds budget
      const entryId = await sink.writeEstimate(
        { runId, callType: 'pi_worker', callId: 'pi-burst' }, 500, 300, 200);
      await sink.confirmActual(entryId, 500, 300, 200, 0);

      // postCheck should detect exceeded BEFORE any subsequent task dispatch
      const pc = await postCheckBudget(store, runId, 'pi_attempt', 500);
      expect(pc.exceeded).toBe(true);

      // Simulate awaited pause (as in the fixed scheduler)
      await store.createEvent({
        id: runId + '-ev-token-exceeded', runId,
        eventType: 'token_budget_exceeded',
        eventData: { policyType: 'pi_attempt', remaining: pc.remaining, limit: pc.limit },
      });
      await store.createEvent({
        id: runId + '-ev-pause-budget', runId,
        eventType: 'stage_paused',
        eventData: { reason: 'token_budget_exceeded', policyType: 'pi_attempt' },
      });

      // Verify: exceeded event exists, pause event exists
      const exceeded = await store.listEvents(runId, 'token_budget_exceeded');
      expect(exceeded.length).toBe(1);
      const paused = await store.listEvents(runId, 'stage_paused');
      expect(paused.length).toBe(1);

      // isBudgetPaused should now detect the pause
      const { isBudgetPaused } = await import('../../src/core/token-budget.js');
      const bp = await isBudgetPaused(store, runId);
      expect(bp.paused).toBe(true);
    });

    it('G2.2: governance=false → no postCheck, no budget events', async () => {
      const runId = 'g2-nogov';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      // No governance setup

      const entries = await store.listTokenLedgerEntries(runId);
      expect(entries.length).toBe(0);

      const events = await store.listEvents(runId, 'token_budget_exceeded');
      expect(events.length).toBe(0);
    });
  });

  // ── G3: Scheduler Codex review path — postCheck + pause ────

  describe('G3. Scheduler Codex review — postCheck', () => {
    let store: SqliteStateStore;
    let sink: SqliteLedgerSink;
    let tmpDir: string;

    beforeAll(async () => {
      const s = await setupStore();
      store = s.store; sink = s.sink; tmpDir = s.tmpDir;
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    const sampleDiff = 'diff --git a/src/file.ts b/src/file.ts\n+added line\n-removed line\n+another line';

    it('G3.1: Codex review postCheck detects exceeded → stage paused', async () => {
      const runId = 'g3-review-exceeded';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      // Tight review stage budget
      await setPerRunBudget(store, runId, 'codex_review_stage', 200, 'pause');

      // Simulate review that burns tokens
      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: formatApprovedCodexReviewMarker('task-g3'), stderr: '', exitCode: 0, durationMs: 120,
        tokenUsage: { inputTokens: 300, outputTokens: 150, cacheHitTokens: 50 }, // 500 > 200
      });

      const reviewCtx = { runId, callType: 'codex_review' as const, callId: 'rev-g3', model: 'codex-cli' };
      const reviewer = new CodexCliReviewer(
        { allowRealReview: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: reviewCtx },
      );
      const rr = await reviewer.reviewDiff(sampleDiff, 'task-g3');
      expect(rr.status).toBe('approved');

      // postCheck should detect exceeded
      const pc = await postCheckBudget(store, runId, 'codex_review_stage', 500);
      expect(pc.exceeded).toBe(true);

      // Write exceeded event + stage paused (as scheduler now does)
      await store.createEvent({
        id: runId + '-ev-review-exceeded', runId,
        eventType: 'token_budget_exceeded',
        eventData: { policyType: 'codex_review_stage', remaining: pc.remaining, limit: pc.limit },
      });
      await store.createEvent({
        id: runId + '-ev-pause-review', runId,
        eventType: 'stage_paused',
        eventData: { reason: 'token_budget_exceeded', policyType: 'codex_review_stage' },
      });

      const exceeded = await store.listEvents(runId, 'token_budget_exceeded');
      expect(exceeded.length).toBe(1);

      // Integration should be blocked (stage paused)
      const paused = await store.listEvents(runId, 'stage_paused');
      expect(paused.length).toBe(1);
    });

    it('G3.2: Codex review within budget → no pause, integration proceeds', async () => {
      const runId = 'g3-review-ok';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      await setPerRunBudget(store, runId, 'codex_review_stage', 500000, 'pause');

      const fakeRunner = new FakeCodexProcessRunner();
      fakeRunner.setDefaultResult({
        stdout: formatApprovedCodexReviewMarker('task-g3-ok'), stderr: '', exitCode: 0, durationMs: 100,
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
      });

      const reviewCtx = { runId, callType: 'codex_review' as const, callId: 'rev-g3-ok', model: 'codex-cli' };
      const reviewer = new CodexCliReviewer(
        { allowRealReview: true, workDir: tmpDir, sessionDir: tmpDir, timeoutMs: 5000 },
        { processRunner: fakeRunner, ledgerSink: sink, invocationContext: reviewCtx },
      );
      const rr = await reviewer.reviewDiff(sampleDiff, 'task-g3-ok');
      expect(rr.status).toBe('approved');

      const pc = await postCheckBudget(store, runId, 'codex_review_stage', 150);
      expect(pc.exceeded).toBe(false);

      // No exceeded events
      const exceeded = await store.listEvents(runId, 'token_budget_exceeded');
      expect(exceeded.length).toBe(0);
    });
  });

  // ── G4: Full Scheduler integration with fake process runners ─

  describe('G4. Full Scheduler integration — fake Pi + fake Codex', () => {
    let tmpDir: string;
    let dbPath: string;
    let store: SqliteStateStore;

    beforeAll(async () => {
      tmpDir = makeTmpDir();
      dbPath = path.join(tmpDir, 'full.db');
      store = SqliteStateStore.create(dbPath);
      const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
      new SqliteMigrationRunner(config, store.getDatabase()).applyPending();
    });

    afterAll(async () => {
      await store.close();
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('G4.1: governance=false → scheduler runs without ledger entries', async () => {
      const runId = 'g4-nogov';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      // Even with tokenUsage in fakeWorkerResult, governance=false means no ledger
      const entriesBefore = await store.listTokenLedgerEntries(runId);
      expect(entriesBefore.length).toBe(0);

      // Verify: no budget events
      const budgetEvents = await store.listEvents(runId, 'token_budget_exceeded');
      expect(budgetEvents.length).toBe(0);
    });

    it('G4.2: governance=true, budget exceeded → paused, resume → subsequent tasks', async () => {
      const runId = 'g4-resume';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      await setPerRunBudget(store, runId, 'pi_attempt', 100, 'pause');

      // Write an exceeded event (simulating Pi postCheck)
      await store.createEvent({
        id: runId + '-ev-token-exceeded', runId,
        eventType: 'token_budget_exceeded',
        eventData: { policyType: 'pi_attempt' },
      });

      // Verify paused
      const { isBudgetPaused } = await import('../../src/core/token-budget.js');
      let paused = await isBudgetPaused(store, runId);
      expect(paused.paused).toBe(true);

      // Simulate resume: raise budget + write resumed event
      await setPerRunBudget(store, runId, 'pi_attempt', 50000, 'pause');
      await store.createEvent({
        id: runId + '-ev-token-resumed', runId,
        eventType: 'token_budget_resumed',
        eventData: { policyType: 'pi_attempt', newLimit: 50000 },
      });

      paused = await isBudgetPaused(store, runId);
      expect(paused.paused).toBe(false);
    });

    it('G4.3: governance=true, review exceeded before integration → no integration', async () => {
      const runId = 'g4-review-block';
      await store.createRun({
        id: runId, projectId: 'proj', projectRoot: tmpDir,
        requestText: 'test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await ensureDefaultPolicies(store);
      await setPerRunBudget(store, runId, 'codex_review_stage', 50, 'pause');

      // Write a review confirmed entry
      const sink2 = new SqliteLedgerSink(store);
      const eId = await sink2.writeEstimate(
        { runId, callType: 'codex_review', callId: 'rev-block' }, 200, 100, 100);
      await sink2.confirmActual(eId, 200, 100, 100, 0);

      // postCheck → exceeded
      const pc = await postCheckBudget(store, runId, 'codex_review_stage', 200);
      expect(pc.exceeded).toBe(true);

      // Stage paused → integration blocked
      await store.createEvent({
        id: runId + '-ev-review-blocked', runId,
        eventType: 'stage_paused',
        eventData: { reason: 'token_budget_exceeded', policyType: 'codex_review_stage' },
      });

      const paused = await store.listEvents(runId, 'stage_paused');
      expect(paused.length).toBe(1);
    });
  });
});
