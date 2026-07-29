// ── Core protocol types for the orchestrator ─────────────────────────────

export interface JobRequest {
  jobId: string;
  projectId: string;
  projectRoot: string;
  requestText: string;
  submittedBy?: string;
  createdAt: string;
  constraints?: {
    productDecisionsLocked?: boolean;
    allowHighRiskOperations?: boolean;
  };
}

export interface BrainPlan {
  jobId: string;
  summary: string;
  tasks: string[];
  dependencies: Array<{ from: string; to: string }>;
  parallelGroups: string[][];
  decisionRequests: string[];
  riskAssessment: {
    level: 'low' | 'medium' | 'high';
    notes: string[];
  };
}

export interface TaskSpec {
  taskId: string;
  title: string;
  goal: string;
  dependencies: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  contextFiles: string[];
  acceptanceChecks: string[];
  allowedCommands: string[];
  riskLevel: 'low' | 'medium' | 'high';
  productDecisionsLocked: boolean;
  expectedOutputs: string[];
  heavyCommandSlotsRequired: number;
  timeoutSeconds: number;
}

export type WorkerResultStatus = 'completed' | 'failed' | 'blocked' | 'needs_decision' | 'scope_violation';

export interface WorkerResult {
  taskId: string;
  status: WorkerResultStatus;
  summary: string;
  filesChanged: string[];
  commitHash?: string;
  checks: Array<{ name: string; status: string; summary: string }>;
  scopeViolations: string[];
  risks: string[];
  unresolvedQuestions: string[];
  productDecisionRequired: boolean;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
  };
}

export type ReviewStatus = 'approved' | 'rework_required' | 'rejected' | 'needs_user_decision';

export interface ReviewResult {
  taskId: string;
  status: ReviewStatus;
  reviewSummary: string;
  findings: string[];
  requiredRework: string[];
  qualityGateStatus: string;
  mergeAllowed: boolean;
  /** Reviewer identifier: 'local-rule', 'codex-cli', 'codex-sdk' */
  reviewer?: string;
}

export interface DecisionRequest {
  decisionId: string;
  jobId: string;
  taskIds: string[];
  type: 'product_experience' | 'high_risk_operation';
  question: string;
  options: Array<{ id: string; label: string; impact: string }>;
  blockingScope: 'affected_tasks_only' | 'all_tasks';
  createdAt: string;
}

export type MergeStatus = 'merged' | 'conflict' | 'failed' | 'skipped';

export interface MergeResult {
  taskId: string;
  status: MergeStatus;
  sourceBranch: string;
  targetBranch: string;
  commitHash?: string;
  mergeCommitHash?: string;
  conflicts: string[];
  mergedAt: string;
}

export type RunSummaryStatus = 'planning' | 'running' | 'completed' | 'failed' | 'canceled';

export interface RunSummary {
  jobId: string;
  status: RunSummaryStatus;
  summary: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  decisionsResolved: number;
  mergedCommits: string[];
  qualityGateSummary: string;
  knownLimitations: string[];
  finishedAt: string;
}
