// ── M5 Governance Fact Gatherer ─────────────────────────────────────────
// Reads governance state without changing approvals, budgets, or events.

import type { StateStore } from '../../state/state-store.js';
import type { GovernanceFacts } from '../../types/m5-types.js';
import { isBudgetPaused } from '../token-budget.js';

/** Gather the persisted governance facts relevant to reconciliation. */
export async function gatherGovernanceFacts(
  store: StateStore,
  runId: string,
): Promise<GovernanceFacts> {
  const [pendingApprovals, budgetPause] = await Promise.all([
    store.getPendingApprovals(runId),
    isBudgetPaused(store, runId),
  ]);

  if (!budgetPause.paused) {
    return {
      pendingApprovals: pendingApprovals.map((approval) => ({
        approvalId: approval.id,
        gate: approval.gate,
        expiresAt: approval.expiresAt,
      })),
      budget: { paused: false, policyType: null, policyExists: false, hasLedgerUsage: false },
    };
  }

  const [policy, usage] = await Promise.all([
    budgetPause.policyType
      ? store.getEffectiveBudgetPolicy(budgetPause.policyType, runId)
      : Promise.resolve(null),
    store.getTokenUsageSummary(runId),
  ]);

  return {
    pendingApprovals: pendingApprovals.map((approval) => ({
      approvalId: approval.id,
      gate: approval.gate,
      expiresAt: approval.expiresAt,
    })),
    budget: {
      paused: true,
      policyType: budgetPause.policyType ?? null,
      policyExists: policy !== null,
      hasLedgerUsage: hasUsageForPolicy(usage, budgetPause.policyType),
    },
  };
}

function hasUsageForPolicy(
  usage: Awaited<ReturnType<StateStore['getTokenUsageSummary']>>,
  policyType: string | undefined,
): boolean {
  const total = (bucket: { estimated: number; actual: number }) => bucket.estimated + bucket.actual;
  switch (policyType) {
    case 'codex_plan':
      return total(usage.codexPlan) > 0;
    case 'codex_review_stage':
      return total(usage.codexReview) > 0;
    case 'pi_run':
    case 'pi_task':
    case 'pi_attempt':
      return total(usage.piWorker) > 0;
    default:
      return false;
  }
}
