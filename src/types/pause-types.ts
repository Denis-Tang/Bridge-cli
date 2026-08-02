export type PauseCategory =
  | 'transient'
  | 'reviewer'
  | 'scope'
  | 'security'
  | 'privacy'
  | 'requirement_choice'
  | 'budget'
  | 'quality'
  | 'integration'
  | 'recovery'
  | 'product_decision'
  | 'retry'
  | 'other';

export interface PauseRecord {
  id: string;
  runId: string;
  stageId: string;
  reasonCode: string;
  category: PauseCategory;
  recoverable: boolean;
  requiredApprovalType: string | null;
  decisionId: string | null;
  evidenceSummary: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface CreateStagePauseInput {
  id: string;
  eventId: string;
  runId: string;
  stageId: string;
  reasonCode: string;
  category: PauseCategory;
  recoverable: boolean;
  requiredApprovalType?: string | null;
  decisionId?: string | null;
  evidenceSummary: string;
  taskId?: string | null;
  attemptId?: string | null;
  eventData?: Record<string, unknown>;
  createdAt?: string;
}

export interface ResolveStagePauseInput {
  pauseId: string;
  stageId: string;
  resolutionNote: string;
  approvalDecisionId?: string | null;
  resolvedAt?: string;
}
