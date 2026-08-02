// ── brainctl gc: orphan worktree/branch inventory & constrained recycling ──
// Default is a READ-ONLY dry-run inventory. Without --apply nothing is deleted.
// --apply requires --decision-note and only recycles entries re-verified on site
// as safe_to_recycle. See src/core/gc-service.ts for the safety contract.

import { Command } from 'commander';
import { resolve } from 'node:path';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { GcService, type GcEntry, type GcInventory, type GcCategory } from '../../core/gc-service.js';

const CATEGORY_LABEL: Record<GcCategory, string> = {
  safe_to_recycle: '可安全回收',
  manual_review: '需人工判断',
  do_not_touch: '不得触碰',
  stale_registration: '注册残留',
};

function formatBytes(n: number): string {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${n} bytes`;
}

function formatEntry(e: GcEntry, indent: string): string {
  const parts = [
    `${indent}• ${e.path || '(无目录)'}`,
  ];
  if (e.branchName) parts.push(`  branch=${e.branchName}`);
  if (e.runId) parts.push(`  run=${e.runId}`);
  if (e.attemptId) parts.push(`  attempt=${e.attemptId}`);
  if (e.ownerStatus) parts.push(`  status=${e.ownerStatus}`);
  if (e.dirExists) {
    parts.push(`  ${formatBytes(e.diskBytes)}`);
    if (e.lastModified) parts.push(`  mtime=${e.lastModified.slice(0, 19).replace('T', ' ')}`);
  }
  if (e.registered) parts.push(`  registered`);
  if (e.unmerged) parts.push(`  ⚠ 未合并提交`);
  parts.push(`  — ${e.reason}`);
  return parts.join('\n');
}

function printInventory(inv: GcInventory): void {
  const order: GcCategory[] = ['safe_to_recycle', 'manual_review', 'do_not_touch', 'stale_registration'];
  for (const cat of order) {
    const group = inv.entries.filter((e) => e.category === cat);
    if (group.length === 0) continue;
    const s = inv.summary.byCategory[cat];
    console.log(`\n[${CATEGORY_LABEL[cat]}] ${group.length} 项 / ${formatBytes(s.bytes)}`);
    for (const e of group) console.log(formatEntry(e, '  '));
  }
  console.log(`\n总计: ${inv.summary.total} 项 / ${formatBytes(inv.summary.totalBytes)}`);
  console.log(`\ngc 默认只读，未删除任何文件。`);
  console.log(`要回收"可安全回收"条目: brainctl gc ${'--project <path>'} --apply --decision-note "<原因>"`);
}

function printApplyResult(inv: GcInventory, results: GcEntry[]): void {
  const byPath = new Map(results.map((r) => [r.path, r]));
  let recycled = 0;
  let skipped = 0;
  console.log(`\n── 回收结果 ──`);
  for (const e of inv.entries) {
    if (e.category === 'stale_registration') {
      const r = byPath.get(e.path);
      if (r) console.log(`  ✓ prune 注册残留: ${e.path}`);
      continue;
    }
    if (e.category !== 'safe_to_recycle') continue;
    const r = byPath.get(e.path);
    if (!r) continue;
    if (r.deleted) {
      recycled += 1;
      console.log(`  ✓ 已回收 [${r.deletionMethod}]: ${e.path}`);
    } else {
      skipped += 1;
      console.log(`  ✗ 跳过: ${e.path}\n      ${r.reason}`);
    }
  }
  console.log(`\n回收 ${recycled} 项，跳过 ${skipped} 项（跳过项均已归入"需人工判断"）。`);
}

export const gcCommand = new Command('gc')
  .description('盘点孤儿 worktree/分支（默认只读）；--apply 只回收现场复核通过的"可安全回收"条目')
  .option('--project <path>', 'Project root used to resolve the default database path and worktrees root')
  .option('--db <path>', 'SQLite state database path; overrides BRAINCTL_SQLITE_PATH')
  .option('--apply', 'Recycle safe_to_recycle entries (requires --decision-note)')
  .option('--decision-note <text>', 'Explicit auditable decision reason; required with --apply')
  .option('--json', 'Output inventory as JSON')
  .action(async (options?: { project?: string; db?: string; apply?: boolean; decisionNote?: string; json?: boolean }) => {
    const isApply = options?.apply === true;
    const isJson = options?.json === true;
    if (isApply && !options?.decisionNote?.trim()) {
      if (isJson) {
        console.log(JSON.stringify({ error: 'decision_note_required', message: '--apply requires --decision-note <reason>' }));
      } else {
        console.error('  ✗ --apply requires --decision-note "<reason>" (explicit auditable decision).');
      }
      process.exit(1);
    }

    console.log('═'.repeat(60));
    console.log('  brainctl gc — 孤儿 worktree / 分支盘点' + (isApply ? '（--apply 回收）' : '（只读）'));
    console.log('═'.repeat(60));

    try {
      const projectRoot = options?.project ? resolve(options.project) : undefined;
      const config = readSqliteConfigFromEnv(projectRoot, options?.db);
      const store = SqliteStateStore.create(config.path);

      const db = store.getDatabase();
      const hasRunsTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'"
      ).get() as any;
      if (!hasRunsTable) {
        const msg = 'Database schema not initialized. Run: brainctl db migrate --apply';
        if (isJson) {
          console.log(JSON.stringify({ error: 'schema_not_initialized', message: msg }));
        } else {
          console.log(`  ✗ ${msg}`);
        }
        await store.close();
        process.exit(1);
      }

      const runner = new SqliteMigrationRunner(config, store.getDatabase());
      runner.applyPending();

      const svc = new GcService(store);
      const inv = await svc.inventory();

      if (isApply) {
        const result = await svc.apply(inv, {
          decisionNote: options!.decisionNote!.trim(),
          projectRoot,
        });
        if (isJson) {
          console.log(JSON.stringify({
            inventory: inv.summary,
            recycledCount: result.recycledCount,
            skippedCount: result.skippedCount,
            pruned: result.pruned,
            results: result.results.map((r) => ({
              path: r.path, category: r.category, deleted: r.deleted,
              deletionMethod: r.deletionMethod, reason: r.reason,
            })),
          }, null, 2));
        } else {
          printApplyResult(inv, result.results);
        }
      } else {
        if (isJson) {
          console.log(JSON.stringify({
            summary: inv.summary,
            entries: inv.entries.map((e) => ({
              path: e.path, category: e.category, reason: e.reason,
              branchName: e.branchName, runId: e.runId, attemptId: e.attemptId,
              attemptStatus: e.ownerStatus, diskBytes: e.diskBytes,
              lastModified: e.lastModified,
            })),
          }, null, 2));
        } else {
          printInventory(inv);
        }
      }

      await store.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ error: 'gc_failed', message: msg }));
      } else {
        console.error(`  ✗ Error: ${msg}`);
      }
      process.exitCode = 1;
    }

    if (!isJson) console.log('═'.repeat(60));
  });
