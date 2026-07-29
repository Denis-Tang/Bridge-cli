// ── brainctl privacy — audit & cleanup CLI ──────────────────────────────
// Provides read-only privacy audit (default) and explicit --apply cleanup.
// Cleanup is path-contained, type-allowlisted, and per-item audited.
// Never recurses into project root, user directory, drive root, or unknown paths.

import { Command } from 'commander';
import { resolve, relative, normalize } from 'node:path';
import { existsSync, readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { logPrivacyDiagnostics } from '../../privacy/doctor-hook.js';

export const privacyCommand = new Command('privacy')
  .description('隐私审计与安全清理（默认只读 dry-run）');

// ══════════════════════════════════════════════════════════════
// privacy audit
// ══════════════════════════════════════════════════════════════

privacyCommand
  .command('audit')
  .description('只读隐私审计：扫描 persisted 日志/SQLite/文件中的敏感数据模式')
  .option('--json', '以 JSON 格式输出')
  .action(async (options?: { json?: boolean }) => {
    const results = await runPrivacyAudit();
    if (options?.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printAuditResults(results);
    }
  });

// ══════════════════════════════════════════════════════════════
// privacy cleanup
// ══════════════════════════════════════════════════════════════

privacyCommand
  .command('cleanup')
  .description('清理过期或可安全删除的运行时 artifact（默认 dry-run）')
  .option('--apply', '实际执行清理（必须显式指定）')
  .option('--json', '以 JSON 格式输出')
  .action(async (options?: { apply?: boolean; json?: boolean }) => {
    const isApply = options?.apply === true;
    if (!isApply) {
      console.log('═'.repeat(60));
      console.log('  brainctl privacy cleanup (DRY-RUN)');
      console.log('═'.repeat(60));
      console.log('  提示: 这是只读预览。要实际执行清理，请使用 --apply');
      console.log('');
    }

    const results = await runPrivacyCleanup(isApply);

    if (options?.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printCleanupResults(results, isApply);
    }
  });

// ══════════════════════════════════════════════════════════════
// Audit implementation
// ══════════════════════════════════════════════════════════════

interface AuditResult {
  timestamp: string;
  database: {
    path: string;
    sizeBytes: number;
    exists: boolean;
    sensitiveColumns: string[];
  };
  runtimeDirs: Array<{
    dir: string;
    fileCount: number;
    totalSizeBytes: number;
    hasLogs: boolean;
    hasPrompts: boolean;
    hasSqlite: boolean;
  }>;
  nestedGitDirs: string[];
  findings: Array<{
    severity: 'info' | 'warning' | 'critical';
    file: string;
    category: string;
    detail: string;
    hash?: string;
  }>;
}

async function runPrivacyAudit(): Promise<AuditResult> {
  const config = readSqliteConfigFromEnv();
  const projectRoot = resolve(process.cwd());
  const brainctlDevDir = resolve(projectRoot, '.brainctl-dev');

  const result: AuditResult = {
    timestamp: new Date().toISOString(),
    database: {
      path: config.path,
      sizeBytes: 0,
      exists: false,
      sensitiveColumns: [],
    },
    runtimeDirs: [],
    nestedGitDirs: [],
    findings: [],
  };

  // Check database
  if (existsSync(config.path)) {
    result.database.exists = true;
    try {
      result.database.sizeBytes = statSync(config.path).size;
    } catch { /* ignore */ }

    // List sensitive columns (read-only schema inspection)
    try {
      const store = SqliteStateStore.create(config.path);
      const db = store.getDatabase();
      const tables = ['runs', 'tasks', 'task_attempts', 'reviews', 'events', 'token_ledger'];
      for (const table of tables) {
        try {
          const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          for (const col of columns) {
            const sensitiveCols = [
              'request_text', 'spec_json', 'review_json', 'findings_json',
              'worker_result_json', 'prompt_hash', 'worktree_path', 'log_path',
              'raw_log_path', 'event_data_json', 'file_path',
            ];
            if (sensitiveCols.includes(col.name)) {
              result.database.sensitiveColumns.push(`${table}.${col.name}`);
            }
          }
        } catch { /* table might not exist */ }
      }
      await store.close();
    } catch { /* ignore */ }

    result.findings.push({
      severity: 'warning',
      file: config.path,
      category: 'sqlite',
      detail: `数据库 ${(result.database.sizeBytes / 1024).toFixed(0)}KB, ${result.database.sensitiveColumns.length} 个敏感列存在`,
    });
  }

  // Check .brainctl-dev
  if (existsSync(brainctlDevDir)) {
    const dirs = ['acceptance', 'fixtures', 'logs', 'plan-logs', 'sessions', 'obsidian-demo', 'tools'];
    for (const dir of dirs) {
      const fullDir = resolve(brainctlDevDir, dir);
      if (!existsSync(fullDir)) continue;

      let fileCount = 0;
      let totalSize = 0;
      let hasLogs = false;
      let hasPrompts = false;
      let hasSqlite = false;

      try {
        for (const entry of walkDir(fullDir)) {
          fileCount++;
          try {
            totalSize += statSync(entry).size;
          } catch { /* ignore */ }
          if (entry.endsWith('.log')) hasLogs = true;
          if (entry.includes('prompt') || entry.includes('_prompt.txt')) hasPrompts = true;
          if (entry.endsWith('.sqlite')) hasSqlite = true;
        }
      } catch { /* ignore */ }

      result.runtimeDirs.push({
        dir: resolve(brainctlDevDir, dir),
        fileCount,
        totalSizeBytes: totalSize,
        hasLogs,
        hasPrompts,
        hasSqlite,
      });

      if (hasLogs || hasPrompts || hasSqlite) {
        result.findings.push({
          severity: 'warning',
          file: resolve(brainctlDevDir, dir),
          category: 'runtime_artifacts',
          detail: `${dir}: ${fileCount} 文件, ${(totalSize / 1024).toFixed(0)}KB, logs=${hasLogs}, prompts=${hasPrompts}, sqlite=${hasSqlite}`,
        });
      }
    }

    // Check for nested .git directories
    for (const entry of walkDir(brainctlDevDir)) {
      const basename = entry.replace(/\\/g, '/').split('/').pop();
      if (basename === '.git' || (entry.endsWith('/.git'))) {
        // Check if it's a directory
        try {
          const s = statSync(entry);
          if (s.isDirectory()) {
            result.nestedGitDirs.push(entry);
            result.findings.push({
              severity: 'warning',
              file: entry,
              category: 'nested_git',
              detail: '嵌套 .git 目录可能包含 Git 历史和身份元数据',
            });
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Check for env var diagnostics
  const envDiags = logPrivacyDiagnostics();

  return result;
}

function printAuditResults(result: AuditResult): void {
  console.log('═'.repeat(60));
  console.log('  brainctl privacy audit');
  console.log('═'.repeat(60));
  console.log(`  时间: ${result.timestamp}`);
  console.log('');

  // Database
  console.log('  ── 数据库 ──');
  if (result.database.exists) {
    console.log(`  路径: ${result.database.path}`);
    console.log(`  大小: ${(result.database.sizeBytes / 1024).toFixed(0)} KB`);
    console.log(`  敏感列 (${result.database.sensitiveColumns.length}):`);
    for (const col of result.database.sensitiveColumns) {
      console.log(`    - ${col}`);
    }
  } else {
    console.log('  数据库文件不存在');
  }

  // Runtime dirs
  console.log('');
  console.log('  ── 运行时目录 ──');
  for (const dir of result.runtimeDirs) {
    const markers: string[] = [];
    if (dir.hasLogs) markers.push('LOGS');
    if (dir.hasPrompts) markers.push('PROMPTS');
    if (dir.hasSqlite) markers.push('SQLITE');
    console.log(`  ${dir.dir}`);
    console.log(`    ${dir.fileCount} 文件, ${(dir.totalSizeBytes / 1024).toFixed(0)} KB ${markers.length > 0 ? '[' + markers.join(', ') + ']' : ''}`);
  }

  // Nested git
  if (result.nestedGitDirs.length > 0) {
    console.log('');
    console.log('  ── 嵌套 Git 目录 ──');
    for (const gitDir of result.nestedGitDirs) {
      console.log(`  ${gitDir}`);
    }
  }

  console.log('');
  console.log('═'.repeat(60));
}

// ══════════════════════════════════════════════════════════════
// Cleanup implementation
// ══════════════════════════════════════════════════════════════

interface CleanupResult {
  timestamp: string;
  mode: 'dry_run' | 'applied';
  items: Array<{
    action: string;
    path: string;
    sizeBytes: number;
    reason: string;
    status: 'would_delete' | 'deleted' | 'skipped';
    error?: string;
  }>;
  summary: {
    totalItems: number;
    wouldDelete: number;
    deleted: number;
    skipped: number;
    totalSizeFreed: number;
  };
}

/**
 * Allowed cleanup target directories (path containment).
 * Cleanup MUST NOT operate outside these directories.
 */
const ALLOWED_CLEANUP_TARGETS = [
  '.brainctl-dev',
  '.brainctl',
];

/**
 * Allowed file extensions/types for automatic cleanup.
 */
const ALLOWED_CLEANUP_EXTENSIONS = new Set([
  '.log', '.txt', '.sqlite', '.sqlite-wal', '.sqlite-shm',
  '.err', '.err.log',
]);

/**
 * Patterns that should NEVER be deleted (even with --apply).
 */
const PROTECTED_PATTERNS = [
  /\.git/i,                    // Git directories
  /package\.json/,             // Project files
  /node_modules/,              // Dependencies
  /src\//,                     // Source code
  /tests\//,                   // Test code
  /\.brainctl\/state\//,       // Production database
];

async function runPrivacyCleanup(isApply: boolean): Promise<CleanupResult> {
  const projectRoot = resolve(process.cwd());
  const result: CleanupResult = {
    timestamp: new Date().toISOString(),
    mode: isApply ? 'applied' : 'dry_run',
    items: [],
    summary: { totalItems: 0, wouldDelete: 0, deleted: 0, skipped: 0, totalSizeFreed: 0 },
  };

  for (const target of ALLOWED_CLEANUP_TARGETS) {
    const fullTarget = resolve(projectRoot, target);
    if (!existsSync(fullTarget)) continue;

    // Validate path containment:
    // The resolved path MUST be inside project root
    const rel = relative(projectRoot, fullTarget);
    if (rel.startsWith('..') || normalize(fullTarget) === normalize(projectRoot)) {
      result.items.push({
        action: 'skip',
        path: fullTarget,
        sizeBytes: 0,
        reason: `路径超出安全边界: ${rel}`,
        status: 'skipped',
      });
      result.summary.skipped++;
      continue;
    }

    // Don't target drive root
    if (normalize(fullTarget).length <= 3) {
      result.items.push({
        action: 'skip',
        path: fullTarget,
        sizeBytes: 0,
        reason: '拒绝操作盘符根目录',
        status: 'skipped',
      });
      result.summary.skipped++;
      continue;
    }

    // Walk directory
    const candidates = findCleanupCandidates(fullTarget);
    for (const candidate of candidates) {
      result.summary.totalItems++;

      const fileSize = candidate.sizeBytes;

      if (isApply) {
        try {
          unlinkSync(candidate.path);
          result.items.push({
            action: 'delete',
            path: candidate.path,
            sizeBytes: fileSize,
            reason: candidate.reason,
            status: 'deleted',
          });
          result.summary.deleted++;
          result.summary.totalSizeFreed += fileSize;
        } catch (err) {
          result.items.push({
            action: 'delete',
            path: candidate.path,
            sizeBytes: fileSize,
            reason: candidate.reason,
            status: 'skipped',
            error: err instanceof Error ? err.message : String(err),
          });
          result.summary.skipped++;
        }
      } else {
        result.items.push({
          action: 'would_delete',
          path: candidate.path,
          sizeBytes: fileSize,
          reason: candidate.reason,
          status: 'would_delete',
        });
        result.summary.wouldDelete++;
      }
    }
  }

  return result;
}

interface CleanupCandidate {
  path: string;
  sizeBytes: number;
  reason: string;
}

function findCleanupCandidates(dir: string): CleanupCandidate[] {
  const candidates: CleanupCandidate[] = [];
  const cutoff = Date.now() - (7 * 86400_000); // 7-day retention for artifacts

  try {
    for (const entry of walkDir(dir)) {
      // Check protected patterns
      if (PROTECTED_PATTERNS.some((p) => p.test(entry))) continue;

      // Check extension
      const ext = entry.substring(entry.lastIndexOf('.'));
      if (!ALLOWED_CLEANUP_EXTENSIONS.has(ext)) continue;

      try {
        const stat = statSync(entry);
        // Check age
        if (stat.mtimeMs > cutoff) continue;

        candidates.push({
          path: entry,
          sizeBytes: stat.size,
          reason: `超过 7 天未修改 (${new Date(stat.mtime).toISOString().substring(0, 10)})`,
        });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return candidates;
}

function printCleanupResults(result: CleanupResult, isApply: boolean): void {
  if (!isApply) {
    console.log('═'.repeat(60));
    console.log('  brainctl privacy cleanup (DRY-RUN)');
    console.log('═'.repeat(60));
  } else {
    console.log('═'.repeat(60));
    console.log('  brainctl privacy cleanup --apply');
    console.log('═'.repeat(60));
  }

  if (result.items.length === 0) {
    console.log('  没有需要清理的文件。');
    return;
  }

  const actionLabel = isApply ? '已删除' : '将删除';
  for (const item of result.items) {
    const icon = item.status === 'deleted' ? '✓' : item.status === 'skipped' ? '✗' : '·';
    const sizeStr = (item.sizeBytes / 1024).toFixed(1) + 'KB';
    console.log(`  ${icon} ${item.path}`);
    console.log(`    ${sizeStr} — ${item.reason}`);
    if (item.error) console.log(`    错误: ${item.error}`);
  }

  console.log('');
  if (!isApply) {
    console.log(`  总计: ${result.summary.wouldDelete} 个文件将被删除`);
    console.log(`  释放: ${(result.summary.totalSizeFreed / 1024).toFixed(1)} KB (dry-run 估算)`);
    console.log('');
    console.log('  要实际执行: brainctl privacy cleanup --apply');
  } else {
    console.log(`  总计: ${result.summary.deleted} 个文件已删除`);
    console.log(`  释放: ${(result.summary.totalSizeFreed / 1024).toFixed(1)} KB`);
    if (result.summary.skipped > 0) {
      console.log(`  跳过: ${result.summary.skipped} 个文件`);
    }
  }
  console.log('═'.repeat(60));
}

// ══════════════════════════════════════════════════════════════
// Utility
// ══════════════════════════════════════════════════════════════

function* walkDir(dir: string): Generator<string> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else {
      yield fullPath;
    }
  }
}
