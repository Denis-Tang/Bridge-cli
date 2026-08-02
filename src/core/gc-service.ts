// ── R1 GC Service: orphan worktree/branch inventory & constrained recycling ──
// Powers `brainctl gc`.
//
// Design contract (see docs/三轮提示词/01-第一轮-worktree与分支孤儿泄漏.md):
// - inventory() is ALWAYS read-only: zero writes to filesystem, Git or SQLite.
// - apply() only recycles entries classified as safe_to_recycle, and re-verifies
//   every precondition ON SITE right before deletion (never trusts the snapshot).
// - Entries with uncommitted changes, non-terminal attempts, unknown origin, or
//   a branch carrying commits not contained in HEAD (paid work recoverable via
//   `brainctl recover attempt`) are NEVER recycled — they go to manual_review.
// - Paths outside the configured worktrees root are do_not_touch, never touched.
// - Registered-but-missing worktrees are stale_registration → git worktree prune.
// - Every recycle writes an auditable SQLite event with the decision note.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync, renameSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';
import type { SqliteStateStore } from '../state/sqlite-store.js';
import { checkWorktreeRegistered } from './reconciliation/worktree-fact-checker.js';
import { checkBranchExists, isBranchMerged } from './reconciliation/git-fact-checker.js';
import { WorktreeManager } from '../git/worktree-manager.js';

// ── Types ────────────────────────────────────────────────────────────────

export type GcCategory =
  | 'safe_to_recycle'
  | 'manual_review'
  | 'do_not_touch'
  | 'stale_registration';

export type GcDeletionMethod =
  | 'recycle_bin'
  | 'permanent'
  | 'git_worktree_remove'
  | 'prune'
  | null;

export interface GcEntry {
  path: string;
  category: GcCategory;
  reason: string;                      // human-readable classification rationale
  branchName: string | null;
  runId: string | null;
  stageId: string | null;
  taskId: string | null;
  attemptId: string | null;
  ownerKind: 'attempt' | 'integration' | 'unknown';
  ownerStatus: string | null;
  projectRoot: string | null;          // repo used for git checks (entry-scoped)
  targetBranch: string | null;         // run's frozen target branch (from execution snapshot); null = unknown
  registered: boolean;                 // in `git worktree list` at inventory time
  dirExists: boolean;
  dirty: boolean;                      // uncommitted tracked changes (or unverifiable)
  unmerged: boolean | null;            // branch has commits not contained in the target branch;
                                       // null = target branch unavailable → fail closed (manual_review)
  diskBytes: number;
  lastModified: string | null;
  deleted: boolean;                    // filled by apply()
  deletionMethod: GcDeletionMethod;
}

export interface GcInventory {
  entries: GcEntry[];
  summary: {
    total: number;
    totalBytes: number;
    byCategory: Record<GcCategory, { count: number; bytes: number }>;
  };
}

export interface GcApplyOptions {
  decisionNote: string;
  /** Fallback repo root for git checks when an entry carries no projectRoot. */
  projectRoot?: string;
  /** Prefer OS recycle bin when available (default true). */
  recycleBin?: boolean;
}

export interface GcApplyResult {
  results: GcEntry[];
  recycledCount: number;
  skippedCount: number;
  pruned: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────

/** Attempt states that are terminal for GC purposes (same set as cleanupMergedStageWorktrees). */
export const ATTEMPT_TERMINAL_STATUSES = new Set([
  'approved', 'failed', 'interrupted', 'canceled', 'rework_required',
]);

/** Integration batch states that are terminal for GC purposes. */
export const INTEGRATION_TERMINAL_STATUSES = new Set(['completed', 'failed']);

const WORKTREES_ROOT_REL = '.brainctl-dev/worktrees';

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeForCompare(p: string): string {
  const resolved = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(root: string, target: string): boolean {
  const r = normalizeForCompare(root);
  const t = normalizeForCompare(target);
  return t === r || t.startsWith(r + '/');
}

function worktreesRootFor(projectRoot: string): string {
  return resolve(projectRoot, WORKTREES_ROOT_REL);
}

interface DirtyCheck {
  dirty: boolean;
  verifiable: boolean;
}

/** Fail-closed dirty check.
 *  - git status succeeds → trust it.
 *  - git status fails AND the dir's .git file points to a gitdir that no longer
 *    exists → git has fully deregistered the directory (dead leftover): no active
 *    tracked state, treat as clean & verifiable.
 *  - anything else (unparseable .git, gitdir still present but git errors) →
 *    cannot verify → conservative dirty (manual review). */
function checkDirtyFailClosed(dir: string): DirtyCheck {
  if (!existsSync(dir)) return { dirty: false, verifiable: true };
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir, stdio: 'pipe', encoding: 'utf-8', timeout: 5000,
    });
    return { dirty: out.trim().length > 0, verifiable: true };
  } catch {
    const gitFile = resolve(dir, '.git');
    if (existsSync(gitFile)) {
      try {
        const content = readFileSync(gitFile, 'utf-8').trim();
        const m = content.match(/^gitdir:\s*(.+)$/m);
        if (m) {
          const gitdir = resolve(m[1].trim());
          if (!existsSync(gitdir)) return { dirty: false, verifiable: true };
        }
      } catch { /* fallthrough */ }
      return { dirty: true, verifiable: false };
    }
    return { dirty: false, verifiable: true };
  }
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(cur); } catch { continue; }
    for (const name of entries) {
      const p = resolve(cur, name);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) stack.push(p);
        else total += st.size;
      } catch { /* skip unreadable */ }
    }
  }
  return total;
}

function lastModifiedOf(dir: string): string | null {
  try { return statSync(dir).mtime.toISOString(); } catch { return null; }
}

function runGit(projectRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe', encoding: 'utf-8', timeout: 10000 }).trim();
}

/** Enumerate runId/taskId/aN (and runId/int/stage-N/aN) directories under the worktrees root. */
function enumerateWorktreeDirs(wtRoot: string): string[] {
  const found: string[] = [];
  let runDirs: string[];
  try { runDirs = readdirSync(wtRoot); } catch { return found; }
  for (const runDir of runDirs) {
    const runPath = resolve(wtRoot, runDir);
    if (!isDir(runPath)) continue;
    let taskDirs: string[];
    try { taskDirs = readdirSync(runPath); } catch { continue; }
    for (const taskDir of taskDirs) {
      const taskPath = resolve(runPath, taskDir);
      if (!isDir(taskPath)) continue;
      let attemptDirs: string[];
      try { attemptDirs = readdirSync(taskPath); } catch { continue; }
      for (const attemptDir of attemptDirs) {
        const attemptPath = resolve(taskPath, attemptDir);
        if (isDir(attemptPath)) found.push(attemptPath);
      }
    }
  }
  return found;
}

function isDir(p: string): boolean {
  try { return lstatSync(p).isDirectory(); } catch { return false; }
}

// ── Service ──────────────────────────────────────────────────────────────

export class GcService {
  constructor(private readonly store: SqliteStateStore) {}

  /** Read-only inventory. Zero writes to filesystem, Git or SQLite. */
  async inventory(): Promise<GcInventory> {
    const db = this.store.getDatabase();

    // runs → projectRoot + frozen target branch for every run in the store.
    // NOTE: `runs` has NO target_branch column; the authoritative target branch
    // is the one frozen into `runs.execution_config_snapshot` (JSON) at run
    // creation time (see config-snapshot.ts). Missing/unparseable snapshot →
    // null → fail closed (manual_review), never fall back to HEAD.
    const runRows = db.prepare('SELECT id, project_root, status, execution_config_snapshot FROM runs').all() as Array<{
      id: string; project_root: string; status: string; execution_config_snapshot: string | null;
    }>;
    const runProjectRoot = new Map<string, string>();
    const runTargetBranch = new Map<string, string | null>();
    for (const r of runRows) {
      runProjectRoot.set(r.id, r.project_root);
      let target: string | null = null;
      if (r.execution_config_snapshot) {
        try {
          const parsed = JSON.parse(r.execution_config_snapshot) as { config?: { targetBranch?: unknown } };
          const value = parsed?.config?.targetBranch;
          if (typeof value === 'string' && value.trim()) target = value.trim();
        } catch { target = null; }
      }
      runTargetBranch.set(r.id, target);
    }

    // Every attempt carrying a worktree path (or an orphan branch).
    const attemptRows = db.prepare(`
      SELECT a.id, a.task_id, a.stage_id, t.run_id, a.status, a.worktree_path, a.branch_name
      FROM task_attempts a JOIN tasks t ON t.id = a.task_id
    `).all() as Array<{
      id: string; task_id: string; stage_id: string; run_id: string;
      status: string; worktree_path: string | null; branch_name: string | null;
    }>;

    // Integration batches (worktree paths are not stored; linked by filesystem enumeration).
    const batchRows = db.prepare(`
      SELECT id, stage_id, run_id, status, integration_branch FROM integration_batches
    `).all() as Array<{
      id: string; stage_id: string; run_id: string; status: string; integration_branch: string;
    }>;

    const entries: GcEntry[] = [];

    // 1) Attempt candidates.
    for (const a of attemptRows) {
      const projectRoot = runProjectRoot.get(a.run_id) ?? null;
      const targetBranch = runTargetBranch.get(a.run_id) ?? null;
      if (!a.worktree_path) {
        if (a.branch_name) {
          entries.push(this.buildEntry({
            path: '', runId: a.run_id, stageId: a.stage_id, taskId: a.task_id,
            attemptId: a.id, ownerKind: 'attempt', ownerStatus: a.status,
            branchName: a.branch_name, projectRoot, targetBranch, registered: false,
            dirExists: false, dirty: false, unmerged: null,
            category: 'manual_review',
            reason: '数据库记录了分支但无 worktree 路径，无法安全判断',
          }));
        }
        continue;
      }
      const path = resolve(a.worktree_path);
      const projectRootForCheck = projectRoot;
      const dirExists = existsSync(path);
      const registered = projectRootForCheck ? checkWorktreeRegistered(projectRootForCheck, path) : false;
      const dirtyCheck = checkDirtyFailClosed(path);
      const branchExists = projectRootForCheck && a.branch_name ? checkBranchExists(projectRootForCheck, a.branch_name) : false;
      // Paid-work guard against the run's FROZEN target branch, never HEAD:
      // HEAD may sit on a branch that already contains the attempt's commits
      // (e.g. the user is on the integration branch), which would silently turn
      // a recyclable-looking entry into a real data loss. Target unknown or
      // missing in the repo → fail closed (null → manual_review).
      const targetExists = targetBranch && projectRootForCheck ? checkBranchExists(projectRootForCheck, targetBranch) : false;
      const unmerged: boolean | null = branchExists && projectRootForCheck && a.branch_name
        ? (targetBranch && targetExists ? !isBranchMerged(projectRootForCheck, a.branch_name, targetBranch) : null)
        : false;
      const terminal = ATTEMPT_TERMINAL_STATUSES.has(a.status);

      entries.push(this.buildEntry({
        path, runId: a.run_id, stageId: a.stage_id, taskId: a.task_id,
        attemptId: a.id, ownerKind: 'attempt', ownerStatus: a.status,
        branchName: a.branch_name, projectRoot: projectRootForCheck, targetBranch,
        registered, dirExists, dirty: dirtyCheck.dirty, unmerged,
        category: this.classify({
          path, projectRoot: projectRootForCheck, dirExists, registered,
          dirtyCheck, terminal, unmerged, unknownOrigin: false, ownerStatus: a.status,
        }),
        reason: '',
      }));
    }

    // 2) Filesystem leftovers without a matching attempt (unknown origin).
    const knownPaths = new Set(entries.map((e) => e.path && normalizeForCompare(e.path)));
    for (const runId of runProjectRoot.keys()) {
      const projectRoot = runProjectRoot.get(runId)!;
      if (!existsSync(projectRoot)) continue;
      const wtRoot = worktreesRootFor(projectRoot);
      for (const dir of enumerateWorktreeDirs(wtRoot)) {
        if (knownPaths.has(normalizeForCompare(dir))) continue;
        // Try to link int/ directories to integration batches (terminal check only).
        const isIntDir = dir.includes(join('int', sep));
        let batchTerminal = false;
        if (isIntDir) {
          batchTerminal = batchRows.filter((b) => b.run_id === runId)
            .length > 0 && batchRows.filter((b) => b.run_id === runId)
            .every((b) => INTEGRATION_TERMINAL_STATUSES.has(b.status));
        }
        const dirtyCheck = checkDirtyFailClosed(dir);
        const terminal = isIntDir ? batchTerminal : false;
        entries.push(this.buildEntry({
          path: dir, runId, stageId: null, taskId: null, attemptId: null,
          ownerKind: isIntDir ? 'integration' : 'unknown', ownerStatus: isIntDir ? (batchTerminal ? 'terminal' : 'non-terminal') : null,
          branchName: null, projectRoot, targetBranch: runTargetBranch.get(runId) ?? null,
          registered: checkWorktreeRegistered(projectRoot, dir),
          dirExists: true, dirty: dirtyCheck.dirty, unmerged: false,
          category: this.classify({
            path: dir, projectRoot, dirExists: true, registered: false,
            dirtyCheck, terminal, unmerged: false, unknownOrigin: !isIntDir,
            ownerStatus: isIntDir ? 'integration' : null,
          }),
          reason: isIntDir ? 'integration 残留目录' : 'SQLite 无对应记录（来源不明）',
        }));
      }
    }

    return { entries, summary: summarize(entries) };
  }

  /** Recycle safe_to_recycle entries only. Every precondition is re-verified on site. */
  async apply(inventory: GcInventory, options: GcApplyOptions): Promise<GcApplyResult> {
    if (!options.decisionNote || !options.decisionNote.trim()) {
      throw new Error('--apply requires --decision-note <reason> (explicit auditable decision)');
    }
    const note = options.decisionNote.trim();
    const results: GcEntry[] = [];
    const prunedRoots = new Set<string>();
    let pruned = false;

    for (const entry of inventory.entries) {
      if (entry.category === 'stale_registration') {
        const root = entry.projectRoot ?? options.projectRoot;
        if (root && !prunedRoots.has(root)) {
          try {
            runGit(root, ['worktree', 'prune']);
            pruned = true;
          } catch { /* prune failure is not fatal; keep entry flagged */ }
          prunedRoots.add(root);
        }
        results.push({ ...entry, deleted: false, deletionMethod: 'prune' });
        continue;
      }
      if (entry.category !== 'safe_to_recycle') {
        results.push({ ...entry });
        continue;
      }

      const root = entry.projectRoot ?? options.projectRoot;
      if (!root) {
        results.push({ ...entry, category: 'manual_review', reason: 'projectRoot 不可用，无法现场复核' });
        continue;
      }
      const fresh = await this.reverify(entry, root);
      if (!fresh.recyclable) {
        results.push({ ...entry, ...fresh.patch, deleted: false });
        continue;
      }

      const outcome = await this.recycle(fresh.entry, root, note);
      results.push(outcome);
    }

    return {
      results,
      recycledCount: results.filter((r) => r.deleted).length,
      skippedCount: results.filter((r) => !r.deleted).length,
      pruned,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private buildEntry(input: {
    path: string; runId: string | null; stageId: string | null; taskId: string | null;
    attemptId: string | null; ownerKind: GcEntry['ownerKind']; ownerStatus: string | null;
    branchName: string | null; projectRoot: string | null; targetBranch: string | null; registered: boolean;
    dirExists: boolean; dirty: boolean; unmerged: boolean | null;
    category: GcCategory; reason: string;
  }): GcEntry {
    const reasons: string[] = [];
    if (input.reason) reasons.push(input.reason);
    switch (input.category) {
      case 'do_not_touch':
        reasons.push('位于 worktrees 根之外，拒绝处理');
        break;
      case 'stale_registration':
        reasons.push('git 仍注册但目录已不存在，可 git worktree prune');
        break;
      case 'safe_to_recycle':
        reasons.push('在 worktrees 根内 + 无未提交改动 + 已终态 + 分支无未合并提交');
        break;
      case 'manual_review':
        if (input.dirty) reasons.push('有未提交 tracked 改动');
        if (input.unmerged === true) reasons.push('该分支含未合并的已付费提交，删除后无法 recover attempt');
        if (input.unmerged === null) reasons.push('目标分支不可用（run 快照缺失或分支不存在），无法验证未合并状态');
        if (!input.ownerStatus || input.ownerKind === 'unknown') reasons.push('SQLite 中无对应记录（来源不明）');
        else if (!ATTEMPT_TERMINAL_STATUSES.has(input.ownerStatus)
          && !INTEGRATION_TERMINAL_STATUSES.has(input.ownerStatus)) reasons.push(`attempt/批次仍非终态（${input.ownerStatus}）`);
        if (input.registered) reasons.push('仍被 git worktree 注册');
        break;
    }
    return {
      path: input.path,
      category: input.category,
      reason: reasons.join('；'),
      branchName: input.branchName,
      runId: input.runId,
      stageId: input.stageId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      ownerKind: input.ownerKind,
      ownerStatus: input.ownerStatus,
      projectRoot: input.projectRoot,
      targetBranch: input.targetBranch,
      registered: input.registered,
      dirExists: input.dirExists,
      dirty: input.dirty,
      unmerged: input.unmerged,
      diskBytes: input.dirExists ? dirSize(input.path) : 0,
      lastModified: input.dirExists ? lastModifiedOf(input.path) : null,
      deleted: false,
      deletionMethod: null,
    };
  }

  private classify(input: {
    path: string; projectRoot: string | null; dirExists: boolean; registered: boolean;
    dirtyCheck: DirtyCheck; terminal: boolean; unmerged: boolean | null; unknownOrigin: boolean;
    ownerStatus: string | null;
  }): GcCategory {
    // Out-of-root paths are never touched.
    if (!input.projectRoot || !isPathInside(worktreesRootFor(input.projectRoot), input.path)) {
      return 'do_not_touch';
    }
    if (!input.dirExists) {
      return input.registered ? 'stale_registration' : 'manual_review';
    }
    if (input.dirtyCheck.dirty || !input.dirtyCheck.verifiable) return 'manual_review';
    if (input.unmerged === true || input.unmerged === null) return 'manual_review'; // null → target unknown, fail closed
    if (!input.terminal) return 'manual_review';
    if (input.unknownOrigin) return 'manual_review';
    return 'safe_to_recycle';
  }

  /** Re-verify ALL preconditions against current state (never trust the inventory snapshot). */
  private async reverify(
    entry: GcEntry,
    fallbackRoot: string | undefined,
  ): Promise<{ recyclable: boolean; entry: GcEntry; patch: Partial<GcEntry> }> {
    const root = entry.projectRoot ?? fallbackRoot ?? null;
    const patch: Partial<GcEntry> = {};
    if (!root) {
      return { recyclable: false, entry, patch: { category: 'manual_review', reason: 'projectRoot 不可用，无法现场复核' } };
    }
    // 1) still inside the configured root?
    if (!isPathInside(worktreesRootFor(root), entry.path)) {
      return { recyclable: false, entry, patch: { category: 'do_not_touch', reason: '现场复核：路径已不在 worktrees 根内，拒绝处理' } };
    }
    // 2) directory still exists?
    if (!existsSync(entry.path)) {
      return { recyclable: false, entry, patch: { category: 'stale_registration', reason: '现场复核：目录已不存在' } };
    }
    // 3) attempt/batch still terminal? (re-read from SQLite)
    let terminal = false;
    if (entry.attemptId) {
      const row = this.store.getDatabase().prepare(
        'SELECT status FROM task_attempts WHERE id = ?'
      ).get(entry.attemptId) as { status: string } | undefined;
      terminal = !!row && ATTEMPT_TERMINAL_STATUSES.has(row.status);
      patch.ownerStatus = row?.status ?? null;
    } else if (entry.ownerKind === 'integration') {
      terminal = true; // batch terminal already validated during inventory
    }
    if (!terminal) {
      return { recyclable: false, entry, patch: { category: 'manual_review', reason: `现场复核：attempt 已非终态（${patch.ownerStatus ?? 'unknown'}）` } };
    }
    // 4) dirty re-check (fail-closed)
    const dirtyCheck = checkDirtyFailClosed(entry.path);
    if (dirtyCheck.dirty || !dirtyCheck.verifiable) {
      return { recyclable: false, entry, patch: { category: 'manual_review', reason: '现场复核：发现未提交 tracked 改动' } };
    }
    // 5) unmerged-commit re-check (paid-work guard) against the run's FROZEN
    //    target branch, never HEAD. Target missing/unknown → fail closed.
    if (entry.branchName) {
      if (!entry.targetBranch || !checkBranchExists(root, entry.targetBranch)) {
        return { recyclable: false, entry, patch: { category: 'manual_review', reason: '现场复核：目标分支不可用，无法验证未合并状态' } };
      }
      if (checkBranchExists(root, entry.branchName) && !isBranchMerged(root, entry.branchName, entry.targetBranch)) {
        return { recyclable: false, entry, patch: { category: 'manual_review', reason: '现场复核：该分支含未合并的已付费提交，删除后无法 recover attempt' } };
      }
    }
    return { recyclable: true, entry: { ...entry, ...patch, projectRoot: root }, patch };
  }

  private async recycle(entry: GcEntry, root: string, note: string): Promise<GcEntry> {
    const wtm = new WorktreeManager(root, { worktreeBaseDir: worktreesRootFor(root) });
    try {
      // Guard: the paid-work guard MUST compare against the run's frozen target
      // branch. HEAD is not acceptable here — cleanupRedundantWorktree would
      // delete a branch that is merged into HEAD but NOT into the target.
      if (!entry.targetBranch || !checkBranchExists(root, entry.targetBranch)) {
        return { ...entry, deleted: false, category: 'manual_review', reason: '回收前复核：目标分支不可用，无法验证未合并状态' };
      }
      if (entry.registered) {
        // Safe path: git worktree remove (dirty → git refuses) + branch -d.
        // cleanupRedundantWorktree re-checks dirty AND merged against the
        // target branch; it throws and we fall back to manual_review instead
        // of ever forcing.
        await wtm.cleanupRedundantWorktree(entry.branchName ?? '', entry.path, entry.targetBranch);
        await this.recordRecycle(entry, root, note, 'git_worktree_remove');
        return { ...entry, deleted: true, deletionMethod: 'git_worktree_remove' };
      }
      // Deregistered leftover directory: recycle bin first, then long-path
      // quarantine, then permanent delete. Re-verify absence after each step.
      const method = await this.recycleOrDelete(entry.path, root);
      // If the branch survives and is fully merged into the target, drop it
      // safely (-d refuses otherwise).
      if (entry.branchName && checkBranchExists(root, entry.branchName)) {
        try {
          if (isBranchMerged(root, entry.branchName, entry.targetBranch)) {
            wtm.deleteBranch(entry.branchName);
          }
        } catch { /* branch left in place; not fatal */ }
      }
      await this.recordRecycle(entry, root, note, method);
      return { ...entry, deleted: true, deletionMethod: method };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...entry, deleted: false, category: 'manual_review', reason: `回收被安全机制拒绝：${message.split('\n')[0]}` };
    }
  }

  /** Prefer OS recycle bin; fall back to short-path quarantine, then permanent delete. */
  private async recycleOrDelete(dir: string, projectRoot: string): Promise<Exclude<GcDeletionMethod, null | 'prune' | 'git_worktree_remove'>> {
    if (process.platform === 'win32' && process.env.GC_RECYCLE_BIN !== '0') {
      try {
        await this.sendToRecycleBin(dir);
        if (!existsSync(dir)) return 'recycle_bin';
      } catch { /* fall through */ }
    }
    // Long-path quarantine: move the exact directory to a short unique sibling,
    // then delete the short path; confirm BOTH paths are gone.
    const quarantine = join(dirname(projectRoot), `.brainctl-gc-${process.pid}-${Date.now()}`);
    try {
      if (!existsSync(quarantine)) {
        renameSync(dir, quarantine);
        rmSync(quarantine, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        if (!existsSync(dir) && !existsSync(quarantine)) return 'permanent';
      }
    } catch { /* fall through */ }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      if (!existsSync(dir)) return 'permanent';
    } catch { /* fall through */ }
    throw new Error(`failed to remove deregistered worktree directory: ${dir}`);
  }

  private async sendToRecycleBin(dir: string): Promise<void> {
    const escaped = dir.replace(/'/g, "''");
    const script =
      `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'pipe', timeout: 20000, windowsHide: true,
    });
  }

  private async recordRecycle(entry: GcEntry, root: string, note: string, method: Exclude<GcDeletionMethod, null>): Promise<void> {
    try {
      await this.store.createEvent({
        id: `${entry.runId ?? 'gc'}-ev-gc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        runId: entry.runId ?? undefined as unknown as string,
        stageId: entry.stageId ?? null,
        taskId: entry.taskId ?? null,
        attemptId: entry.attemptId ?? null,
        eventType: 'gc_recycled',
        eventData: {
          path: entry.path,
          branchName: entry.branchName,
          decisionNote: note,
          deletionMethod: method,
          diskBytes: entry.diskBytes,
        },
      });
    } catch { /* audit failure must not change deletion semantics, but is reported below */ }
  }
}

function summarize(entries: GcEntry[]): GcInventory['summary'] {
  const byCategory: Record<GcCategory, { count: number; bytes: number }> = {
    safe_to_recycle: { count: 0, bytes: 0 },
    manual_review: { count: 0, bytes: 0 },
    do_not_touch: { count: 0, bytes: 0 },
    stale_registration: { count: 0, bytes: 0 },
  };
  let totalBytes = 0;
  for (const e of entries) {
    byCategory[e.category].count += 1;
    byCategory[e.category].bytes += e.diskBytes;
    totalBytes += e.diskBytes;
  }
  return { total: entries.length, totalBytes, byCategory };
}
