// ── Unified Privacy Sanitizer ───────────────────────────────────────────
// Single entry point for all log/event/persistence sanitization.
// Supersedes src/utils/sanitize.ts and src/adapters/pi-worker-log-redactor.ts.
//
// Covers: bearer tokens, API keys, JWTs, connection strings, private keys,
// passwords, email addresses, and user paths.
//
// All adapters MUST route through this sanitizer; no adapter may implement
// its own inconsistent sanitization rules.

import { createHash } from 'node:crypto';

// ══════════════════════════════════════════════════════════════
// Pattern definitions
// ══════════════════════════════════════════════════════════════

const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string | ((match: string, ...args: string[]) => string); name: string }> = [
  // Bearer tokens
  { name: 'bearer', pattern: /Bearer\s+[\w\-._~+\/=]{8,}/gi, replacement: 'Bearer [REDACTED]' },
  // API keys (sk-, pk-, rk- prefixes)
  { name: 'api_key', pattern: /\b(sk|pk|rk)-[a-zA-Z0-9_-]{16,}\b/g, replacement: '$1-[REDACTED]' },
  // JWT tokens
  { name: 'jwt', pattern: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  // AWS access keys
  { name: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA[REDACTED]' },
  // AWS secret keys (40-char base64)
  { name: 'aws_secret', pattern: /\b[A-Za-z0-9\/+]{40}\b/g, replacement: (match: string) => {
    // Only match if it looks like a key (mixed case + digits + base64 chars)
    const hasMixed = /[a-z]/.test(match) && /[A-Z]/.test(match);
    return hasMixed ? '[REDACTED_SECRET_KEY]' : match;
  }},
  // Private keys (PEM blocks)
  { name: 'private_key',
    pattern: /-----BEGIN\s(?:RSA\s|EC\s|DSA\s|OPENSSH\s)?PRIVATE\sKEY-----[^]*?-----END\s(?:RSA\s|EC\s|DSA\s|OPENSSH\s)?PRIVATE\sKEY-----/g,
    replacement: '-----BEGIN PRIVATE KEY-----[REDACTED]',
  },
  // GitHub tokens
  { name: 'github_pat', pattern: /\b(github_pat_)[A-Za-z0-9_]{20,}\b/g, replacement: 'github_pat_[REDACTED]' },
  { name: 'ghp_token', pattern: /\b(ghp_)[A-Za-z0-9]{36}\b/g, replacement: 'ghp_[REDACTED]' },
  { name: 'gho_token', pattern: /\b(gho_)[A-Za-z0-9]{36}\b/g, replacement: 'gho_[REDACTED]' },
  // Generic password in assignment
  { name: 'password_assign', pattern: /(password|passwd|pwd)\s*[:=]\s*\S+/gi, replacement: '$1=[REDACTED]' },
  // Connection strings with embedded credentials
  { name: 'conn_string',
    pattern: /(mysql|postgres|postgresql|mongodb|redis|sqlite):\/\/[^:]+:[^@]+@/gi,
    replacement: '$1://[REDACTED]:[REDACTED]@',
  },
  // Environment variable assignments with values (DEEPSEEK_API_KEY=value or DEEPSEEK_API_KEY="value")
  { name: 'env_key',
    pattern: /(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|BRAINCTL_\w+)\s*=\s*(['"]?)[^\s;"']+\2/gi,
    replacement: '$1=[REDACTED]',
  },
  // Authorization headers with values
  { name: 'auth_header',
    pattern: /(Authorization|X-Api-Key|X-Auth-Token)\s*:\s*\S+/gi,
    replacement: '$1: [REDACTED]',
  },
  // Email addresses (standalone)
  { name: 'email',
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    replacement: (match: string) => {
      // Keep only first char of local part + domain TLD
      const parts = match.split('@');
      if (parts.length !== 2) return match;
      const localFirst = parts[0].charAt(0);
      const domainParts = parts[1].split('.');
      const tld = domainParts.length > 1 ? domainParts[domainParts.length - 1] : '';
      return `${localFirst}***@***.${tld}`;
    },
  },
];

// ══════════════════════════════════════════════════════════════
// Sensitive keys to entirely drop from structured data
// ══════════════════════════════════════════════════════════════

const DROP_KEYS = new Set([
  'prompt', 'rawPrompt', 'systemPrompt', 'userPrompt',
  'response', 'rawResponse', 'fullOutput',
  'stdout', 'stderr', 'logContent', 'rawLog',
  'env', 'environment', 'envVars',
  'apiKey', 'token', 'accessToken',
  'secret', 'password', 'credential',
  'auth', 'authorization', 'cookie', 'session',
  'privateKey', 'pem', 'cert', 'certificate',
  'absolutePath', 'worktreePath',
  'homedir', 'userProfile',
]);

const PROMPT_LIKE_KEYS = new Set([
  'promptText', 'promptContent', 'instruction', 'context',
  'requestText', 'message', 'input', 'output', 'content',
  'text', 'body', 'planningPrompt', 'reviewPrompt',
  'diff', 'fullDiff', 'diffContent',
]);

// ══════════════════════════════════════════════════════════════
// Core sanitization functions
// ══════════════════════════════════════════════════════════════

/**
 * Sanitize a plain text string (log content, error messages, etc.).
 * Redacts secrets, API keys, JWTs, connection strings, emails, etc.
 */
export function sanitizeText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement as any);
    pattern.lastIndex = 0;
  }
  return result;
}

/**
 * Sanitize structured event data before persistence.
 * Drops sensitive keys entirely, hashes prompt-like fields, redacts
 * secret patterns in remaining strings.
 */
export function sanitizeEventData(data: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    // Drop known sensitive keys
    if (DROP_KEYS.has(key) || DROP_KEYS.has(key.toLowerCase())) continue;

    // Prompt-like fields: replace with hash
    if (PROMPT_LIKE_KEYS.has(key) || PROMPT_LIKE_KEYS.has(key.toLowerCase())) {
      if (typeof value === 'string' && value.length > 0) {
        sanitized[key] = createHash('sha256').update(value, 'utf-8').digest('hex');
      }
      continue;
    }

    // Recursively sanitize nested objects
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeEventData(value as Record<string, unknown>);
      continue;
    }

    // Redact secrets in strings
    if (typeof value === 'string') {
      sanitized[key] = sanitizeText(value);
      continue;
    }

    // Arrays: sanitize each element
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) =>
        typeof item === 'string' ? sanitizeText(item) : item,
      );
      continue;
    }

    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * Sanitize log content specifically for file writing.
 * Wraps sanitizeText with additional path redaction.
 */
export function sanitizeLogContent(content: string): string {
  let result = sanitizeText(content);
  // Redact Windows user paths
  result = result.replace(/C:\\Users\\[^\\\s]+/gi, '<USER_PROFILE>');
  result = result.replace(/C:\/Users\/[^\/\s]+/gi, '<USER_PROFILE>');
  // Redact common absolute path patterns (D:\, E:\, etc.)
  result = result.replace(/[A-Z]:\\[^\s"']+/g, (match: string) => {
    // Don't redact if it looks like a relative path or already redacted
    if (match.includes('<USER_PROFILE>') || match.includes('<PROJECT_ROOT>')) return match;
    // Keep drive letter but redact path for non-project paths
    return '<ABSOLUTE_PATH>';
  });
  return result;
}

/**
 * Sanitize an error message before displaying or logging.
 * Ensures no secrets leak through exception traces.
 */
export function sanitizeError(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
    // Also check stack for secrets
    if (err.stack) {
      const sanitizedStack = sanitizeText(err.stack);
      return sanitizeText(msg) + '\n' + sanitizedStack.split('\n').slice(1).join('\n');
    }
  } else {
    msg = String(err);
  }
  return sanitizeText(msg);
}

/**
 * Compute a SHA-256 hash (same as existing promptHash, kept for consistency).
 */
export function computeHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Check if a string contains any recognized secret patterns.
 * Used for pre-write verification.
 */
export function containsSecrets(text: string): boolean {
  for (const { pattern } of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      return true;
    }
    pattern.lastIndex = 0;
  }
  return false;
}

/**
 * Generate a summary of what would be redacted (for audit purposes).
 */
export function auditRedactions(text: string): Array<{ name: string; count: number }> {
  const results: Array<{ name: string; count: number }> = [];
  for (const { pattern, name } of REDACT_PATTERNS) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      results.push({ name, count: matches.length });
    }
  }
  return results;
}
