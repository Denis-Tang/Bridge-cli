// ── M5 Lock Validator ────────────────────────────────────────────────────
// Validates lock ownership against attempt, task, run state.
// Pure functions — determines if a lock is orphaned, owner is alive, etc.

import type { AttemptFacts, LockFacts } from '../../types/m5-types.js';

/**
 * Terminal attempt statuses that allow lock release.
 */
const TERMINAL_ATTEMPT_STATUSES = new Set([
  'approved', 'failed', 'interrupted', 'canceled',
]);

/**
 * Determine if a lock is orphaned (owner attempt is terminal).
 */
export function isLockOrphaned(ownerAttemptStatus: string | null): boolean {
  if (!ownerAttemptStatus) return false;
  return TERMINAL_ATTEMPT_STATUSES.has(ownerAttemptStatus);
}

/**
 * Determine if a lock is safely releasable based on owner PID status.
 */
export function isLockSafelyReleasable(
  ownerPidAlive: 'alive' | 'gone' | 'unknown' | 'n/a',
  ownerAttemptStatus: string | null,
): boolean {
  // If owner PID is confirmed gone, safe to release
  if (ownerPidAlive === 'gone') return true;

  // If owner is terminal, safe to release regardless of PID
  if (ownerAttemptStatus && TERMINAL_ATTEMPT_STATUSES.has(ownerAttemptStatus)) return true;

  // If owner PID is alive, NOT safe
  if (ownerPidAlive === 'alive') return false;

  // Unknown/N/A — not safe without more info
  return false;
}

/**
 * Build LockFacts for an active lock.
 */
export function buildLockFacts(
  lockId: string,
  filePathHash: string,
  taskId: string,
  lockType: string,
  lockStatus: string,
  ownerAttemptId: string | null,
  ownerAttemptStatus: string | null,
  ownerPidAlive: 'alive' | 'gone' | 'unknown' | 'n/a',
  ownerRunStatus: string | null,
): LockFacts {
  return {
    lockId,
    filePathHash,
    taskId,
    lockType,
    lockStatus,
    ownerAttemptId,
    ownerAttemptStatus,
    ownerPidAlive,
    ownerRunStatus,
  };
}

/**
 * Detect lock conflicts: same path, multiple active locks.
 * Returns true if more than one active lock exists for the same file path.
 */
export function detectLockConflicts(locks: LockFacts[]): LockFacts[] {
  const pathMap = new Map<string, LockFacts[]>();
  for (const lock of locks) {
    if (lock.lockStatus !== 'locked') continue;
    const existing = pathMap.get(lock.filePathHash) || [];
    existing.push(lock);
    pathMap.set(lock.filePathHash, existing);
  }

  const conflicts: LockFacts[] = [];
  for (const [, group] of pathMap) {
    if (group.length > 1) {
      conflicts.push(...group);
    }
  }
  return conflicts;
}
