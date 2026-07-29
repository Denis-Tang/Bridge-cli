import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';

export const dbCommand = new Command('db')
  .description('数据库迁移管理 (SQLite)');

// ── db status ────────────────────────────────────────────────────────────
dbCommand
  .command('status')
  .description('查看数据库迁移状态')
  .action(async () => {
    console.log('═'.repeat(50));
    console.log('  brainctl db status — 迁移状态');
    console.log('═'.repeat(50));

    const config = readSqliteConfigFromEnv();
    console.log(`  后端: SQLite`);
    console.log(`  数据库文件: ${config.path}`);
    console.log(`  文件存在: ${existsSync(config.path) ? '✅ 是' : '○ 否'}`);

    if (!existsSync(config.path)) {
      console.log('\n  数据库文件尚未创建。运行以下命令初始化:');
      console.log('    npm run brainctl -- db migrate --apply');
      console.log('═'.repeat(50));
      return;
    }

    try {
      const store = SqliteStateStore.create(config.path);
      const runner = new SqliteMigrationRunner(config, store.getDatabase());
      const plan = runner.getPlan();

      console.log(`  已迁移: ${plan.applied.length}`);
      console.log(`  待迁移: ${plan.pending.length}`);

      if (plan.applied.length > 0) {
        console.log('\n  已应用的迁移:');
        for (const m of plan.applied) {
          console.log(`    ✓ ${m.version}_${m.name} (${m.appliedAt ?? 'unknown'})`);
        }
      }
      if (plan.pending.length > 0) {
        console.log('\n  待应用的迁移:');
        for (const m of plan.pending) {
          console.log(`    ○ ${m.version}_${m.name}`);
        }
        console.log('\n  运行 `brainctl db migrate --dry-run` 预览，或 `brainctl db migrate --apply` 执行。');
      }

      await store.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ 错误: ${msg}`);
      process.exitCode = 1;
    }

    console.log('═'.repeat(50));
  });

// ── db migrate ───────────────────────────────────────────────────────────
const migrateCommand = new Command('migrate')
  .description('执行数据库迁移 (SQLite)')
  .option('--dry-run', '仅预览待执行迁移，不建表')
  .option('--apply', '实际执行迁移（建表）')
  .action(async (options: { dryRun?: boolean; apply?: boolean }) => {
    const hasFlag = options.dryRun || options.apply;

    if (!hasFlag) {
      console.log('═'.repeat(50));
      console.log('  brainctl db migrate');
      console.log('═'.repeat(50));
      console.log('  请指定执行模式:');
      console.log('    --dry-run    预览待执行迁移');
      console.log('    --apply      实际执行迁移');
      console.log('\n  示例:');
      console.log('    npm run brainctl -- db migrate --dry-run');
      console.log('    npm run brainctl -- db migrate --apply');
      console.log('═'.repeat(50));
      return;
    }

    if (options.dryRun) {
      await handleDryRun();
    } else if (options.apply) {
      await handleApply();
    }
  });

dbCommand.addCommand(migrateCommand);

// ── Shared helpers ───────────────────────────────────────────────────────
function getConfigOrExit(): { config: ReturnType<typeof readSqliteConfigFromEnv> } {
  const cfg = readSqliteConfigFromEnv();
  return { config: cfg };
}

async function handleDryRun(): Promise<void> {
  console.log('═'.repeat(50));
  console.log('  brainctl db migrate --dry-run');
  console.log('═'.repeat(50));

  const { config } = getConfigOrExit();
  console.log(`  后端: SQLite`);
  console.log(`  数据库文件: ${config.path}`);
  console.log(`  文件存在: ${existsSync(config.path) ? '✅ 是' : '○ 否（dry-run 不会创建）'}`);

  try {
    const store = SqliteStateStore.create(config.path);
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    const plan = runner.getPlan();

    console.log(`  已迁移: ${plan.applied.length}`);
    console.log(`  待迁移: ${plan.pending.length}`);

    if (plan.pending.length === 0) {
      console.log('\n  ✓ 数据库已是最新，无需迁移。');
    } else {
      console.log('\n  将按以下顺序执行迁移:');
      for (const m of plan.pending) {
        console.log(`    ${m.version}_${m.name} (${m.checksum.slice(0, 12)}...)`);
      }
      console.log('\n  ⚠ 当前为 dry-run 模式，未执行任何建表操作。');
      console.log('  如需执行，请运行:');
      console.log('    npm run brainctl -- db migrate --apply');
    }

    await store.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ 错误: ${msg}`);
    process.exitCode = 1;
  }

  console.log('═'.repeat(50));
}

async function handleApply(): Promise<void> {
  console.log('═'.repeat(50));
  console.log('  brainctl db migrate --apply');
  console.log('═'.repeat(50));

  const { config } = getConfigOrExit();
  console.log(`  后端: SQLite`);
  console.log(`  数据库文件: ${config.path}`);

  try {
    const store = SqliteStateStore.create(config.path);
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    const plan = runner.getPlan();

    if (plan.pending.length === 0) {
      console.log('  ✓ 数据库已是最新，无需迁移。');
      await store.close();
      console.log('═'.repeat(50));
      return;
    }

    console.log(`  待迁移: ${plan.pending.length}`);
    for (const m of plan.pending) {
      console.log(`    ${m.version}_${m.name}`);
    }
    console.log('');

    const applied = runner.applyPending();

    console.log(`  ✓ 成功应用 ${applied.length} 个迁移:`);
    for (const m of applied) {
      console.log(`    ✓ ${m.version}_${m.name}`);
    }

    await store.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ 迁移失败: ${msg}`);
    process.exitCode = 1;
  }

  console.log('═'.repeat(50));
}
