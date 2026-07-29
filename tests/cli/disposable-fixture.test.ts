import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function makeFixture(kind: 'node' | 'custom'): string {
  const disposableParent = join(tmpdir(), '.brainctl-dev');
  mkdirSync(disposableParent, { recursive: true });
  const root = mkdtempSync(join(disposableParent, `brainctl-${kind}-fixture-`));
  mkdirSync(join(root, '.brainctl'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf-8' }).trim();
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  if (kind === 'node') {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
      schemaVersion: 1, projectId: 'node-fixture', projectRoot: root, defaultBaseBranch: branch,
      qualityGates: { task: [{ name: 'node-test', command: 'npm', args: ['test'], cwd: '.', timeoutMs: 30000 }], stage: [] },
    }));
  } else {
    writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
      schemaVersion: 1, projectId: 'custom-fixture', projectRoot: root, defaultBaseBranch: branch,
      qualityGates: { task: [{ name: 'custom-node-check', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', timeoutMs: 30000 }], stage: [] },
    }));
  }
  writeFileSync(join(root, 'README.md'), `# ${kind}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

function runFixture(root: string, file: string) {
  return spawnSync(process.execPath, [tsxCli, 'src/cli/brainctl.ts', 'submit', 'write demo result', '--project', root, '--local-run', '--demo-fixture', '--demo-file', file], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 120000,
  });
}

describe('disposable project adapters', () => {
  it('GATE-01 and DEMO-01 complete Node and non-npm custom configured gates', () => {
    const nodeRoot = makeFixture('node');
    const customRoot = makeFixture('custom');
    try {
      const nodeResult = runFixture(nodeRoot, 'artifacts/node-result.txt');
      const customResult = runFixture(customRoot, 'artifacts/custom-result.txt');
      expect(nodeResult.status, nodeResult.stderr || nodeResult.stdout).toBe(0);
      expect(customResult.status, customResult.stderr || customResult.stdout).toBe(0);
      expect(existsSync(join(nodeRoot, 'artifacts', 'node-result.txt'))).toBe(true);
      expect(existsSync(join(customRoot, 'artifacts', 'custom-result.txt'))).toBe(true);
      expect(readFileSync(join(nodeRoot, 'artifacts', 'node-result.txt'), 'utf-8')).toContain('write demo result');
    } finally {
      rmSync(nodeRoot, { recursive: true, force: true });
      rmSync(customRoot, { recursive: true, force: true });
    }
  });
});
