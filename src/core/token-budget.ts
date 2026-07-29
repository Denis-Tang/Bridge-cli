// ── M4 Token Budget — Budget pre-check & exceed handling ──────────────
// Hard pause on exceed. Must explicitly raise budget to resume.
// Never kills running Pi. Budget paused ≠ M3 resource paused.

import type { StateStore } from '../state/state-store.js';
import type { PolicyType } from '../types/m4-types.js';
import { getEffectiveBudgetLimit } from './budget-policy-store.js';

export interface BudgetCheckResult {
  /** Whether the estimated usage fits within remaining budget */
  allowed: boolean;
  /** Remaining budget after this call */
  remaining: number;
  /** Budget limit */
  limit: number;
  /** Estimated usage for this call */
  estimated: number;
  /** Used so far (from ledger) */
  used: number;
  /** Action on exceed */
  actionOnExceed: string;
  /** Reason if not allowed */
  reason?: string;
}

/**
 * Pre-check: can we start a new call given the current usage?
 * Checks estimated tokens against remaining budget.
 * Returns BudgetCheckResult.allowed = false if estimate exceeds remaining.
 */
export async function preCheckBudget(
  store: StateStore,
  runId: string,
  policyType: PolicyType,
  estimate: number,
): Promise<BudgetCheckResult> {
  const limit = await getEffectiveBudgetLimit(store, policyType, runId);
  const summary = await store.getTokenUsageSummary(runId);

  // Effective usage: sum of per-entry effective values (each entry counted once).
  // summary.actual = sum of confirmed actuals; summary.estimated = sum of pending estimates.
  let used = 0;
  if (policyType === 'codex_plan') used = summary.codexPlan.actual + summary.codexPlan.estimated;
  else if (policyType === 'codex_review_stage' || policyType === 'stage_review') used = summary.codexReview.actual + summary.codexReview.estimated;
  else if (policyType === 'pi_run' || policyType === 'pi_task' || policyType === 'pi_attempt') {
    used = summary.piWorker.actual + summary.piWorker.estimated;
  }

  const remaining = limit.tokenLimit - used;
  const allowed = estimate <= remaining;

  return {
    allowed,
    remaining: Math.max(0, remaining),
    limit: limit.tokenLimit,
    estimated: estimate,
    used,
    actionOnExceed: limit.actionOnExceed,
    reason: allowed ? undefined : `Estimated ${estimate} tokens exceeds remaining ${remaining}/${limit.tokenLimit}`,
  };
}

/**
 * Post-check: after a call completes, check if we've exceeded budget.
 * Returns true if exceeded. Does NOT kill any running processes.
 */
export async function postCheckBudget(
  store: StateStore,
  runId: string,
  policyType: PolicyType,
  actualTokens: number,
): Promise<{ exceeded: boolean; remaining: number; limit: number }> {
  const limit = await getEffectiveBudgetLimit(store, policyType, runId);
  const summary = await store.getTokenUsageSummary(runId);

  let used = 0;
  if (policyType === 'codex_plan') used = summary.codexPlan.actual + summary.codexPlan.estimated;
  else if (policyType === 'codex_review_stage' || policyType === 'stage_review') used = summary.codexReview.actual + summary.codexReview.estimated;
  else used = summary.piWorker.actual + summary.piWorker.estimated;

  const remaining = limit.tokenLimit - used;

  return {
    exceeded: remaining < 0,
    remaining: Math.max(0, remaining),
    limit: limit.tokenLimit,
  };
}

/**
 * Check if a run is currently in a token-budget paused state.
 * Token pause is distinct from M3 resource pause.
 */
export async function isBudgetPaused(
  store: StateStore,
  runId: string,
): Promise<{ paused: boolean; policyType?: PolicyType; reason?: string }> {
  const events = await store.listEvents(runId, 'token_budget_exceeded');
  const resumeEvents = await store.listEvents(runId, 'token_budget_resumed');

  if (events.length === 0) return { paused: false };

  const lastExceeded = events[events.length - 1];
  const lastResumed = resumeEvents.length > 0 ? resumeEvents[resumeEvents.length - 1] : null;

  const exceededTime = new Date(lastExceeded.createdAt).getTime();
  const resumedTime = lastResumed ? new Date(lastResumed.createdAt).getTime() : 0;

  if (exceededTime > resumedTime) {
    // Parse event data for policy type
    let policyType: PolicyType | undefined;
    try {
      if (lastExceeded.eventDataJson) {
        const data = JSON.parse(lastExceeded.eventDataJson);
        policyType = data.policyType;
      }
    } catch { /* */ }
    return {
      paused: true,
      policyType,
      reason: 'Token budget exceeded — must raise limit explicitly to resume',
    };
  }

  return { paused: false };
}
