import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { suggestProjectConfig, defaults, type ProjectConfigFile } from '../../adapters/project-adapter.js';

function hasGitRepository(projectPath: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: projectPath, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── Sensitive-key detection for diff redaction ──────────────────────────

const REDACT_KEYWORDS = ['token', 'secret', 'password', 'passwd', 'api_key', 'apikey',
  'credential', 'auth', 'private_key', 'privatekey', 'access_key', 'accesskey'];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACT_KEYWORDS.some((kw) => lower.includes(kw));
}

function redactArg(arg: unknown): string {
  if (typeof arg !== 'string') return String(arg);
  if (isSensitiveKey(arg)) return '[REDACTED]';
  const eqIdx = arg.indexOf('=');
  if (eqIdx >= 0 && isSensitiveKey(arg.slice(0, eqIdx))) {
    return `${arg.slice(0, eqIdx + 1)}[REDACTED]`;
  }
  return arg;
}

function redactArray(args: unknown[]): string[] {
  return args.map(redactArg);
}

function redactConfigForDiff(obj: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 8) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'env') {
      out[k] = typeof v === 'object' && v !== null && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).map((name) => [name, '[REDACTED]']))
        : '[REDACTED]';
    } else if (k === 'args' && Array.isArray(v)) {
      out[k] = redactArray(v);
    } else if (k === 'command' || isSensitiveKey(k)) {
      out[k] = '[REDACTED]';
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === 'object' && item !== null
          ? redactConfigForDiff(item as Record<string, unknown>, depth + 1)
          : redactArg(item),
      );
    } else if (typeof v === 'object' && v !== null) {
      out[k] = redactConfigForDiff(v as Record<string, unknown>, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function printRedactedDiff(oldObj: Record<string, unknown>, newObj: Record<string, unknown>): void {
  const oldRedacted = redactConfigForDiff(oldObj);
  const newRedacted = redactConfigForDiff(newObj);
  console.log('  配置 diff（- 旧, + 新；敏感值已脱敏）:');
  for (const line of JSON.stringify(oldRedacted, null, 2).split(/\r?\n/)) {
    console.log(`  - ${line}`);
  }
  for (const line of JSON.stringify(newRedacted, null, 2).split(/\r?\n/)) {
    console.log(`  + ${line}`);
  }
}

// ── Field-level merge ───────────────────────────────────────────────────

const MERGEABLE_TOP_KEYS = new Set([
  'worker', 'reviewer', 'qualityGates', 'artifactRetention',
  'resourceSampling', 'forbiddenPaths', 'allowedPaths', 'sharedLocks',
]);

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...target };
  for (const [k, v] of Object.entries(source)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v) && typeof merged[k] === 'object' && merged[k] !== null && !Array.isArray(merged[k])) {
      merged[k] = deepMerge(merged[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function fieldLevelMerge(oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>): Record<string, unknown> {
  // Start with new config as base (ensures schemaVersion, projectId etc. are fresh)
  const merged = { ...newConfig };
  // For user-customizable sections, deep-merge: old user values win
  for (const key of MERGEABLE_TOP_KEYS) {
    if (oldConfig[key] !== undefined && typeof oldConfig[key] === 'object') {
      const newVal = newConfig[key];
      const oldVal = oldConfig[key];
      if (newVal === undefined || newVal === null) {
        merged[key] = oldVal;
      } else if (typeof newVal === 'object' && !Array.isArray(newVal)) {
        merged[key] = deepMerge(
          newVal as Record<string, unknown>,
          oldVal as Record<string, unknown>,
        );
      } else {
        // Arrays: preserve old if user customized (non-empty),
        // otherwise use new default
        const oldArr = Array.isArray(oldVal) ? oldVal : [];
        const newArr = Array.isArray(newVal) ? newVal : [];
        merged[key] = oldArr.length > 0 ? oldArr : newArr;
      }
    }
  }
  return merged;
}

// ── Atomic write ────────────────────────────────────────────────────────

function atomicWriteJson(configPath: string, data: unknown): void {
  const tmpPath = `${configPath}.tmp-${Date.now()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
  } catch (err) {
    // If wx fails (file exists), retry with a different suffix
    const retryPath = `${configPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(retryPath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
    // On Windows, rename can fail if target exists; delete first
    try { unlinkSync(configPath); } catch { /* ok */ }
    renameSync(retryPath, configPath);
    return;
  }
  try { unlinkSync(configPath); } catch { /* ok */ }
  renameSync(tmpPath, configPath);
}

// ── Command ─────────────────────────────────────────────────────────────

export const initCommand = new Command('init')
  .description('初始化目标项目接入配置（默认 dry-run；只有 --apply 才写入）')
  .requiredOption('--project <path>', '目标项目路径')
  .option('--apply', '创建 .brainctl/project.json')
  .option('--update', '与 --apply 联用，字段级合并更新已有配置，保留用户自定义')
  .action((options: { project: string; apply?: boolean; update?: boolean }) => {
    const projectPath = resolve(options.project);
    console.log('═'.repeat(50));
    console.log(`  brainctl init — 项目接入初始化${options.apply ? '' : ' (dry-run)'}`);
    console.log('═'.repeat(50));

    if (!existsSync(projectPath)) {
      console.log(`  ✗ 目标路径不存在: ${projectPath}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  ✓ 目标路径存在: ${projectPath}`);
    console.log(hasGitRepository(projectPath) ? '  ✓ 目标路径是 Git 仓库' : '  ⚠ 目标路径不是 Git 仓库（配置仍可预览）');

    const proposed = suggestProjectConfig(projectPath);
    // Write portable '.' for projectRoot in the saved config file
    const configForFile: Record<string, unknown> = { ...proposed, projectRoot: '.' } as unknown as Record<string, unknown>;
    const json = JSON.stringify(configForFile, null, 2) + '\n';
    const configDir = resolve(projectPath, '.brainctl');
    const configPath = resolve(configDir, 'project.json');
    const exists = existsSync(configPath);

    console.log(`  配置文件: ${configPath}`);
    console.log(`  当前分支建议: ${proposed.defaultBaseBranch || '(未探测到，将在运行时阻断并要求显式分支)'}`);
    console.log(`  质量门建议: ${proposed.qualityGates.task?.length ?? 0} 个 task / ${proposed.qualityGates.stage?.length ?? 0} 个 stage`);
    console.log('  .gitignore 建议: 将 .brainctl-dev/ 加入目标项目 .gitignore（本命令不自动修改）');
    console.log('  配置便携性: projectRoot 保存为 "."，加载时相对于配置文件目录解析');

    if (!options.apply) {
      console.log('\n  预览配置（敏感值已脱敏）:');
      const redactedForDisplay = redactConfigForDiff(configForFile);
      console.log(JSON.stringify(redactedForDisplay, null, 2));
      console.log('  ⚠ dry-run 未写入任何文件。需要写入时使用 --apply。');
      console.log('═'.repeat(50));
      return;
    }

    if (exists && !options.update) {
      console.log('  ✗ 配置已存在；默认拒绝覆盖。请先审阅后使用 --apply --update。');
      process.exitCode = 1;
      return;
    }

    if (exists) {
      let oldConfig: Record<string, unknown>;
      try {
        oldConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch {
        console.log('  ✗ 无法解析已有配置，拒绝覆盖。');
        process.exitCode = 1;
        return;
      }
      // Field-level merge: preserve user customizations
      const merged = fieldLevelMerge(oldConfig, configForFile);
      printRedactedDiff(oldConfig, merged);
      mkdirSync(configDir, { recursive: true });
      atomicWriteJson(configPath, merged);
      console.log(`  ✓ 已字段级合并更新: ${configPath}`);
      console.log('  ℹ 用户自定义 worker/reviewer/gates/retention 已保留，仅缺失键采用新默认值。');
    } else {
      console.log('  + 将创建新的 .brainctl/project.json');
      mkdirSync(configDir, { recursive: true });
      atomicWriteJson(configPath, configForFile);
      console.log(`  ✓ 已写入: ${configPath}`);
    }
    console.log('═'.repeat(50));
  });
