import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ProjectAdapter, defaults, detectBranch, resolveProjectPath, suggestProjectConfig } from '../../src/adapters/project-adapter.js';
import { resolveConfig } from '../../src/core/config-resolver.js';
import { createExecutionConfigSnapshot, deserializeExecutionConfigSnapshot } from '../../src/core/config-snapshot.js';
import { PortableNoopResourceSampler } from '../../src/core/resource-sampler.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'brainctl-config-'));
  mkdirSync(join(root, '.brainctl'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  return root;
}

describe('ProjectAdapter and universal configuration', () => {
  it('CONFIG-01 loads a valid project config and detects the current branch', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }));
      const suggested = suggestProjectConfig(root);
      // Schema now requires a non-empty allowedPaths (fail closed); a suggested
      // config must carry an explicit write scope to be loadable.
      suggested.allowedPaths = ['src/'];
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify(suggested));
      const loaded = new ProjectAdapter().load(root);
      expect(loaded.projectId).toBeTruthy();
      expect(loaded.defaultBaseBranch).toBe(detectBranch(root));
      expect(loaded.qualityGates.task?.[0].args).toEqual(['test']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CONFIG-01B rejects an empty allowedPaths at schema level (fail closed)', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1, projectId: 'x', projectRoot: root,
        allowedPaths: [],
      }));
      expect(() => new ProjectAdapter().load(root)).toThrow(/allowedPaths/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REVIEWER-01 codex-cli reviewer without --sandbox read-only is rejected at startup', () => {
    const root = fixture();
    try {
      const project = defaults(root);
      project.reviewer = { ...project.reviewer, type: 'codex-cli', args: ['exec', '--ephemeral', '-'] };
      expect(() => resolveConfig({ projectConfig: project, detectedBranch: 'main' })).toThrow(/--sandbox read-only/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REVIEWER-02 codex-cli reviewer with --sandbox read-only passes', () => {
    const root = fixture();
    try {
      const project = defaults(root);
      project.reviewer = { ...project.reviewer, type: 'codex-cli', args: ['exec', '--ephemeral', '--sandbox', 'read-only', '-'] };
      const resolved = resolveConfig({ projectConfig: project, detectedBranch: 'main' });
      expect(resolved.reviewer.type).toBe('codex-cli');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('REVIEWER-03 non-codex-cli reviewers are not sandbox-gated', () => {
    const root = fixture();
    try {
      const project = defaults(root);
      project.reviewer = { ...project.reviewer, type: 'local-rule', args: ['anything'] };
      expect(() => resolveConfig({ projectConfig: project, detectedBranch: 'main' })).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CONFIG-02 rejects unknown fields, path escape, and empty commands with field-specific errors', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1, projectId: 'x', projectRoot: root, unknown: true,
      }));
      expect(() => new ProjectAdapter().load(root)).toThrow(/unknown/);

      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1, projectId: 'x', projectRoot: root,
        qualityGates: { task: [{ name: 'bad', command: '', args: [], cwd: '../outside' }] },
      }));
      expect(() => new ProjectAdapter().load(root)).toThrow(/qualityGates\.task/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CONFIG-03 applies CLI > run snapshot > project > defaults', () => {
    const root = fixture();
    try {
      const project = defaults(root);
      project.defaultBaseBranch = 'project-branch';
      const snapshot = {
        targetBranch: 'snapshot-branch',
        executionMode: 'simple' as const,
        worker: { ...project.worker, type: 'real-pi' as const, model: 'snapshot-model' },
        maxParallelTasks: 2,
      };
      const resolved = resolveConfig({
        projectConfig: project,
        snapshot,
        detectedBranch: 'detected-branch',
        cliOverrides: { targetBranch: 'cli-branch', worker: 'fake', maxParallelTasks: 3, executionMode: 'default' },
      });
      expect(resolved.targetBranch).toBe('cli-branch');
      expect(resolved.worker.type).toBe('fake');
      expect(resolved.worker.model).toBe('snapshot-model');
      expect(resolved.maxParallelTasks).toBe(3);
      expect(resolved.executionMode).toBe('default');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RESUME-01 snapshot is versioned and redacts credential-like arguments', () => {
    const root = fixture();
    try {
      const config = defaults(root);
      config.worker.args = ['--token', 'super-secret', 'API_KEY=also-secret'];
      const serialized = createExecutionConfigSnapshot(resolveConfig({ projectConfig: config, detectedBranch: 'main' }));
      expect(serialized).not.toContain('super-secret');
      expect(serialized).not.toContain('also-secret');
      expect(deserializeExecutionConfigSnapshot(serialized)?.snapshotVersion).toBe(1);
      expect(deserializeExecutionConfigSnapshot(serialized)?.config.executionMode).toBe('token-efficient');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PLATFORM-01 portable sampler explicitly degrades without fake measurements', async () => {
    const sample = await new PortableNoopResourceSampler().sample();
    expect(sample.source).toBe('portable_noop');
    expect(sample.degraded).toBe(true);
    expect(sample.cpu.cores).toBe(0);
  });

  it('PORTABLE-01 config with projectRoot="." resolves to config file dir', () => {
    const root = fixture();
    try {
      // Write a config with portable projectRoot
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1,
        projectId: 'test-portable',
        projectRoot: '.',
        defaultBaseBranch: 'main',
      }));
      const loaded = new ProjectAdapter().load(root);
      // projectRoot should resolve to the actual project path, not literal '.'
      expect(loaded.projectRoot).toBe(root);
      expect(loaded.projectId).toBe('test-portable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PORTABLE-01B relative path resolution requires an explicit trusted base', () => {
    const root = fixture();
    try {
      expect(() => resolveProjectPath('relative-project')).toThrow(/base directory/i);
      expect(resolveProjectPath('relative-project', root)).toBe(resolve(root, 'relative-project'));
      expect(resolveProjectPath('.', root)).toBe(resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PORTABLE-02 config with absolute projectRoot still works (backward compat)', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1,
        projectId: 'test-abs',
        projectRoot: root,
        defaultBaseBranch: 'main',
      }));
      const loaded = new ProjectAdapter().load(root);
      expect(loaded.projectRoot).toBe(root);
      expect(loaded.projectId).toBe('test-abs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PORTABLE-03 unsupported worker type fails closed', () => {
    const root = fixture();
    try {
      const config = defaults(root);
      // Try to pick an unsupported worker type
      expect(() => resolveConfig({
        projectConfig: config,
        cliOverrides: { worker: 'codex-cli' },
      })).toThrow(/Unsupported worker type/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PORTABLE-04 unsupported reviewer type fails closed', () => {
    const root = fixture();
    try {
      const config = defaults(root);
      expect(() => resolveConfig({
        projectConfig: config,
        cliOverrides: { reviewer: 'codex' },
      })).toThrow(/Unsupported reviewer type/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PORTABLE-05 portable config moved with project remains valid', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1,
        projectId: 'test-portable-move',
        projectRoot: '.',
        defaultBaseBranch: 'main',
      }));
      // Load from root — should resolve projectRoot to root
      const first = new ProjectAdapter().load(root);
      expect(first.projectRoot).toBe(root);
      // Simulate moving: create new dir and symlink the config
      const root2 = mkdtempSync(join(tmpdir(), 'brainctl-moved-'));
      try {
        mkdirSync(join(root2, '.brainctl'), { recursive: true });
        writeFileSync(join(root2, '.brainctl', 'project.json'), JSON.stringify({
          schemaVersion: 1,
          projectId: 'test-portable-move',
          projectRoot: '.',
          defaultBaseBranch: 'main',
        }));
        const second = new ProjectAdapter().load(root2);
        expect(second.projectRoot).toBe(root2);
      } finally {
        rmSync(root2, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PORTABLE-06 unsupported worker type in schema fails closed', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1,
        projectId: 'test',
        projectRoot: root,
        defaultBaseBranch: 'main',
        worker: { type: 'codex-cli' },
      }));
      expect(() => new ProjectAdapter().load(root)).toThrow(/worker/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('PORTABLE-07 unsupported reviewer type in schema fails closed', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, '.brainctl', 'project.json'), JSON.stringify({
        schemaVersion: 1,
        projectId: 'test',
        projectRoot: root,
        defaultBaseBranch: 'main',
        reviewer: { type: 'fake' },
      }));
      expect(() => new ProjectAdapter().load(root)).toThrow(/reviewer/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
