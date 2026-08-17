import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { ProjectAdapter } from '../../adapters/project-adapter.js';
import { assertValidQualityGates } from '../../quality/quality-gate-config.js';

function commandVersion(command: string): string | null {
  try {
    return execFileSync(command, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim().split(/\r?\n/)[0] || 'available';
  } catch {
    return null;
  }
}

function commandAvailable(command: string): boolean {
  if (resolve(command) === command) return existsSync(command);
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function parseVersionParts(raw: string | null): number[] {
  if (!raw) return [];
  const match = raw.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [];
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function versionAtLeast(raw: string | null, major: number, minor = 0): boolean {
  const [maj, min] = parseVersionParts(raw);
  return maj > major || (maj === major && min >= minor);
}

export { parseVersionParts, versionAtLeast };

/** Count *.sql migration files under a directory (0 when the dir is missing). */
function countSqlFiles(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.sql')).length;
  } catch {
    return 0;
  }
}

const CODEX_MIN_MAJOR = 0;
const CODEX_MIN_MINOR = 140;

export interface BridgeRepositoryIdentityResult {
  ok: boolean;
  packageName: string | null;
  warning: string | null;
}

export function inspectBridgeRepositoryIdentity(root: string): BridgeRepositoryIdentityResult {
  const packagePath = join(resolve(root), 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown };
    const packageName = typeof parsed.name === 'string' ? parsed.name : null;
    if (packageName === 'bridge-orchestrator') {
      return { ok: true, packageName, warning: null };
    }
    return {
      ok: false,
      packageName,
      warning: `当前目录不是 Bridge 正式仓库（package.json.name=${packageName ?? 'missing'}）`,
    };
  } catch {
    return {
      ok: false,
      packageName: null,
      warning: '当前目录不是 Bridge 正式仓库（package.json 缺失或不可读）',
    };
  }
}

export const doctorCommand = new Command('doctor')
  .description('只读检查 Node.js、node:sqlite、Git、Pi、Codex、项目配置与质量门、dist 完整性')
  .option('--project <path>', '目标项目路径，默认当前目录')
  .action(async (options: { project?: string }) => {
    const projectRoot = resolve(options.project || process.cwd());
    console.log('═'.repeat(50));
    console.log('  brainctl doctor — 环境检查（只读）');
    console.log('═'.repeat(50));

    const bridgeIdentity = inspectBridgeRepositoryIdentity(process.cwd());
    if (bridgeIdentity.ok) {
      console.log('  ✓ Bridge repository: bridge-orchestrator');
    } else {
      console.log(`  ⚠ ${bridgeIdentity.warning}`);
    }

    const version = process.versions.node;
    const major = Number(version.split('.')[0]);
    const nodeRangeOk = major >= 24 && major < 25;
    console.log(`  ${nodeRangeOk ? '✓' : '✗'} Node.js: v${version}（支持区间: >=24.0.0 <25.0.0）`);

    try {
      await import('node:sqlite');
      console.log('  ✓ node:sqlite: 可导入（Node 24 实验性能力）');
    } catch (err) {
      console.log(`  ✗ node:sqlite: 不可用 — ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const command of ['git', 'pi', 'codex']) {
      const value = commandVersion(command);
      console.log(`  ${value ? '✓' : '✗'} ${command}: ${value || '未在 PATH 中找到'}`);
    }

    // ── Version thresholds (CONFIG.md) ──
    const piVersion = commandVersion('pi');
    const codexVersion = commandVersion('codex');
    if (piVersion) {
      // The verified version is a policy value (default 0.82.1 per CONFIG.md);
      // deviation is a loud warning, not a hard refusal (the runtime probe decides).
      const verified = '0.82.1';
      const piParts = parseVersionParts(piVersion);
      const verifiedParts = parseVersionParts(verified);
      const matches = piParts.length > 0 && piParts[0] === verifiedParts[0]
        && (verifiedParts[1] === undefined || piParts[1] === verifiedParts[1])
        && (verifiedParts[2] === undefined || piParts[2] === verifiedParts[2]);
      if (matches) {
        console.log(`  ✓ Pi CLI version: ${piVersion}（已验证版本 ${verified}）`);
      } else {
        console.log(`  ⚠ Pi CLI version: ${piVersion} ≠ 已验证版本 ${verified}（CONFIG.md）。` +
          '真实 Pi 运行前 guard 自检必须通过；如已升级并重新验证，请更新 verifiedPiVersion。');
      }
    } else {
      console.log('  ⚠ Pi CLI: 未找到。真实 Pi 施工不可用（fake/disposable 仍可）。');
    }
    if (codexVersion) {
      if (versionAtLeast(codexVersion, CODEX_MIN_MAJOR, CODEX_MIN_MINOR)) {
        console.log(`  ✓ Codex CLI version: ${codexVersion}（>= ${CODEX_MIN_MAJOR}.${CODEX_MIN_MINOR}.0 要求满足）`);
      } else {
        console.log(`  ✗ Codex CLI version: ${codexVersion}（CONFIG.md 要求 >= ${CODEX_MIN_MAJOR}.${CODEX_MIN_MINOR}.0，请升级）`);
      }
    } else {
      console.log('  ⚠ Codex CLI: 未找到。真实审查不可用（local-rule 仅限 fake/disposable）。');
    }

    const adapterResult = new ProjectAdapter().loadSafe(projectRoot);
    if (!adapterResult.ok) {
      console.log(`  ✗ project.json: ${adapterResult.reason}`);
    } else {
      const config = adapterResult.config;
      console.log(`  ✓ project config: schemaVersion=${config.schemaVersion}, projectId=${config.projectId}`);
      console.log(`    base branch: ${config.defaultBaseBranch || '(运行时探测)'}`);
      try {
        const parsed = assertValidQualityGates(config.qualityGates);
        for (const [scope, gates] of Object.entries(parsed)) {
          for (const gate of gates) {
            const cwd = resolve(projectRoot, gate.cwd || '.');
            const available = commandAvailable(gate.command);
            console.log(`    quality gate ${scope}/${gate.name}: cwd=${existsSync(cwd) ? 'ok' : 'missing'}, command=${available ? 'available' : 'missing'}`);
          }
        }
      } catch (err) {
        console.log(`  ✗ quality gates: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── real-pi ↔ codex-cli pairing (local-rule is only allowed for fake/disposable) ──
      const workerType = config.worker.type;
      const reviewerType = config.reviewer.type;
      if (workerType === 'real-pi' && reviewerType !== 'codex-cli') {
        console.log(`  ✗ worker/reviewer pairing: real-pi 必须配对 codex-cli 审查（当前 reviewer=${reviewerType}；local-rule 仅限 fake/disposable）。`);
      } else if (workerType === 'fake' && reviewerType === 'codex-cli') {
        console.log('  ⚠ worker/reviewer pairing: fake worker + codex-cli 审查是允许的（测试），但会消耗真实 Codex 调用。');
      } else {
        console.log(`  ✓ worker/reviewer pairing: ${workerType} + ${reviewerType}`);
      }

      // ── costBudget completeness for real Providers ──
      const needsRealBudget = workerType === 'real-pi' || reviewerType === 'codex-cli';
      const budget = config.costBudget;
      if (needsRealBudget) {
        const missing: string[] = [];
        const invalid: string[] = [];
        for (const key of ['limit', 'maxPiCallCost', 'maxCodexCallCost'] as const) {
          const value = budget ? budget[key] : undefined;
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            (value === undefined || value === null ? missing : invalid).push(key);
          }
        }
        if (missing.length === 0 && invalid.length === 0) {
          console.log(`  ✓ costBudget: limit=${budget!.limit}, maxPiCallCost=${budget!.maxPiCallCost}, maxCodexCallCost=${budget!.maxCodexCallCost}`);
        } else {
          console.log(`  ⚠ costBudget 不完整：${[...missing.map((k) => `${k}(缺失)`), ...invalid.map((k) => `${k}(非法)`)].join(', ')}。真实 Provider 调用前必须补齐。`);
        }
      } else if (budget) {
        console.log('  ○ costBudget: 已配置（当前为 fake/local-rule，真实调用前仍应复核）。');
      } else {
        console.log('  ○ costBudget: 未配置（当前为 fake/local-rule，无需真实预算）。');
      }
    }

    // ── dist completeness: tsc does not copy .sql migrations ──
    const srcSqlDir = resolve(projectRoot, 'src', 'state', 'migrations', 'sqlite');
    const distSqlDir = resolve(projectRoot, 'dist', 'state', 'migrations', 'sqlite');
    const srcCount = countSqlFiles(srcSqlDir);
    const distCount = countSqlFiles(distSqlDir);
    if (srcCount === 0) {
      console.log('  ○ dist completeness: 未在仓库内找到 src/state/migrations/sqlite（可能不是仓库根）。');
    } else if (distCount === srcCount) {
      console.log(`  ✓ dist .sql migrations: ${distCount}/${srcCount}（dist/state/migrations/sqlite 完整）`);
    } else {
      console.log(`  ✗ dist .sql migrations: ${distCount}/${srcCount}（tsc 不复制 .sql，请重新执行 npm run build 的 postbuild 复制步骤）`);
    }

    const sqliteConfig = readSqliteConfigFromEnv();
    console.log(`  ✓ SQLite path: ${sqliteConfig.path}`);
    console.log(`    database exists: ${existsSync(sqliteConfig.path) ? 'yes' : 'no'}`);
    if (existsSync(sqliteConfig.path)) {
      try {
        const store = SqliteStateStore.create(sqliteConfig.path);
        const runner = new SqliteMigrationRunner(sqliteConfig, store.getDatabase());
        const plan = runner.getPlan();
        console.log(`    migrations: ${plan.applied.length} applied, ${plan.pending.length} pending`);
        await store.close();
      } catch (err) {
        console.log(`  ○ SQLite status unavailable — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log('═'.repeat(50));
    if (major < 24 || major >= 25) process.exitCode = 1;
  });
