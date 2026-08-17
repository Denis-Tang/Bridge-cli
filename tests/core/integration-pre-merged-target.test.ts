// Target branch that already contains EXACTLY the reviewed integration tree must
// be accepted without a second merge and without re-invoking a Reviewer. Every
// other shape of an advanced target must still be rejected (fail-closed).
//
// Real disposable git repos; no providers, no database.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StageIntegrationCoordinator } from '../../src/core/stage-integration.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(root: string, file: string, body: string, message: string): string {
  writeFileSync(path.join(root, file), body, 'utf-8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** Reproduce the real-world shape: stage base on main, an integration branch off
 *  it, then main merged with --no-ff so the reviewed tree is already present. */
function setupRepo(): { root: string; base: string; reviewed: string } {
  const root = path.join(tmpdir(), `bridge-premerge-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  cleanup.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  commit(root, 'seed.txt', 'seed\n', 'seed');
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '-b', 'brainctl/int/stage-1/a1']);
  const reviewed = commit(root, 'feature.txt', 'feature\n', 'reviewed integration');
  git(root, ['checkout', 'main']);
  return { root, base, reviewed };
}

function coordinatorFor(root: string): StageIntegrationCoordinator {
  return new StageIntegrationCoordinator(
    {} as never,
    { projectRoot: root, targetBranch: 'main' } as never,
    {} as never,
    {} as never,
  );
}

function detect(root: string, targetHead: string, reviewed: string, base: string): {
  accepted: boolean; reason: string; reviewedTree: string;
} {
  const coordinator = coordinatorFor(root) as unknown as {
    detectAlreadyMergedReviewedTree(
      targetBranch: string, targetHead: string, reviewedIntegrationCommit: string, stageBase: string,
    ): { accepted: boolean; reason: string; reviewedTree: string };
  };
  return coordinator.detectAlreadyMergedReviewedTree('main', targetHead, reviewed, base);
}

describe('pre-merged target detection', () => {
  it('accepts a target whose merge commit contains exactly the reviewed tree', () => {
    const { root, base, reviewed } = setupRepo();
    git(root, ['merge', '--no-ff', '--no-edit', '--', 'brainctl/int/stage-1/a1']);
    const targetHead = git(root, ['rev-parse', 'main']);

    // Same shape as the real incident: two parents = base + reviewed, trees equal.
    expect(git(root, ['rev-list', '--parents', '-n', '1', 'main']).split(/\s+/).slice(1))
      .toEqual([base, reviewed]);
    expect(git(root, ['rev-parse', 'main^{tree}'])).toBe(git(root, ['rev-parse', `${reviewed}^{tree}`]));

    const result = detect(root, targetHead, reviewed, base);
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('target_already_contains_reviewed_tree');
    expect(result.reviewedTree).toBe(git(root, ['rev-parse', `${reviewed}^{tree}`]));
  });

  it('accepts a fast-forward target, where the tree also matches exactly', () => {
    const { root, base, reviewed } = setupRepo();
    git(root, ['merge', '--ff-only', '--', 'brainctl/int/stage-1/a1']);
    expect(git(root, ['rev-parse', 'main'])).toBe(reviewed);

    expect(detect(root, git(root, ['rev-parse', 'main']), reviewed, base).accepted).toBe(true);
  });

  it('rejects a target that advanced beyond the reviewed tree', () => {
    const { root, base, reviewed } = setupRepo();
    git(root, ['merge', '--no-ff', '--no-edit', '--', 'brainctl/int/stage-1/a1']);
    // Unreviewed work landed after the review — must never be silently accepted.
    commit(root, 'extra.txt', 'unreviewed\n', 'extra work after review');
    const targetHead = git(root, ['rev-parse', 'main']);

    const result = detect(root, targetHead, reviewed, base);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('target_tree_differs_from_reviewed_tree');
  });

  it('rejects a target that never absorbed the reviewed commit', () => {
    const { root, base, reviewed } = setupRepo();
    commit(root, 'other.txt', 'other\n', 'unrelated advance on target');
    const targetHead = git(root, ['rev-parse', 'main']);

    const result = detect(root, targetHead, reviewed, base);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('reviewed_integration_commit_not_ancestor_of_target');
  });

  it('rejects a coincidentally identical tree that lacks the reviewed ancestry', () => {
    const { root, base, reviewed } = setupRepo();
    // Replay the same content on main without merging the reviewed commit:
    // trees will match, ancestry will not. Tree equality alone must not suffice.
    commit(root, 'feature.txt', 'feature\n', 'same content, different history');
    const targetHead = git(root, ['rev-parse', 'main']);
    expect(git(root, ['rev-parse', 'main^{tree}'])).toBe(git(root, ['rev-parse', `${reviewed}^{tree}`]));

    const result = detect(root, targetHead, reviewed, base);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('reviewed_integration_commit_not_ancestor_of_target');
  });

  it('rejects a rewritten history where the stage base is no longer an ancestor', () => {
    const { root, base, reviewed } = setupRepo();
    git(root, ['merge', '--no-ff', '--no-edit', '--', 'brainctl/int/stage-1/a1']);
    const realBase = base;
    // A base from an unrelated history line (e.g. after a rebase/filter) must not
    // be treated as the same line just because the tree happens to match.
    git(root, ['checkout', '--orphan', 'rewritten']);
    git(root, ['rm', '-rf', '--cached', '.']);
    const orphanBase = commit(root, 'seed.txt', 'seed\n', 'rewritten seed');
    git(root, ['checkout', 'main']);
    const targetHead = git(root, ['rev-parse', 'main']);

    expect(detect(root, targetHead, reviewed, realBase).accepted).toBe(true);
    const result = detect(root, targetHead, reviewed, orphanBase);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('stage_base_not_ancestor_of_target');
  });

  it('fails closed when git cannot resolve the reviewed commit', () => {
    const { root, base } = setupRepo();
    const result = detect(root, git(root, ['rev-parse', 'main']), 'f'.repeat(40), base);
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/^pre_merge_probe_failed: /);
  });
});
