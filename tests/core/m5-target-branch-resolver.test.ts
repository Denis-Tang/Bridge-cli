import { describe, expect, it } from 'vitest';
import { resolveIntegrationTargetBranch } from '../../src/core/reconciliation/target-branch-resolver.js';
import type { EventRecord } from '../../src/types/m2-types.js';

function event(
  id: string,
  stageId: string | null,
  eventType: string,
  eventData: unknown,
): EventRecord {
  return {
    id,
    runId: 'run-1',
    stageId,
    taskId: null,
    attemptId: null,
    eventType,
    eventDataJson: eventData === null ? null : JSON.stringify(eventData),
    createdAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('M5 integration target branch resolution', () => {
  it('uses the latest matching stage event instead of assuming main', () => {
    const targetBranch = resolveIntegrationTargetBranch([
      event('old', 'stage-1', 'integration_completed', {
        integrationBranch: 'integration/old', targetBranch: 'main',
      }),
      event('wanted', 'stage-1', 'integration_completed', {
        integrationBranch: 'integration/current', targetBranch: 'release/2026.07',
      }),
      event('other-stage', 'stage-2', 'integration_completed', {
        integrationBranch: 'integration/current', targetBranch: 'develop',
      }),
    ], 'stage-1', 'integration/current');

    expect(targetBranch).toBe('release/2026.07');
  });

  it('returns null when persisted events cannot prove the target branch', () => {
    const targetBranch = resolveIntegrationTargetBranch([
      event('malformed-shape', 'stage-1', 'integration_completed', { targetBranch: 42 }),
      event('irrelevant', 'stage-1', 'plan_created', { targetBranch: 'main' }),
    ], 'stage-1', 'integration/current');

    expect(targetBranch).toBeNull();
  });
});
