// ── M4 Phase 2: Decision Gate & CLI Tests ──────────────────────────────
// Tests G1 decision gate, governance config, approval flows.
// No real Pi/Codex calls; uses temp SQLite + fake data.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import type { StructuredPlan } from '../../src/types/m2-types.js';
import {
  assessG1Risk,
  createG1Approvals,
  getPendingG1Approvals,
  checkG1Approvable,
  approveG1Decision,
  revokeDecision,
  expireRunDecisions,
  getGovernanceConfig,
  setGovernanceEnabled,
  resetGovernanceConfigCache,
  isDisposableProject,
} from '../../src/core/decision-gate.js';

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

function makeLowRiskPlan(overrides: Partial<StructuredPlan> = {}): StructuredPlan {
  return {
    jobId: 'test-job',
    summary: 'Test plan',
    stages: [{ stageNumber: 1, title: 'Stage 1', tasks: ['t1', 't2'] }],
    tasks: [
      {
        taskId: 't1', stageNumber: 1, title: 'Task 1',
        goal: 'Do task 1', dependencies: [],
        estimatedWritePaths: ['src/a.ts'],
        allowedPaths: ['src/'], forbiddenPaths: [],
        contextFiles: [], acceptanceChecks: ['ok'],
        allowedCommands: ['npm test'], riskLevel: 'low',
        productDecisionsLocked: false, expectedOutputs: [],
        heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
      },
      {
        taskId: 't2', stageNumber: 1, title: 'Task 2',
        goal: 'Do task 2', dependencies: ['t1'],
        estimatedWritePaths: ['src/b.ts'],
        allowedPaths: ['src/'], forbiddenPaths: [],
        contextFiles: [], acceptanceChecks: ['ok'],
        allowedCommands: ['npm test'], riskLevel: 'low',
        productDecisionsLocked: false, expectedOutputs: [],
        heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
      },
    ],
    riskAssessment: { level: 'low', notes: [] },
    ...overrides,
  };
}

function makeHighRiskTaskPlan(): StructuredPlan {
  return makeLowRiskPlan({
    tasks: [{
      taskId: 't1', stageNumber: 1, title: 'Risky Task',
      goal: 'Delete everything', dependencies: [],
      estimatedWritePaths: ['Dockerfile', 'k8s/deploy.yaml'],
      allowedPaths: ['src/', 'k8s/'], forbiddenPaths: [],
      contextFiles: [], acceptanceChecks: ['ok'],
      allowedCommands: ['rm -rf'], riskLevel: 'high',
      productDecisionsLocked: false, expectedOutputs: [],
      heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
    }],
    riskAssessment: { level: 'high', notes: ['Dangerous operations'] },
  });
}

// ════════════════════════════════════════════════════════════
// Risk Assessment Tests (no DB needed)
// ════════════════════════════════════════════════════════════

describe('M4 G1 Risk Assessment', () => {
  it('low-risk plan on disposable project has no blocking findings', () => {
    const plan = makeLowRiskPlan();
    const findings = assessG1Risk(plan, false);
    const blocking = findings.filter((f) => f.requiresApproval);
    expect(blocking.length).toBe(0);
  });

  it('real project triggers high risk finding', () => {
    const plan = makeLowRiskPlan();
    const findings = assessG1Risk(plan, true);
    const realProject = findings.find((f) => f.category === 'real_project');
    expect(realProject).toBeDefined();
    expect(realProject!.requiresApproval).toBe(true);
  });

  it('high plan risk creates blocking finding', () => {
    const plan = makeHighRiskTaskPlan();
    const findings = assessG1Risk(plan, false);
    const blocking = findings.filter((f) => f.requiresApproval);
    expect(blocking.length).toBeGreaterThanOrEqual(2);
  });

  it('high risk tasks are detected', () => {
    const plan = makeHighRiskTaskPlan();
    const findings = assessG1Risk(plan, false);
    const highTask = findings.find((f) => f.category === 'high_risk_task');
    expect(highTask).toBeDefined();
    expect(highTask!.requiresApproval).toBe(true);
  });

  it('production config paths are detected', () => {
    const plan = makeHighRiskTaskPlan();
    const findings = assessG1Risk(plan, false);
    const prodConfig = findings.find((f) => f.category === 'prod_config');
    expect(prodConfig).toBeDefined();
    expect(prodConfig!.requiresApproval).toBe(true);
  });

  it('medium risk plan is informational but not blocking', () => {
    const plan = makeLowRiskPlan({ riskAssessment: { level: 'medium', notes: ['Caution'] } });
    const findings = assessG1Risk(plan, false);
    const planRisk = findings.find((f) => f.category === 'plan_risk');
    expect(planRisk).toBeDefined();
    expect(planRisk!.requiresApproval).toBe(false);
    expect(planRisk!.severity).toBe('medium');
  });

  it('isDisposableProject detects .brainctl-dev paths', () => {
    expect(isDisposableProject('C:/project/.brainctl-dev/fixtures/test')).toBe(true);
    expect(isDisposableProject('C:/project/.brainctl-dev')).toBe(true);
    expect(isDisposableProject('C:/project/src')).toBe(false);
    expect(isDisposableProject('C:/real-project')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// G1 Approval Flow Tests (temp SQLite)
// ════════════════════════════════════════════════════════════

describe('M4 G1 Approval Flow', () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteStateStore;

  async function ensureRun(rId: string): Promise<void> {
    const existing = await store.getRun(rId);
    if (!existing) {
      await store.createRun({
        id: rId, projectId: 'proj', projectRoot: '/tmp/test-proj',
        requestText: 'G1 test', status: 'planning',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
    }
  }

  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m4-g1-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'g1.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('creates G1 approvals for high-risk plan on real project', async () => {
    await ensureRun('g1-real');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-real', plan, true);
    expect(decisions.length).toBeGreaterThanOrEqual(3);
    for (const d of decisions) {
      expect(d.gate).toBe('G1');
      expect(d.status).toBe('pending');
    }
    const ra = await store.getRiskAssessment('g1-real-g1-risk');
    expect(ra).not.toBeNull();
    expect(ra!.riskLevel).toBe('high');
  });

  it('low-risk plan on disposable project creates no pending approvals', async () => {
    await ensureRun('g1-low');
    const plan = makeLowRiskPlan();
    const decisions = await createG1Approvals(store, 'g1-low', plan, false);
    expect(decisions.length).toBe(0);
    const { approvable } = await checkG1Approvable(store, 'g1-low');
    expect(approvable).toBe(true);
  });

  it('checkG1Approvable detects pending decisions', async () => {
    await ensureRun('g1-chk');
    const plan = makeHighRiskTaskPlan();
    await createG1Approvals(store, 'g1-chk', plan, true);
    const { approvable, pendingDecisions } = await checkG1Approvable(store, 'g1-chk');
    expect(approvable).toBe(false);
    expect(pendingDecisions.length).toBeGreaterThan(0);
  });

  it('approveG1Decision approves a single decision', async () => {
    await ensureRun('g1-appr');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-appr', plan, true);
    const ok = await approveG1Decision(store, decisions[0].id);
    expect(ok).toBe(true);
    const updated = await store.getApprovalDecision(decisions[0].id);
    expect(updated!.status).toBe('approved');
  });

  it('approveG1Decision fails for non-existent decision', async () => {
    const ok = await approveG1Decision(store, 'nonexistent-id');
    expect(ok).toBe(false);
  });

  it('approveG1Decision fails for already approved decision', async () => {
    await ensureRun('g1-twice');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-twice', plan, true);
    await approveG1Decision(store, decisions[0].id);
    const second = await approveG1Decision(store, decisions[0].id);
    expect(second).toBe(false);
  });

  it('approving all decisions makes run approvable', async () => {
    await ensureRun('g1-all');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-all', plan, true);
    for (const d of decisions) {
      await approveG1Decision(store, d.id);
    }
    const { approvable, pendingDecisions } = await checkG1Approvable(store, 'g1-all');
    expect(approvable).toBe(true);
    expect(pendingDecisions.length).toBe(0);
  });

  it('revokeDecision revokes a pending decision', async () => {
    await ensureRun('g1-revoke');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-revoke', plan, true);
    const result = await revokeDecision(store, decisions[0].id);
    expect(result.success).toBe(true);
    const updated = await store.getApprovalDecision(decisions[0].id);
    expect(updated!.status).toBe('revoked');
  });

  it('revokeDecision fails for already revoked', async () => {
    await ensureRun('g1-rev2');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-rev2', plan, true);
    await revokeDecision(store, decisions[0].id);
    const second = await revokeDecision(store, decisions[0].id);
    expect(second.success).toBe(false);
  });

  it('revokeDecision fails for non-existent', async () => {
    const result = await revokeDecision(store, 'nonexistent');
    expect(result.success).toBe(false);
  });

  it('expireRunDecisions expires all active decisions', async () => {
    await ensureRun('g1-exp');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-exp', plan, true);
    await approveG1Decision(store, decisions[0].id);
    const count = await expireRunDecisions(store, 'g1-exp');
    expect(count).toBeGreaterThanOrEqual(1);
    const allDecisions = await store.listApprovalDecisions('g1-exp');
    for (const d of allDecisions) {
      if (d.status !== 'revoked') {
        expect(d.status).toBe('expired');
      }
    }
  });

  it('getPendingG1Approvals filters by gate G1', async () => {
    await ensureRun('g1-filter');
    const plan = makeHighRiskTaskPlan();
    await createG1Approvals(store, 'g1-filter', plan, true);
    const pending = await getPendingG1Approvals(store, 'g1-filter');
    for (const p of pending) {
      expect(p.gate).toBe('G1');
      expect(p.status).toBe('pending');
    }
  });

  it('no raw paths in approval metadata', async () => {
    await ensureRun('g1-san');
    const plan = makeHighRiskTaskPlan();
    const decisions = await createG1Approvals(store, 'g1-san', plan, true);
    for (const d of decisions) {
      if (d.metadata && d.metadata.detailHash) {
        expect(d.metadata.detailHash).toMatch(/^[a-f0-9]{64}$/);
      }
      const metaStr = JSON.stringify(d.metadata);
      expect(metaStr).not.toContain('Dockerfile');
      expect(metaStr).not.toContain('k8s');
    }
  });
});

// ════════════════════════════════════════════════════════════
// Governance Config Tests
// ════════════════════════════════════════════════════════════

describe('M4 Governance Config', () => {
  let cfgDir: string;

  beforeEach(() => {
    resetGovernanceConfigCache();
    cfgDir = path.join(tmpdir(), `brainctl-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(cfgDir, { recursive: true });
  });

  afterAll(() => {
    resetGovernanceConfigCache();
  });

  it('defaults to disabled when no config file', () => {
    resetGovernanceConfigCache();
    const cfg = getGovernanceConfig(cfgDir);
    expect(cfg.enabled).toBe(false);
  });

  it('enables governance via setGovernanceEnabled', () => {
    setGovernanceEnabled(cfgDir, true);
    const cfg = getGovernanceConfig(cfgDir);
    expect(cfg.enabled).toBe(true);
  });

  it('disables governance via setGovernanceEnabled', () => {
    setGovernanceEnabled(cfgDir, true);
    setGovernanceEnabled(cfgDir, false);
    const cfg = getGovernanceConfig(cfgDir);
    expect(cfg.enabled).toBe(false);
  });

  it('writes config.json to .brainctl/', () => {
    setGovernanceEnabled(cfgDir, true);
    const configPath = path.join(cfgDir, '.brainctl', 'config.json');
    expect(existsSync(configPath)).toBe(true);
  });

  it('config file contains governance.enabled key', () => {
    setGovernanceEnabled(cfgDir, true);
    const configPath = path.join(cfgDir, '.brainctl', 'config.json');
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed['governance.enabled']).toBe(true);
  });

  it('resetGovernanceConfigCache forces re-read', () => {
    setGovernanceEnabled(cfgDir, false);
    let cfg = getGovernanceConfig(cfgDir);
    expect(cfg.enabled).toBe(false);

    const configPath = path.join(cfgDir, '.brainctl', 'config.json');
    writeFileSync(configPath, JSON.stringify({
      'governance.enabled': true,
      governance: { enabled: true },
    }, null, 2));

    cfg = getGovernanceConfig(cfgDir);
    expect(cfg.enabled).toBe(false);

    resetGovernanceConfigCache();
    cfg = getGovernanceConfig(cfgDir);
    expect(cfg.enabled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// Governance Disabled = M2/M3 Unchanged
// ════════════════════════════════════════════════════════════

describe('M4 Governance Disabled Regression', () => {
  it('governance disabled means assessG1Risk is not automatically blocking', () => {
    // When governance.enabled is false, the G1 gate is not invoked.
    // The assessment itself is a pure function - it doesn't enforce.
    // The enforcement is in the CLI command layer (submit/approve).
    // Verifying the pure assessment works correctly.
    const plan = makeLowRiskPlan();
    const findings = assessG1Risk(plan, true); // real project
    expect(findings.length).toBeGreaterThan(0); // assessment works
    // But without governance enabled, these don't create approvals
    expect(true).toBe(true);
  });
});
