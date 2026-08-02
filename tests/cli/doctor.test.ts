import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectBridgeRepositoryIdentity } from '../../src/cli/commands/doctor.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bridge-doctor-identity-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('doctor Bridge repository identity', () => {
  it('accepts the formal bridge-orchestrator package identity', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bridge-orchestrator' }), 'utf8');

    expect(inspectBridgeRepositoryIdentity(root)).toEqual({
      ok: true,
      packageName: 'bridge-orchestrator',
      warning: null,
    });
  });

  it('warns explicitly when the package name belongs to another checkout', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'codex-brain-pi-orchestrator' }), 'utf8');

    const result = inspectBridgeRepositoryIdentity(root);
    expect(result.ok).toBe(false);
    expect(result.packageName).toBe('codex-brain-pi-orchestrator');
    expect(result.warning).toContain('当前目录不是 Bridge 正式仓库');
  });

  it('fails closed when package.json is missing or unreadable', () => {
    const result = inspectBridgeRepositoryIdentity(tempRoot());
    expect(result.ok).toBe(false);
    expect(result.packageName).toBeNull();
    expect(result.warning).toContain('当前目录不是 Bridge 正式仓库');
  });
});
