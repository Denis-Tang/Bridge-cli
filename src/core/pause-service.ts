import type { StateStore } from '../state/state-store.js';
import type {
  CreateStagePauseInput,
  PauseRecord,
  ResolveStagePauseInput,
} from '../types/pause-types.js';

export async function pauseStage(
  store: StateStore,
  input: CreateStagePauseInput,
): Promise<PauseRecord> {
  let decisionId = input.decisionId ?? null;
  if (input.requiredApprovalType && !decisionId) {
    decisionId = `${input.runId}-pause-${input.stageId}-${input.requiredApprovalType}-${Date.now()}`;
    const gate = isIntegrationApproval(input.requiredApprovalType) ? 'G3' : 'G2';
    await store.createApprovalDecision({
      id: decisionId,
      runId: input.runId,
      gate,
      decisionType: input.requiredApprovalType,
      scope: gate === 'G3' ? 'stage' : 'single_action',
      status: 'pending',
      approvedBy: 'user',
      expiresAt: null,
      metadata: {
        stageId: input.stageId,
        pauseId: input.id,
        reasonCode: input.reasonCode,
      },
    });
  }
  return store.createStagePause({ ...input, decisionId });
}

export async function resolveStagePause(
  store: StateStore,
  input: ResolveStagePauseInput,
): Promise<boolean> {
  if (!input.resolutionNote.trim()) {
    throw new Error('resolutionNote is required to resolve a Stage pause');
  }
  return store.resolveStagePause(input);
}

function isIntegrationApproval(type: string): boolean {
  return [
    'large_merge',
    'stage_budget_override',
    'conflict_resolution',
    'prod_config_touch',
  ].includes(type);
}
