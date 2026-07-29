// ── brainctl revoke ─────────────────────────────────────────────────────
// Revoke a previously granted approval decision.
// Already-started Pi workers are not affected (M3 principle).

import { Command } from 'commander';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { revokeDecision } from '../../core/decision-gate.js';

export const revokeCommand = new Command('revoke')
  .description('撤销已授予的审批决策（已启动 Pi 不受影响）')
  .argument('<decision-id>', '要撤销的审批决策 ID')
  .action(async (decisionId: string) => {
    const config = readSqliteConfigFromEnv();
    const store = SqliteStateStore.create(config.path);
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();

    try {
      const result = await revokeDecision(store, decisionId);
      if (result.success) {
        console.log(`✓ ${result.message}`);
        console.log('  注意：已启动的 Pi 进程不受影响，但依赖此审批的未启动动作将被阻止。');
      } else {
        console.log(`✗ ${result.message}`);
        process.exitCode = 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ 撤销失败: ${msg}`);
      process.exitCode = 1;
    } finally {
      await store.close();
    }
  });
