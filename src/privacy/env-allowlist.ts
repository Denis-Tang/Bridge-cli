// ── Environment Allowlist Manager ──────────────────────────────────────
// Controls which environment variables are passed to spawned subprocesses
// (Pi, Codex CLI, quality gates). Default: only PATH and essential system
// vars. Provider-specific vars must be explicitly declared.
//
// Projects may declare required variable NAMES (not values) in config.

// ══════════════════════════════════════════════════════════════
// Default allowlist — always passed to subprocesses
// ══════════════════════════════════════════════════════════════

const DEFAULT_ALLOWLIST = new Set([
  // System essentials
  'PATH',
  'SystemRoot',
  'SystemDrive',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Windows
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'ProgramFiles',
  'ProgramFiles(x86)',
  // NPM/Node
  'NODE_PATH',
  // Locale
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
]);

/**
 * Provider-specific env var names that may be explicitly allowed.
 * Only the NAME is allowed; value is passed from current process.env.
 */
const PROVIDER_ALLOWLIST = new Set([
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'COHERE_API_KEY',
  'BRAINCTL_SQLITE_PATH',
  'BRAINCTL_PRIVACY_PROFILE',
  'BRAINCTL_DEBUG_EXPIRES_AT',
]);

/**
 * Build a sanitized environment object for subprocess spawning.
 * Only allowlisted variables are included.
 *
 * @param projectAllowedVars - Variable NAMES (not values) declared by the project
 * @returns A new env object containing only allowed variables
 */
export function buildSubprocessEnv(
  projectAllowedVars?: string[],
): Record<string, string> {
  const result: Record<string, string> = {};

  // Always pass default vars
  for (const key of DEFAULT_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      result[key] = process.env[key]!;
    }
  }

  // Pass explicitly allowed provider vars
  for (const key of PROVIDER_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      result[key] = process.env[key]!;
    }
  }

  // Pass project-declared var names (only if in process.env)
  if (projectAllowedVars) {
    for (const key of projectAllowedVars) {
      if (process.env[key] !== undefined) {
        result[key] = process.env[key]!;
      }
    }
  }

  return result;
}

/**
 * Check whether a variable name is in the default or provider allowlists.
 * Used by config validation to reject sensitive declarations.
 */
export function isAllowedEnvVarName(name: string): boolean {
  return DEFAULT_ALLOWLIST.has(name) || PROVIDER_ALLOWLIST.has(name);
}

/**
 * Validate that project-declared env var names are acceptable.
 * Returns a list of rejected names (e.g., names containing "PASSWORD", "SECRET", etc.).
 */
export function validateProjectEnvVars(vars: string[]): { valid: string[]; rejected: string[] } {
  const valid: string[] = [];
  const rejected: string[] = [];

  const forbiddenPatterns = [
    /PASSWORD/i, /SECRET/i, /TOKEN/i, /KEY/i,
    /CERT/i, /CREDENTIAL/i, /AUTH/i,
    /\.env/i, /CONFIG/i,
  ];

  for (const name of vars) {
    // Must match env var naming convention
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      rejected.push(name);
      continue;
    }
    // Must not contain forbidden patterns
    if (forbiddenPatterns.some((p) => p.test(name))) {
      rejected.push(name);
      continue;
    }
    valid.push(name);
  }

  return { valid, rejected };
}

/**
 * Get a diagnostic summary of what env vars are available for subprocesses.
 * Used by doctor command — only reports presence/absence, NEVER values.
 */
export function getEnvDiagnostics(): Record<string, 'present' | 'not_set'> {
  const diagnostics: Record<string, 'present' | 'not_set'> = {};

  for (const key of PROVIDER_ALLOWLIST) {
    diagnostics[key] = process.env[key] !== undefined ? 'present' : 'not_set';
  }

  return diagnostics;
}

/**
 * Build a minimal subprocess env for sandboxed execution where no
 * provider keys should be available.
 */
export function buildMinimalSubprocessEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of DEFAULT_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      result[key] = process.env[key]!;
    }
  }
  return result;
}
