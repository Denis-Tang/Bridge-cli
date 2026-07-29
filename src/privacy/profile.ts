// ── Privacy Profile: minimal vs debug mode ─────────────────────────────
// Default is "minimal" — no raw prompts, diffs, stdout/stderr, env, or
// absolute paths are persisted. "debug" must be explicitly enabled with
// an expiry time and shows a prominent warning.

export type PrivacyProfile = 'minimal' | 'debug';

export interface PrivacyProfileConfig {
  /** Active privacy profile */
  profile: PrivacyProfile;
  /** When debug mode expires (ISO timestamp). Only meaningful for 'debug'. */
  debugExpiresAt: string | null;
  /** Whether a prominent warning was acknowledged for this debug session */
  debugWarningAcknowledged: boolean;
}

/** Fields that must NOT be persisted in minimal mode */
export const MINIMAL_BLOCKED_FIELDS = new Set([
  // Raw prompts / instructions
  'planningPrompt', 'reviewPrompt', 'workerPrompt', 'fullPrompt',
  'rawPrompt', 'planningPromptHash',
  // Diffs
  'fullDiff', 'rawDiff', 'diffContent',
  // Provider output (raw)
  'rawStdout', 'rawStderr', 'rawOutput', 'providerOutput',
  // Environment
  'environment', 'env', 'envVars', 'fullEnvironment',
  // Absolute paths
  'absolutePath', 'worktreeAbsolutePath',
]);

/** Fields that are allowed in minimal mode (for audit/recovery) */
export const MINIMAL_ALLOWED_FIELDS = new Set([
  // Structured metadata
  'runId', 'stageId', 'taskId', 'attemptId', 'batchId', 'reportId',
  'status', 'exitCode', 'severity', 'kind',
  // Hashes (safe)
  'promptHash', 'evidenceHash', 'filePathHash', 'projectRootHash',
  'commitHash', 'mergeCommitHash', 'targetMergeCommit',
  // Relative paths
  'relativePath', 'filePath', 'branchName', 'integrationBranch',
  // Truncated summaries
  'summary', 'proposal', 'reviewSummary',
  // Counts/timestamps
  'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'durationMs',
  'totalFindings', 'blockingCount', 'warningCount', 'infoCount',
  'appliedCount', 'skippedCount',
  // Token counts (numeric only)
  'estimatedTotal', 'estimatedInput', 'estimatedOutput',
  'actualTotal', 'actualInput', 'actualOutput', 'actualCacheHit',
  'tokenLimit',
]);

/**
 * Create a default privacy profile config (minimal mode).
 */
export function createDefaultProfile(): PrivacyProfileConfig {
  return {
    profile: 'minimal',
    debugExpiresAt: null,
    debugWarningAcknowledged: false,
  };
}

/**
 * Check if debug mode is still valid and not expired.
 */
export function isDebugActive(config: PrivacyProfileConfig): boolean {
  if (config.profile !== 'debug') return false;
  if (!config.debugExpiresAt) return false;
  return new Date() < new Date(config.debugExpiresAt);
}

/**
 * Get the configured privacy profile from environment or project config.
 * Environment variable BRAINCTL_PRIVACY_PROFILE overrides project config.
 * BRAINCTL_DEBUG_EXPIRES_AT sets expiry (ISO timestamp).
 */
export function resolvePrivacyProfile(
  projectOverride?: Partial<PrivacyProfileConfig>,
): PrivacyProfileConfig {
  const envProfile = process.env.BRAINCTL_PRIVACY_PROFILE;
  const envExpires = process.env.BRAINCTL_DEBUG_EXPIRES_AT;

  const base = projectOverride
    ? { ...createDefaultProfile(), ...projectOverride }
    : createDefaultProfile();

  if (envProfile === 'debug' || envProfile === 'minimal') {
    base.profile = envProfile;
  }

  if (envProfile === 'debug' && envExpires) {
    base.debugExpiresAt = envExpires;
  }

  if (base.profile === 'debug') {
    // Validate expiry
    if (!base.debugExpiresAt) {
      // No expiry set — default to 1 hour
      base.debugExpiresAt = new Date(Date.now() + 3600_000).toISOString();
    }
    if (new Date(base.debugExpiresAt) <= new Date()) {
      // Expired — fall back to minimal
      base.profile = 'minimal';
      base.debugExpiresAt = null;
    }
    // Debug must be explicit — cannot be permanently silent
    base.debugWarningAcknowledged = false;
  }

  return base;
}
