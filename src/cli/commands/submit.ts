import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { WorktreeManager } from '../../git/worktree-manager.js';
import { MergeManager } from '../../git/merge-manager.js';
import { DiffScopeValidator } from '../../git/diff-scope-validator.js';
import { QualityGateRunner, type QualityGateConfig } from '../../quality/quality-gate-runner.js';
import { LocalRuleReviewer } from '../../adapters/local-rule-reviewer.js';
import { CodexCliReviewer } from '../../adapters/codex-cli-reviewer.js';
import { CodexReviewer } from '../../adapters/codex-reviewer.js';
import { PiRpcWorker } from '../../adapters/pi-rpc-worker.js';
import { CodexTechnicalClarifier } from '../../adapters/codex-technical-clarifier.js';
import type { PiWorkerConfig } from '../../adapters/pi-worker-types.js';
import { ObsidianRecorder } from '../../recorder/obsidian-recorder.js';
import { CodexCliBrain } from '../../adapters/codex-cli-brain.js';
import type { StructuredPlan, StructuredTaskSpec } from '../../types/m2-types.js';
import { SqliteLedgerSink, estimateForCallType } from '../../core/token-telemetry.js';
import { preCheckBudget, postCheckBudget } from '../../core/token-budget.js';
import { ensureDefaultPolicies } from '../../core/budget-policy-store.js';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { validateRealProjectExecution } from '../../core/real-project-gate.js';
import {
  getGovernanceConfig,
  resetGovernanceConfigCache,
  createG1Approvals,
  assessG1Risk,
  isDisposableProject,
} from '../../core/decision-gate.js';
import { loadRuntimeProjectConfig } from '../../core/project-runtime-config.js';
import { createExecutionConfigSnapshot } from '../../core/config-snapshot.js';
import { detectBranch } from '../../adapters/project-adapter.js';
import { qualityGatesToRunnerConfig } from '../../quality/quality-gate-config.js';

export const submitCommand = new Command('submit')
  .description('提交自然语言需求给 Codex Brain 进行规划')
  .argument('<request>', '自然语言需求描述')
  .option('--dry-run', '仅验证输入并生成示例 JobRequest，不执行实际调度')
  .option('--local-run', '在 disposable 项目上执行本地真实试运行')
  .option('--project <path>', '目标项目路径（仅 --local-run 模式需要）')
  .option('--allow-real-project', '允许对非 disposable 项目执行 --local-run')
  .option('--demo-fixture', '启用明确的 fake demo fixture 模式（仅与 --demo-file 联用）')
  .option('--demo-file <path>', 'fake demo fixture 要写入的项目内相对路径')
  .option('--worker <type>', 'Worker 类型: fake (默认) 或 real-pi', 'fake')
  .option('--worker-timeout-ms <ms>', 'Worker 超时毫秒数（仅 real-pi，默认 180000，最小 30000）')
  .option('--reviewer <type>', 'Reviewer 类型: local-rule (默认) 或 codex-cli', 'local-rule')
  .action(async (request: string, options: { dryRun?: boolean; localRun?: boolean; project?: string; allowRealProject?: boolean; demoFixture?: boolean; demoFile?: string; worker?: string; workerTimeoutMs?: string; reviewer?: string }) => {
    console.log('═'.repeat(50));
    console.log('  brainctl submit — 提交需求');
    console.log('═'.repeat(50));
    console.log(`  需求: "${request}"`);

    // ── Dry-run mode ──────────────────────────────────────────────────
    if (options.dryRun) {
      const jobRequest = {
        jobId: `job_dryrun_${Date.now()}`,
        projectId: '(dry-run)',
        projectRoot: '(dry-run)',
        requestText: request,
        submittedBy: 'brainctl-cli',
        createdAt: new Date().toISOString(),
        constraints: {
          productDecisionsLocked: true,
          allowHighRiskOperations: false,
        },
      };

      console.log('\n  生成的 JobRequest（符合 JSON Schema）:');
      console.log(JSON.stringify(jobRequest, null, 2));
      console.log('\n  ⚠ 当前为 dry-run 模式，未执行任何实际调度。');
      console.log('═'.repeat(50));
      return;
    }

    // ── Local-run mode ────────────────────────────────────────────────
    if (options.localRun) {
      if (!options.project) {
        console.log('  ✗ --local-run 需要 --project <path> 指定目标项目。');
        process.exit(1);
      }

      const projectPath = resolve(options.project);

      const realProjectGate = validateRealProjectExecution(projectPath, options.allowRealProject === true);
      if (!realProjectGate.allowed) {
        console.log(`  ✗ ${realProjectGate.reason}`);
        process.exit(1);
      }

      if (!existsSync(projectPath)) {
        console.log(`  ✗ 目标项目路径不存在: ${projectPath}`);
        process.exit(1);
      }

      try {
        execFileSync('git', ['rev-parse', '--git-dir'], { cwd: projectPath, stdio: 'pipe' });
      } catch {
        console.log('  ✗ 目标项目不是 Git 仓库。');
        process.exit(1);
      }

      const runId = `run_${Date.now()}`;
      const branchName = `brainctl/${runId}`;
      const worktreeRel = `.brainctl-dev/worktrees/${runId}`;
      const recordsRoot = resolve(projectPath, '.brainctl-dev/obsidian-demo');
      const logDir = resolve(projectPath, '.brainctl-dev/logs');
      const sessionDir = resolve(projectPath, '.brainctl-dev/sessions');
      mkdirSync(logDir, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });

      const workerType = options.worker || 'fake';
      const reviewerType = options.reviewer || 'local-rule';

      if (workerType === 'fake' && (!options.demoFixture || !options.demoFile)) {
        console.log('  ✗ fake worker 只允许在明确的 demo fixture 模式运行；请同时提供 --demo-fixture --demo-file <relative-path>，或使用结构化计划入口。');
        process.exit(1);
      }
      if (options.demoFixture && (!options.demoFile || !isSafeDemoFile(options.demoFile))) {
        console.log('  ✗ --demo-file 必须是目标项目内的安全相对路径。');
        process.exit(1);
      }

      // Parse worker timeout
      let workerTimeoutMs = 180000;
      if (options.workerTimeoutMs) {
        const parsed = parseInt(options.workerTimeoutMs, 10);
        if (isNaN(parsed) || parsed < 30000) {
          console.log('  ✗ --worker-timeout-ms 必须 >= 30000');
          process.exit(1);
        }
        workerTimeoutMs = parsed;
      }

      const runtime = loadRuntimeProjectConfig(projectPath, {
        cliOverrides: { worker: workerType, reviewer: reviewerType, workerTimeoutMs },
      });
      const localPrivacyService = PrivacyService.create({ projectRoot: projectPath });
      const targetBranch = runtime.resolved.targetBranch || detectBranch(projectPath);
      if (!targetBranch) {
        console.log('  ✗ 未能探测目标分支；请先在 Git 仓库中检出分支，或配置 defaultBaseBranch。');
        process.exit(1);
      }

      console.log(`\n  运行 ID: ${runId}`);
      console.log(`  目标项目: ${projectPath}`);
      console.log(`  Worker 分支: ${branchName}`);
      console.log(`  Worker 类型: ${workerType}`);
      console.log(`  Worker 超时: ${workerTimeoutMs}ms`);
      console.log(`  Reviewer 类型: ${reviewerType}`);
      console.log('');

      const phaseStatus: Array<{ name: string; ok: boolean }> = [];
      const cleanupWarnings: string[] = [];

      try {
        // Phase 1: Create branch
        phaseStatus.push({ name: '创建分支', ok: false });
        console.log('  ▶ 阶段 1/7: 创建分支...');
        const wtm = new WorktreeManager(projectPath);
        wtm.createBranch(branchName, targetBranch);
        phaseStatus[0].ok = true;

        // Phase 2: Create worktree
        phaseStatus.push({ name: '创建工作目录', ok: false });
        console.log('  ▶ 阶段 2/7: 创建工作目录...');
        mkdirSync(resolve(projectPath, '.brainctl-dev/worktrees'), { recursive: true });
        wtm.createWorktree(branchName, worktreeRel);
        phaseStatus[1].ok = true;

        // Phase 3: Execute
        phaseStatus.push({ name: '执行施工', ok: false });
        console.log('  ▶ 阶段 3/7: 执行施工...');
        const fullWtPath = resolve(projectPath, worktreeRel);
        if (workerType === 'real-pi') {
          console.log('    使用真实 Pi Worker 执行...');
          const piConfig: PiWorkerConfig = {
            workerId: `brainctl-${runId}`,
            command: runtime.resolved.worker.command,
            args: runtime.resolved.worker.args,
            model: runtime.resolved.worker.model || undefined,
            workingDirectory: fullWtPath,
            sessionDirectory: sessionDir,
            rawLogPath: resolve(logDir, `${runId}_pi.log`),
            timeoutMs: runtime.resolved.worker.timeoutMs,
            allowRealPiExecution: true,
            requireClarification: true,
            env: localPrivacyService.buildProviderEnv('pi', undefined, runtime.resolved.worker.model),
            clarificationResponder: new CodexTechnicalClarifier({
              command: runtime.resolved.reviewer.command || 'codex',
              args: runtime.resolved.reviewer.args,
              timeoutMs: runtime.resolved.reviewer.timeoutMs,
              env: localPrivacyService.buildProviderEnv('codex'),
            }),
          };
          const piWorker = new PiRpcWorker(piConfig);
          const taskSpec = {
            taskId: runId,
            title: 'Pi Worker 施工任务',
            goal: request,
            dependencies: [],
            allowedPaths: runtime.resolved.allowedPaths.length > 0 ? runtime.resolved.allowedPaths : ['.'],
            forbiddenPaths: runtime.resolved.forbiddenPaths,
            contextFiles: [],
            acceptanceChecks: ['任务完成'],
            allowedCommands: ['git diff', 'git add', 'git commit', 'node', 'npm'],
            riskLevel: 'low' as const,
            productDecisionsLocked: true,
            expectedOutputs: ['WorkerResult'],
            heavyCommandSlotsRequired: 0,
            timeoutSeconds: 120,
          };
          const piResult = await piWorker.executeTask({
            taskSpec,
            worktreePath: fullWtPath,
            runId,
          });
          if (piResult.workerResult && piResult.workerResult.status === 'completed') {
            console.log(`    Pi Worker 完成: ${piResult.workerResult.summary}`);
            if (piResult.providerUsage) {
              const usage = piResult.providerUsage;
              console.log(`    Provider 用量: ${usage.totalTokens} tokens, cost ${usage.costTotal.toFixed(8)} USD`);
            } else {
              console.log('    Provider 用量: unavailable');
            }
          } else {
            const errMsg = piResult.errorMessage || 'Pi Worker 执行失败';
            throw new Error(`Pi Worker 执行失败: ${errMsg}`);
          }
        } else {
          // Fake worker is deliberately limited to an explicit demo fixture path.
          const demoFile = options.demoFile as string;
          const messageFile = resolve(fullWtPath, demoFile);
          mkdirSync(dirname(messageFile), { recursive: true });
          writeFileSync(messageFile, `Hello brainctl!\nUpdated by: ${runId}\nRequest: ${request}\n`);
          execFileSync('git', ['add', demoFile.replace(/\\/g, '/')], { cwd: fullWtPath, stdio: 'pipe' });
          execFileSync('git', ['commit', '-m', `brainctl: ${request.substring(0, 60)}`], { cwd: fullWtPath, stdio: 'pipe' });
          const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fullWtPath, encoding: 'utf-8' }).trim();
          console.log(`    commit: ${commitHash}`);
        }
        phaseStatus[2].ok = true;

        // Phase 4: Scope check
        phaseStatus.push({ name: '检查范围', ok: false });
        console.log('  ▶ 阶段 4/7: 检查 diff 范围...');
        const changedFiles = wtm.getChangedFiles(fullWtPath, targetBranch);
        const validator = new DiffScopeValidator();
        const scopeResult = validator.validate(changedFiles, runtime.resolved.allowedPaths.length > 0 ? runtime.resolved.allowedPaths : ['.'], runtime.resolved.forbiddenPaths);
        if (scopeResult.forbiddenFiles.length > 0) {
          throw new Error(`Scope violation: ${scopeResult.forbiddenFiles.join(', ')}`);
        }
        console.log(`    变更文件: ${changedFiles.join(', ') || '(无)'}`);
        phaseStatus[3].ok = true;
        const hasChanges = changedFiles.length > 0;

        // Phase 5: Quality Gate
        phaseStatus.push({ name: '质量门', ok: false });
        console.log('  ▶ 阶段 5/7: 执行质量门...');
        const qg = new QualityGateRunner(fullWtPath);
        const gates: QualityGateConfig[] = qualityGatesToRunnerConfig(runtime.resolved.qualityGatesTask);
        if (gates.length === 0) throw new Error('No quality gates configured for this project; configure .brainctl/project.json before local-run.');
        const qgResult = await qg.runGates(gates, true);
        if (!qgResult.passed) {
          const detail = qgResult.results.map((result) => `${result.name}: ${result.status} (${result.stderrTail || result.stdoutTail || 'no output'})`).join(' | ');
          throw new Error(`Quality gate failed: ${qgResult.summary}; ${detail}`);
        }
        console.log(`    质量门: ${qgResult.summary}`);
        phaseStatus[4].ok = true;

        // Phase 6: Review
        phaseStatus.push({ name: '审查', ok: false });
        console.log('  ▶ 阶段 6/7: 审查 diff...');
        if (!hasChanges) {
          console.log('    审查结果: 无 diff，目标状态已满足，跳过审查。');
        } else {
          const diff = wtm.getDiff(fullWtPath, targetBranch);
          let reviewResult;
          if (reviewerType === 'codex-cli') {
            const codexReviewer = new CodexCliReviewer({
              workDir: fullWtPath,
              sessionDir,
              allowRealReview: true,
              command: runtime.resolved.reviewer.command,
              args: runtime.resolved.reviewer.args,
              timeoutMs: runtime.resolved.reviewer.timeoutMs,
              env: localPrivacyService.buildProviderEnv('codex'),
            });
            reviewResult = await codexReviewer.reviewDiff(diff, runId);
          } else {
            // local-rule (default)
            const localReviewer = new LocalRuleReviewer();
            reviewResult = localReviewer.reviewDiff(diff, runId);
          }
          if (!reviewResult.mergeAllowed) {
            throw new Error(`审查拒绝: ${reviewResult.reviewSummary}`);
          }
          console.log(`    审查结果: ${reviewResult.reviewSummary}`);
        }
        phaseStatus[5].ok = true;

        // Phase 7: Merge + Record
        phaseStatus.push({ name: '合并与记录', ok: false });
        console.log(hasChanges ? '  ▶ 阶段 7/7: 合并并记录...' : '  ▶ 阶段 7/7: 记录并清理...');
        let mergeCommitHash: string | undefined;
        if (hasChanges) {
          const mm = new MergeManager(wtm);
          const mergeResult = mm.merge(branchName, targetBranch);
          if (!mergeResult.success) {
            throw new Error(`Merge failed: ${mergeResult.message}`);
          }
          mergeCommitHash = mergeResult.mergeCommitHash;
          console.log(`    合并结果: ${mergeResult.message}`);
        } else {
          console.log('    合并结果: 无变更，无需合并。');
        }

        const recorder = new ObsidianRecorder({ recordsRoot, projectFolder: 'local-run' });
        await recorder.recordProjectDescription(`Local run for: ${request}`);
        await recorder.recordFinalResult(runId, hasChanges ? 'Local run completed and merged' : 'Local run completed with no changes', [
          { taskId: runId, status: 'completed', summary: hasChanges ? 'Local run completed' : 'Target state already satisfied; no changes were needed' },
        ]);

        try {
          await wtm.cleanupWorktree(branchName, fullWtPath);
        } catch (err) {
          const warning = err instanceof Error ? err.message : String(err);
          cleanupWarnings.push(`Worktree cleanup failed: ${warning}`);
        }

        try {
          wtm.deleteBranch(branchName);
        } catch (err) {
          const warning = err instanceof Error ? err.message : String(err);
          cleanupWarnings.push(`Branch cleanup failed: ${warning}`);
        }

        phaseStatus[6].ok = true;

        console.log('\n  ✅ 本地试运行成功完成！');
        console.log(`  合并 commit: ${mergeCommitHash ?? '(无，目标状态已满足)'}`);
        if (cleanupWarnings.length > 0) {
          console.log('\n  ⚠ 清理警告:');
          for (const warning of cleanupWarnings) {
            console.log(`    - ${warning.split('\n')[0]}`);
          }
          console.log('    合并与记录已完成；请稍后运行 git worktree prune 或手动清理残留 worktree。');
        }
        console.log('\n  各阶段状态:');
        for (const p of phaseStatus) {
          console.log(`    ${p.ok ? '✓' : '✗'} ${p.name}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n  ❌ 运行失败: ${msg}`);
        console.log('\n  阶段状态:');
        for (const p of phaseStatus) {
          console.log(`    ${p.ok ? '✓' : '✗'} ${p.name}`);
        }
        process.exitCode = 1;
      }

      console.log('═'.repeat(50));
      return;
    }

    // ── M2 Structured Plan mode ────────────────────────────────
    if (!options.dryRun && !options.localRun) {
      if (!options.project) {
        console.log('  x M2 mode requires --project <path>');
        process.exit(1);
      }
      return await handleStructuredPlan(request, options.project, options);
    }

    // ── Default ──────────────────────────────────────────────────────
    console.log('\n  请指定执行模式:');
    console.log('    --dry-run              预览 JobRequest，不执行');
    console.log('    --local-run            在 disposable 项目上运行；fake 需显式 --demo-fixture --demo-file');
    console.log('    --worker <type>        Worker 类型: fake (默认) 或 real-pi');
    console.log('    --worker-timeout-ms    Worker 超时毫秒数（仅 real-pi，默认 180000）');
    console.log('    --reviewer <type>      Reviewer 类型: local-rule (默认) 或 codex-cli');
    console.log('\n  示例:');
    console.log('    npm run brainctl -- submit "修改文档" --dry-run');
    console.log('    npm run brainctl -- submit "修改 demo 文件" --project .brainctl-dev/fixtures/demo-target-repo --local-run --demo-fixture --demo-file <relative-path>');
    console.log('    npm run brainctl -- submit "修改 src/message.txt" --project .brainctl-dev/fixtures/demo-target-repo --local-run --worker real-pi');
    console.log('    npm run brainctl -- submit "修改 src/message.txt" --project .brainctl-dev/fixtures/demo-target-repo --local-run --reviewer codex-cli');
    console.log('═'.repeat(50));
  });

// M2 Structured Plan helper
async function handleStructuredPlan(request: string, projectPath: string, options: { worker?: string; reviewer?: string; workerTimeoutMs?: string }): Promise<void> {
  const runId = 'run_' + Date.now();
  const config = readSqliteConfigFromEnv();
  const projectRoot = resolve(projectPath);
  try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, stdio: 'pipe' }); }
  catch { console.log('  x --project must be a valid Git repo: ' + projectRoot); process.exit(1); }

  const runtime = loadRuntimeProjectConfig(projectRoot, {
    cliOverrides: {
      worker: options.worker,
      reviewer: options.reviewer,
      workerTimeoutMs: options.workerTimeoutMs ? Number(options.workerTimeoutMs) : undefined,
    },
  });
  const executionConfigSnapshot = createExecutionConfigSnapshot(runtime.resolved);

  // ── M4: Initialize governance before Brain call ──
  resetGovernanceConfigCache();
  const govCfg = getGovernanceConfig(projectRoot);
  const governanceEnabled = govCfg.enabled;

  console.log('  Calling Codex CLI for structured plan (project: ' + projectRoot + ')...');
  const planDir = resolve(projectRoot, '.brainctl-dev/plan-logs');
  mkdirSync(planDir, { recursive: true });

  const now = new Date().toISOString();

  // ── governance=true: create store/run BEFORE Brain for ledger context ──
  // ── governance=false: call Brain FIRST, only create store after valid plan (M2 behavior) ──

  if (governanceEnabled) {
    // ── M4 governance path ──
    const privacyService = PrivacyService.create({ projectRoot });
    const store = SqliteStateStore.create(config.path, privacyService);
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
    await store.createRun({ id: runId, projectId: runtime.projectConfig.projectId, projectRoot, requestText: request, status: 'planning', executionConfigSnapshot, createdAt: now, updatedAt: now });

    await ensureDefaultPolicies(store);
    const est = estimateForCallType('codex_plan', { requestText: request });
    const check = await preCheckBudget(store, runId, 'codex_plan', est.total);

    if (!check.allowed) {
      console.log('  x Token budget exceeded for planning: ' + check.reason);
      await store.createEvent({ id: runId + '-ev-plan-budget-exceeded', runId, eventType: 'token_budget_exceeded', eventData: { policyType: 'codex_plan', remaining: check.remaining, limit: check.limit } });
      console.log('  Plan is NOT approvable.');
      console.log('  Use "brainctl resume ' + runId + ' --increase-budget <tokens>" to raise the codex_plan limit.');
      await store.close();
      return;
    }

    const sink = new SqliteLedgerSink(store);
    const planCtx: import('../../core/token-telemetry.js').InvocationContext = { runId, callType: 'codex_plan', callId: runId + '-plan', model: 'codex-cli' };

    const brain = new CodexCliBrain(
      { workDir: projectRoot, sessionDir: planDir, allowRealPlanning: true, timeoutMs: 300_000 },
      { ledgerSink: sink, invocationContext: planCtx },
    );
    const planResult = await brain.generatePlan(request, runId);

    // Post-check
    const pc = await postCheckBudget(store, runId, 'codex_plan', 0).catch(() => null);
    if (pc && pc.exceeded) {
      console.log('  x Token budget exceeded after planning: ' + pc.remaining + '/' + pc.limit);
      await store.createEvent({ id: runId + '-ev-plan-post-exceeded', runId, eventType: 'token_budget_exceeded', eventData: { policyType: 'codex_plan', remaining: pc.remaining, limit: pc.limit } });
      console.log('  Plan is NOT approvable.');
      await store.close();
      return;
    }

    if (planResult.errors.length > 0) writeFileSync(resolve(planDir, runId + '_plan-errors.txt'), planResult.errors.join('\n'), 'utf-8');
    if (planResult.rawOutput) writeFileSync(resolve(planDir, runId + '_plan-output.txt'), planResult.rawOutput, 'utf-8');

    if (!planResult.plan) {
      console.log('  x Codex planning FAILED: ' + planResult.errors.join('; '));
      console.log('  Diagnostics: ' + planDir);
      console.log('  Plan is NOT approvable.');
      await store.close();
      return;
    }

    const vErr = validateStructuredPlan(planResult.plan);
    if (vErr.length > 0) {
      writeFileSync(resolve(planDir, runId + '_plan-schema-errors.txt'), vErr.join('\n'), 'utf-8');
      console.log('  x Codex output schema invalid:');
      for (const e of vErr) console.log('    - ' + e);
      console.log('  Plan is NOT approvable.');
      await store.close();
      return;
    }

    await persistPlanToStore(store, runId, projectRoot, request, planResult.plan, now, planDir, governanceEnabled);
    await store.close();
  } else {
    // ── M2 path: governance=false — call Brain first, only create store after valid plan ──
    const brain = new CodexCliBrain({ workDir: projectRoot, sessionDir: planDir, allowRealPlanning: true, timeoutMs: 300_000 });
    const planResult = await brain.generatePlan(request, runId);

    if (planResult.errors.length > 0) writeFileSync(resolve(planDir, runId + '_plan-errors.txt'), planResult.errors.join('\n'), 'utf-8');
    if (planResult.rawOutput) writeFileSync(resolve(planDir, runId + '_plan-output.txt'), planResult.rawOutput, 'utf-8');

    if (!planResult.plan) {
      console.log('  x Codex planning FAILED: ' + planResult.errors.join('; '));
      console.log('  Diagnostics: ' + planDir);
      console.log('  Plan is NOT approvable.');
      // M2 invariant: NO store created, NO run, NO ledger, NO events
      return;
    }

    const vErr = validateStructuredPlan(planResult.plan);
    if (vErr.length > 0) {
      writeFileSync(resolve(planDir, runId + '_plan-schema-errors.txt'), vErr.join('\n'), 'utf-8');
      console.log('  x Codex output schema invalid:');
      for (const e of vErr) console.log('    - ' + e);
      console.log('  Plan is NOT approvable.');
      // M2 invariant: NO store created
      return;
    }

    // Plan valid → now create store/run/stages/tasks
    const privacyService2 = PrivacyService.create({ projectRoot });
    const store = SqliteStateStore.create(config.path, privacyService2);
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
    await store.createRun({ id: runId, projectId: runtime.projectConfig.projectId, projectRoot, requestText: request, status: 'planning', executionConfigSnapshot, createdAt: now, updatedAt: now });
    await persistPlanToStore(store, runId, projectRoot, request, planResult.plan, now, planDir, governanceEnabled);
    await store.close();
  }
}

function isSafeDemoFile(value: string): boolean {
  if (!value.trim() || isAbsolute(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  return !normalized.split('/').some((part) => part === '..' || part === '');
}

/** Persist a validated plan to the store: stages, tasks, events, G1 approvals. */
async function persistPlanToStore(
  store: SqliteStateStore, runId: string, projectRoot: string, request: string,
  plan: StructuredPlan, now: string, planDir: string, governanceEnabled: boolean,
): Promise<void> {
  // 为每个 task 生成 run-scoped 唯一 ID
  const taskIdMap = new Map<string, string>();
  for (const task of plan.tasks) {
    const uniqueId = runId + '-' + task.taskId;
    taskIdMap.set(task.taskId, uniqueId);
    (task as any).taskId = uniqueId;
    if (Array.isArray(task.dependencies)) {
      (task as any).dependencies = task.dependencies.map((d: string) => taskIdMap.get(d) || (runId + '-' + d));
    }
  }
  for (const stage of plan.stages) {
    stage.tasks = stage.tasks.map((t) => taskIdMap.get(t) || (runId + '-' + t));
  }

  for (const stage of plan.stages) {
    const stageId = runId + '-stage-' + stage.stageNumber;
    await store.createStage({ id: stageId, runId, stageNumber: stage.stageNumber, title: stage.title, status: 'pending' });
    for (const task of plan.tasks.filter((t: any) => t.stageNumber === stage.stageNumber)) {
      await store.createTask({ id: task.taskId, runId, title: task.title, status: 'pending', specJson: task, createdAt: now, updatedAt: now });
    }
  }

  await store.createEvent({ id: runId + '-ev-plan', runId, eventType: 'plan_created', eventData: { request } });

  // ── M4: G1 Decision Gate ──
  if (governanceEnabled) {
    const isReal = !isDisposableProject(projectRoot);
    const findings = assessG1Risk(plan, isReal);
    const decisions = await createG1Approvals(store, runId, plan, isReal);

    console.log('');
    console.log('  ══ M4 治理: G1 风险评估 ══');
    const worstFinding = findings.find((f) => f.severity === 'critical')
      || findings.find((f) => f.severity === 'high' && f.requiresApproval)
      || findings.find((f) => f.severity === 'medium' && f.requiresApproval);
    console.log('  综合风险: ' + (worstFinding ? worstFinding.severity : (plan.riskAssessment?.level || 'low')));
    for (const f of findings) {
      const icon = f.requiresApproval ? '\u26a0' : '\u2139';
      console.log('  ' + icon + ' [' + f.severity + '] ' + f.category + ': ' + f.detail.substring(0, 80));
    }
    if (decisions.length > 0) {
      console.log('');
      console.log('  待确认审批 (' + decisions.length + '):');
      for (const d of decisions) {
        console.log('    ' + d.id + ' \u2014 ' + d.decisionType + ' [pending]');
      }
      console.log('');
      console.log('  逐项确认:  brainctl approve ' + runId + ' --approve <decision-id>');
      console.log('  批量确认 (仅 low-risk): brainctl approve ' + runId + ' --auto');
    } else {
      console.log('  \u2713 无待确认审批，可直接批准。');
    }
  }

  console.log('');
  console.log('  Plan generated. Run ID: ' + runId);
  console.log('');
  console.log('  Stages:');
  for (const stage of plan.stages) {
    const stageTasks = plan.tasks.filter((t: any) => t.stageNumber === stage.stageNumber);
    console.log('    Stage ' + stage.stageNumber + ': ' + stage.title + ' (' + stageTasks.length + ' tasks)');
    for (const task of stageTasks) {
      const ds = task.dependencies.length > 0 ? ' (deps: ' + task.dependencies.join(', ') + ')' : '';
      console.log('      - ' + task.taskId + ': ' + task.title + ds);
      if (task.estimatedWritePaths.length > 0) console.log('         writes: ' + task.estimatedWritePaths.join(', '));
    }
  }
  console.log('');
  console.log('  Risk: ' + plan.riskAssessment.level);
  for (const note of plan.riskAssessment.notes) console.log('    - ' + note);
  console.log('');
  console.log('  Use "brainctl approve ' + runId + '" to start.');
  console.log('  Plan logs: ' + planDir);
}

function validateStructuredPlan(plan: StructuredPlan): string[] {
  const e: string[] = [];
  if (!plan.stages || plan.stages.length === 0) e.push('missing stages');
  if (!plan.tasks || plan.tasks.length === 0) e.push('missing tasks');
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!t.taskId) { e.push('task missing taskId'); continue; }
    if (ids.has(t.taskId)) { e.push('duplicate taskId: ' + t.taskId); continue; }
    ids.add(t.taskId);
    if (typeof t.stageNumber !== 'number') e.push(t.taskId + ': missing stageNumber');
    if (!t.title) e.push(t.taskId + ': missing title');
    if (!t.goal) e.push(t.taskId + ': missing goal');
    if (!t.estimatedWritePaths || t.estimatedWritePaths.length === 0) e.push(t.taskId + ': missing estimatedWritePaths');
  }
  for (const s of plan.stages) {
    if (!s.tasks || s.tasks.length === 0) e.push('stage ' + s.stageNumber + ': no tasks');
    for (const tid of (s.tasks || [])) if (!ids.has(tid)) e.push('stage ' + s.stageNumber + ' refs unknown task: ' + tid);
  }
  return e;
}
