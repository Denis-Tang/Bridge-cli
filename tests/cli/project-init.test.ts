import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'brainctl-init-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  return root;
}

function runInit(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [tsxCli, 'src/cli/brainctl.ts', 'init', '--project', root, ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}

describe('brainctl init', () => {
  it('INIT-01 defaults to dry-run with zero writes', () => {
    const root = makeRepo();
    try {
      const result = runInit(root);
      expect(result.status).toBe(0);
      expect(existsSync(join(root, '.brainctl', 'project.json'))).toBe(false);
      expect(result.stdout).toContain('dry-run');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('INIT-02 apply creates config, repeat refuses, update does field-level merge and writes', () => {
    const root = makeRepo();
    try {
      expect(runInit(root, '--apply').status).toBe(0);
      const configPath = join(root, '.brainctl', 'project.json');
      expect(existsSync(configPath)).toBe(true);
      const first = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(first.projectRoot).toBe('.');
      const repeat = runInit(root, '--apply');
      expect(repeat.status).not.toBe(0);
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(first);
      const update = runInit(root, '--apply', '--update');
      expect(update.status).toBe(0);
      expect(update.stdout).toContain('diff');
      expect(update.stdout).toContain('脱敏');
      // After update, config should still have projectRoot="." and merged fields
      const afterUpdate = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(afterUpdate.projectRoot).toBe('.');
      expect(afterUpdate.schemaVersion).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('INIT-03 update preserves user-customized fields', () => {
    const root = makeRepo();
    try {
      runInit(root, '--apply');
      const configPath = join(root, '.brainctl', 'project.json');
      // Manually customize worker
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config.worker = { type: 'real-pi', command: 'pi', args: ['--mode', 'rpc', '--custom'], model: 'my-model', timeoutMs: 99999, maxConcurrency: 2 };
      writeFileSync(configPath, JSON.stringify(config));
      // Run update
      const update = runInit(root, '--apply', '--update');
      expect(update.status).toBe(0);
      const afterUpdate = JSON.parse(readFileSync(configPath, 'utf-8'));
      // User customizations preserved
      expect(afterUpdate.worker.type).toBe('real-pi');
      expect(afterUpdate.worker.args).toContain('--custom');
      expect(afterUpdate.worker.timeoutMs).toBe(99999);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('INIT-04 sensitive args are redacted in diff output', () => {
    const root = makeRepo();
    try {
      runInit(root, '--apply');
      const configPath = join(root, '.brainctl', 'project.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config.worker.args = ['--token', 'super-secret-value'];
      writeFileSync(configPath, JSON.stringify(config));
      const update = runInit(root, '--apply', '--update');
      expect(update.status).toBe(0);
      // Diff output should not contain the secret value
      expect(update.stdout).not.toContain('super-secret-value');
      expect(update.stdout).toContain('[REDACTED]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('INIT-05 env values are redacted in update diff output', () => {
    const root = makeRepo();
    try {
      runInit(root, '--apply');
      const configPath = join(root, '.brainctl', 'project.json');
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config.worker.env = {
        SAFE_LABEL: 'synthetic',
        PROVIDER_TOKEN: 'synthetic-env-secret-value',
      };
      writeFileSync(configPath, JSON.stringify(config));

      const update = runInit(root, '--apply', '--update');
      expect(update.status).toBe(0);
      expect(update.stdout).not.toContain('synthetic-env-secret-value');
      expect(update.stdout).not.toContain('"SAFE_LABEL": "synthetic"');
      expect(update.stdout).toContain('[REDACTED]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
