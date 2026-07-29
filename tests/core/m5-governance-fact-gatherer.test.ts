import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';
import { gatherGovernanceFacts } from '../../src/core/reconciliation/governance-fact-gatherer.js';
import { classifyFacts, deriveSafeActions } from '../../src/core/reconciliation/classifier.js';
import type { ReconciliationFactSnapshot } from '../../src/types/m5-types.js';

let tmpDir: string;
let store: SqliteStateStore;

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function facts(runId: string, governance: ReconciliationFactSnapshot['governance']): ReconciliationFactSnapshot {
  return {
    run: {
      runId, runStatus: 'running', projectRootHash: 'sha256:fake', governanceEnabled: true,
      gitHead: 'abc123', gitHeadResolvable: true, mergeConflict: false, conflictFiles: [],
    },
    stages: [],
    governance,
  };
}

describe('M5 governance fact gathering', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m5-gov-facts-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'm5-governance.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    new SqliteMigrationRunner(config, store.getDatabase()).applyPending();
  });

  afterAll(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gathers expired approvals and a budget pause without mutating either', async () => {
    const runId = uid('run');
    const approvalId = uid('approval');
    await store.createRun({
      id: runId, projectId: uid('project'), projectRoot: '/tmp/m5-governance', requestText: 'test',
      status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.createApprovalDecision({
      id: approvalId, runId, gate: 'G2', decisionType: 'scope_expansion', scope: 'task',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await store.createEvent({
      id: uid('budget-pause'), runId, eventType: 'token_budget_exceeded',
      eventData: { policyType: 'pi_run' },
    });

    const governance = await gatherGovernanceFacts(store, runId);
    expect(governance.pendingApprovals).toEqual([
      expect.objectContaining({ approvalId, gate: 'G2' }),
    ]);
    expect(governance.budget).toEqual({
      paused: true, policyType: 'pi_run', policyExists: false, hasLedgerUsage: false,
    });
    expect((await store.getApprovalDecision(approvalId))!.status).toBe('pending');

    const findings = classifyFacts(facts(runId, governance), true);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'approval_expired', entityId: approvalId, severity: 'info' }),
      expect.objectContaining({ kind: 'budget_paused_stale', severity: 'warning' }),
    ]));
    expect(deriveSafeActions(findings)).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionType: 'update_approval_expired', targetEntityId: approvalId }),
    ]));
  });

  it('skips governance findings when governance is disabled', async () => {
    const runId = uid('run');
    const governance = {
      pendingApprovals: [{ approvalId: uid('approval'), gate: 'G1', expiresAt: '2000-01-01T00:00:00.000Z' }],
      budget: { paused: true, policyType: 'pi_run', policyExists: false, hasLedgerUsage: false },
    };

    const findings = classifyFacts(facts(runId, governance), false);
    expect(findings.filter((finding) =>
      finding.kind === 'approval_expired' || finding.kind === 'budget_paused_stale',
    )).toHaveLength(0);
  });
});
