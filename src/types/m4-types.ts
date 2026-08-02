// ── M4 Governance Types: Decision Gate, Risk Gate, Token Budget ─────────

// ══════════════════════════════════════════════════════════════
// ApprovalDecision — persisted decision gate record
// ══════════════════════════════════════════════════════════════

export type ApprovalGate = 'G1' | 'G2' | 'G3';

export type DecisionType =
  | 'run_budget'
  | 'high_risk_task'
  | 'real_project_auth'
  | 'scope_expansion'
  | 'review_budget_override'
  | 'stage_budget_override'
  | 'large_merge'
  | 'prod_config_touch'
  | 'conflict_resolution';

export type ApprovalScope = 'run' | 'stage' | 'task' | 'single_action';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';

export type ApprovedBy = 'user' | 'auto';

export interface ApprovalDecision {
  id: string;
  runId: string;
  gate: ApprovalGate;
  decisionType: DecisionType;
  scope: ApprovalScope;
  status: ApprovalStatus;
  approvedBy: ApprovedBy;
  approvedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ══════════════════════════════════════════════════════════════
// TokenLedgerEntry — sanitized token usage record
// ══════════════════════════════════════════════════════════════

export type CallType = 'codex_plan' | 'codex_review' | 'codex_review_skipped' | 'stage_review' | 'pi_worker';

export type LedgerStatus = 'estimated' | 'confirmed' | 'unavailable';

export interface TokenLedgerEntry {
  id: string;
  runId: string;
  stageId: string | null;
  taskId: string | null;
  attemptId: string | null;
  callType: CallType;
  callId: string;
  estimatedTotal: number | null;
  estimatedInput: number | null;
  estimatedOutput: number | null;
  actualTotal: number | null;
  actualInput: number | null;
  actualOutput: number | null;
  actualCacheHit: number | null;
  promptHash: string | null;
  model: string | null;
  durationMs: number | null;
  isSynthetic?: boolean;
  status: LedgerStatus;
  createdAt: string;
}

// ══════════════════════════════════════════════════════════════
// BudgetPolicy — per-run or global budget configuration
// ══════════════════════════════════════════════════════════════

export type PolicyType =
  | 'codex_plan'
  | 'codex_review_stage'
  | 'stage_review'
  | 'pi_run'
  | 'pi_task'
  | 'pi_attempt';

export type BudgetScope = 'global' | 'run' | 'stage';

export type OnExceedAction = 'pause' | 'warn' | 'reject';

export interface BudgetPolicy {
  id: string;
  runId: string | null;       // NULL = global default
  scope: BudgetScope;
  policyType: PolicyType;
  tokenLimit: number;
  actionOnExceed: OnExceedAction;
  createdAt: string;
  updatedAt: string;
}

// ══════════════════════════════════════════════════════════════
// RiskAssessment — risk snapshot at decision points
// ══════════════════════════════════════════════════════════════

export type AssessmentType = 'plan' | 'pre_stage' | 'pre_merge' | 'scope_expansion';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type AssessmentTrigger = 'auto' | 'user_request' | 'scope_drift';

export interface RiskAssessment {
  id: string;
  runId: string;
  stageId: string | null;
  assessmentType: AssessmentType;
  riskLevel: RiskLevel;
  findingsJson: string | null;   // sanitized findings, no raw paths
  trigger: AssessmentTrigger;
  resolved: boolean;             // 0 or 1 in SQLite
  resolvedAt: string | null;
  createdAt: string;
}

// ══════════════════════════════════════════════════════════════
// Default budget values (contract §5.2)
// ══════════════════════════════════════════════════════════════

export const DEFAULT_BUDGETS = {
  codexPlan: 50_000,
  codexReviewPerStage: 30_000,
  stageReview: 30_000,
  piRun: 200_000,
  piTask: 50_000,
  piAttempt: 30_000,
  estimateMovingAvgWindow: 3,
} as const;

// ══════════════════════════════════════════════════════════════
// Budget summary for status display
// ══════════════════════════════════════════════════════════════

export interface TokenBudgetSummary {
  codexPlan: { limit: number; used: number };
  codexReview: { limit: number; used: number };
  pi: { limit: number; used: number };
}

export interface GovernanceStatus {
  enabled: boolean;
  pendingApprovals: number;
}

export interface CostBudgetConfig {
  currency: 'CNY' | 'USD';
  limit: number;
  maxPiCallCost: number;
  maxCodexCallCost: number;
  pricingVersion: string;
}

export interface CostReservation {
  id: string;
  runId: string;
  stageId: string | null;
  taskId: string | null;
  attemptId: string | null;
  callType: CallType;
  callId: string;
  currency: CostBudgetConfig['currency'];
  budgetLimit: number;
  reservedCost: number;
  actualCost: number | null;
  status: 'reserved' | 'confirmed' | 'unavailable' | 'released' | 'written_off';
  pricingVersion: string;
  usageStatus: 'pending' | 'confirmed' | 'unavailable';
  phase: 'reserved' | 'spawned' | 'settled';
  spawnedAt: string | null;
  ownerId: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  terminationEvidence: string | null;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}
