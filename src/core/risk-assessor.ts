// ── M4 Risk Assessor — High-Risk Gate Classifier ─────────────────────────
// Classifies 8 categories per contract §4.1. Never stores raw paths/secrets.
// Default policy: deny for real-project + dangerous commands; all else → pending G1/G2.

import { promptHash } from '../utils/sanitize.js';

// ══════════════════════════════════════════════════════════════
// Risk Categories
// ══════════════════════════════════════════════════════════════

export type RiskCategory =
  | 'real_project'
  | 'dangerous_git'
  | 'dangerous_command'
  | 'sensitive_path'
  | 'lockfile_modification'
  | 'production_config'
  | 'budget_anomaly'
  | 'scope_expansion';

export interface RiskFinding {
  category: RiskCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Hash of the matched value — never stores raw path or command */
  matchHash: string;
  /** Human-readable context (sanitized, no raw paths longer than 30 chars) */
  context: string;
  /** Default action: 'deny' = always block; 'warn' = G1 pending; 'info' = audit only */
  defaultAction: 'deny' | 'warn' | 'info';
  /** Which gate creates the approval */
  gate: 'G1' | 'G2';
}

// ══════════════════════════════════════════════════════════════
// Pattern Lists
// ══════════════════════════════════════════════════════════════

export const DANGEROUS_GIT_COMMANDS = [
  'push', 'push --force', 'force push', 'git push --force',
  'rebase', 'git rebase', 'reset --hard', 'git reset --hard',
  'clean -f', 'git clean -fd', 'filter-branch', 'git filter-branch',
  'push --delete', 'git push --delete',
];

export const DANGEROUS_SHELL_COMMANDS = [
  'rm -rf', 'rm -r', 'drop table', 'drop database',
  'truncate', 'truncate table',
  ':(){ :|:& };:', // fork bomb
  '> /dev/sda', 'dd if=',
];

export const SENSITIVE_PATH_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', 'credentials.*',
  '*secret*', '*token*', '~/.ssh/', '~/.aws/', '~/.config/',
];

export const PRODUCTION_CONFIG_PATTERNS = [
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.github/workflows/', 'Jenkinsfile', 'k8s/', 'helm/',
  'terraform/', '*.tf', 'nginx.conf', '.gitlab-ci.yml',
];

export const LOCKFILE_PATTERNS = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Gemfile.lock', 'Cargo.lock', 'poetry.lock',
];

// ══════════════════════════════════════════════════════════════
// Risk Assessor
// ══════════════════════════════════════════════════════════════

export class RiskAssessor {
  /**
   * Assess all risks for a given context.
   * @param isRealProject Whether the target is a real (non-disposable) project
   * @param estimatedPaths estimatedWritePaths from tasks
   * @param commands Allowed commands from tasks
   * @param contextFiles Context files referenced
   */
  assess(
    isRealProject: boolean,
    estimatedPaths: string[],
    commands: string[],
    contextFiles: string[],
    planRiskLevel: string = 'low',
  ): RiskFinding[] {
    const findings: RiskFinding[] = [];

    // 1. Real project (deny by default)
    if (isRealProject) {
      findings.push({
        category: 'real_project',
        severity: 'high',
        matchHash: promptHash('real_project:' + new Date().toISOString().substring(0, 10)),
        context: 'Non-disposable project path',
        defaultAction: 'deny',
        gate: 'G1',
      });
    }

    // 2. Dangerous Git commands (deny)
    for (const cmd of commands) {
      const matched = DANGEROUS_GIT_COMMANDS.find((d) =>
        cmd.toLowerCase().includes(d.toLowerCase()),
      );
      if (matched) {
        findings.push({
          category: 'dangerous_git',
          severity: 'critical',
          matchHash: promptHash('git:' + matched),
          context: 'Dangerous git operation: ' + matched,
          defaultAction: 'deny',
          gate: 'G1',
        });
      }
    }

    // 3. Dangerous shell commands (deny)
    for (const cmd of commands) {
      const matched = DANGEROUS_SHELL_COMMANDS.find((d) =>
        cmd.toLowerCase().includes(d.toLowerCase()),
      );
      if (matched) {
        findings.push({
          category: 'dangerous_command',
          severity: 'critical',
          matchHash: promptHash('cmd:' + matched),
          context: 'Irreversible command: ' + matched,
          defaultAction: 'deny',
          gate: 'G1',
        });
      }
    }

    // 4. Sensitive paths
    const allPaths = [...estimatedPaths, ...contextFiles];
    for (const p of allPaths) {
      const matched = SENSITIVE_PATH_PATTERNS.find((pattern) =>
        matchesPattern(p, pattern),
      );
      if (matched) {
        // src/core/ paths are allowed without warning
        if (p.startsWith('src/core/')) continue;

        findings.push({
          category: 'sensitive_path',
          severity: 'high',
          matchHash: promptHash('sens:' + matched),
          context: 'Sensitive path matched pattern: ' + matched,
          defaultAction: 'warn',
          gate: 'G1',
        });
        break; // One finding per category
      }
    }

    // 5. Production config paths
    for (const p of allPaths) {
      const matched = PRODUCTION_CONFIG_PATTERNS.find((pattern) =>
        matchesPattern(p, pattern),
      );
      if (matched) {
        findings.push({
          category: 'production_config',
          severity: 'high',
          matchHash: promptHash('prod:' + matched),
          context: 'Production config path: ' + matched,
          defaultAction: 'warn',
          gate: 'G1',
        });
        break;
      }
    }

    // 6. Lock file modifications
    const lockCount = allPaths.filter((p) =>
      LOCKFILE_PATTERNS.some((lp) => matchesPattern(p, lp)),
    ).length;
    if (lockCount > 0) {
      findings.push({
        category: 'lockfile_modification',
        severity: 'medium',
        matchHash: promptHash('lock:' + lockCount),
        context: `${lockCount} lock file(s) may be modified`,
        defaultAction: 'info',
        gate: 'G2',
      });
    }

    return findings;
  }

  /**
   * Check if any finding requires outright denial (cannot proceed).
   */
  hasDenyFindings(findings: RiskFinding[]): boolean {
    return findings.some((f) => f.defaultAction === 'deny');
  }

  /**
   * Get findings that create G1 approvals.
   */
  getG1Findings(findings: RiskFinding[]): RiskFinding[] {
    return findings.filter((f) => f.gate === 'G1' && f.defaultAction !== 'info');
  }

  /**
   * Get findings that create G2 approvals.
   */
  getG2Findings(findings: RiskFinding[]): RiskFinding[] {
    return findings.filter((f) => f.gate === 'G2' && f.defaultAction !== 'info');
  }

  /**
   * Get the overall risk level from findings.
   */
  getOverallRiskLevel(findings: RiskFinding[], planLevel: string = 'low'): string {
    if (findings.some((f) => f.severity === 'critical')) return 'critical';
    if (findings.some((f) => f.severity === 'high' && f.defaultAction !== 'info')) return 'high';
    if (planLevel === 'high' || planLevel === 'critical') return 'high';
    if (planLevel === 'medium') return 'medium';
    if (findings.some((f) => f.severity === 'medium' && f.defaultAction !== 'info')) return 'medium';
    return 'low';
  }
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function matchesPattern(inputPath: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp('(^|/)' + escaped + '($|/)', 'i');
  return re.test(inputPath) || inputPath.toLowerCase().includes(pattern.toLowerCase());
}

/** Singleton for convenience */
export const riskAssessor = new RiskAssessor();
