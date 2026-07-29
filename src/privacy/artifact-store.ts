// ── Privacy Artifact Store ──────────────────────────────────────────────
// Manages runtime artifact persistence under privacy constraints.
// In minimal mode: only structured metadata + hashes. No raw content.
// In debug mode: full content with expiry.

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { PrivacyProfileConfig } from './profile.js';
import { isDebugActive } from './profile.js';
import { sanitizeText, sanitizeLogContent, computeHash } from './sanitizer.js';
import type { CryptoService } from './crypto.js';

export interface ArtifactWriteOptions {
  /** Privacy profile controlling what gets written */
  profile: PrivacyProfileConfig;
  /** Optional crypto service for encrypting sensitive fields */
  crypto?: CryptoService | null;
  /** Project root for relative path computation */
  projectRoot?: string;
}

export interface ArtifactStoreConfig {
  baseDir: string;
  defaultRetentionDays: number;
}

/**
 * Privacy-aware artifact store.
 * 
 * minimal mode:
 *   - Logs are sanitized before writing (secrets redacted)
 *   - Raw prompts are NOT saved
 *   - Diffs are NOT saved raw (hash only)
 *   - Absolute paths are NOT written
 *   - Provider stdout/stderr tail is NOT saved
 * 
 * debug mode:
 *   - Full content may be written with explicit flag
 *   - Expiry time is enforced
 */
export class PrivacyArtifactStore {
  private config: ArtifactStoreConfig;

  constructor(config: ArtifactStoreConfig) {
    this.config = config;
    mkdirSync(config.baseDir, { recursive: true });
  }

  /**
   * Write sanitized log content. In minimal mode, all secrets are redacted.
   * In debug mode, a warning header is prepended.
   */
  writeLog(filename: string, content: string, options: ArtifactWriteOptions): void {
    const path = resolve(this.config.baseDir, filename);
    mkdirSync(this.config.baseDir, { recursive: true });

    let finalContent: string;

    if (options.profile.profile === 'minimal' || !isDebugActive(options.profile)) {
      // Minimal: sanitized content only
      finalContent = sanitizeLogContent(content);
      // Add privacy header
      finalContent = `[PRIVACY: minimal mode — secrets, paths, and raw content redacted]\n${finalContent}`;
    } else {
      // Debug: full content with warning
      const expiresAt = options.profile.debugExpiresAt || 'unknown';
      finalContent = [
        '═════════════════════════════════════════════',
        '⚠️  DEBUG MODE — CONTAINS SENSITIVE CONTENT',
        `   Expires: ${expiresAt}`,
        '   DO NOT COMMIT OR SHARE THIS FILE',
        '═════════════════════════════════════════════',
        content,
      ].join('\n');
    }

    writeFileSync(path, finalContent, 'utf-8');
  }

  /**
   * Write a sanitized summary of a task outcome (for audit).
   * Never includes raw prompts, diffs, or full output.
   */
  writeTaskSummary(
    taskId: string,
    summary: {
      taskId: string;
      runId: string;
      status: string;
      promptHash: string;
      diffHash?: string;
      workerResultHash?: string;
      exitCode?: number | null;
      durationMs: number;
      errorSummary?: string;
    },
    options: ArtifactWriteOptions,
  ): void {
    const filename = `${taskId}_summary.json`;
    const path = resolve(this.config.baseDir, filename);

    const sanitized = {
      ...summary,
      errorSummary: summary.errorSummary ? sanitizeText(summary.errorSummary) : undefined,
      writtenAt: new Date().toISOString(),
      privacyMode: options.profile.profile,
    };

    writeFileSync(path, JSON.stringify(sanitized, null, 2), 'utf-8');
  }

  /**
   * Conditionally write a prompt (only in debug mode).
   * In minimal mode, only the SHA-256 hash is returned — nothing is written to disk.
   */
  writePromptIfDebug(
    filename: string,
    prompt: string,
    options: ArtifactWriteOptions,
  ): string {
    const hash = computeHash(prompt);

    if (isDebugActive(options.profile)) {
      this.writeLog(filename, prompt, options);
    }

    return hash;
  }

  /**
   * Get total size of stored artifacts for retention management.
   */
  getStoreSizeBytes(): number {
    let total = 0;
    try {
      const files = this.listAllFiles(this.config.baseDir);
      for (const file of files) {
        try {
          total += statSync(file).size;
        } catch { /* file might have been deleted */ }
      }
    } catch { /* ignore */ }
    return total;
  }

  /**
   * Cleanup artifacts older than the configured retention period.
   * Returns count of removed files.
   */
  cleanupExpired(): number {
    const cutoff = Date.now() - (this.config.defaultRetentionDays * 86400_000);
    let removed = 0;

    try {
      const files = this.listAllFiles(this.config.baseDir);
      for (const file of files) {
        try {
          const stat = statSync(file);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(file);
            removed++;
          }
        } catch { /* skip inaccessible files */ }
      }
    } catch { /* ignore */ }

    return removed;
  }

  /**
   * List all files recursively in a directory.
   */
  private listAllFiles(dir: string): string[] {
    const result: string[] = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          result.push(...this.listAllFiles(fullPath));
        } else {
          result.push(fullPath);
        }
      }
    } catch { /* ignore */ }
    return result;
  }
}

/**
 * Compute a deterministic project root hash for relative path references.
 * Uses SHA-256 of the lowercase, backslash-normalized path.
 */
export function hashProjectRoot(projectRoot: string): string {
  const normalized = projectRoot.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

/**
 * Convert an absolute path to a relative path (from project root).
 * Returns null if path is outside project root.
 */
export function toRelativePath(absolutePath: string, projectRoot: string): string | null {
  const normalizedAbs = absolutePath.replace(/\\/g, '/');
  const normalizedRoot = projectRoot.replace(/\\/g, '/');
  // Different drives → outside root
  if (normalizedAbs.charAt(0).toUpperCase() !== normalizedRoot.charAt(0).toUpperCase()) {
    return null;
  }
  const rel = relative(projectRoot, absolutePath);
  if (rel.startsWith('..')) return null;
  return rel.replace(/\\/g, '/');
}
