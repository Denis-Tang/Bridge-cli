// ── M5 Worktree Fact Checker ─────────────────────────────────────────────
// Pure worktree fact detection — existence, registration, dirty state.
// All functions read-only. No writes to filesystem or Git.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Check if a worktree path exists on disk.
 */
export function checkWorktreeExists(absPath: string): boolean {
  try {
    return existsSync(absPath);
  } catch {
    return false;
  }
}

/**
 * Check if a worktree is registered in git worktree list.
 */
export function checkWorktreeRegistered(projectRoot: string, worktreePath: string): boolean {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5000,
    });
    const normalizedTarget = worktreePath.replace(/\\/g, '/').toLowerCase();
    const lines = out.split('\n');
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const registered = line.slice('worktree '.length).trim().replace(/\\/g, '/').toLowerCase();
        if (registered === normalizedTarget) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a worktree has uncommitted changes (dirty).
 */
export function checkWorktreeDirty(worktreePath: string): boolean {
  try {
    if (!existsSync(worktreePath)) return false;
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 5000,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
