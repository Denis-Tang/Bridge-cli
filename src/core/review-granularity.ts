// ── Review Granularity — Per-task vs stage-level review decision ───────
// Decides whether a task needs per-task Codex review or can be aggregated
// into a stage-level review. Used by token-efficient mode.

import type { ExecutionMode, StructuredTaskSpec } from '../types/m2-types.js';
import type { WorkerResult } from '../types/protocol.js';

/**
 * Determine whether a task should receive per-task Codex review.
 * Returns false when review can be deferred to stage-level aggregation.
 */
export function shouldDoTaskLevelReview(
  spec: StructuredTaskSpec,
  workerResult: WorkerResult | null,
  qualityGatePassed: boolean,
  mode: ExecutionMode,
  isRetry: boolean,
): boolean {
  // Default mode: always per-task
  if (mode === 'default') return true;

  // High risk: always per-task
  if (spec.riskLevel === 'high') return true;

  // Sensitive/config paths: always per-task
  const sensitivePatterns = ['Dockerfile', '.env', '.pem', '.key', 'credentials', 'secret', 'token',
    '.github/workflows', 'Jenkinsfile', 'nginx.conf', 'terraform', 'helm'];
  const touchesSensitive = spec.estimatedWritePaths?.some((p) =>
    sensitivePatterns.some((pattern) => p.includes(pattern)),
  );
  if (touchesSensitive) return true;

  // Scope violations require review
  if (workerResult?.scopeViolations && workerResult.scopeViolations.length > 0) return true;

  // Quality gate failure: per-task review
  if (!qualityGatePassed) return true;

  // Retry/rework: per-task review
  if (isRetry) return true;

  // Worker blocked or needs decision
  if (workerResult && (workerResult.status === 'blocked' || workerResult.status === 'needs_decision')) return true;

  // Simple mode: only review if high risk or gate failure (already handled above)
  // Token-efficient mode: low/medium risk, first attempt, gate passed → skip per-task
  if (mode === 'simple' || mode === 'token-efficient') return false;

  // Unknown mode: be conservative
  return true;
}

/**
 * Determine if a stage should receive aggregated Codex review.
 */
export function shouldDoStageLevelReview(
  stageTasks: Array<{ spec: StructuredTaskSpec; reviewSkipped: boolean }>,
  mode: ExecutionMode,
): boolean {
  if (mode === 'default') return false;
  if (mode === 'simple') return false;

  // Token-efficient: run stage review if any task had review skipped
  if (mode === 'token-efficient') {
    return stageTasks.some((t) => t.reviewSkipped);
  }

  return false;
}

/**
 * Signal that stage review failed and task-level upgrade is needed.
 */
export function isUpgradeNeeded(
  stageReviewPassed: boolean,
  skippedTaskCount: number,
): boolean {
  return !stageReviewPassed && skippedTaskCount > 0;
}
