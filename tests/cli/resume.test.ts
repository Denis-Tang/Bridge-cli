import { describe, expect, it } from 'vitest';
import {
  requireMatchingPauseConfirmation,
  isCostBudgetPauseReason,
  validateProductDecisionResume,
} from '../../src/cli/commands/resume.js';
import type { PauseRecord } from '../../src/types/pause-types.js';

const activePause: PauseRecord = {
  id: 'pause-123', runId: 'run-1', stageId: 'stage-1',
  reasonCode: 'temporary_failure', category: 'transient', recoverable: true,
  requiredApprovalType: null, decisionId: null, evidenceSummary: 'sha256:evidence',
  createdAt: '2026-08-02T00:00:00.000Z', resolvedAt: null, resolutionNote: null,
};

const productDecisionPause: PauseRecord = {
  id: 'pause-pd', runId: 'run-1', stageId: 'stage-1',
  reasonCode: 'product_decision_required', category: 'product_decision', recoverable: true,
  requiredApprovalType: 'product_decision', decisionId: 'decision-pd',
  evidenceSummary: 'sha256:pd', createdAt: '2026-08-02T00:00:00.000Z',
  resolvedAt: null, resolutionNote: null,
};

describe('resume pause confirmation', () => {
  it('rejects a missing --confirm-pause for a paused Stage', () => {
    expect(() => requireMatchingPauseConfirmation(activePause, undefined))
      .toThrow(/--confirm-pause pause-123/);
  });

  it('rejects an incorrect or stale pause id', () => {
    expect(() => requireMatchingPauseConfirmation(activePause, 'pause-old'))
      .toThrow(/pause id.*不匹配|does not match/i);
  });

  it('returns the active record only for the exact pause id', () => {
    expect(requireMatchingPauseConfirmation(activePause, 'pause-123')).toBe(activePause);
  });

  it('fails closed for a legacy paused Stage without a PauseRecord', () => {
    expect(() => requireMatchingPauseConfirmation(null, 'pause-123'))
      .toThrow(/PauseRecord|结构化暂停记录/);
  });
});

describe('product_decision resume validation', () => {
  it('requires exact --approve before accepting a decision note', () => {
    expect(() => validateProductDecisionResume(productDecisionPause, {
      approve: 'decision-other',
      decisionNote: '  valid note  ',
    })).toThrow(/--approve.*decision-pd/);
  });

  it('rejects a missing or blank --decision-note even with exact --approve', () => {
    expect(() => validateProductDecisionResume(productDecisionPause, {
      approve: 'decision-pd',
      decisionNote: '   ',
    })).toThrow(/--decision-note/);
  });

  it('returns the trimmed note only for exact approve + nonblank note', () => {
    expect(validateProductDecisionResume(productDecisionPause, {
      approve: 'decision-pd',
      decisionNote: '  approved answer  ',
    })).toBe('approved answer');
  });

  it('fails closed when the product_decision pause has no decisionId', () => {
    const missingDecision = { ...productDecisionPause, decisionId: null };
    expect(() => validateProductDecisionResume(missingDecision, {
      approve: undefined,
      decisionNote: 'note',
    })).toThrow(/decisionId/);
  });

  it('does not gate non-product pauses on --approve/--decision-note', () => {
    expect(validateProductDecisionResume(activePause, {
      approve: undefined,
      decisionNote: '  ignored  ',
    })).toBe('ignored');
  });
});

describe('cost-budget pause detection (H3b)', () => {
  it('flags cost (amount) budget pause reason codes', () => {
    expect(isCostBudgetPauseReason('cost_budget_exceeded')).toBe(true);
    expect(isCostBudgetPauseReason('cost_ledger_unavailable')).toBe(true);
    expect(isCostBudgetPauseReason('cost_budget_missing')).toBe(true);
    expect(isCostBudgetPauseReason('cost_budget_exceeded: 10 requested, 5 remaining')).toBe(true);
  });

  it('does not flag token-budget or unrelated pauses', () => {
    expect(isCostBudgetPauseReason('token_budget_exceeded')).toBe(false);
    expect(isCostBudgetPauseReason('temporary_failure')).toBe(false);
    expect(isCostBudgetPauseReason(null)).toBe(false);
    expect(isCostBudgetPauseReason(undefined)).toBe(false);
    expect(isCostBudgetPauseReason('')).toBe(false);
  });
});
