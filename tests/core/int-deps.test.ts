// ── Integration worktree deps preparation (task 03C) ──────────────────────
// The stage gate runs inside a fresh integration worktree that git worktree add
// does not populate with node_modules. `prepareIntWorktreeDeps` must provision a
// run-LOCAL deps copy and junction the worktree to it — and must NEVER point at
// the main repository's own node_modules (the phase-0 wipe lesson).

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareIntWorktreeDeps } from '../../src/core/int-deps.js';

function makeTree(): { root: string; projectRoot: string } {
  const root = path.join(tmpdir(), `bridge-intdeps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const projectRoot = path.join(root, 'project');
  mkdirSync(path.join(projectRoot, 'node_modules', 'typescript', 'bin'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'node_modules', 'vitest'), 'export const v = 1;\n', 'utf-8');
  writeFileSync(path.join(projectRoot, 'postcss.config.mjs'), 'export default {};\n', 'utf-8');
  return { root, projectRoot };
}

describe('prepareIntWorktreeDeps', () => {
  it('provisions run-local deps and links them into the worktree', () => {
    const { root, projectRoot } = makeTree();
    const runId = 'run-test-1';
    const worktreePath = path.join(root, 'project', '.brainctl-dev', 'worktrees', runId, 'int', 'stage-1', 'a1');
    mkdirSync(worktreePath, { recursive: true });

    const ok = prepareIntWorktreeDeps({ projectRoot, runId, worktreePath, extraFiles: ['postcss.config.mjs'] });

    expect(ok).toBe(true);
    const runDeps = path.join(projectRoot, '.brainctl-dev', 'int-deps', runId, 'node_modules');
    expect(existsSync(runDeps)).toBe(true);
    expect(readdirSync(runDeps).sort()).toEqual(['typescript', 'vitest']);
    expect(existsSync(path.join(worktreePath, 'node_modules'))).toBe(true);
    expect(existsSync(path.join(worktreePath, 'postcss.config.mjs'))).toBe(true);
  });

  it('does not create a junction to the MAIN repo node_modules (run-local only)', () => {
    const { root, projectRoot } = makeTree();
    const runId = 'run-test-2';
    const worktreePath = path.join(root, 'project', '.brainctl-dev', 'worktrees', runId, 'int', 'stage-1', 'a1');
    mkdirSync(worktreePath, { recursive: true });

    prepareIntWorktreeDeps({ projectRoot, runId, worktreePath });

    // The worktree node_modules must resolve inside the run-local deps dir,
    // never to <projectRoot>/node_modules directly.
    const mainNm = path.join(projectRoot, 'node_modules');
    const runNm = path.join(projectRoot, '.brainctl-dev', 'int-deps', runId, 'node_modules');
    expect(path.resolve(mainNm)).not.toBe(path.resolve(runNm));
    // Sanity: a file visible through the worktree link exists in the run copy.
    expect(existsSync(path.join(runNm, 'typescript', 'bin', 'tsc'))).toBe(true);
  });

  it('is a no-op when the repo has no node_modules (fake/CI fixtures)', () => {
    const root = path.join(tmpdir(), `bridge-intdeps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const projectRoot = path.join(root, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const worktreePath = path.join(projectRoot, '.brainctl-dev', 'worktrees', 'r', 'int', 'stage-1', 'a1');
    mkdirSync(worktreePath, { recursive: true });

    const ok = prepareIntWorktreeDeps({ projectRoot, runId: 'r', worktreePath });
    expect(ok).toBe(false);
    expect(existsSync(path.join(projectRoot, '.brainctl-dev', 'int-deps'))).toBe(false);
  });
});
