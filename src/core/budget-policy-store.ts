// ── M4 Budget Policy Store — Budget limits & priority resolution ─────────
// Priority: per-run > global. Default policies from contract §5.2.

import type { StateStore } from '../state/state-store.js';
import type { BudgetPolicy, PolicyType, OnExceedAction } from '../types/m4-types.js';
import { DEFAULT_BUDGETS } from '../types/m4-types.js';

export interface BudgetLimit {
  policyType: PolicyType;
  tokenLimit: number;
  actionOnExceed: OnExceedAction;
  source: 'global' | 'per-run';
}

const DEFAULT_POLICIES: Record<PolicyType, BudgetLimit> = {
  codex_plan: { policyType: 'codex_plan', tokenLimit: DEFAULT_BUDGETS.codexPlan, actionOnExceed: 'pause', source: 'global' },
  codex_review_stage: { policyType: 'codex_review_stage', tokenLimit: DEFAULT_BUDGETS.codexReviewPerStage, actionOnExceed: 'pause', source: 'global' },
  stage_review: { policyType: 'stage_review', tokenLimit: DEFAULT_BUDGETS.stageReview, actionOnExceed: 'pause', source: 'global' },
  pi_run: { policyType: 'pi_run', tokenLimit: DEFAULT_BUDGETS.piRun, actionOnExceed: 'pause', source: 'global' },
  pi_task: { policyType: 'pi_task', tokenLimit: DEFAULT_BUDGETS.piTask, actionOnExceed: 'pause', source: 'global' },
  pi_attempt: { policyType: 'pi_attempt', tokenLimit: DEFAULT_BUDGETS.piAttempt, actionOnExceed: 'pause', source: 'global' },
};

let budgetPolicyIdSeq = 0;

/**
 * Get the effective budget limit for a policy type.
 * Checks per-run policies first, then global, then hardcoded defaults.
 */
export async function getEffectiveBudgetLimit(
  store: StateStore,
  policyType: PolicyType,
  runId?: string | null,
): Promise<BudgetLimit> {
  // Check for explicit policy in SQLite
  const policy = await store.getEffectiveBudgetPolicy(policyType, runId || undefined);
  if (policy) {
    return {
      policyType: policy.policyType as PolicyType,
      tokenLimit: policy.tokenLimit,
      actionOnExceed: policy.actionOnExceed as OnExceedAction,
      source: policy.runId ? 'per-run' : 'global',
    };
  }
  return { ...DEFAULT_POLICIES[policyType] };
}

/**
 * Ensure default global policies exist in the database.
 * Creates them if they don't exist (idempotent — uses safe INSERT OR IGNORE pattern via catch).
 */
export async function ensureDefaultPolicies(store: StateStore): Promise<void> {
  for (const [pt, limit] of Object.entries(DEFAULT_POLICIES)) {
    try {
      const existing = await store.getEffectiveBudgetPolicy(pt, undefined);
      if (!existing) {
        await store.createBudgetPolicy({
          id: `global-${pt}`,
          scope: 'global',
          policyType: pt,
          tokenLimit: limit.tokenLimit,
          actionOnExceed: limit.actionOnExceed,
        });
      }
    } catch { /* policy may already exist — safe to skip */ }
  }
}

/**
 * Set a per-run budget override.
 */
export async function setPerRunBudget(
  store: StateStore,
  runId: string,
  policyType: PolicyType,
  tokenLimit: number,
  actionOnExceed: OnExceedAction = 'pause',
): Promise<BudgetPolicy> {
  return store.createBudgetPolicy({
    id: `${runId}-budget-${policyType}-${Date.now()}-${budgetPolicyIdSeq++}`,
    runId,
    scope: 'run',
    policyType,
    tokenLimit,
    actionOnExceed,
  });
}

/**
 * Get all effective budgets for a run (used for status/audit display).
 */
export async function getAllEffectiveBudgets(
  store: StateStore,
  runId?: string | null,
): Promise<Record<PolicyType, BudgetLimit>> {
  const result: Record<string, BudgetLimit> = {};
  for (const pt of Object.keys(DEFAULT_POLICIES) as PolicyType[]) {
    result[pt] = await getEffectiveBudgetLimit(store, pt, runId);
  }
  return result as Record<PolicyType, BudgetLimit>;
}
