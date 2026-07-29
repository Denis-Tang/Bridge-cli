import { execFileSync } from 'node:child_process';
import { WorktreeManager } from './worktree-manager.js';

export interface MergeResult {
  success: boolean;
  mergeCommitHash?: string;
  conflicts: string[];
  message: string;
}

/**
 * Merge Manager - handles merging task branches into the target branch.
 */
export class MergeManager {
  private worktreeManager: WorktreeManager;

  constructor(worktreeManager: WorktreeManager) {
    this.worktreeManager = worktreeManager;
  }

  /**
   * Execute a git command and return stdout.
   */
  private git(args: string[], cwd?: string): string {
    const workDir = cwd ?? this.worktreeManager.getProjectRoot();
    try {
      return execFileSync('git', args, {
        cwd: workDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      const output = err instanceof Error ? (err as any).stdout?.toString().trim() ?? err.message : String(err);
      throw new Error(`Git command failed: ${JSON.stringify(['git', ...args])}\n${output}`);
    }
  }

  private currentBranch(): string {
    const branch = this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') throw new Error('Unable to determine current Git branch; configure target branch explicitly.');
    return branch;
  }

  /**
   * Merge a task branch into the target branch.
   * First fast-forward merges the base branch into the task branch,
   * then merges the task branch into the target branch.
   */
  merge(taskBranch: string, targetBranch?: string): MergeResult {
    const resolvedTargetBranch = targetBranch?.trim() || this.currentBranch();
    const projectRoot = this.worktreeManager.getProjectRoot();

    // Check if branches exist
    if (!this.worktreeManager.branchExists(taskBranch)) {
      return {
        success: false,
        conflicts: [],
        message: `Task branch '${taskBranch}' does not exist.`,
      };
    }

    // Check if there are conflicts first
    const conflictCheck = this.detectConflicts(taskBranch, resolvedTargetBranch);
    if (conflictCheck.hasConflicts) {
      return {
        success: false,
        conflicts: conflictCheck.conflictFiles,
        message: `Merge would cause conflicts in: ${conflictCheck.conflictFiles.join(', ')}`,
      };
    }

    // Ensure we're on target branch
    try {
      this.git(['checkout', resolvedTargetBranch]);
    } catch {
      throw new Error(`Cannot checkout target branch '${resolvedTargetBranch}'.`);
    }

    // Fetch latest base branch state (only if remote exists)
    try {
      const remotes = this.git(['remote']);
      if (remotes.includes('origin')) {
        this.git(['fetch', 'origin', resolvedTargetBranch]);
        this.git(['merge', `origin/${resolvedTargetBranch}`, '--ff-only']);
      }
    } catch {
      // No remote or fast-forward failed; continue with local
    }

    // Merge the task branch
    try {
      const result = this.git(['merge', taskBranch, '--no-ff', '--no-edit']);
      const mergeCommitHash = this.git(['rev-parse', 'HEAD']);

      return {
        success: true,
        mergeCommitHash,
        conflicts: [],
        message: `Successfully merged '${taskBranch}' into '${resolvedTargetBranch}'.`,
      };
    } catch (err) {
      // Merge conflict - abort and report
      try {
        this.git(['merge', '--abort']);
      } catch {
        // If abort fails, we have a bigger problem
      }

      const conflictFiles = this.detectConflicts(taskBranch, resolvedTargetBranch).conflictFiles;
      return {
        success: false,
        conflicts: conflictFiles,
        message: `Merge conflict in: ${conflictFiles.join(', ')}`,
      };
    }
  }

  /**
   * Check if a merge between two branches would cause conflicts.
   * Uses a trial merge and aborts it.
   */
  detectConflicts(
    sourceBranch: string,
    targetBranch: string,
  ): { hasConflicts: boolean; conflictFiles: string[] } {
    const projectRoot = this.worktreeManager.getProjectRoot();

    // Save current branch
    let currentBranch: string;
    try {
      currentBranch = this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch {
      return { hasConflicts: false, conflictFiles: [] };
    }

    try {
      // Checkout target branch
      this.git(['checkout', targetBranch]);

      // Try merge with --no-commit to detect conflicts
      let mergeOutput = '';
      try {
        mergeOutput = this.git(['merge', '--no-commit', '--no-ff', sourceBranch]);
      } catch (err) {
        mergeOutput = err instanceof Error ? err.message : String(err);
      }

      const hasConflicts = mergeOutput.toLowerCase().includes('conflict');
      let conflictFiles: string[] = [];

      if (hasConflicts) {
        // Parse conflict files from git status
        try {
          const status = this.git(['diff', '--name-only', '--diff-filter=U']);
          conflictFiles = status ? status.split('\n').filter((f) => f.length > 0) : [];
        } catch {
          conflictFiles = [];
        }
      }

      // Abort the merge attempt
      try {
        this.git(['merge', '--abort']);
      } catch {
        try { this.git(['reset', '--merge']); } catch { /* ignore */ }
      }

      // Restore original branch
      this.git(['checkout', currentBranch]);

      return { hasConflicts, conflictFiles };
    } catch {
      // Failed to check, return safe default
      try {
        try { this.git(['merge', '--abort']); } catch {
          try { this.git(['reset', '--merge']); } catch { /* ignore */ }
        }
        this.git(['checkout', currentBranch]);
      } catch {
        // Ignore recovery errors
      }
      return { hasConflicts: false, conflictFiles: [] };
    }
  }

  /**
   * Check if a branch has been merged into the target branch.
   */
  isMerged(branchName: string, targetBranch?: string): boolean {
    try {
      const merged = this.git(['branch', '--merged', targetBranch?.trim() || this.currentBranch()]);
      return merged.split('\n').some((b) => b.trim() === branchName);
    } catch {
      return false;
    }
  }
}
