import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Diff Scope Validator - checks that modified files are within allowed paths.
 * Also can validate against forbidden paths (e.g., .env, secrets).
 */
export interface ScopeValidationResult {
  valid: boolean;
  violations: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  invalidPathFiles: string[];
}

export class DiffScopeValidator {
  /**
   * Validate that all changed files are within the allowed paths
   * and none are in the forbidden paths.
   */
  validate(
    changedFiles: string[],
    allowedPaths: string[],
    forbiddenPaths: string[] = [],
    repositoryRoot?: string,
  ): ScopeValidationResult {
    const violations: string[] = [];
    const allowedFiles: string[] = [];
    const forbiddenFiles: string[] = [];
    const invalidPathFiles: string[] = [];

    const allowed = this.normalizePatternList('allowedPaths', allowedPaths, violations);
    const forbidden = this.normalizePatternList('forbiddenPaths', forbiddenPaths, violations, repositoryRoot);

    // Fail closed on an empty allowedPaths: an empty list is NOT "no
    // restriction", it means no write path is authorized at all. Codex
    // generates allowedPaths; a plan that omits it must never silently open
    // the scope guard to every file in the repository.
    if (allowed.length === 0 && changedFiles.length > 0) {
      violations.push('allowedPaths is empty: no write path is authorized');
    }

    for (const file of changedFiles) {
      const normalizedFile = this.normalizeChangedPath(file);
      if (!normalizedFile.ok) {
        invalidPathFiles.push(file);
        violations.push(`File '${file}' is not a safe repository-relative path: ${normalizedFile.reason}`);
        continue;
      }

      // Check forbidden paths first
      const isForbidden = this.matchesAnyPattern(normalizedFile.path, forbidden);
      if (isForbidden) {
        forbiddenFiles.push(file);
        violations.push(`File '${file}' is in a forbidden path`);
        continue;
      }

      // Check allowed paths (an empty allowedPaths was already rejected above,
      // so no file can be inside it)
      const isAllowed = allowed.length > 0 && this.matchesAnyPattern(normalizedFile.path, allowed);
      if (isAllowed) {
        allowedFiles.push(file);
      } else if (allowed.length > 0) {
        violations.push(`File '${file}' is not in any allowed path`);
      }
    }

    return {
      valid: violations.length === 0,
      violations,
      allowedFiles,
      forbiddenFiles,
      invalidPathFiles,
    };
  }

  /**
   * Get changed files from a git diff between two refs.
   */
  getChangedFilesFromGit(
    repoPath: string,
    baseRef?: string,
    headRef: string = 'HEAD',
  ): string[] {
    try {
      const resolvedBaseRef = baseRef?.trim() || execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (!resolvedBaseRef || resolvedBaseRef === 'HEAD') return [];
      const result = execFileSync(
        'git',
        ['diff', '--name-only', `${resolvedBaseRef}...${headRef}`, '--'],
        { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
      return result ? result.split('\n').filter((f) => f.length > 0) : [];
    } catch {
      return [];
    }
  }

  normalizePathForLock(filePath: string): { ok: true; path: string } | { ok: false; reason: string } {
    return this.normalizeChangedPath(filePath);
  }

  private normalizePatternList(
    kind: string,
    patterns: string[],
    violations: string[],
    repositoryRoot?: string,
  ): string[] {
    const normalized: string[] = [];
    for (const pattern of patterns) {
      let candidate = pattern;
      const raw = String(pattern || '').replace(/\\/g, '/').trim();
      const isAbsolutePattern = path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('//');
      if (kind === 'forbiddenPaths' && repositoryRoot && isAbsolutePattern) {
        if (raw.includes('*') || raw.includes('?')) {
          violations.push(`${kind} entry '${pattern}' is unsafe: absolute glob patterns are forbidden`);
          continue;
        }
        const relativePath = path.relative(path.resolve(repositoryRoot), path.resolve(raw));
        const outsideRepository = relativePath === '..'
          || relativePath.startsWith(`..${path.sep}`)
          || path.isAbsolute(relativePath);
        if (outsideRepository) {
          // Git changed-file evidence is repository-relative, so an external
          // privacy/evidence directory cannot match it. Keep that boundary in
          // the worker/privacy configuration without treating it as bad diff policy.
          continue;
        }
        candidate = relativePath || '**';
      }

      const out = this.normalizePattern(candidate);
      if (!out.ok) {
        violations.push(`${kind} entry '${pattern}' is unsafe: ${out.reason}`);
      } else {
        normalized.push(out.path);
      }
    }
    return normalized;
  }

  private normalizeChangedPath(value: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (!value || !value.trim()) return { ok: false, reason: 'empty path' };
    const raw = value.replace(/\\/g, '/').trim();
    if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('//')) {
      return { ok: false, reason: 'absolute path is forbidden' };
    }
    const parts = raw.split('/').filter((p) => p.length > 0 && p !== '.');
    if (parts.includes('..')) return { ok: false, reason: '.. escape is forbidden' };
    if (parts.length === 0) return { ok: false, reason: 'empty path' };
    return { ok: true, path: parts.join('/').toLowerCase() };
  }

  private normalizePattern(value: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (!value || !value.trim()) return { ok: false, reason: 'empty path' };
    const raw = value.replace(/\\/g, '/').trim();
    if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('//')) {
      return { ok: false, reason: 'absolute path is forbidden' };
    }
    const parts = raw.split('/').filter((p) => p.length > 0 && p !== '.');
    if (parts.includes('..')) return { ok: false, reason: '.. escape is forbidden' };
    if (parts.length === 0) return { ok: false, reason: 'empty path' };
    return { ok: true, path: parts.join('/').toLowerCase() };
  }

  /**
   * Check if a path matches any pattern in a list.
   * Supports glob-like patterns (**, *).
   */
  private matchesAnyPattern(filePath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      if (this.matchPattern(filePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Simple pattern matching with ** and * support.
   */
  private matchPattern(filePath: string, pattern: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    const normalizedPattern = pattern.replace(/\\/g, '/').toLowerCase();

    // Direct match
    if (normalizedPath === normalizedPattern) return true;

    // Directory prefix match (pattern ends with /)
    const prefix = normalizedPattern.endsWith('/') ? normalizedPattern : normalizedPattern + '/';
    if (!normalizedPattern.includes('*') && normalizedPath.startsWith(prefix)) return true;

    // If pattern doesn't contain glob chars, just check prefix
    if (!normalizedPattern.includes('*')) return false;

    // Convert glob pattern to regex for ** and * patterns
    const regexStr = this.globToRegex(normalizedPattern);
    const re = new RegExp(regexStr);
    return re.test(normalizedPath);
  }

  /**
   * Convert a simple glob pattern to a regular expression.
   * Supports ** (any depth) and * (single segment).
   */
  private globToRegex(pattern: string): string {
    let result = '';
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === '*' && pattern[i + 1] === '*') {
        // ** matches any depth (including none)
        result += '.*';
        i++;
        // Skip following '/' for '**/' pattern
        if (pattern[i + 1] === '/') {
          i++;
        }
      } else if (ch === '*') {
        // * matches anything except '/' (single segment)
        result += '[^/]*';
      } else if (ch === '?') {
        result += '[^/]';
      } else if (ch === '.') {
        result += '\\.';
      } else {
        result += ch;
      }
    }
    // Match full path
    return `^${result}$`;
  }
}
