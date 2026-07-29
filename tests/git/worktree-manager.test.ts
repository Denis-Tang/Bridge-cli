import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorktreeManager } from '../../src/git/worktree-manager.js';

let tmpDir: string;
let repoDir: string;
let worktreeDir: string;
let manager: WorktreeManager;

function runGit(args: string[], cwd?: string): string {
  const workDir = cwd ?? repoDir;
  return execSync(`git ${args.join(' ')}`, {
    cwd: workDir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

describe('WorktreeManager', () => {
  beforeAll(() => {
    // Create a temporary git repository
    tmpDir = path.join(tmpdir(), `brainctl-test-${Date.now()}`);
    repoDir = path.join(tmpDir, 'test-repo');
    worktreeDir = path.join(tmpDir, 'worktrees');

    mkdirSync(repoDir, { recursive: true });

    // Initialize git repo
    runGit(['init']);
    runGit(['config', 'user.email', 'test@brainctl.dev']);
    runGit(['config', 'user.name', 'Test User']);

    // Create an initial commit
    writeFileSync(path.join(repoDir, 'README.md'), '# Test Repo\n');
    runGit(['add', 'README.md']);
    runGit(['commit', '-m', 'init']);

    // Create a main branch
    runGit(['branch', '-M', 'main']);

    // Create some files for testing
    mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    mkdirSync(path.join(repoDir, 'docs'), { recursive: true });
    writeFileSync(path.join(repoDir, 'src', 'index.ts'), '// main file\n');
    writeFileSync(path.join(repoDir, 'docs', 'guide.md'), '# Guide\n');
    runGit(['add', '-A']);
    runGit(['commit', '-m', 'add-sources']);

    manager = new WorktreeManager(repoDir);
  });

  afterAll(() => {
    // Cleanup
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createBranch', () => {
    it('creates a new branch from main', () => {
      const branch = manager.createBranch('task/test-001', 'main');
      expect(branch).toBe('task/test-001');
      const branches = runGit(['branch', '--list']);
      expect(branches).toContain('task/test-001');
    });

    it('returns existing branch without error', () => {
      const branch = manager.createBranch('task/test-001', 'main');
      expect(branch).toBe('task/test-001');
    });
  });

  describe('createWorktree', () => {
    it('creates a worktree for a branch', () => {
      const wtPath = manager.createWorktree('task/test-001', worktreeDir);
      expect(wtPath).toBe(path.resolve(repoDir, worktreeDir));
      expect(existsSync(wtPath)).toBe(true);

      // Verify it's on the correct branch
      const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath);
      expect(branch).toBe('task/test-001');
    });
  });

  describe('getChangedFiles and getDiff', () => {
    it('detects no changes initially', () => {
      const files = manager.getChangedFiles(worktreeDir, 'main');
      expect(files).toEqual([]);
    });

    it('detects changed files after modification', () => {
      // Make a change in the worktree
      writeFileSync(path.join(worktreeDir, 'docs', 'guide.md'), '# Updated Guide\nMore content\n');

      runGit(['add', 'docs/guide.md'], worktreeDir);
      runGit(['commit', '-m', 'update-guide'], worktreeDir);

      const files = manager.getChangedFiles(worktreeDir, 'main');
      expect(files).toContain('docs/guide.md');
    });

    it('getDiff returns patch content', () => {
      const diff = manager.getDiff(worktreeDir, 'main');
      expect(diff).toContain('docs/guide.md');
      expect(diff).toContain('# Updated Guide');
    });
  });

  describe('hasUncommittedChanges', () => {
    it('returns false for clean worktree', () => {
      expect(manager.hasUncommittedChanges(worktreeDir)).toBe(false);
    });

    it('returns true for dirty worktree', () => {
      writeFileSync(path.join(worktreeDir, 'new-file.txt'), 'new content');
      expect(manager.hasUncommittedChanges(worktreeDir)).toBe(true);
      // Clean up
      execSync(`git -C "${worktreeDir}" checkout -- .`, { stdio: 'pipe' });
    });
  });

  describe('getCurrentCommit', () => {
    it('returns a valid commit hash', () => {
      const hash = manager.getCurrentCommit(worktreeDir);
      expect(hash).not.toBeNull();
      expect(hash!.length).toBe(40); // SHA-1 length
    });
  });

  describe('isValidWorktree', () => {
    it('validates a correct worktree', () => {
      expect(manager.isValidWorktree(worktreeDir)).toBe(true);
    });

    it('rejects non-existent directory', () => {
      expect(manager.isValidWorktree('/nonexistent/path')).toBe(false);
    });

    it('rejects invalid directory', () => {
      expect(manager.isValidWorktree(tmpDir)).toBe(false);
    });
  });

  describe('cleanupWorktree', () => {
    it('removes a worktree safely', async () => {
      // Create another branch and worktree for cleanup testing
      const branchName = 'task/test-cleanup';
      const wtDir = path.join(tmpDir, 'cleanup-wt');
      manager.createBranch(branchName, 'main');
      manager.createWorktree(branchName, wtDir);

      expect(existsSync(wtDir)).toBe(true);

      // Commit to avoid uncommitted changes error
      writeFileSync(path.join(wtDir, 'cleanup-test.txt'), 'cleanup test');
      runGit(['add', 'cleanup-test.txt'], wtDir);
      runGit(['commit', '-m', 'cleanup-test'], wtDir);

      // Merge the branch first
      runGit(['checkout', 'main']);
      runGit(['merge', branchName, '--no-edit']);

      await manager.cleanupWorktree(branchName, wtDir);
      expect(existsSync(wtDir)).toBe(false);
    });

    it.runIf(process.platform === 'win32')('finishes cleanup when an ignored nested path exceeds MAX_PATH', async () => {
      const branchName = 'task/test-long-cleanup';
      const cleanupManager = new WorktreeManager(repoDir, { worktreeBaseDir: '.brainctl-dev/worktrees' });
      const wtDir = path.join(repoDir, '.brainctl-dev', 'worktrees', 'cleanup-long-wt');
      cleanupManager.createBranch(branchName, 'main');
      cleanupManager.createWorktree(branchName, wtDir);

      writeFileSync(path.join(wtDir, '.gitignore'), 'ignored/\n');
      runGit(['add', '.gitignore'], wtDir);
      runGit(['commit', '-m', 'ignore-cleanup-fixture'], wtDir);
      const deepDir = path.join(wtDir, 'ignored', ...Array.from({ length: 12 }, (_, index) => `segment-${index}-${'x'.repeat(18)}`));
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(path.join(deepDir, 'leftover.txt'), 'ignored cleanup fixture');

      runGit(['checkout', 'main']);
      runGit(['merge', branchName, '--no-edit']);
      await cleanupManager.cleanupWorktree(branchName, wtDir);

      expect(existsSync(wtDir)).toBe(false);
    });
  });

  describe('deleteBranch', () => {
    it('deletes a merged branch', () => {
      manager.deleteBranch('task/test-cleanup');
      const branches = runGit(['branch', '--list']);
      expect(branches).not.toContain('task/test-cleanup');
    });

    it('throws for unmerged branch', () => {
      // Create a branch and add a commit that won't be merged
      manager.createBranch('task/test-unmerged', 'main');
      const wtDir2 = path.join(tmpDir, 'unmerged-wt');
      manager.createWorktree('task/test-unmerged', wtDir2);
      writeFileSync(path.join(wtDir2, 'unmerged.txt'), 'data');
      runGit(['add', 'unmerged.txt'], wtDir2);
      runGit(['commit', '-m', 'unmerged-commit'], wtDir2);

      // Go back to main so current branch is not the one being deleted
      runGit(['checkout', 'main']);

      expect(() => manager.deleteBranch('task/test-unmerged')).toThrow();
      // Clean up: remove worktree first, then force delete branch
      runGit(['worktree', 'remove', '--force', wtDir2]);
      runGit(['branch', '-D', 'task/test-unmerged']);
      try { rmSync(wtDir2, { recursive: true, force: true }); } catch {}
    });
  });
});
