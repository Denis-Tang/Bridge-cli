import { describe, expect, it } from 'vitest';
import { requireMatchingPauseConfirmation } from '../../src/cli/commands/resume.js';
import type { PauseRecord } from '../../src/types/pause-types.js';

const activePause: PauseRecord = {
  id: 'pause-123', runId: 'run-1', stageId: 'stage-1',
  reasonCode: 'temporary_failure', category: 'transient', recoverable: true,
  requiredApprovalType: null, decisionId: null, evidenceSummary: 'sha256:evidence',
  createdAt: '2026-08-02T00:00:00.000Z', resolvedAt: null, resolutionNote: null,
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
