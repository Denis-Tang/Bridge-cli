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
  getGovernanceConfig, resetGovernanceConfigCache,
  approveDecision, getAllPendingApprovals,
} from '../../core/decision-gate.js';
import { setPerRunBudget } from '../../core/budget-policy-store.js';
import type { PolicyType } from '../../types/m4-types.js';
import {
  runPreflightReconciliation,
  hasBlockingFindings,
  printPreflightBlocked,
} from './reconcile.js';

export const resumeCommand = new Command('resume')
  .description('恢复暂停的 run。M4: --increase-budget 提高 Token 限额')
  .argument('<run-id>', 'run ID')
  .option('--adaptive-concurrency', '启用 M3 自适应并发')
  .option('--max-parallel-tasks <n>', '最大并行任务数 (1-16)', parseInt)
  .option('--allow-real-project', '允许对非 disposable 项目恢复真实 Pi/Codex 施工')
  .option('--target-branch <branch>', '目标合并分支（默认当前分支）')
  .option('--increase-budget <n>', 'M4: 提高 Token 预算上限（token 数）', parseInt)
  .option('--policy-type <type>', 'M4: 预算类型 (codex_plan|codex_review_stage|pi_run|pi_task|pi_attempt)')
  .option('--approve <decision-id>', 'M4: 批准指定决策 ID 后恢复')
  .action(async (runId: string, options: {
    adaptiveConcurrency?: boolean; maxParallelTasks?: number;
    allowRealProject?: boolean; targetBranch?: string;
    increaseBudget?: number; policyType?: string; approve?: string;
  }) => {
    console.log('═'.repeat(50));
    console.log('  brainctl resume');
    console.log('═'.repeat(50));

    try {
      const config = readSqliteConfigFromEnv();
      const store = SqliteStateStore.create(config.path);

      const run = await store.getRun(runId);
      if (!run) {
        console.log(`  ✗ Run ${runId} 不存在。`);
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
        },
      });

      // ── M5: Preflight reconciliation (zero-write, before any state change) ──
      const preflightFindings = await runPreflightReconciliation(store, runId, 'resume_preflight');
      if (hasBlockingFindings(preflightFindings)) {
        printPreflightBlocked(preflightFindings, runId);
        await store.close();
        process.exit(1);
      }

      // Now safe to apply migrations and proceed
      const runner = new SqliteMigrationRunner(config, store.getDatabase());
      runner.applyPending();

      // ── M4: Handle token budget resume ──
      if (options.increaseBudget !== undefined || options.approve || options.policyType) {
        resetGovernanceConfigCache();
        const govCfg = getGovernanceConfig(run.projectRoot);
        if (!govCfg.enabled) {
          console.log('  ✗ M4 治理未开启。无法使用 --increase-budget / --approve。');
          console.log('  请先运行: brainctl config set governance.enabled true');
          await store.close();
          process.exit(1);
        }

        // Approve specific decision first
        if (options.approve) {
          const ok = await approveDecision(store, options.approve);
          if (!ok) {
            console.log(`  ✗ 决策 ${options.approve} 批准失败（不存在或已处理）。`);
            await store.close();
            process.exit(1);
          }
          console.log(`  ✓ 决策已批准: ${options.approve}`);
        }

        // All pending approvals must be handled before resume
        const { g1, g2, g3 } = await getAllPendingApprovals(store, runId);
        const allPending = [...g1, ...g2, ...g3];
        if (allPending.length > 0) {
          console.log(`  ✗ 仍有 ${allPending.length} 个决策待确认:`);
          for (const d of allPending) {
            console.log(`    ${d.id} [${d.gate}] ${d.decisionType} — ${d.status}`);
          }
          console.log('  请逐项确认后再 resume。');
          await store.close();
          process.exit(1);
        }

        // Increase budget if requested
        if (options.increaseBudget !== undefined) {
          const pt = (options.policyType || 'pi_run') as PolicyType;
          const validTypes: PolicyType[] = ['codex_plan', 'codex_review_stage', 'pi_run', 'pi_task', 'pi_attempt'];
          if (!validTypes.includes(pt)) {
            console.log(`  ✗ 无效的 policy-type: ${pt}`);
            console.log(`  有效值: ${validTypes.join(', ')}`);
            await store.close();
            process.exit(1);
          }

          if (options.increaseBudget < 100 || options.increaseBudget > 10_000_000) {
            console.log('  ✗ --increase-budget 必须在 100-10000000 之间');
            await store.close();
            process.exit(1);
          }

          await setPerRunBudget(store, runId, pt, options.increaseBudget, 'pause');
          console.log(`  ✓ ${pt} 预算提高到 ${options.increaseBudget} tokens`);

          await store.createEvent({
            id: `${runId}-ev-budget-resume-${Date.now()}`,
            runId,
            eventType: 'token_budget_resumed',
            eventData: { policyType: pt, newLimit: options.increaseBudget },
          });
        }
      }

      // ── Check run state ──
      if (run.status !== 'waiting_decision' && run.status !== 'running') {
        const stages = await store.listStages(runId);
        const pausedStage = stages.find((s) => s.status === 'paused');
        if (!pausedStage) {
          console.log(`  ✗ Run ${runId} 没有暂停的阶段。状态: "${run.status}"`);
          await store.close();
          process.exit(1);
        }
      }

      let maxParallelTasks = runtime.resolved.maxParallelTasks;
      if (options.maxParallelTasks !== undefined) {
        if (isNaN(options.maxParallelTasks) || options.maxParallelTasks < 1 || options.maxParallelTasks > 16) {
          console.log('  ✗ --max-parallel-tasks must be between 1 and 16');
          await store.close();
          process.exit(1);
        }
        maxParallelTasks = options.maxParallelTasks;
      }

      const adaptiveEnabled = options.adaptiveConcurrency === true;
      if (adaptiveEnabled) {
        console.log(`  M3 自适应并发: 启用 (max ${maxParallelTasks} tasks)`);
      }

      const targetBranch = runtime.resolved.targetBranch || resolveTargetBranch(run.projectRoot, options.targetBranch);
      console.log(`  目标分支: ${targetBranch}`);

      const now = new Date().toISOString();
      await store.updateRunStatus(runId, 'running', now);
      await store.createEvent({
        id: `${runId}-ev-resume-${Date.now()}`,
        runId,
        eventType: 'run_resumed',
        eventData: { resumedAt: now },
      });

      const schedulerConfig: Partial<SchedulerConfig> & { projectRoot: string } = {
        ...schedulerConfigFromResolved(runtime.resolved, getGovernanceConfig(run.projectRoot).enabled),
        targetBranch,
        maxParallelTasks,
        resourceSamplingEnabled: adaptiveEnabled || runtime.resolved.resourceSampling.enabled,
      };

      const scheduler = new StageScheduler(store, schedulerConfig);
      console.log('  ▶ Resuming scheduler...');
      await scheduler.startRun(runId);
      console.log('  ▶ Scheduler completed.');

      const finalRun = await store.getRun(runId);
      console.log('  Final run status: ' + (finalRun?.status || 'unknown'));
      console.log('  ✅ Run ' + runId + ' finished.');
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
