import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { StageScheduler, type SchedulerConfig } from '../../core/stage-scheduler.js';
import { WindowsResourceSampler } from '../../core/resource-sampler.js';
import { loadRuntimeProjectConfig, schedulerConfigFromResolved } from '../../core/project-runtime-config.js';
import { validateRealProjectExecution } from '../../core/real-project-gate.js';
import {
  getGovernanceConfig,
  resetGovernanceConfigCache,
  checkG1Approvable,
  approveG1Decision,
} from '../../core/decision-gate.js';
import {
  runPreflightReconciliation,
  hasBlockingFindings,
  printPreflightBlocked,
} from './reconcile.js';

export const approveCommand = new Command('approve')
  .alias('run')
  .description('批准 run 的第 1 阶段，开始施工')
  .argument('<run-id>', 'run ID')
  .option('--adaptive-concurrency', '启用 M3 自适应并发（默认关闭，M2 行为）')
  .option('--max-parallel-tasks <n>', '最大并行任务数 (1-16，默认 4)', parseInt)
  .option('--allow-real-project', '允许对非 disposable 项目启动真实 Pi/Codex 施工')
  .option('--target-branch <branch>', '目标合并分支（默认当前分支）')
  .option('--execution-mode <mode>', '执行模式覆盖: token-efficient, simple 或 default')
  .option('--db <path>', 'SQLite 状态库路径；优先于 BRAINCTL_SQLITE_PATH')
  .option('--auto', '批量确认（仅 low-risk 且无待确认审批时有效）')
  .option('--approve <decision-id>', '逐项确认指定审批决策 ID')
  .action(async (runId: string, options: {
    adaptiveConcurrency?: boolean;
    maxParallelTasks?: number;
    allowRealProject?: boolean;
    targetBranch?: string;
    executionMode?: string;
    auto?: boolean;
    approve?: string;
    db?: string;
  }) => {
    console.log('═'.repeat(50));
    console.log('  brainctl approve');
    console.log('═'.repeat(50));

    try {
      const config = readSqliteConfigFromEnv(undefined, options.db);
      const store = SqliteStateStore.create(config.path);

      const run = await store.getRun(runId);
      if (!run) {
        console.log(`  ✗ Run ${runId} 不存在。`);
        await store.close();
        process.exit(1);
      }

      if (run.status !== 'planning') {
        console.log(`  ✗ Run ${runId} 当前状态为 "${run.status}"，不能批准。只有 planning 状态的 run 才能批准。`);
        await store.close();
        process.exit(1);
      }

      const realProjectGate = validateRealProjectExecution(run.projectRoot, options.allowRealProject === true);
      if (!realProjectGate.allowed) {
        console.log(`  ✗ ${realProjectGate.reason}`);
        await store.close();
        process.exit(1);
      }

      const runtime = loadRuntimeProjectConfig(run.projectRoot, {
        snapshotText: run.executionConfigSnapshot,
        cliOverrides: {
          targetBranch: options.targetBranch,
          maxParallelTasks: options.maxParallelTasks,
          resourceSamplingEnabled: options.adaptiveConcurrency === true ? true : undefined,
          executionMode: options.executionMode,
        },
      });

      // ── M5: Preflight reconciliation (zero-write, before any mutation) ──
      const preflightFindings = await runPreflightReconciliation(store, runId, 'approve_preflight');
      if (hasBlockingFindings(preflightFindings)) {
        printPreflightBlocked(preflightFindings, runId);
        await store.close();
        process.exit(1);
      }

      // Now safe to apply migrations
      const runner = new SqliteMigrationRunner(config, store.getDatabase());
      runner.applyPending();

      // ── M4: G1 Decision Gate check ──
      resetGovernanceConfigCache();
      const govCfg = getGovernanceConfig(run.projectRoot);

      if (govCfg.enabled) {
        const { approvable, pendingDecisions } = await checkG1Approvable(store, runId);

        // --approve <decision-id>: single decision confirmation
        if (options.approve) {
          const ok = await approveG1Decision(store, options.approve);
          if (!ok) {
            console.log(`  ✗ 决策 ${options.approve} 不存在、非 G1、或已处理。`);
            await store.close();
            process.exit(1);
          }
          console.log(`  ✓ G1 决策已确认: ${options.approve}`);

          // Re-check if all G1 decisions now approved
          const recheck = await checkG1Approvable(store, runId);
          if (!recheck.approvable) {
            console.log(`  还有 ${recheck.pendingDecisions.length} 个 G1 决策待确认。`);
            console.log('  请继续逐项确认或撤销后重试。');
            await store.close();
            return;
          }
          // Fall through to normal approve flow
        } else if (options.auto) {
          // --auto: only allowed if approvable (no pending)
          if (!approvable) {
            console.log(`  ✗ --auto 不允许：有 ${pendingDecisions.length} 个 G1 决策待确认。`);
            console.log('  请逐项确认:');
            for (const d of pendingDecisions) {
              console.log(`    brainctl approve ${runId} --approve ${d.id}  (${d.decisionType})`);
            }
            await store.close();
            process.exit(1);
          }
          console.log('  ✓ --auto: 无待确认决策，继续执行。');
        } else {
          // Default: reject if pending G1 decisions
          if (!approvable) {
            console.log(`  ✗ G1 决策门未通过：有 ${pendingDecisions.length} 个决策待确认。`);
            console.log('  请逐项确认:');
            for (const d of pendingDecisions) {
              console.log(`    brainctl approve ${runId} --approve ${d.id}  (${d.decisionType})`);
            }
            console.log('');
            console.log('  或使用 --auto（仅所有决策已确认时有效）。');
            await store.close();
            process.exit(1);
          }
          console.log('  ✓ G1 决策门已通过。');
        }
      }

      // Note: governance disabled → M2/M3 path unchanged (no gate)

      // Check no active run for same project
      const activeRun = await store.getActiveRunByProject(run.projectRoot);
      if (activeRun && activeRun.id !== runId) {
        console.log(`  ✗ 项目已有活动 Run: ${activeRun.id}（状态: ${activeRun.status}）。先完成或取消它。`);
        await store.close();
        process.exit(1);
      }

      // ── Parse and validate max-parallel-tasks ──
      let maxParallelTasks = runtime.resolved.maxParallelTasks;
      if (options.maxParallelTasks !== undefined) {
        if (isNaN(options.maxParallelTasks) || options.maxParallelTasks < 1 || options.maxParallelTasks > 16) {
          console.log('  ✗ --max-parallel-tasks must be between 1 and 16');
          await store.close();
          process.exit(1);
        }
        maxParallelTasks = options.maxParallelTasks;
      }

      // ── Parse adaptive concurrency ──
      const adaptiveEnabled = options.adaptiveConcurrency === true;
      if (adaptiveEnabled) {
        console.log(`  M3 自适应并发: 启用 (max ${maxParallelTasks} tasks)`);
      }

      const targetBranch = runtime.resolved.targetBranch || resolveTargetBranch(run.projectRoot, options.targetBranch);
      console.log(`  目标分支: ${targetBranch}`);
      console.log(`  执行模式: ${runtime.resolved.executionMode}`);

      // Update run status to running
      const now = new Date().toISOString();
      await store.updateRunStatus(runId, 'running', now);

      // Get stages and start first one
      const stages = await store.listStages(runId);
      if (stages.length === 0) {
        console.log('  ⚠ Run has no stages. Creating a default stage.');
        await store.createStage({
          id: `${runId}-stage-1`,
          runId,
          stageNumber: 1,
          title: 'Default Stage',
          status: 'ready',
        });
      }

      const firstStage = stages[0] || await store.getStage(`${runId}-stage-1`);
      if (firstStage) {
        if (firstStage.status === 'paused') {
          throw new Error('暂停阶段不能通过 approve 直接恢复；请使用 resume --confirm-pause <pause-id>。');
        }
        await store.updateStageStatus(firstStage.id, 'ready', now);
        console.log(`  ▶ 第 1 阶段已就绪: ${firstStage.title}`);

        await store.createEvent({
          id: `${runId}-ev-approved-${Date.now()}`,
          runId,
          stageId: firstStage.id,
          eventType: 'run_approved',
          eventData: { approvedAt: now, stageId: firstStage.id },
        });

        const schedulerConfig: Partial<SchedulerConfig> & { projectRoot: string } = {
          ...schedulerConfigFromResolved(runtime.resolved, govCfg.enabled),
          targetBranch,
          maxParallelTasks,
          resourceSamplingEnabled: adaptiveEnabled || runtime.resolved.resourceSampling.enabled,
        };

        const scheduler = new StageScheduler(store, schedulerConfig);
        console.log('  ▶ Starting scheduler (real Pi + Codex, timeout 10min)...');
        await scheduler.startRun(runId);
        console.log('  ▶ Scheduler completed.');

        console.log('  ✅ Run ' + runId + ' confirmed.');

        const finalRun = await store.getRun(runId);
        console.log('  Final status: ' + (finalRun?.status || 'unknown'));

        const finalStages = await store.listStages(runId);
        for (const s of finalStages) {
          console.log('    Stage ' + s.stageNumber + ': ' + s.status);
        }
      }

      await store.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ 错误: ${msg}`);
      process.exitCode = 1;
    }

    console.log('═'.repeat(50));
  });

function resolveTargetBranch(projectRoot: string, requestedTargetBranch?: string): string {
  const explicit = requestedTargetBranch?.trim();
  if (explicit) return explicit;
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: pathResolve(projectRoot),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
