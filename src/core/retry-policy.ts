// ══════════════════════════════════════════════════════════════════════════
// Retry Policy — 有限重试与失败状态收敛 (P0-3)
// ══════════════════════════════════════════════════════════════════════════
//
// 语义：
//   maxReworkCount = 2 → 初次 attempt 之外最多再施工 2 次 → 最多 3 个 attempt
//
// 所有 worker/scope/quality/review 拒绝都计入 attempt 失败，
// 但是否允许 retry 由本策略统一决定。
//
// 分类原则：结构化、fail-closed。未知失败默认不可重试。

/** 结构化失败分类 */
export const FailureCategory = {
  /** 瞬态 / worker 临时故障 — 可有限重试 */
  TRANSIENT: 'transient',
  /** 质量门失败 — 可有限重试 */
  QUALITY: 'quality',
  /** 审查拒绝 / 返工要求 — 可有限重试 */
  REVIEW: 'review',
  /** 范围违规 — 不可自动重试 */
  SCOPE: 'scope',
  /** 安全阻断 — 不可自动重试 */
  SECURITY: 'security',
  /** 隐私阻断 — 不可自动重试 */
  PRIVACY: 'privacy',
  /** 需要产品决策 — 不可自动重试 */
  PRODUCT_DECISION: 'product_decision',
  /** 用户取消 — 不可自动重试 */
  CANCEL: 'cancel',
  /** 不可验证 diff / 完成证据缺失 — 不可自动重试 */
  UNVERIFIABLE: 'unverifiable',
  /** 恢复时数据损坏 — 不可自动重试 */
  DATA_CORRUPTION: 'data_corruption',
  /** 未知 / 未识别失败 — fail-closed，不可自动重试 */
  UNKNOWN: 'unknown',
} as const;

export type FailureCategory = (typeof FailureCategory)[keyof typeof FailureCategory];

/** 分类结果 */
export interface ClassifiedFailure {
  /** 是否可重试 */
  retriable: boolean;
  /** 分类原因（机器可读） */
  reason: string;
  /** 失败类别 */
  category: FailureCategory;
}

/** 重试预算检查结果 */
export interface RetryBudgetResult {
  /** 是否允许继续创建 attempt */
  allowed: boolean;
  /** 不允许的原因 */
  reason: string;
  /** 剩余可重试次数（不含本次） */
  remainingRetries: number;
  /** 下一个 attempt 的序号 */
  retryOrdinal: number;
  /** 重试预算是否已耗尽 */
  exhausted: boolean;
  /** 失败分类（仅当 allowed=false 时有意义） */
  failureCategory?: FailureCategory;
}

/**
 * Retriable 类别集合：仅这些类别允许重试。
 * 不在集合中的类别一律不可重试（fail-closed）。
 */
const RETRIABLE_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  FailureCategory.TRANSIENT,
  FailureCategory.QUALITY,
  FailureCategory.REVIEW,
]);

/**
 * 根据 attempt 状态和退出原因进行结构化失败分类。
 *
 * 匹配顺序：
 *   1. 明确 fatal 的 exitReason 前缀 → 对应 non-retriable 类别
 *   2. 明确 transient 的 exitReason 前缀 → transient
 *   3. 质量门失败 → quality
 *   4. 审查拒绝 → review
 *   5. attempt 状态 fallback
 *   6. 默认：unknown（fail-closed）
 *
 * 注意：状态 fallback `rework_required` 和 `failed` 不再默认重试。
 * 必须由明确的 exitReason 前缀匹配到已知 retriable 类别才允许重试。
 */
export function classifyFailure(
  attemptStatus: string,
  exitReason: string | undefined,
): ClassifiedFailure {
  const reason = exitReason || '';

  // ── 1. Non-retriable: product decision ────────────────────────────
  if (reason.startsWith('product_decision:')) {
    return { retriable: false, reason: 'product_decision_required', category: FailureCategory.PRODUCT_DECISION };
  }

  // ── 2. Non-retriable: privacy ─────────────────────────────────────
  if (reason.startsWith('privacy:')) {
    return { retriable: false, reason: 'privacy_blocked', category: FailureCategory.PRIVACY };
  }

  // ── 3. Non-retriable: security ────────────────────────────────────
  if (reason.startsWith('security:')) {
    return { retriable: false, reason: 'security_blocked', category: FailureCategory.SECURITY };
  }

  // ── 4. Non-retriable: cancel ──────────────────────────────────────
  if (reason.startsWith('canceled:')) {
    return { retriable: false, reason: 'canceled', category: FailureCategory.CANCEL };
  }
  if (reason === 'canceled') {
    return { retriable: false, reason: 'canceled', category: FailureCategory.CANCEL };
  }

  // ── 5. Non-retriable: scope violation ─────────────────────────────
  if (reason.startsWith('scope:')) {
    return { retriable: false, reason: 'scope_violation', category: FailureCategory.SCOPE };
  }

  // ── 6. Non-retriable: unverifiable diff ───────────────────────────
  if (
    reason.startsWith('unverifiable') ||
    reason.includes('worker_completed_without_verifiable_diff') ||
    reason.includes('expected_write_missing') ||
    reason.includes('real_reviewer_empty_diff')
  ) {
    return { retriable: false, reason: 'unverifiable_diff', category: FailureCategory.UNVERIFIABLE };
  }

  // ── 7. Non-retriable: resume data corruption ──────────────────────
  if (reason.startsWith('resume:')) {
    if (reason.includes('worktree missing') || reason.includes('workerResult missing') || reason.includes('path_lock_invalid')) {
      return { retriable: false, reason: 'resume_data_corrupted', category: FailureCategory.DATA_CORRUPTION };
    }
    return { retriable: false, reason: 'resume_failed', category: FailureCategory.DATA_CORRUPTION };
  }

  // ── 8. Non-retriable: Pi clarification tool policy violation ───────
  if (reason.startsWith('clarification_required') && reason.includes('Pi 澄清工具策略违规')) {
    return { retriable: false, reason: 'clarification_policy_violation', category: FailureCategory.SECURITY };
  }

  // ── 9. Retriable: clarification protocol/uncertainty without a user question ──
  // The 95% gate still fails closed, but a fresh bounded attempt may read again.
  // Actual user questions remain product_decision and are handled above.
  if (reason.startsWith('clarification_required:')) {
    return { retriable: true, reason: 'clarification_retry_required', category: FailureCategory.TRANSIENT };
  }

  // ── 10. Non-retriable: blocked / needs_decision ───────────────────
  if (reason.startsWith('blocked:')) {
    return { retriable: false, reason: 'worker_blocked', category: FailureCategory.PRODUCT_DECISION };
  }

  // ── 10. Non-retriable: no quality gates configured ────────────────
  if (reason.startsWith('no_quality_gates_configured')) {
    return { retriable: false, reason: 'no_quality_gates_configured', category: FailureCategory.UNKNOWN };
  }

  // ── 11. Retriable: worktree failure ───────────────────────────────
  if (reason.startsWith('wt_fail:')) {
    return { retriable: true, reason: 'worktree_failure', category: FailureCategory.TRANSIENT };
  }

  // ── 12. Retriable: worker result missing ──────────────────────────
  if (reason.startsWith('worker_result_missing') || reason.includes('worker_result_missing')) {
    return { retriable: true, reason: 'worker_result_missing', category: FailureCategory.TRANSIENT };
  }

  // ── 12b. Retriable: no-change completion evidence failures ────────
  // The worker claimed a no-change completion but its worktree was dirty or the
  // evidence could not be verified (e.g. it edited files without committing).
  // A fresh bounded attempt can redo the task properly, so these are retriable.
  if (reason.includes('worker_completed_worktree_dirty_without_diff')
    || reason.includes('worker_completed_evidence_unverifiable')) {
    return { retriable: true, reason: 'no_change_evidence_failed', category: FailureCategory.TRANSIENT };
  }

  // ── 13. Retriable: exception (unhandled throw in execTask) ────────
  // Only explicit `exception:` prefix from catch block is retriable;
  // other unknown paths are fail-closed.
  if (reason.startsWith('exception:')) {
    return { retriable: true, reason: 'exec_task_exception', category: FailureCategory.TRANSIENT };
  }

  // ── 14. Retriable: quality gate failure ───────────────────────────
  if (reason.startsWith('qg_failed:')) {
    return { retriable: true, reason: 'quality_gate_failure', category: FailureCategory.QUALITY };
  }

  // ── 15. Retriable: review rejection ───────────────────────────────
  if (reason.startsWith('review:')) {
    return { retriable: true, reason: 'review_rejection', category: FailureCategory.REVIEW };
  }

  // ── 16. Attempt status fallback — explicit rework_required with no reason ──
  if (attemptStatus === 'rework_required') {
    // rework_required without a reason prefix → review rejection (retriable)
    return { retriable: true, reason: 'rework_required_no_reason', category: FailureCategory.REVIEW };
  }

  // ── 17. Default: unknown — fail-closed ────────────────────────────
  // Any unrecognized failure pattern, including `failed` status with no
  // matching exitReason, is treated as non-retriable to prevent infinite loops.
  return { retriable: false, reason: 'unrecognized_failure', category: FailureCategory.UNKNOWN };
}

/**
 * 根据 WorkerResult 综合判断是否允许重试。
 * 同时检查 productDecisionRequired 等 Worker 返回的标记。
 */
export function classifyFailureFromWorkerResult(
  attemptStatus: string,
  exitReason: string | undefined,
  productDecisionRequired: boolean,
): ClassifiedFailure {
  if (productDecisionRequired) {
    return { retriable: false, reason: 'product_decision_required', category: FailureCategory.PRODUCT_DECISION };
  }
  return classifyFailure(attemptStatus, exitReason);
}

// ══════════════════════════════════════════════════════════════════════════
// 向后兼容 wrappers — 保留旧 API 给现有调用者
// ══════════════════════════════════════════════════════════════════════════

/** @deprecated 使用 classifyFailure() 代替 */
export interface RetryDecision {
  retry: boolean;
  reason: string;
  category: string;
}

/** @deprecated 使用 classifyFailure() 代替 */
export function shouldRetry(
  attemptStatus: string,
  exitReason: string | undefined,
): RetryDecision {
  const result = classifyFailure(attemptStatus, exitReason);
  return { retry: result.retriable, reason: result.reason, category: result.category };
}

/** @deprecated 使用 classifyFailureFromWorkerResult() 代替 */
export function shouldRetryFromWorkerResult(
  attemptStatus: string,
  exitReason: string | undefined,
  productDecisionRequired: boolean,
): RetryDecision {
  const result = classifyFailureFromWorkerResult(attemptStatus, exitReason, productDecisionRequired);
  return { retry: result.retriable, reason: result.reason, category: result.category };
}

/**
 * 根据 maxReworkCount 计算最多允许的 attempt 数量。
 * maxReworkCount=2 → 初次 + 最多 2 次返工 → 最多 3 个 attempt。
 */
export function maxAllowedAttempts(maxReworkCount: number): number {
  return maxReworkCount + 1;
}

/**
 * 检查任务是否允许继续创建 attempt。
 *
 * 使用真实 attempt 记录计数的 attempt 预算。
 * resume 不能重置或绕过耗尽状态。
 *
 * @param existingAttempts 已有的所有 attempt（按 attemptNumber 升序）
 * @param maxReworkCount 配置的 maxReworkCount
 * @param latestAttemptStatus 最新 attempt 的状态
 * @param exitReason 最新 attempt 的退出原因
 */
export function checkRetryBudget(
  existingAttempts: Array<{ status: string; exitReason?: string | null }>,
  maxReworkCount: number,
  latestAttemptStatus: string,
  exitReason: string | undefined,
): RetryBudgetResult {
  const maxAllowed = maxAllowedAttempts(maxReworkCount);

  // Count meaningful attempts — exclude canceled and interrupted
  const nonCanceledAttempts = existingAttempts.filter(
    (a) => a.status !== 'canceled' && a.status !== 'interrupted',
  );
  const currentCount = nonCanceledAttempts.length;

  // Remaining = max allowed total - current count
  const remainingRetries = Math.max(0, maxAllowed - currentCount);

  // Budget exhausted by count alone?
  if (currentCount >= maxAllowed) {
    return {
      allowed: false,
      reason: `retry_budget_exhausted: ${currentCount}/${maxAllowed} attempts used`,
      remainingRetries: 0,
      retryOrdinal: currentCount,
      exhausted: true,
      failureCategory: FailureCategory.UNKNOWN,
    };
  }

  // Check structured failure classification
  const classification = classifyFailure(latestAttemptStatus, exitReason);

  if (!classification.retriable) {
    return {
      allowed: false,
      reason: `non_retriable: ${classification.reason}`,
      remainingRetries,
      retryOrdinal: currentCount,
      exhausted: false,
      failureCategory: classification.category,
    };
  }

  return {
    allowed: true,
    reason: classification.reason,
    remainingRetries,
    retryOrdinal: currentCount + 1, // next attempt ordinal
    exhausted: false,
    failureCategory: classification.category,
  };
}
