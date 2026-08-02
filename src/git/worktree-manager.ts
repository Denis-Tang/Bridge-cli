import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Worktree Manager - creates and manages Git worktrees for isolated task execution.
 * Each task gets its own branch + worktree.
 */
export class WorktreeManager {
  private projectRoot: string;
  private worktreeBaseDir: string | null;

  constructor(projectRoot: string, options?: { worktreeBaseDir?: string }) {
    this.projectRoot = path.resolve(projectRoot);
    this.worktreeBaseDir = options?.worktreeBaseDir
      ? path.resolve(this.projectRoot, options.worktreeBaseDir)
      : null;
  }

  /**
   * Get the project root path.
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Execute a git command in the project root and return stdout.
   */
  private git(args: string[], cwd?: string): string {
    const workDir = cwd ?? this.projectRoot;
    return execFileSync('git', args, {
      cwd: workDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  private currentBranch(cwd = this.projectRoot): string {
    const branch = this.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (!branch || branch === 'HEAD') throw new Error('Unable to determine the current Git branch; configure a base branch explicitly.');
    return branch;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizePathForCompare(value: string): string {
    return path.resolve(value).replace(/\\/g, '/').toLowerCase();
  }

  private isRegisteredWorktree(worktreePath: string): boolean {
    try {
      const list = this.git(['worktree', 'list', '--porcelain']);
      const target = this.normalizePathForCompare(worktreePath);
      return list
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length).trim())
        .some((registered) => this.normalizePathForCompare(registered) === target);
    } catch {
      return true;
    }
  }

  /**
   * Check if a branch already exists (local or remote).
   */
  branchExists(branchName: string): boolean {
    try {
      this.git(['rev-parse', '--verify', branchName]);
      return true;
    } catch {
      return false;
    }
  }

  isBranchMergedInto(branchName: string, targetRef = 'HEAD'): boolean {
    if (!this.branchExists(branchName)) return true;
    try {
      this.git(['merge-base', '--is-ancestor', branchName, targetRef]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new branch from the given base branch.
   * If the branch already exists, return it without error.
   */
  createBranch(branchName: string, baseBranch?: string): string {
    const resolvedBaseBranch = baseBranch?.trim() || this.currentBranch();
    if (this.branchExists(branchName)) {
      return branchName;
    }

    // Ensure base branch exists locally
    try {
      this.git(['rev-parse', '--verify', resolvedBaseBranch]);
    } catch {
      // Try to fetch and create tracking branch
      try {
        this.git(['fetch', 'origin', resolvedBaseBranch]);
        this.git(['checkout', '-b', resolvedBaseBranch, `origin/${resolvedBaseBranch}`]);
        this.git(['checkout', '-']);
      } catch {
        // Create base branch from current HEAD
        this.git(['branch', resolvedBaseBranch]);
      }
    }

    this.git(['branch', branchName, resolvedBaseBranch]);
    return branchName;
  }

  /**
   * Create a Git worktree for the given branch at the target directory.
   * Returns the resolved worktree path.
   */
  createWorktree(branchName: string, targetDir: string): string {
    const resolvedTarget = path.resolve(this.projectRoot, targetDir);

    // Create parent directory if needed
    const parentDir = path.dirname(resolvedTarget);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Ensure branch exists
    if (!this.branchExists(branchName)) {
      throw new Error(`Branch '${branchName}' does not exist. Call createBranch() first.`);
    }

    // Check if worktree already exists
    if (existsSync(resolvedTarget)) {
      // Verify it's already linked to the branch
      try {
        const currentBranch = this.git(['rev-parse', '--abbrev-ref', 'HEAD'], resolvedTarget);
        if (currentBranch === branchName) {
          return resolvedTarget;
        }
      } catch {
        // Directory exists but isn't a valid worktree; remove and recreate
      }
    }

    this.git(['worktree', 'add', '--', resolvedTarget, branchName]);
    return resolvedTarget;
  }

  /**
   * Get the list of changed files in the worktree compared to the base branch.
   * Returns file paths relative to the repo root.
   */
  getChangedFiles(worktreePath: string, baseBranch?: string): string[] {
    const resolvedBaseBranch = baseBranch?.trim() || this.currentBranch();
    const result = this.git(
      ['diff', '--name-only', resolvedBaseBranch + '...HEAD', '--'],
      worktreePath,
    );
    if (!result) return [];
    return result.split('\n').filter((f) => f.length > 0);
  }

  /**
   * Get the full diff for changed files compared to the base branch.
   */
  getDiff(worktreePath: string, baseBranch?: string): string {
    const resolvedBaseBranch = baseBranch?.trim() || this.currentBranch();
    const result = this.git(
      ['diff', resolvedBaseBranch + '...HEAD', '--'],
      worktreePath,
    );
    return result;
  }

  /**
   * Get the diff of staged or unstaged changes (not yet committed).
   */
  getUncommittedDiff(worktreePath: string): string {
    // Staged changes
    let diff = '';
    try {
      diff = this.git(['diff', '--cached', '--'], worktreePath);
    } catch {
      // No staged changes
    }
    // Unstaged changes
    try {
      const unstaged = this.git(['diff', '--'], worktreePath);
      if (unstaged) {
        diff = diff ? `${diff}\n${unstaged}` : unstaged;
      }
    } catch {
      // No unstaged changes
    }
    return diff;
  }

  /**
   * Get the current commit hash in the worktree.
   */
  getCurrentCommit(worktreePath: string): string | null {
    try {
      return this.git(['rev-parse', 'HEAD'], worktreePath);
    } catch {
      return null;
    }
  }

  /**
   * Check if the worktree has any uncommitted changes.
   */
  hasUncommittedChanges(worktreePath: string): boolean {
    try {
      const status = this.git(['status', '--porcelain'], worktreePath);
      return status.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Safely check if the worktree path is valid and belongs to the project.
   */
  isValidWorktree(worktreePath: string): boolean {
    if (!existsSync(worktreePath)) return false;
    try {
      const gitDir = this.git(['rev-parse', '--git-dir'], worktreePath);
      // If --git-dir resolves successfully, it's a valid git working tree
      return gitDir.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Safely remove a worktree.
   * Does NOT use `git clean` or `git reset` that could destroy data.
   * Only removes the worktree if the branch has been merged or if force flag is set.
   */
  async cleanupWorktree(branchName: string, worktreePath?: string): Promise<void> {
    const targetPath = worktreePath ?? path.resolve(this.projectRoot, '.brainctl/worktrees', branchName);

    // Check if the worktree directory exists
    if (!existsSync(targetPath)) {
      // Worktree already removed, but we might need to prune
      try {
        this.git(['worktree', 'prune']);
      } catch {
        // Ignore prune errors
      }
      return;
    }

    // Check for uncommitted changes
    if (this.hasUncommittedChanges(targetPath)) {
      throw new Error(
        `Worktree '${branchName}' has uncommitted changes. ` +
        `Commit or stash changes before removing the worktree.`,
      );
    }

    // Remove the worktree using git worktree remove (safe). Windows can keep
    // short-lived file handles open after subprocesses exit, so retry before
    // surfacing a cleanup failure.
    let lastError: unknown = null;
    this.assertCleanupTarget(branchName, targetPath);

    const removeArgs = ['worktree', 'remove', '--', targetPath];
    for (const waitMs of [0, 500, 1000, 2000]) {
      if (waitMs > 0) {
        await this.delay(waitMs);
      }
      try {
        this.git(removeArgs);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError === null) {
      // Prune stale worktree references
      try {
        this.git(['worktree', 'prune']);
      } catch {
        // Ignore
      }
      return;
    }

    // Git can unregister the worktree and still fail to delete the directory
    // on Windows. If it is no longer registered, removing the leftover folder
    // is equivalent to finishing git's cleanup.
    try {
      this.git(['worktree', 'prune']);
    } catch (err) {
      // Ignore prune errors; removal handling below reports the original error.
    }

    if (!this.isRegisteredWorktree(targetPath) && this.cleanupTargetOwned(targetPath)) {
      let directRemovalSucceeded = false;
      try {
        rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        if (!existsSync(targetPath)) {
          directRemovalSucceeded = true;
        }
      } catch {
        // Try the short-path quarantine fallback below.
      }
      if (directRemovalSucceeded) return;

      // A deeply nested ignored dependency tree can exceed Git/Win32 path
      // limits even after Git has unregistered the worktree. Moving the
      // exact owned directory to a short sibling of the project reduces the
      // prefix without traversing or broadening the deletion target.
      {
        const quarantinePath = path.join(
          path.dirname(this.projectRoot),
          `.brainctl-cleanup-${process.pid}-${Date.now()}`,
        );
        try {
          if (existsSync(quarantinePath)) {
            throw new Error(`cleanup quarantine already exists: ${quarantinePath}`);
          }
          renameSync(targetPath, quarantinePath);
          rmSync(quarantinePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
          if (!existsSync(quarantinePath)) return;
        } catch (quarantineError) {
          throw new Error(
            `Failed to finish cleanup of unregistered worktree '${branchName}': ` +
            `${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`,
          );
        }
      }
    }

    throw new Error(
      `Failed to remove worktree '${branchName}': ${lastError instanceof Error ? lastError.message : String(lastError)}\n` +
      `This is a safety measure. If you're sure you want to remove it, ` +
      `manually check the worktree and use 'git worktree remove -f ${targetPath}'.`,
    );
  }

  async cleanupRedundantWorktree(
    branchName: string,
    worktreePath: string | undefined,
    targetRef = 'HEAD',
  ): Promise<void> {
    const targetPath = worktreePath ?? path.resolve(this.projectRoot, '.brainctl/worktrees', branchName);
    if (existsSync(targetPath) && this.hasUncommittedChanges(targetPath)) {
      throw new Error(`Worktree '${branchName}' is dirty and must be preserved.`);
    }
    if (!this.isBranchMergedInto(branchName, targetRef)) {
      throw new Error(`Branch '${branchName}' has unique recoverable commits and must be preserved.`);
    }
    await this.cleanupWorktree(branchName, targetPath);
    this.deleteBranch(branchName);
  }

  /**
   * Remove a local branch safely.
   * Refuses to delete if not merged, unless force is specified.
   */
  deleteBranch(branchName: string): void {
    if (!this.branchExists(branchName)) return;

    try {
      this.git(['branch', '-d', branchName]);
    } catch (err) {
      throw new Error(
        `Branch '${branchName}' is not fully merged. Use --force to delete anyway.`,
      );
    }
  }

  /**
   * Fetch the latest state of the base branch from origin.
   */
  async fetchBaseBranch(baseBranch?: string): Promise<void> {
    const resolvedBaseBranch = baseBranch?.trim() || this.currentBranch();
    try {
      this.git(['fetch', 'origin', resolvedBaseBranch]);
      // Update local branch pointer
      this.git(['branch', '-f', resolvedBaseBranch, `origin/${resolvedBaseBranch}`]);
    } catch {
      // No remote or fetch failed; skip
    }
  }

  private assertCleanupTarget(branchName: string, targetPath: string): void {
    const resolved = path.resolve(targetPath);
    const root = this.safeRealpath(this.projectRoot);
    const target = this.safeRealpath(resolved);
    const rootPath = root ?? this.projectRoot;
    const targetCompare = this.normalizePathForCompare(target ?? resolved);
    const rootCompare = this.normalizePathForCompare(rootPath);
    if (targetCompare === rootCompare || /^[a-z]:\/?$/i.test(targetCompare)) {
      throw new Error(`Refusing to clean unsafe worktree target '${branchName}': target is project root or drive root.`);
    }
    if (this.worktreeBaseDir) {
      const base = this.safeRealpath(this.worktreeBaseDir) ?? this.worktreeBaseDir;
      const baseCompare = this.normalizePathForCompare(base);
      if (!targetCompare.startsWith(baseCompare.endsWith('/') ? baseCompare : baseCompare + '/')) {
        throw new Error(`Refusing to clean worktree outside configured worktreeBaseDir: ${resolved}`);
      }
    }
    if (!this.isRegisteredWorktree(resolved) && !this.cleanupTargetOwned(resolved)) {
      throw new Error(`Refusing to clean unregistered worktree without attempt ownership proof: ${resolved}`);
    }
  }

  private cleanupTargetOwned(targetPath: string): boolean {
    const normalized = this.normalizePathForCompare(targetPath);
    return normalized.includes('/.brainctl-dev/worktrees/') || normalized.includes('/.brainctl/worktrees/');
  }

  private safeRealpath(value: string): string | null {
    try {
      return realpathSync(value);
    } catch {
      return null;
    }
  }
}
