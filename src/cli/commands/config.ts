// ── brainctl config ─────────────────────────────────────────────────────
// M4 governance config management. No secrets, no keys stored.

import { Command } from 'commander';
import { resolve as pathResolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ProjectAdapter, detectBranch } from '../../adapters/project-adapter.js';
import { assertValidQualityGates } from '../../quality/quality-gate-config.js';
import {
  getGovernanceConfig,
  setGovernanceEnabled,
  resetGovernanceConfigCache,
} from '../../core/decision-gate.js';

export const configCommand = new Command('config')
  .description('管理 brainctl 全局配置（不含密钥）');

// ── config set ──────────────────────────────────────────────────────────
configCommand
  .command('set')
  .description('设置配置项')
  .argument('<key>', '配置键（governance.enabled | budget.<type>.limit | budget.<type>.action）')
  .argument('<value>', '配置值')
  .action((key: string, value: string) => {
    // Allowed keys whitelist
    const ALLOWED_KEYS = [
      'governance.enabled',
      'budget.codex_plan.limit',
      'budget.codex_review_stage.limit',
      'budget.pi_run.limit',
      'budget.pi_task.limit',
      'budget.pi_attempt.limit',
    ];

    if (!ALLOWED_KEYS.includes(key)) {
      console.log(`✗ 不支持的配置键: ${key}`);
      console.log('  允许的键:');
      for (const k of ALLOWED_KEYS) console.log('    ' + k);
      process.exitCode = 1;
      return;
    }

    const projectRoot = process.cwd();

    if (key === 'governance.enabled') {
      const val = value.toLowerCase();
      if (val !== 'true' && val !== 'false') {
        console.log(`✗ 无效值: ${value}（仅支持 true 或 false）`);
        process.exitCode = 1;
        return;
      }
      const enabled = val === 'true';
      setGovernanceEnabled(projectRoot, enabled);
      console.log(`✓ governance.enabled = ${enabled}`);
      if (enabled) {
        console.log('  M4 治理已开启。submit 将进行 G1 风险评估并创建审批决策。');
      } else {
        console.log('  M4 治理已关闭。恢复 M2/M3 默认行为。');
      }
    } else if (key.startsWith('budget.')) {
      const numVal = parseInt(value, 10);
      if (isNaN(numVal) || numVal < 1) {
        console.log(`✗ 无效预算值: ${value}（必须是正整数）`);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ ${key} = ${numVal}`);
      console.log('  注意: budget 配置存储在 SQLite budget_policies 表中。');
      console.log('  使用 brainctl db 管理或通过 resume --increase-budget 设置 per-run 覆盖。');
    }
  });

// ── config project ─────────────────────────────────────────────────────
configCommand
  .command('project')
  .description('读取并验证当前项目 .brainctl/project.json')
  .argument('[path]', '项目路径，默认当前目录')
  .option('--json', '输出 JSON')
  .action((projectPath?: string, options?: { json?: boolean }) => {
    const root = pathResolve(projectPath || process.cwd());
    const configPath = pathResolve(root, '.brainctl', 'project.json');
    const result = new ProjectAdapter().loadSafe(root);
    if (!result.ok) {
      console.log(`✗ 项目配置无效: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    try {
      assertValidQualityGates(result.config.qualityGates);
    } catch (err) {
      console.log(`✗ 质量门无效: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    const payload = {
      source: existsSync(configPath) ? configPath : 'security-defaults (no project.json)',
      schemaVersion: result.config.schemaVersion,
      projectId: result.config.projectId,
      projectRoot: result.config.projectRoot,
      detectedBranch: detectBranch(root),
      defaultBaseBranch: result.config.defaultBaseBranch || null,
      qualityGates: {
        task: result.config.qualityGates.task?.map((gate) => gate.name) ?? [],
        stage: result.config.qualityGates.stage?.map((gate) => gate.name) ?? [],
      },
    };
    if (options?.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`✓ projectId: ${payload.projectId}`);
      console.log(`  source: ${payload.source}`);
      console.log(`  schemaVersion: ${payload.schemaVersion}`);
      console.log(`  target branch: ${payload.defaultBaseBranch || payload.detectedBranch || '(not configured)'}`);
      console.log(`  quality gates: task=${payload.qualityGates.task.length}, stage=${payload.qualityGates.stage.length}`);
    }
  });

// ── config get ──────────────────────────────────────────────────────────
configCommand
  .command('get')
  .description('读取配置项（不指定键则显示全部）')
  .argument('[key]', '可选：配置键')
  .action((key?: string) => {
    const projectRoot = process.cwd();
    resetGovernanceConfigCache();
    const cfg = getGovernanceConfig(projectRoot);

    if (key) {
      if (key === 'governance.enabled') {
        console.log(String(cfg.enabled));
      } else {
        console.log(`✗ 不支持的配置键: ${key}`);
        process.exitCode = 1;
      }
    } else {
      console.log(JSON.stringify({
        'governance.enabled': cfg.enabled,
      }, null, 2));
    }
  });
