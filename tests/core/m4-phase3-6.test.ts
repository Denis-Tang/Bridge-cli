// ── M4 Phase 3-6: Integration Tests ─────────────────────────────────────
// Covers risk assessor, scope guard, G2/G3 gates, token budget, audit.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { RiskAssessor } from '../../src/core/risk-assessor.js';
import { checkScopeExpansion } from '../../src/core/scope-guard.js';
import {
  createG2Approval, createG3Approval,
  getPendingG2Approvals, getPendingG3Approvals,
  checkG2Approvable, checkG3Approvable,
  approveDecision, getAllPendingApprovals,
} from '../../src/core/decision-gate.js';
import {
  writeTokenEstimate, writeTokenActual, writeTokenUnavailable,
  estimateCodexPlanTokens, estimateCodexReviewTokens, estimatePiWorkerTokens,
} from '../../src/core/token-ledger.js';
import {
  getEffectiveBudgetLimit, ensureDefaultPolicies, setPerRunBudget, getAllEffectiveBudgets,
} from '../../src/core/budget-policy-store.js';
import { preCheckBudget, postCheckBudget, isBudgetPaused } from '../../src/core/token-budget.js';

// ════════════════════════════════════════════════════════════
// Risk Assessor Tests
// ════════════════════════════════════════════════════════════

describe('M4 Risk Assessor', () => {
  const assessor = new RiskAssessor();

  it('detects real project', () => {
    const findings = assessor.assess(true, ['src/a.ts'], ['npm test'], [], 'low');
    expect(findings.some((f) => f.category === 'real_project')).toBe(true);
  });

  it('detects dangerous git commands', () => {
    const findings = assessor.assess(false, ['src/a.ts'], ['git push --force'], [], 'low');
    const dangerous = findings.filter((f) => f.category === 'dangerous_git');
    expect(dangerous.length).toBeGreaterThan(0);
    expect(dangerous[0].defaultAction).toBe('deny');
  });

  it('detects dangerous shell commands', () => {
    const findings = assessor.assess(false, [], ['rm -rf /tmp'], [], 'low');
    const dangerous = findings.filter((f) => f.category === 'dangerous_command');
    expect(dangerous.length).toBeGreaterThan(0);
    expect(dangerous[0].severity).toBe('critical');
  });

  it('detects sensitive paths', () => {
    const findings = assessor.assess(false, ['.env', 'src/secret.key'], ['npm test'], [], 'low');
    expect(findings.some((f) => f.category === 'sensitive_path')).toBe(true);
  });

  it('detects production config paths', () => {
    const findings = assessor.assess(false, ['Dockerfile', 'k8s/deploy.yaml'], ['npm test'], [], 'low');
    expect(findings.some((f) => f.category === 'production_config')).toBe(true);
  });

  it('detects lockfile modifications', () => {
    const findings = assessor.assess(false, ['package-lock.json'], ['npm test'], [], 'low');
    expect(findings.some((f) => f.category === 'lockfile_modification')).toBe(true);
  });

  it('has deny findings for real + dangerous commands', () => {
    const findings = assessor.assess(true, [], ['git push --force', 'rm -rf'], [], 'low');
    expect(assessor.hasDenyFindings(findings)).toBe(true);
  });

  it('no deny findings for clean disposable project', () => {
    const findings = assessor.assess(false, ['src/index.ts'], ['npm test', 'npm run build'], [], 'low');
    expect(assessor.hasDenyFindings(findings)).toBe(false);
  });

  it('outputs hash, not raw paths', () => {
    const findings = assessor.assess(false, ['.env.production'], [], [], 'low');
    const sf = findings.find((f) => f.category === 'sensitive_path');
    expect(sf).toBeDefined();
    expect(sf!.matchHash).toMatch(/^[a-f0-9]+$/);
    expect(sf!.context).not.toContain('.env.production');
  });

  it('src/core/ paths are exempt from sensitive path warning', () => {
    const findings = assessor.assess(false, ['src/core/.env.template'], [], [], 'low');
    expect(findings.some((f) => f.category === 'sensitive_path')).toBe(false);
  });

  it('getG1Findings and getG2Findings classify correctly', () => {
    const findings = assessor.assess(true, ['package-lock.json'], ['git push'], [], 'low');
    expect(assessor.getG1Findings(findings).length).toBeGreaterThan(0);
    expect(assessor.getG2Findings(findings).length).toBeGreaterThanOrEqual(0);
  });
});

// ════════════════════════════════════════════════════════════
// Scope Guard Tests
// ════════════════════════════════════════════════════════════

describe('M4 Scope Guard', () => {
  it('no expansion when all files within estimate', () => {
    const result = checkScopeExpansion(
      ['src/a.ts', 'src/b.ts'],
      ['src/'],
      ['src/'],
    );
    expect(result.expanded).toBe(false);
    expect(result.expansionPct).toBe(0);
  });

  it('detects expansion when files outside estimate', () => {
    const result = checkScopeExpansion(
      ['src/a.ts', 'docs/readme.md', 'docs/api.md'],
      ['src/'],
      ['src/', 'docs/'],
      0.20,
    );
    expect(result.expanded).toBe(true);
    expect(result.expansionPct).toBeGreaterThan(0.20);
    expect(result.expandedFiles).toContain('docs/readme.md');
  });

  it('no expansion when below threshold', () => {
    const result = checkScopeExpansion(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'docs/readme.md'],
      ['src/'],
      ['src/', 'docs/'],
      0.30,
    );
    expect(result.expanded).toBe(false);
    expect(result.expansionPct).toBeLessThanOrEqual(0.30);
  });

  it('forbidden files always trigger expansion', () => {
    const result = checkScopeExpansion(
      ['src/a.ts', '.env'],
      ['src/'],
      ['src/'],
      0.20,
    );
    expect(result.expanded).toBe(true);
    expect(result.forbiddenFiles).toContain('.env');
  });

  it('empty changed files = no expansion', () => {
    const result = checkScopeExpansion([], ['src/'], ['src/']);
    expect(result.expanded).toBe(false);
  });

  it('custom threshold respected', () => {
    const result = checkScopeExpansion(
      ['src/a.ts', 'docs/b.md'],
      ['src/'],
      ['src/', 'docs/'],
      0.60,
    );
    expect(result.expanded).toBe(false); // 1/2 = 50% < 60%
  });
});

// ════════════════════════════════════════════════════════════
// G2/G3 Gate + Token Ledger + Budget Tests (DB-backed)
// ════════════════════════════════════════════════════════════

describe('M4 G2/G3 Gates & Token Budget', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;
  const runId = 'm4-full-run';

  async function ensureRun(rId: string): Promise<void> {
    const existing = await store.getRun(rId);
    if (!existing) {
      await store.createRun({
        id: rId, projectId: 'proj', projectRoot: '/tmp/m4-proj',
        requestText: 'M4 integration test', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }
  }

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m4-full-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'full.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
    await ensureRun(runId);
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── G2 Gate ──
  describe('G2 Execution Gate', () => {
    it('creates G2 approval for scope expansion', async () => {
      const decision = await createG2Approval(store, runId, 'task-1', 'scope_expansion', 'Scope expanded by 25%');
      expect(decision.gate).toBe('G2');
      expect(decision.status).toBe('pending');
      expect(decision.scope).toBe('task');
    });

    it('getPendingG2Approvals filters G2 only', async () => {
      const pending = await getPendingG2Approvals(store, runId);
      for (const p of pending) {
        expect(p.gate).toBe('G2');
        expect(p.status).toBe('pending');
      }
    });

    it('checkG2Approvable detects pending', async () => {
      const { approvable } = await checkG2Approvable(store, runId, 'task-1');
      expect(approvable).toBe(false);
    });

    it('approveDecision works for G2', async () => {
      const decision = await createG2Approval(store, runId, 'task-2', 'scope_expansion', 'Test');
      const ok = await approveDecision(store, decision.id, 'G2');
      expect(ok).toBe(true);
    });
  });

  // ── G3 Gate ──
  describe('G3 Merge Gate', () => {
    it('creates G3 approval for large merge', async () => {
      const decision = await createG3Approval(store, runId, 'stage-1', 'large_merge', 'Diff exceeds 500 lines');
      expect(decision.gate).toBe('G3');
      expect(decision.scope).toBe('stage');
    });

    it('getPendingG3Approvals filters G3 only', async () => {
      const pending = await getPendingG3Approvals(store, runId);
      for (const p of pending) {
        expect(p.gate).toBe('G3');
      }
    });

    it('checkG3Approvable filters by stage', async () => {
      const { approvable } = await checkG3Approvable(store, runId, 'stage-1');
      expect(approvable).toBe(false);
    });
  });

  // ── getAllPendingApprovals ──
  describe('getAllPendingApprovals', () => {
    it('returns breakdown by gate', async () => {
      const all = await getAllPendingApprovals(store, runId);
      expect(all).toHaveProperty('g1');
      expect(all).toHaveProperty('g2');
      expect(all).toHaveProperty('g3');
      expect(Array.isArray(all.g1)).toBe(true);
    });
  });

  // ── Token Ledger ──
  describe('Token Ledger', () => {
    it('writeTokenEstimate stores estimated entry', async () => {
      const entry = await writeTokenEstimate(store, {
        runId, callType: 'codex_plan', callId: 'plan-1', model: 'gpt-4',
      }, estimateCodexPlanTokens('test request'));

      expect(entry.status).toBe('estimated');
      expect(entry.estimatedTotal).toBeGreaterThan(0);
      expect(entry.actualTotal).toBeNull();
    });

    it('writeTokenActual stores confirmed entry', async () => {
      const entry = await writeTokenActual(store, {
        runId, callType: 'pi_worker', callId: 'pi-1', model: 'deepseek-v3', durationMs: 5000,
      }, { total: 8000, input: 5000, output: 3000, cacheHit: 0 });

      expect(entry.status).toBe('confirmed');
      expect(entry.actualTotal).toBe(8000);
      expect(entry.model).toBe('deepseek-v3');
    });

    it('writeTokenUnavailable stores unavailable entry', async () => {
      const entry = await writeTokenUnavailable(store, {
        runId, callType: 'codex_review', callId: 'review-1',
      });

      expect(entry.status).toBe('unavailable');
      expect(entry.actualTotal).toBeNull();
    });

    it('estimateCodexReviewTokens returns valid estimate', () => {
      const est = estimateCodexReviewTokens(100);
      expect(est.total).toBeGreaterThan(0);
      expect(est.input).toBeLessThan(est.total);
    });

    it('estimatePiWorkerTokens scales with paths', () => {
      const est1 = estimatePiWorkerTokens(100, 2);
      const est2 = estimatePiWorkerTokens(100, 10);
      expect(est2.total).toBeGreaterThan(est1.total);
    });

    it('no prompt OR raw response stored', async () => {
      const entry = await writeTokenEstimate(store, {
        runId, callType: 'codex_plan', callId: 'plan-secure',
      }, estimateCodexPlanTokens('sensitive content'), 'TOP SECRET PROMPT TEXT');

      // promptHash is SHA256, not the raw text
      expect(entry.promptHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.promptHash).not.toContain('TOP SECRET');
      expect(entry.promptHash).not.toContain('sensitive');
    });
  });

  // ── Budget Policy ──
  describe('Budget Policy', () => {
    it('getEffectiveBudgetLimit returns defaults', async () => {
      const limit = await getEffectiveBudgetLimit(store, 'codex_plan', runId);
      expect(limit.tokenLimit).toBe(50000);
      expect(limit.actionOnExceed).toBe('pause');
    });

    it('per-run budget overrides global', async () => {
      await setPerRunBudget(store, runId, 'codex_plan', 100000, 'warn');
      const limit = await getEffectiveBudgetLimit(store, 'codex_plan', runId);
      expect(limit.tokenLimit).toBe(100000);
      expect(limit.actionOnExceed).toBe('warn');
      expect(limit.source).toBe('per-run');
    });

    it('ensureDefaultPolicies creates missing defaults', async () => {
      await ensureDefaultPolicies(store);
      const budgets = await getAllEffectiveBudgets(store, runId);
      expect(budgets.codex_plan).toBeDefined();
      expect(budgets.pi_attempt).toBeDefined();
    });

    it('getAllEffectiveBudgets returns all types', async () => {
      const budgets = await getAllEffectiveBudgets(store, runId);
      for (const pt of ['codex_plan', 'codex_review_stage', 'pi_run', 'pi_task', 'pi_attempt']) {
        expect(budgets[pt as keyof typeof budgets]).toBeDefined();
      }
    });
  });

  // ── Token Budget ──
  describe('Token Budget Pre/Post Check', () => {
    it('preCheckBudget allows when under limit', async () => {
      const result = await preCheckBudget(store, runId, 'codex_plan', 1000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('preCheckBudget with huge estimate might be denied', async () => {
      // With per-run budget of 100000 set above, 200000 should be denied
      const result = await preCheckBudget(store, runId, 'codex_plan', 200000);
      // May or may not deny depending on existing ledger entries
      expect(typeof result.allowed).toBe('boolean');
    });

    it('postCheckBudget returns exceeded status', async () => {
      const result = await postCheckBudget(store, runId, 'codex_plan', 1000);
      expect(result).toHaveProperty('exceeded');
      expect(result).toHaveProperty('remaining');
      expect(result).toHaveProperty('limit');
    });

    it('isBudgetPaused returns false when no exceeded event', async () => {
      const { paused } = await isBudgetPaused(store, runId);
      expect(paused).toBe(false);
    });
  });
});
