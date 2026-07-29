// ── M4 Store CRUD Tests ─────────────────────────────────────────────────
// Tests approval_decisions, token_ledger, budget_policies, risk_assessments.
// Token ledger tests MUST NOT contain raw prompt text — only SHA256 hashes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { promptHash } from '../../src/utils/sanitize.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('M4 Store — approval_decisions CRUD', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m4-crud-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'm4-crud.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  async function createTestRun(runId: string) {
    return store.createRun({
      id: runId, projectId: 'proj-m4', projectRoot: '/tmp/m4-proj',
      requestText: 'M4 test', status: 'planning',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }

  // ════════════════════════════════════════════════════════════
  // approval_decisions
  // ════════════════════════════════════════════════════════════

  describe('approval_decisions', () => {
    it('creates and retrieves a pending approval', async () => {
      await createTestRun('ad-run-1');
      const ad = await store.createApprovalDecision({
        id: 'ad-001', runId: 'ad-run-1', gate: 'G1',
        decisionType: 'real_project_auth', scope: 'run',
      });
      expect(ad.id).toBe('ad-001');
      expect(ad.gate).toBe('G1');
      expect(ad.status).toBe('pending');
      expect(ad.approvedBy).toBe('user');
      expect(ad.expiresAt).toBeNull();

      const fetched = await store.getApprovalDecision('ad-001');
      expect(fetched).not.toBeNull();
      expect(fetched!.decisionType).toBe('real_project_auth');
    });

    it('approves a decision and updates status', async () => {
      await createTestRun('ad-run-2');
      await store.createApprovalDecision({
        id: 'ad-002', runId: 'ad-run-2', gate: 'G2',
        decisionType: 'scope_expansion', scope: 'task',
        approvedBy: 'user',
        metadata: { paths: ['a', 'b'] },
      });
      const now = new Date().toISOString();
      const ok = await store.updateApprovalDecisionStatus('ad-002', 'approved', now);
      expect(ok).toBe(true);

      const fetched = await store.getApprovalDecision('ad-002');
      expect(fetched!.status).toBe('approved');
      expect(fetched!.metadata).toEqual({ paths: ['a', 'b'] });
    });

    it('denies and revokes decisions', async () => {
      await createTestRun('ad-run-3');
      await store.createApprovalDecision({
        id: 'ad-003', runId: 'ad-run-3', gate: 'G1',
        decisionType: 'high_risk_task', scope: 'task',
      });
      await store.updateApprovalDecisionStatus('ad-003', 'denied', new Date().toISOString());
      expect((await store.getApprovalDecision('ad-003'))!.status).toBe('denied');

      await store.createApprovalDecision({
        id: 'ad-004', runId: 'ad-run-3', gate: 'G3',
        decisionType: 'large_merge', scope: 'single_action',
        status: 'approved', approvedBy: 'auto',
        approvedAt: new Date().toISOString(),
      });
      await store.updateApprovalDecisionStatus('ad-004', 'revoked', new Date().toISOString());
      expect((await store.getApprovalDecision('ad-004'))!.status).toBe('revoked');
    });

    it('lists decisions by run and filters by status', async () => {
      await createTestRun('ad-run-4');
      await store.createApprovalDecision({
        id: 'ad-005', runId: 'ad-run-4', gate: 'G1',
        decisionType: 'run_budget', scope: 'run', status: 'approved',
      });
      await store.createApprovalDecision({
        id: 'ad-006', runId: 'ad-run-4', gate: 'G2',
        decisionType: 'review_budget_override', scope: 'stage', status: 'pending',
      });

      const all = await store.listApprovalDecisions('ad-run-4');
      expect(all.length).toBe(2);

      const pending = await store.listApprovalDecisions('ad-run-4', 'pending');
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe('ad-006');

      // getPendingApprovals shortcut
      const pending2 = await store.getPendingApprovals('ad-run-4');
      expect(pending2.length).toBe(1);
      expect(pending2[0].id).toBe('ad-006');
    });

    it('supports all decision types and scopes', async () => {
      await createTestRun('ad-run-5');
      const types = ['run_budget', 'high_risk_task', 'real_project_auth',
        'scope_expansion', 'review_budget_override', 'stage_budget_override',
        'large_merge', 'prod_config_touch', 'conflict_resolution'] as const;
      const scopes = ['run', 'stage', 'task', 'single_action'] as const;
      const gates = ['G1', 'G2', 'G3'] as const;

      for (let i = 0; i < types.length; i++) {
        await store.createApprovalDecision({
          id: `ad-type-${i}`,
          runId: 'ad-run-5',
          gate: gates[i % 3],
          decisionType: types[i],
          scope: scopes[i % 4],
          status: i % 2 === 0 ? 'pending' : 'approved',
        });
      }

      const all = await store.listApprovalDecisions('ad-run-5');
      expect(all.length).toBe(types.length);
    });
  });

  // ════════════════════════════════════════════════════════════
  // token_ledger
  // ════════════════════════════════════════════════════════════

  describe('token_ledger', () => {
    it('inserts estimated entry with prompt hash (no raw text)', async () => {
      await createTestRun('tl-run-1');
      const hash = promptHash('some-arbitrary-text');
      const entry = await store.insertTokenLedgerEntry({
        id: 'tl-001',
        runId: 'tl-run-1',
        callType: 'codex_plan',
        callId: 'call-abc',
        estimatedTotal: 5000,
        estimatedInput: 3000,
        estimatedOutput: 2000,
        promptHash: hash,
        model: 'gpt-4',
        status: 'estimated',
      });

      expect(entry.id).toBe('tl-001');
      expect(entry.estimatedTotal).toBe(5000);
      expect(entry.promptHash).toBe(hash);
      // Verify: the stored hash is a SHA256 hex string (64 chars)
      expect(entry.promptHash).toMatch(/^[a-f0-9]{64}$/);
      // Actual fields should be null
      expect(entry.actualTotal).toBeNull();
      expect(entry.status).toBe('estimated');
    });

    it('inserts confirmed entry with actual token counts', async () => {
      await createTestRun('tl-run-2');
      const entry = await store.insertTokenLedgerEntry({
        id: 'tl-002',
        runId: 'tl-run-2',
        stageId: 'stg-1',
        taskId: 'tsk-1',
        attemptId: 'att-1',
        callType: 'pi_worker',
        callId: 'pi-session-xyz',
        estimatedTotal: 10000,
        actualTotal: 9876,
        actualInput: 5000,
        actualOutput: 4000,
        actualCacheHit: 876,
        promptHash: promptHash('pi-instruction'),
        model: 'deepseek-v3',
        durationMs: 12345,
        status: 'confirmed',
      });

      expect(entry.actualTotal).toBe(9876);
      expect(entry.actualInput).toBe(5000);
      expect(entry.actualCacheHit).toBe(876);
      expect(entry.model).toBe('deepseek-v3');
      expect(entry.durationMs).toBe(12345);
      expect(entry.status).toBe('confirmed');
    });

    it('inserts unavailable entry (no actual data available)', async () => {
      await createTestRun('tl-run-3');
      const entry = await store.insertTokenLedgerEntry({
        id: 'tl-003',
        runId: 'tl-run-3',
        callType: 'codex_review',
        callId: 'review-1',
        estimatedTotal: 2500,
        promptHash: promptHash('review-prompt'),
        status: 'unavailable',
      });

      expect(entry.status).toBe('unavailable');
      expect(entry.actualTotal).toBeNull();
      expect(entry.estimatedTotal).toBe(2500);
    });

    it('lists entries by run and filters by call type', async () => {
      await createTestRun('tl-run-4');
      await store.insertTokenLedgerEntry({
        id: 'tl-010', runId: 'tl-run-4', callType: 'codex_plan', callId: 'c1',
        estimatedTotal: 100, promptHash: promptHash('p1'), status: 'estimated',
      });
      await store.insertTokenLedgerEntry({
        id: 'tl-011', runId: 'tl-run-4', callType: 'codex_review', callId: 'c2',
        estimatedTotal: 200, promptHash: promptHash('p2'), status: 'estimated',
      });
      await store.insertTokenLedgerEntry({
        id: 'tl-012', runId: 'tl-run-4', callType: 'pi_worker', callId: 'c3',
        estimatedTotal: 300, promptHash: promptHash('p3'), status: 'estimated',
      });

      const all = await store.listTokenLedgerEntries('tl-run-4');
      expect(all.length).toBe(3);

      const plans = await store.listTokenLedgerEntries('tl-run-4', 'codex_plan');
      expect(plans.length).toBe(1);
      expect(plans[0].callType).toBe('codex_plan');
    });

    it('computes token usage summary across call types', async () => {
      await createTestRun('tl-run-5');
      await store.insertTokenLedgerEntry({
        id: 'tl-020', runId: 'tl-run-5', callType: 'codex_plan', callId: 'c1',
        estimatedTotal: 1000, actualTotal: 900, promptHash: promptHash('x1'), status: 'confirmed',
      });
      await store.insertTokenLedgerEntry({
        id: 'tl-021', runId: 'tl-run-5', callType: 'codex_plan', callId: 'c2',
        estimatedTotal: 2000, promptHash: promptHash('x2'), status: 'estimated',
      });
      await store.insertTokenLedgerEntry({
        id: 'tl-022', runId: 'tl-run-5', callType: 'codex_review', callId: 'c3',
        estimatedTotal: 500, actualTotal: 480, promptHash: promptHash('x3'), status: 'confirmed',
      });
      await store.insertTokenLedgerEntry({
        id: 'tl-023', runId: 'tl-run-5', callType: 'pi_worker', callId: 'c4',
        estimatedTotal: 5000, actualTotal: 4800, promptHash: promptHash('x4'), status: 'confirmed',
      });

      const summary = await store.getTokenUsageSummary('tl-run-5');
      // Per-entry effective usage: confirmed uses actual, estimated uses estimate
      // tl-020 confirmed → actual=900, estimated=0
      // tl-021 estimated → actual=0, estimated=2000
      expect(summary.codexPlan.estimated).toBe(2000);
      expect(summary.codexPlan.actual).toBe(900);
      // tl-022 confirmed → actual=480, estimated=0
      expect(summary.codexReview.estimated).toBe(0);
      expect(summary.codexReview.actual).toBe(480);
      // tl-023 confirmed → actual=4800, estimated=0
      expect(summary.piWorker.estimated).toBe(0);
      expect(summary.piWorker.actual).toBe(4800);
      expect(summary.totalEstimated).toBe(2000);
      expect(summary.totalActual).toBe(6180);
    });

    it('never stores raw prompt text — only SHA256 hash', async () => {
      await createTestRun('tl-run-6');
      const entry = await store.insertTokenLedgerEntry({
        id: 'tl-030', runId: 'tl-run-6', callType: 'codex_plan', callId: 'c-hash',
        estimatedTotal: 100, promptHash: promptHash('secret-prompt-content'),
        status: 'estimated',
      });

      // promptHash must be 64-char hex
      expect(entry.promptHash).toMatch(/^[a-f0-9]{64}$/);
      // No raw column should contain the plaintext
      expect(entry.promptHash).not.toContain('secret-prompt-content');

      // Verify DB row has no raw text
      const fetched = await store.getTokenLedgerEntry('tl-030');
      expect(fetched!.promptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(fetched!.promptHash).not.toContain('secret-prompt-content');

      // prompt_hash should NOT be reversible (hash != original)
      expect(promptHash('secret-prompt-content')).not.toBe('secret-prompt-content');
    });
  });

  // ════════════════════════════════════════════════════════════
  // budget_policies
  // ════════════════════════════════════════════════════════════

  describe('budget_policies', () => {
    it('creates global and per-run policies', async () => {
      await createTestRun('bp-run-1');

      // Global policy (run_id = null)
      const global = await store.createBudgetPolicy({
        id: 'bp-global', scope: 'global', policyType: 'pi_attempt',
        tokenLimit: 30000, actionOnExceed: 'pause',
      });
      expect(global.runId).toBeNull();
      expect(global.tokenLimit).toBe(30000);
      expect(global.actionOnExceed).toBe('pause');

      // Per-run policy
      const perRun = await store.createBudgetPolicy({
        id: 'bp-run-1', runId: 'bp-run-1', scope: 'run',
        policyType: 'pi_attempt', tokenLimit: 50000, actionOnExceed: 'warn',
      });
      expect(perRun.runId).toBe('bp-run-1');
      expect(perRun.tokenLimit).toBe(50000);
    });

    it('getEffectiveBudgetPolicy returns per-run over global', async () => {
      await createTestRun('bp-run-2');

      await store.createBudgetPolicy({
        id: 'bp-eff-g', scope: 'global', policyType: 'pi_task',
        tokenLimit: 50000, actionOnExceed: 'pause',
      });
      await store.createBudgetPolicy({
        id: 'bp-eff-r', runId: 'bp-run-2', scope: 'run', policyType: 'pi_task',
        tokenLimit: 100000, actionOnExceed: 'warn',
      });

      const effective = await store.getEffectiveBudgetPolicy('pi_task', 'bp-run-2');
      expect(effective).not.toBeNull();
      // Should return per-run, not global
      expect(effective!.id).toBe('bp-eff-r');
      expect(effective!.tokenLimit).toBe(100000);
    });

    it('getEffectiveBudgetPolicy falls back to global when no per-run', async () => {
      await createTestRun('bp-run-3');

      await store.createBudgetPolicy({
        id: 'bp-only-g', scope: 'global', policyType: 'codex_plan',
        tokenLimit: 50000, actionOnExceed: 'pause',
      });

      const effective = await store.getEffectiveBudgetPolicy('codex_plan', 'bp-run-3');
      expect(effective).not.toBeNull();
      expect(effective!.id).toBe('bp-only-g');
      expect(effective!.runId).toBeNull();
    });

    it('returns null for missing policy type', async () => {
      await createTestRun('bp-run-4');
      const result = await store.getEffectiveBudgetPolicy('nonexistent', 'bp-run-4');
      expect(result).toBeNull();
    });

    it('lists all policies or filters by run', async () => {
      await createTestRun('bp-run-5');

      await store.createBudgetPolicy({
        id: 'bp-l1', scope: 'global', policyType: 'codex_plan', tokenLimit: 50000,
      });
      await store.createBudgetPolicy({
        id: 'bp-l2', runId: 'bp-run-5', scope: 'run', policyType: 'pi_run', tokenLimit: 200000,
      });

      const all = await store.listBudgetPolicies();
      expect(all.length).toBeGreaterThanOrEqual(2);

      const globals = await store.listBudgetPolicies(null);
      expect(globals.length).toBeGreaterThanOrEqual(1);
      for (const g of globals) expect(g.runId).toBeNull();

      const forRun = await store.listBudgetPolicies('bp-run-5');
      // Should include both global and per-run
      expect(forRun.length).toBeGreaterThanOrEqual(2);
    });

    it('updates policy token limit and action', async () => {
      await store.createBudgetPolicy({
        id: 'bp-upd', scope: 'global', policyType: 'pi_attempt', tokenLimit: 10000,
      });
      const ok = await store.updateBudgetPolicy('bp-upd', 50000, 'reject');
      expect(ok).toBe(true);

      const updated = await store.getBudgetPolicy('bp-upd');
      expect(updated!.tokenLimit).toBe(50000);
      expect(updated!.actionOnExceed).toBe('reject');
    });

    it('supports all policy types', async () => {
      const types = ['codex_plan', 'codex_review_stage', 'pi_run', 'pi_task', 'pi_attempt'];
      for (const t of types) {
        await store.createBudgetPolicy({
          id: `bp-${t}`, runId: 'bp-policy-types', scope: 'global',
          policyType: t as any, tokenLimit: 1000,
        });
        const bp = await store.getBudgetPolicy(`bp-${t}`);
        expect(bp!.policyType).toBe(t);
      }
    });
  });

  // ════════════════════════════════════════════════════════════
  // risk_assessments
  // ════════════════════════════════════════════════════════════

  describe('risk_assessments', () => {
    it('creates and retrieves risk assessment', async () => {
      await createTestRun('ra-run-1');
      const ra = await store.createRiskAssessment({
        id: 'ra-001',
        runId: 'ra-run-1',
        assessmentType: 'plan',
        riskLevel: 'medium',
        findingsJson: JSON.stringify([{ category: 'real_project', severity: 'medium' }]),
        trigger: 'auto',
      });

      expect(ra.id).toBe('ra-001');
      expect(ra.riskLevel).toBe('medium');
      expect(ra.assessmentType).toBe('plan');
      expect(ra.resolved).toBe(false);

      const fetched = await store.getRiskAssessment('ra-001');
      expect(fetched).not.toBeNull();
      expect(fetched!.findingsJson).toContain('real_project');
    });

    it('resolves a risk assessment', async () => {
      await createTestRun('ra-run-2');
      await store.createRiskAssessment({
        id: 'ra-002', runId: 'ra-run-2', assessmentType: 'pre_stage',
        riskLevel: 'high', trigger: 'user_request',
      });

      const now = new Date().toISOString();
      await store.resolveRiskAssessment('ra-002', now);

      const fetched = await store.getRiskAssessment('ra-002');
      expect(fetched!.resolved).toBe(true);
      expect(fetched!.resolvedAt).toBe(now);
    });

    it('lists assessments for a run', async () => {
      await createTestRun('ra-run-3');
      await store.createRiskAssessment({
        id: 'ra-010', runId: 'ra-run-3', assessmentType: 'plan',
        riskLevel: 'low', trigger: 'auto',
      });
      await store.createRiskAssessment({
        id: 'ra-011', runId: 'ra-run-3', assessmentType: 'pre_merge',
        riskLevel: 'critical', trigger: 'scope_drift',
      });

      const list = await store.listRiskAssessments('ra-run-3');
      expect(list.length).toBe(2);
      expect(list[0].riskLevel).toBe('low');
      expect(list[1].riskLevel).toBe('critical');
    });

    it('supports all assessment types and risk levels', async () => {
      await createTestRun('ra-run-4');
      const types = ['plan', 'pre_stage', 'pre_merge', 'scope_expansion'] as const;
      const levels = ['low', 'medium', 'high', 'critical'] as const;

      for (let i = 0; i < types.length; i++) {
        await store.createRiskAssessment({
          id: `ra-enum-${i}`, runId: 'ra-run-4',
          assessmentType: types[i], riskLevel: levels[i], trigger: 'auto',
        });
      }

      const list = await store.listRiskAssessments('ra-run-4');
      expect(list.length).toBe(4);
    });

    it('findings_json is optional', async () => {
      await createTestRun('ra-run-5');
      const ra = await store.createRiskAssessment({
        id: 'ra-no-findings', runId: 'ra-run-5',
        assessmentType: 'plan', riskLevel: 'low', trigger: 'auto',
      });
      expect(ra.findingsJson).toBeNull();
    });
  });
});
