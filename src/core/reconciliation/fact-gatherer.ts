// ── M5 Fact Gatherer ─────────────────────────────────────────────────────
// Interface + default implementations for gathering facts from
// SQLite, Git, filesystem, and process table.
// All fact gathering is read-only. Zero writes to any system.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import type { FactGatherer } from '../../types/m5-types.js';

/**
 * Default FactGatherer implementation using real OS/Git/filesystem calls.
 * Safe for Phase 3 real fact gathering.
 */
export class DefaultFactGatherer implements FactGatherer {
  async checkPidAlive(pid: number): Promise<'alive' | 'gone' | 'unknown'> {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          stdio: 'pipe',
          encoding: 'utf-8',
          timeout: 2000,
        });
        return out.includes(`"${pid}"`) ? 'alive' : 'gone';
      } else {
        try {
          process.kill(pid, 0);
          return 'alive';
        } catch {
          return 'gone';
        }
      }
    } catch {
      return 'unknown';
    }
  }

  async pathExists(absPath: string): Promise<boolean> {
    try {
      return existsSync(absPath);
    } catch {
      return false;
    }
  }

  async branchExists(projectRoot: string, branchName: string): Promise<boolean> {
    try {
      runGit(projectRoot, ['rev-parse', '--verify', '--end-of-options', branchName]);
      return true;
    } catch {
      return false;
    }
  }

  async getGitHead(projectRoot: string): Promise<string | null> {
    try {
      return runGit(projectRoot, ['rev-parse', 'HEAD']) || null;
    } catch {
      return null;
    }
  }

  async hasMergeConflict(projectRoot: string): Promise<boolean> {
    try {
      // Check for MERGE_HEAD (standard Git conflict marker)
      const gitDir = runGit(projectRoot, ['rev-parse', '--git-dir']);
      return existsSync(pathResolve(projectRoot, gitDir, 'MERGE_HEAD'));
    } catch {
      return false;
    }
  }

  async getConflictFiles(projectRoot: string): Promise<string[]> {
    try {
      const out = runGit(projectRoot, ['diff', '--name-only', '--diff-filter=U']);
      if (!out) return [];
      return out.split('\n').map((f) => f.split('/').pop() || f);
    } catch {
      return [];
    }
  }

  async isWorktreeRegistered(projectRoot: string, worktreePath: string): Promise<boolean> {
    try {
      const out = runGit(projectRoot, ['worktree', 'list', '--porcelain']);
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

  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    try {
      if (!existsSync(worktreePath)) return false;
      const out = runGit(worktreePath, ['status', '--porcelain']);
      return out.trim().length > 0;
    } catch {
      return false;
    }
  }

  async isBranchMerged(projectRoot: string, branch: string, targetBranch: string): Promise<boolean> {
    try {
      runGit(projectRoot, ['merge-base', '--is-ancestor', '--end-of-options', branch, targetBranch]);
      return true;
    } catch {
      return false;
    }
  }

  async isCommitReachable(projectRoot: string, commitHash: string): Promise<boolean> {
    try {
      runGit(projectRoot, ['merge-base', '--is-ancestor', '--end-of-options', commitHash, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  async getBranchHead(projectRoot: string, branchName: string): Promise<string | null> {
    try {
      return runGit(projectRoot, ['rev-parse', '--verify', '--end-of-options', branchName]) || null;
    } catch {
      return null;
    }
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

/**
 * Compute SHA256 hash of a string.
 * Used for evidence hashes and path sanitization.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Compute project root hash (SHA256 of sanitized path).
 */
export function hashProjectRoot(projectRoot: string): string {
  return sha256(projectRoot);
}
