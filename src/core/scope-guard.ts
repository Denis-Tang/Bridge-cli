// ── M4 Scope Guard — Diff-based scope expansion detector ─────────────────
// Compares actual changed files against estimatedWritePaths/allowedPaths.
// Exceeds threshold (default 20%) → creates scope_expansion G2 pending approval.

import { promptHash } from '../utils/sanitize.js';

export interface ScopeCheckResult {
  /** Whether scope has expanded beyond threshold */
  expanded: boolean;
  /** Percentage of files outside estimated paths */
  expansionPct: number;
  /** Files that are outside estimatedWritePaths but inside allowedPaths */
  expandedFiles: string[];
  /** Files completely outside allowedPaths (hard violation) */
  forbiddenFiles: string[];
  /** Threshold used for this check */
  threshold: number;
}

/**
 * Check if actual changed files exceed the estimated scope.
 *
 * @param changedFiles - Files actually modified (from git diff)
 * @param estimatedWritePaths - Paths the task was expected to write to
 * @param allowedPaths - Paths the task is allowed to write to
 * @param threshold - Percentage (0-1) of files outside estimate that triggers expansion
 */
export function checkScopeExpansion(
  changedFiles: string[],
  estimatedWritePaths: string[],
  allowedPaths: string[],
  threshold: number = 0.20,
): ScopeCheckResult {
  if (changedFiles.length === 0) {
    return { expanded: false, expansionPct: 0, expandedFiles: [], forbiddenFiles: [], threshold };
  }

  const estimated = estimatedWritePaths.length > 0 ? estimatedWritePaths : allowedPaths;
  const expandedFiles: string[] = [];
  const forbiddenFiles: string[] = [];

  for (const file of changedFiles) {
    const inEstimate = estimated.some((p) => isPathInScope(file, p));
    const inAllowed = allowedPaths.length === 0 || allowedPaths.some((p) => isPathInScope(file, p));

    if (!inAllowed) {
      forbiddenFiles.push(file);
    } else if (!inEstimate) {
      expandedFiles.push(file);
    }
  }

  // Hard violation: any forbidden file = always expansion
  if (forbiddenFiles.length > 0) {
    return {
      expanded: true,
      expansionPct: 1.0,
      expandedFiles,
      forbiddenFiles,
      threshold,
    };
  }

  // Soft expansion: files within allowed but outside estimate
  const expansionPct = changedFiles.length > 0
    ? expandedFiles.length / changedFiles.length
    : 0;

  return {
    expanded: expansionPct > threshold,
    expansionPct,
    expandedFiles,
    forbiddenFiles: [],
    threshold,
  };
}

/**
 * Check if a file path is within a scope pattern.
 * Supports simple glob: * matches any sequence, ** matches directories.
 */
function isPathInScope(filePath: string, scopePattern: string): boolean {
  // Normalize paths
  const fp = filePath.replace(/\\/g, '/');
  const sp = scopePattern.replace(/\\/g, '/');

  // Exact match
  if (fp === sp) return true;

  // Prefix match: scope 'src/' matches 'src/foo/bar.ts'
  if (sp.endsWith('/') && fp.startsWith(sp)) return true;

  // Glob match
  if (sp.includes('*')) {
    const regex = globToRegex(sp);
    return regex.test(fp);
  }

  // file in scope directory
  if (!sp.includes('*') && !sp.endsWith('/')) {
    return fp.startsWith(sp + '/') || fp === sp;
  }

  return fp.startsWith(sp);
}

function globToRegex(pattern: string): RegExp {
  let r = '^';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      r += '.*';
      i += 2;
      if (pattern[i] === '/') i++;
    } else if (pattern[i] === '*') {
      r += '[^/]*';
      i++;
    } else if (pattern[i] === '?') {
      r += '[^/]';
      i++;
    } else {
      r += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  r += '$';
  return new RegExp(r, 'i');
}
