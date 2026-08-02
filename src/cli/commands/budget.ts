// ── brainctl budget: reservation ledger read + manual write-off ──────────
// `budget list` is read-only. `budget write-off` is the ONLY way to release an
// `unavailable` reservation back into the pool — it is manual, explicit and
// auditable (mandatory --decision-note, persisted event). Dashboard stays
// read-only; there is no write endpoint there.

import { Command } from 'commander';
import { resolve } from 'node:path';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';

const RESERVATION_STATUSES = ['reserved', 'confirmed', 'unavailable', 'released', 'written_off'];

async function openStore(options: { project?: string; db?: string }): Promise<{ store: SqliteStateStore; close: () => Promise<void> }> {
  const projectRoot = options.project ? resolve(options.project) : undefined;
  const config = readSqliteConfigFromEnv(projectRoot, options.db);
  const store = SqliteStateStore.create(config.path);
  new SqliteMigrationRunner(config, store.getDatabase()).applyPending();
  return { store, close: () => store.close() };
}

export const budgetCommand = new Command('budget')
  .description('成本预留账本：只读盘点（list）与人工核销（write-off）');

budgetCommand
  .command('list')
  .description('列出成本预留（默认全部；--status 过滤，如 unavailable）')
  .option('--run-id <id>', 'Filter by run id')
  .option('--status <status>', `Filter by status: ${RESERVATION_STATUSES.join(' | ')}`)
  .option('--project <path>', 'Project root used to resolve the default database path')
  .option('--db <path>', 'SQLite state database path; overrides BRAINCTL_SQLITE_PATH')
  .option('--json', 'Output as JSON')
  .action(async (options?: { runId?: string; status?: string; project?: string; db?: string; json?: boolean }) => {
    const isJson = options?.json === true;
    try {
      if (options?.status && !RESERVATION_STATUSES.includes(options.status)) {
        const msg = `invalid --status '${options.status}'; expected one of: ${RESERVATION_STATUSES.join(', ')}`;
        if (isJson) console.log(JSON.stringify({ error: 'invalid_status', message: msg }));
        else console.error(`  ✗ ${msg}`);
        process.exit(1);
      }
      const { store, close } = await openStore(options ?? {});
      const db = store.getDatabase();
      const hasTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cost_reservations'"
      ).get() as any;
      if (!hasTable) {
        if (isJson) console.log(JSON.stringify({ error: 'schema_not_initialized' }));
        else console.log('  ✗ cost_reservations 表不存在；先运行 brainctl db migrate --apply');
        await close();
        process.exit(1);
      }
      const where: string[] = [];
      const params: string[] = [];
      if (options?.runId) { where.push('run_id = ?'); params.push(options.runId); }
      if (options?.status) { where.push('status = ?'); params.push(options.status); }
      const rows = db.prepare(
        `SELECT * FROM cost_reservations${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC`
      ).all(...params) as Array<Record<string, unknown>>;
      const total = rows.reduce((sum, r) => sum + Number(r.reserved_cost ?? 0), 0);
      if (isJson) {
        console.log(JSON.stringify({
          count: rows.length,
          totalReservedCost: total,
          reservations: rows.map((r) => ({
            id: r.id, runId: r.run_id, callType: r.call_type, status: r.status,
            phase: r.phase, reservedCost: r.reserved_cost, actualCost: r.actual_cost,
            createdAt: r.created_at, heartbeatAt: r.heartbeat_at, settledAt: r.settled_at,
          })),
        }, null, 2));
      } else {
        console.log('═'.repeat(60));
        console.log('  brainctl budget list' + (options?.status ? ` --status ${options.status}` : ''));
        console.log('═'.repeat(60));
        if (rows.length === 0) {
          console.log('  （无匹配预留）');
        }
        for (const r of rows) {
          const status = String(r.status);
          const mark = status === 'unavailable' ? '⚠ ' : status === 'written_off' ? '✎ ' : '  ';
          console.log(`  ${mark}${r.id}`);
          console.log(`      run=${r.run_id}  call=${r.call_type}  status=${status}  phase=${r.phase}`);
          console.log(`      预留=${Number(r.reserved_cost)} ${r.currency}  实际=${r.actual_cost ?? '-'}  创建=${String(r.created_at).slice(0, 19).replace('T', ' ')}`);
        }
        console.log(`\n  共 ${rows.length} 条 / 预留合计 ${total}`);
        console.log(`  提示: 先看后销 — 用 --status unavailable 盘点后，再对每条执行 write-off。`);
        console.log('═'.repeat(60));
      }
      await close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isJson) console.log(JSON.stringify({ error: 'budget_list_failed', message: msg }));
      else console.error(`  ✗ Error: ${msg}`);
      process.exitCode = 1;
    }
  });

budgetCommand
  .command('write-off')
  .description('人工核销一条 unavailable 预留（必须 --decision-note；可审计；reserved/spawned 拒绝）')
  .requiredOption('--reservation <id>', 'Reservation id (status must be unavailable)')
  .requiredOption('--decision-note <text>', 'Explicit auditable reason; mandatory')
  .option('--project <path>', 'Project root used to resolve the default database path')
  .option('--db <path>', 'SQLite state database path; overrides BRAINCTL_SQLITE_PATH')
  .option('--json', 'Output as JSON')
  .action(async (options?: { reservation?: string; decisionNote?: string; project?: string; db?: string; json?: boolean }) => {
    const isJson = options?.json === true;
    const note = options?.decisionNote?.trim() ?? '';
    if (!note) {
      if (isJson) console.log(JSON.stringify({ error: 'decision_note_required' }));
      else console.error('  ✗ --decision-note "<reason>" is required (explicit auditable decision).');
      process.exit(1);
    }
    try {
      const { store, close } = await openStore(options ?? {});
      const changed = await store.writeOffCostReservation?.({
        id: options!.reservation!,
        decisionNote: note,
      });
      if (!changed) {
        if (isJson) console.log(JSON.stringify({ error: 'write_off_rejected', reservation: options!.reservation, message: 'reservation 不存在或状态不是 unavailable（reserved/spawned 一律拒绝，防止误核销在跑调用）' }));
        else console.error(`  ✗ 拒绝核销 ${options!.reservation}: 不存在或状态不是 unavailable。`);
        process.exitCode = 1;
      } else {
        if (isJson) console.log(JSON.stringify({ ok: true, reservation: options!.reservation, status: 'written_off', decisionNote: note }));
        else console.log(`  ✓ ${options!.reservation} 已核销为 written_off（决策: ${note}）。该预留不再计入 remaining。`);
      }
      await close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isJson) console.log(JSON.stringify({ error: 'write_off_failed', message: msg }));
      else console.error(`  ✗ Error: ${msg}`);
      process.exitCode = 1;
    }
  });
