// ── M5 Git Fact Checker ──────────────────────────────────────────────────
// Pure Git fact detection functions.
// All functions are read-only — no writes to Git or filesystem.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

/**
 * Check if a Git branch exists in the repository.
 */
export function checkBranchExists(projectRoot: string, branchName: string): boolean {
  try {
    runGit(projectRoot, ['rev-parse', '--verify', '--end-of-options', branchName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current HEAD commit hash.
 */
export function getGitHead(projectRoot: string): string | null {
  try {
    const out = runGit(projectRoot, ['rev-parse', 'HEAD']);
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Check if the repository has an active merge conflict (MERGE_HEAD exists).
 */
export function hasMergeConflict(projectRoot: string): boolean {
  try {
    const gitDir = runGit(projectRoot, ['rev-parse', '--git-dir']);
    return existsSync(pathResolve(projectRoot, gitDir, 'MERGE_HEAD'));
  } catch {
    return false;
  }
}

/**
 * Get list of files with merge conflicts (filenames only, no paths).
 */
export function getConflictFileNames(projectRoot: string): string[] {
  try {
    const out = runGit(projectRoot, ['diff', '--name-only', '--diff-filter=U']);
    if (!out) return [];
    return out.split('\n').map((f) => f.split(/[/\\]/).pop() || f).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Check if a branch has been merged into the target branch.
 */
export function isBranchMerged(projectRoot: string, branch: string, targetBranch: string): boolean {
  try {
    runGit(projectRoot, ['merge-base', '--is-ancestor', '--end-of-options', branch, targetBranch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a specific commit is an ancestor of HEAD.
 */
export function isCommitReachable(projectRoot: string, commitHash: string): boolean {
  try {
    runGit(projectRoot, ['merge-base', '--is-ancestor', '--end-of-options', commitHash, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/** Invoke Git without a shell so repository-derived values stay data. */
function runGit(projectRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 5000,
  }).trim();
}
