/**
 * Command Policy - defines which commands are allowed or forbidden
 * during task execution. Acts as a safety layer before executing
 * any shell commands.
 *
 * SECURITY: Shell metacharacters (&&, ||, ;, |, >, <, $(), ``,
 * PowerShell subexpressions, etc.) are ALWAYS rejected when the
 * policy is used to gate shell-mode execution. In vector (argv)
 * mode metacharacters are passed literally and pose no risk.
 */

export interface CommandPolicyRule {
  /** Glob-like pattern for the command */
  pattern: string;
  /** 'allow' or 'deny' */
  action: 'allow' | 'deny';
  /** Optional reason for the rule */
  reason?: string;
}

export interface CommandCheckResult {
  allowed: boolean;
  matchedRule?: CommandPolicyRule;
  reason: string;
}

/**
 * Shell metacharacters that are NEVER allowed in command strings
 * when the policy gates shell-mode execution. These are the most
 * common cross-platform injection vectors and have no legitimate
 * use in a quality gate that already uses a command + args[] vector.
 */
const SHELL_METACHARACTERS = [
  '&&',      // command chaining (bash/cmd/ps)
  '&',       // background / command separator (cmd)
  '||',      // OR chain
  '|',       // pipe
  ';',       // command separator (bash/ps)
  '>',       // output redirect
  '<',       // input redirect
  '$(',      // command substitution (bash/ps)
  '`',       // command substitution (backtick)
  '%',       // PowerShell environment variable (only dangerous with special forms)
  '$(',      // PowerShell subexpression
  '@(',      // PowerShell array subexpression
  '${',      // variable expansion with braces
];

/**
 * PowerShell-specific metacharacters that are risky when combined
 * with executable invocation.
 */
const PS_DANGEROUS_PATTERNS = [
  /\$\(.*\)/,     // $(...) subexpression
  /%[A-Za-z_].*%/,  // %VAR% expansion with body (cmd)
  /@\(/,            // @() array subexpression
];

/**
 * Returns true if the command string contains shell metacharacters
 * that could be used for injection / command chaining.
 */
export function containsShellMetacharacters(command: string): boolean {
  // Check for literal metacharacter strings
  for (const mc of SHELL_METACHARACTERS) {
    if (command.includes(mc)) return true;
  }
  // Check PowerShell-specific patterns
  for (const pat of PS_DANGEROUS_PATTERNS) {
    if (pat.test(command)) return true;
  }
  return false;
}

/**
 * Command Policy - validates commands against a set of rules.
 * Default rules block destructive operations while allowing
 * common safe commands.
 */
export class CommandPolicy {
  private rules: CommandPolicyRule[];

  constructor(rules?: CommandPolicyRule[]) {
    this.rules = rules ?? [
      // Deny destructive operations
      { pattern: 'rm -rf *', action: 'deny', reason: 'Recursive force delete is too dangerous' },
      { pattern: 'rm -rf /*', action: 'deny', reason: 'System-level delete is forbidden' },
      { pattern: 'del /f /s *', action: 'deny', reason: 'Force recursive delete is forbidden' },
      { pattern: 'rd /s /q *', action: 'deny', reason: 'Directory recursive delete is forbidden' },
      { pattern: 'format *', action: 'deny', reason: 'Format is forbidden' },
      { pattern: 'git push', action: 'deny', reason: 'Git push is forbidden in task execution' },
      { pattern: 'git push --force', action: 'deny', reason: 'Force push is forbidden' },
      // Allow git read operations
      { pattern: 'git diff', action: 'allow', reason: 'Read-only git diff' },
      { pattern: 'git log', action: 'allow', reason: 'Read-only git log' },
      { pattern: 'git status', action: 'allow', reason: 'Read-only git status' },
      { pattern: 'git show', action: 'allow', reason: 'Read-only git show' },
      { pattern: 'git branch', action: 'allow', reason: 'Read git branches' },
      // Allow common tools
      { pattern: 'npm test', action: 'allow', reason: 'Run tests' },
      { pattern: 'npm run', action: 'allow', reason: 'Run npm scripts' },
      { pattern: 'npx', action: 'allow', reason: 'Run npx commands' },
      { pattern: 'node', action: 'allow', reason: 'Run node' },
      { pattern: 'python', action: 'allow', reason: 'Run python' },
      { pattern: 'tsc', action: 'allow', reason: 'TypeScript compiler' },
      { pattern: 'vitest', action: 'allow', reason: 'Run vitest tests' },
    ];
  }

  /**
   * Check if a command is allowed by the policy.
   * When used for shell-mode gating, metacharacter detection
   * is applied FIRST (before any allow/deny rule).
   */
  isAllowed(command: string): CommandCheckResult {
    const trimmed = command.trim();

    // Shell metacharacter block — always first, always deny.
    // Even if an allow rule would match the prefix, metacharacters
    // indicate injection/command-chaining intent.
    if (containsShellMetacharacters(trimmed)) {
      return {
        allowed: false,
        reason: 'Shell metacharacters detected in command string — command chaining, piping, redirection, and substitution are forbidden. Use argument vectors instead.',
      };
    }

    // Check deny rules first
    for (const rule of this.rules) {
      if (rule.action === 'deny' && this.matchesPattern(trimmed, rule.pattern)) {
        return {
          allowed: false,
          matchedRule: rule,
          reason: rule.reason ?? `Command matches deny pattern: ${rule.pattern}`,
        };
      }
    }

    // Check allow rules
    for (const rule of this.rules) {
      if (rule.action === 'allow' && this.matchesPattern(trimmed, rule.pattern)) {
        return {
          allowed: true,
          matchedRule: rule,
          reason: rule.reason ?? 'Command is allowed',
        };
      }
    }

    // Default: deny unknown commands
    return {
      allowed: false,
      reason: `Command '${trimmed}' is not in the allowed list`,
    };
  }

  /**
   * Check if a command starts with a given pattern.
   * Patterns are prefix-matched for allow rules and exact/prefix for deny.
   */
  private matchesPattern(command: string, pattern: string): boolean {
    const normalizedCmd = command.toLowerCase();
    const normalizedPattern = pattern.toLowerCase();

    // Exact match
    if (normalizedCmd === normalizedPattern) return true;

    // Prefix match (command starts with pattern)
    if (normalizedCmd.startsWith(normalizedPattern)) return true;

    // Check if the command is just the base command with args
    // e.g., 'git' matches 'git diff', 'git push'
    const cmdParts = normalizedCmd.split(/\s+/);
    const patternParts = normalizedPattern.split(/\s+/);

    // If command starts with the same base as the pattern
    if (cmdParts.length >= patternParts.length) {
      let matches = true;
      for (let i = 0; i < patternParts.length; i++) {
        if (cmdParts[i] !== patternParts[i]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }

    return false;
  }

  /**
   * Add a rule to the policy.
   */
  addRule(rule: CommandPolicyRule): void {
    this.rules.push(rule);
  }

  /**
   * Get all rules (copy for inspection).
   */
  getRules(): CommandPolicyRule[] {
    return [...this.rules];
  }
}
