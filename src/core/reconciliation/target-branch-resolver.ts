// ── M5 Integration Target Branch Resolver ────────────────────────────────
// Integration batches predate an explicit target-branch column. The
// scheduler's per-stage integration events are therefore the only persisted
// source that can prove which target was used. Never guess a default branch.

import type { EventRecord } from '../../types/m2-types.js';

const TARGET_BRANCH_EVENT_TYPES = new Set([
  'integration_completed',
  'integration_conflict',
  'stage_completed',
]);

/**
 * Recover the target branch for one integration batch from its stage events.
 * Missing or malformed evidence is deliberately represented as null.
 */
export function resolveIntegrationTargetBranch(
  events: readonly EventRecord[],
  stageId: string,
  integrationBranch: string,
): string | null {
  for (const event of [...events].reverse()) {
    if (event.stageId !== stageId || !TARGET_BRANCH_EVENT_TYPES.has(event.eventType)) continue;

    const data = parseEventData(event.eventDataJson);
    if (!data) continue;

    const targetBranch = data.targetBranch;
    if (typeof targetBranch !== 'string' || targetBranch.trim().length === 0) continue;

    // When present, the branch must belong to this batch rather than a
    // historical integration event on the same stage.
    if (typeof data.integrationBranch === 'string' && data.integrationBranch !== integrationBranch) continue;

    return targetBranch.trim();
  }

  return null;
}

function parseEventData(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const data: unknown = JSON.parse(value);
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
