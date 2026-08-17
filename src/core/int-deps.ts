// ── Integration worktree dependency preparation (task 03C) ────────────────
// The stage quality gate runs inside the freshly-created integration worktree,
// but `git worktree add` does NOT bring `node_modules` along. On slow machines
// the gate can start before any deps are present (the "integration worktree
// dependency race"). This module makes dependency readiness a first-class,
// in-repo step: it provisions a run-local deps copy and junctions the new
// worktree's `node_modules` to it BEFORE the gate runs.
//
// CRITICAL (from the phase-0 lesson): the junction target must NEVER be the
// main repository's own `node_modules`. When a merged stage worktree is cleaned
// up, Windows deletes the junction and can recursively clear the target — the
// main `node_modules` was wiped once by exactly this. So we always point at a
// per-run copy under `<projectRoot>/.brainctl-dev/int-deps/<runId>/`.
//
// This is the replacement for the DSH-workspace hack scripts
// (prepare-int-deps.cjs / watch-int-deps*.ps1 / hardlink-deps.cjs).

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, linkSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface PrepareIntDepsInput {
  projectRoot: string;
  runId: string;
  /** Path of the newly created integration worktree. */
  worktreePath: string;
  /** Optional extra files to copy into the worktree (e.g. postcss.config.mjs). */
  extraFiles?: string[];
  /** Hard-link instead of copying the deps farm (default true on Windows). */
  hardlink?: boolean;
}

/**
 * Provision a run-local node_modules copy (hardlinks preferred for speed) and
 * junction/symlink it into the integration worktree so quality gates can run
 * immediately. No-op when the repo has no node_modules (tests/CI without deps).
 */
export function prepareIntWorktreeDeps(input: PrepareIntDepsInput): boolean {
  const { projectRoot, runId, worktreePath } = input;
  const mainNodeModules = resolve(projectRoot, 'node_modules');
  if (!existsSync(mainNodeModules)) return false;

  // Per-run deps copy. Never the main repo's node_modules.
  const runDepsDir = resolve(projectRoot, '.brainctl-dev', 'int-deps', runId);
  const runNodeModules = join(runDepsDir, 'node_modules');
  if (!existsSync(runNodeModules)) {
    mkdirSync(runNodeModules, { recursive: true });
    linkTree(mainNodeModules, runNodeModules, input.hardlink !== false);
  }

  // Junction / symlink the worktree's node_modules to the run-local copy.
  // Do not skip when an EMPTY directory is already present: git/worktree
  // operations can leave an empty node_modules behind, and skipping the link
  // would make stage quality gates run in a dependency-less worktree.
  const wtNodeModules = resolve(worktreePath, 'node_modules');
  if (!existsSync(wtNodeModules) || isStaleEmptyDirectory(wtNodeModules)) {
    linkNodeModules(wtNodeModules, runNodeModules);
  }

  // Extra config files the gates may need (postcss etc.).
  for (const file of input.extraFiles ?? []) {
    const src = resolve(projectRoot, file);
    const dst = resolve(worktreePath, file);
    if (existsSync(src) && !existsSync(dst)) {
      try { copyFileSync(src, dst); } catch { /* best effort */ }
    }
  }
  return true;
}

/** Recursively hard-link (fall back to copy) a source tree into a new dir. */
function linkTree(source: string, dest: string, hardlink: boolean): void {
  for (const entry of readdirSync(source)) {
    const sp = join(source, entry);
    const dp = join(dest, entry);
    const st = lstatSync(sp);
    if (st.isDirectory()) {
      mkdirSync(dp, { recursive: true });
      linkTree(sp, dp, hardlink);
    } else if (st.isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(sp), dp, process.platform === 'win32' ? 'junction' : 'file');
      } catch {
        try { copyFileSync(sp, dp); } catch { /* ignore */ }
      }
    } else if (st.isFile()) {
      if (hardlink) {
        try { linkSync(sp, dp); continue; } catch { /* fall back to copy */ }
      }
      try { copyFileSync(sp, dp); } catch { /* ignore */ }
    }
  }
}

/**
 * Create a directory junction (Windows) or symlink (POSIX) at `linkPath`
 * pointing to `target`. Cleans up a stale empty dir if present.
 */
function linkNodeModules(linkPath: string, target: string): void {
  const parent = dirname(linkPath);
  mkdirSync(parent, { recursive: true });
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // Possibly a stale empty dir (some git operations leave one behind).
    try {
      const st = lstatSync(linkPath);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        rmSync(linkPath, { recursive: true, force: true });
        try { symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* give up */ }
      }
    } catch { /* nothing to clean */ }
  }
}

/** True when `dir` exists as a real empty directory (not a link/junction). */
function isStaleEmptyDirectory(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}
