import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  .description('只读检查 Node.js、node:sqlite、Git、Pi、Codex、项目配置与质量门')
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
    console.log(`  ${major >= 24 && major < 25 ? '✓' : '✗'} Node.js: v${version}（支持区间: >=24.0.0 <25.0.0）`);

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
