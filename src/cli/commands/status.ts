import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { TERMINAL_RUN_STATUSES } from '../../core/state-machine.js';
import { WindowsResourceSampler } from '../../core/resource-sampler.js';
import type { ResourceSampler, ResourceSample, BudgetState } from '../../types/m3-types.js';
import { computeBudget, deriveHardCap } from '../../types/m3-types.js';
import { buildStatusSnapshot } from '../../core/status-snapshot.js';

export const statusCommand = new Command('status')
  .description('查看当前运行状态')
  .argument('[run-id]', '可选的 run ID，查看指定 run 的详情')
  .option('--json', '以 JSON 格式输出状态快照')
  .option('--project <path>', '项目根目录；用于解析默认数据库路径')
  .option('--db <path>', 'SQLite 状态库路径；优先于 BRAINCTL_SQLITE_PATH')
  .action(async (runId?: string, options?: { json?: boolean; project?: string; db?: string }) => {
    const config = readSqliteConfigFromEnv(options?.project, options?.db);

    if (!existsSync(config.path)) {
      if (options?.json) {
        console.log(JSON.stringify({ error: 'db_not_initialized', message: '数据库文件尚未创建' }));
      } else {
        console.log('='.repeat(50));
        console.log('  brainctl status');
        console.log('='.repeat(50));
        console.log('  数据库文件尚未创建。运行以下命令初始化:');
        console.log('    npm run brainctl -- db migrate --apply');
        console.log('='.repeat(50));
      }
      return;
    }

    try {
      const store = SqliteStateStore.create(config.path);

      if (options?.json) {
        // ── JSON mode: build full StatusSnapshot ──
        const sampler = createSafeSampler();
        const snapshot = await buildStatusSnapshot(
          { store, sampler, userMaxParallel: 4, dbPath: config.path },
          runId || null,
        );
        console.log(JSON.stringify(snapshot, null, 2));
      } else if (runId) {
        // ── Human mode: run detail with resource line ──
        await showResourceLineSafely();
        await showRunDetail(store, runId, config.path);
      } else {
        // ── Human mode: summary with resource line ──
        await showResourceLineSafely();
        await showSummary(store);
      }

      await store.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (options?.json) {
        console.log(JSON.stringify({ error: 'status_failed', message: msg }));
      } else {
        console.error('  x 错误: ' + msg);
      }
      process.exitCode = 1;
    }

    if (!options?.json) {
      console.log('='.repeat(50));
    }
  });

// ── Safe resource line display ─────────────────────────────────────────

async function showResourceLineSafely(): Promise<void> {
  console.log('='.repeat(50));
  console.log('  brainctl status');
  console.log('='.repeat(50));

  try {
    const sampler = createSafeSampler();
    const sample = await sampler.sample();
    const hardCap = deriveHardCap(sample.cpu.cores);
    const budget = computeBudget(sample, 4, hardCap);

    const cpuStr = sample.cpu.usagePercent.toFixed(0) + '%';
    const memStr = sample.memory.usagePercent.toFixed(0) + '%';
    const piStr = sample.piCount + '/' + hardCap;
    const budgetStr = budget.dispatchPaused
      ? 'PAUSED' + (budget.pauseReason ? ' (' + budget.pauseReason + ')' : '')
      : budget.current.toString();
    const degradeMarker = sample.degraded ? ' [降级:' + (sample.degradeReason || 'unknown') + ']' : '';

    console.log('  资源: CPU ' + cpuStr + ' | 内存 ' + memStr + ' | Pi ' + piStr + ' | 预算 ' + budgetStr + degradeMarker);
    console.log('-'.repeat(50));
  } catch (err) {
    // Sampling failed → safe degrade, show minimal line
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log('  资源: 采样失败 (budget=1) [' + errMsg.substring(0, 50) + ']');
    console.log('-'.repeat(50));
  }
}

function createSafeSampler(): ResourceSampler {
  try {
    return new WindowsResourceSampler();
  } catch {
    return {
      async sample(): Promise<ResourceSample> {
        return {
          cpu: { usagePercent: 0, cores: 0 },
          memory: { totalMb: 0, usedMb: 0, freeMb: 0, usagePercent: 0 },
          piCount: 0,
          source: 'fallback',
          degraded: true,
          degradeReason: 'sampler_constructor_failed',
        };
      },
    };
  }
}

// ── Summary (M2 compatible, extended with resource line already shown) ─

async function showSummary(store: SqliteStateStore): Promise<void> {
  console.log('  最近 Runs:');
  const db = (store as any).db;
  // Check if encrypted column exists
  const runCols = db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
  const hasEncryptedCol = runCols.some((c: { name: string }) => c.name === 'encrypted_request_text');
  const selectCols = hasEncryptedCol
    ? 'id, project_root, status, request_text, encrypted_request_text, created_at'
    : 'id, project_root, status, request_text, created_at';
  const rows = db.prepare(`SELECT ${selectCols} FROM runs ORDER BY created_at DESC LIMIT 10`).all() as Record<string, unknown>[];

  if (rows.length === 0) {
    console.log('    (无)');
    return;
  }

  for (const row of rows) {
    const statusIcon = getStatusIcon(String(row.status));
    console.log('    ' + statusIcon + ' ' + String(row.id).substring(0, 20) + ' - ' + String(row.status));
    console.log('       项目: ' + String(row.project_root).substring(0, 40));
    const requestText = String(row.request_text || '');
    const encryptedText = hasEncryptedCol ? (row.encrypted_request_text ? String(row.encrypted_request_text) : null) : null;
    // Use privacy-aware display if encrypted column exists
    let displayText: string;
    if (hasEncryptedCol && encryptedText) {
      displayText = '[encrypted]';
    } else if (hasEncryptedCol && !requestText) {
      displayText = '[unavailable]';
    } else {
      displayText = requestText.substring(0, 50);
    }
    console.log('       需求: ' + displayText);
    console.log('       时间: ' + String(row.created_at).substring(0, 19));
    console.log('');
  }

  console.log('  提示: 使用 "brainctl status <run-id>" 查看详情');
}

// ── Run detail (M2 compatible, extended with event timeline) ──────────

async function showRunDetail(store: SqliteStateStore, runId: string, dbPath: string): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) {
    console.log('  x Run ' + runId + ' 不存在。');
    return;
  }

  console.log('  Run: ' + run.id);
  console.log('  状态: ' + getStatusIcon(run.status) + ' ' + run.status);
  console.log('  项目: ' + run.projectRoot);
  console.log('  需求: ' + getDisplayText(run));
  console.log('  创建: ' + run.createdAt);
  if (run.finishedAt) console.log('  完成: ' + run.finishedAt);

  const stages = await store.listStages(runId);
  if (stages.length > 0) {
    console.log('');
    console.log('  阶段 (' + stages.length + '):');
    for (const stage of stages) {
      const icon = getStatusIcon(stage.status);
      console.log('    ' + icon + ' Stage ' + stage.stageNumber + ': ' + stage.title + ' [' + stage.status + ']');
      if (stage.baseCommit) console.log('       base: ' + stage.baseCommit);
      if (stage.integrationBranch) console.log('       int branch: ' + stage.integrationBranch);

      const attempts = await store.listAttemptsByStage(stage.id);
      if (attempts.length > 0) {
        for (const att of attempts) {
          const attIcon = getStatusIcon(att.status);
          console.log('      ' + attIcon + ' Attempt ' + att.attemptNumber + ' [' + att.status + ']');
          if (att.piPid != null) {
            let alive = 'unknown';
            try {
              if (process.platform === 'win32') {
                const out = execFileSync('tasklist', ['/FI', `PID eq ${att.piPid}`, '/FO', 'CSV', '/NH'], { stdio: 'pipe', encoding: 'utf-8', timeout: 1000 });
                alive = out.includes('"' + att.piPid + '"') ? 'alive' : 'gone (interrupted)';
              } else {
                try { process.kill(att.piPid, 0); alive = 'alive'; } catch { alive = 'gone (interrupted)'; }
              }
            } catch { alive = 'unknown'; }
            console.log('         PID: ' + att.piPid + ' (' + alive + ')');
          }
          if (att.worktreePath) console.log('         worktree: ' + att.worktreePath);
          if (att.exitReason) console.log('         exit: ' + att.exitReason);
          if (att.resultSource !== 'pi') console.log('         source: ' + att.resultSource + (att.adoptedCommit ? ' (' + att.adoptedCommit + ')' : ''));
          if (att.startedAt) console.log('         started: ' + att.startedAt);
          if (att.stoppedAt) console.log('         stopped: ' + att.stoppedAt);
        }
      }

      // Active locks for this run
      const locks = await store.getActiveLocksForRun(runId);
      const stageLocks = locks.filter((l) => {
        const stageAtts = attempts.map((a) => a.taskId);
        return stageAtts.includes(l.taskId) && l.status === 'locked';
      });
      if (stageLocks.length > 0) {
        console.log('       Active locks:');
        for (const l of stageLocks) {
          console.log('         lock: ' + l.filePath + ' (task: ' + l.taskId + ', ' + l.lockType + ')');
        }
      }

      const batches = await store.listIntegrationBatches(stage.id);
      if (batches.length > 0) {
        for (const batch of batches) {
          console.log('       integration: ' + batch.status + ' (branch: ' + batch.integrationBranch + ')');
          if (batch.mergeCommitHash) console.log('         commit: ' + batch.mergeCommitHash);
          if (batch.conflictsJson) console.log('         conflicts: ' + batch.conflictsJson);
          console.log('         review coverage: ' + batch.reviewCoverageStatus + (batch.reviewedThroughCommit ? ' through ' + batch.reviewedThroughCommit : ''));
        }
      }
    }
  }

  const costEntries = await store.listCostReservations(runId);
  if (costEntries.length > 0) {
    const latest = costEntries[costEntries.length - 1];
    // written_off is an explicit budget release — it must NOT count as committed.
    const committed = costEntries.reduce((sum, entry) => sum + (entry.status === 'confirmed' && entry.actualCost != null ? entry.actualCost : entry.status === 'released' || entry.status === 'written_off' ? 0 : entry.reservedCost), 0);
    const byStatus = (status: string, phase?: string) => costEntries
      .filter((e) => e.status === status && (phase === undefined || e.phase === phase))
      .reduce((sum, e) => sum + e.reservedCost, 0);
    const settledCost = costEntries
      .filter((e) => e.status === 'confirmed')
      .reduce((sum, e) => sum + (e.actualCost ?? 0), 0);
    const parts = [
      `调用配额: ${committed}/${latest.budgetLimit}（无单位，非金额）`,
      `reserved ${byStatus('reserved', 'reserved')}`,
      `spawned ${byStatus('reserved', 'spawned')}`,
      `unavailable ${byStatus('unavailable')}`,
      `written_off ${byStatus('written_off')}`,
      `settled ${settledCost}`,
    ];
    console.log(`  ${parts.join(' ｜ ')}`);
  }
  // R3: guard self-check audit — latest outcome for this run.
  const selfChecks = (await store.listEvents(runId, 'pi_guard_selfcheck')).slice(-1);
  if (selfChecks.length > 0) {
    try {
      const data = JSON.parse(selfChecks[0].eventDataJson || '{}') as Record<string, unknown>;
      const ok = data.ok === true;
      const version = data.piVersion ?? 'unknown';
      const verified = data.verifiedPiVersion ?? 'unknown';
      const drift = data.versionMismatch === true;
      const cat = data.failureCategory ? `（${data.failureCategory}）` : '';
      console.log(`  guard 自检: ${ok ? '通过' : 'FAILED'} · pi ${version}${drift ? ` ≠ 已验证 ${verified}（版本漂移）` : ''}${cat}`);
    } catch { /* unparsable event is not fatal */ }
  }

  const pausedForResume = stages.find((stage) => stage.status === 'paused');
  if (pausedForResume) {
    const activePause = await store.getActivePauseForStage(pausedForResume.id);
    const confirmation = activePause ? ` --confirm-pause ${activePause.id}` : '';
    console.log(`  下一步: brainctl resume ${runId}${confirmation} --allow-real-project --db "${dbPath}"`);
    if (!activePause) {
      console.log('  ! 该暂停阶段缺少活动 PauseRecord；resume 将 fail closed，请先执行 reconcile 诊断。');
    }
  }

  const events = await store.listEvents(runId);
  if (events.length > 0) {
    console.log('');
    console.log('  Events (' + events.length + '):');
    // Show last 20 events
    for (const ev of events.slice(-20)) {
      console.log('    ' + ev.createdAt.substring(11, 19) + ' ' + ev.eventType);
    }
  }

  // ── M5: Reconciliation summary (read-only, from persisted report) ──
  const latestReport = await store.getLatestReconciliationReport(runId);
  if (latestReport) {
    console.log('');
    console.log('  Reconciled: ' + latestReport.appliedCount + ' applied, ' +
      latestReport.blockingCount + ' blocking remaining');
    if (latestReport.finishedAt) {
      console.log('  Last apply: ' + latestReport.finishedAt.substring(0, 19));
    }
  } else {
    console.log('');
    console.log('  Reconciled: 未执行过 reconciliation apply（状态未经收敛验证）');
  }

  // Show pause reason if stage is paused
  const pausedStage = stages.find((s) => s.status === 'paused');
  if (pausedStage) {
    const pauseEvents = events.filter((e) => e.eventType === 'stage_paused' && e.stageId === pausedStage.id);
    if (pauseEvents.length > 0) {
      const lastPause = pauseEvents[pauseEvents.length - 1];
      let reason = 'unknown';
      if (lastPause.eventDataJson) {
        try { reason = JSON.parse(lastPause.eventDataJson).reason || 'unknown'; } catch { /* */ }
      }
      console.log('');
      console.log('  ! 暂停原因: ' + reason);
    }
  }
}

/**
 * Get display-safe text for a run record.
 * Shows encrypted/legacy_plaintext/unavailable status appropriately.
 */
function getDisplayText(run: { requestText: string; encryptedRequestText?: string | null }): string {
  if (run.encryptedRequestText) {
    return '[encrypted]';
  }
  if (!run.requestText || run.requestText.length === 0) {
    return '[unavailable]';
  }
  if (run.requestText === '[ENCRYPTED]' || run.requestText === '[UNAVAILABLE]') {
    return `[${run.requestText.slice(1, -1).toLowerCase()}]`;
  }
  // Legacy plaintext - show truncated
  return `[legacy] ${run.requestText.substring(0, 50)}`;
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'completed':
    case 'merged':
      return 'v';
    case 'approved':
      return 'v';  // attempt approved = review passed (but not yet merged)
    case 'running':
    case 'ready':
    case 'worker_completed':
    case 'integrating':
      return '>';
    case 'failed':
    case 'rejected':
    case 'merge_blocked':
      return 'x';
    case 'paused':
    case 'pending':
    case 'planning':
      return '|';
    case 'canceled':
    case 'interrupted':
      return 'o';
    case 'rework_required':
      return '~';
    default:
      return '.';
  }
}
