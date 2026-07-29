import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWindowsCliCommand } from '../../src/adapters/windows-cli-resolver.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(name: string): string {
  const root = path.join(tmpdir(), `bridge-cli-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

describe('resolveWindowsCliCommand', () => {
  it('prefers a native exe without changing the argument vector', () => {
    const root = tempRoot('exe');
    const exe = path.join(root, 'codex.exe');
    writeFileSync(exe, 'synthetic');
    const resolved = resolveWindowsCliCommand('codex', ['exec', '-'], { PATH: root }, 'win32');
    expect(resolved).toEqual({ command: exe, args: ['exec', '-'], source: 'native-exe' });
  });

  it('parses an npm cmd shim into node plus a local JS entry without a shell', () => {
    const root = tempRoot('shim');
    const entry = path.join(root, 'node_modules', 'example-cli', 'dist', 'cli.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'console.log("ok")');
    writeFileSync(path.join(root, 'pi.cmd'), [
      '@ECHO off',
      'SET dp0=%~dp0',
      '"%_prog%" "%dp0%\\node_modules\\example-cli\\dist\\cli.js" %*',
    ].join('\r\n'));

    const resolved = resolveWindowsCliCommand('pi', ['--mode', 'rpc'], { PATH: root }, 'win32');
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual([entry, '--mode', 'rpc']);
    expect(resolved.source).toBe('npm-shim');
  });

  it('respects PATH order so an npm shim can precede an inaccessible later exe', () => {
    const shimRoot = tempRoot('ordered-shim');
    const exeRoot = tempRoot('ordered-exe');
    const entry = path.join(shimRoot, 'node_modules', 'example-cli', 'cli.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, 'console.log("ok")');
    writeFileSync(path.join(shimRoot, 'codex.cmd'), '"%_prog%" "%dp0%\\node_modules\\example-cli\\cli.js" %*');
    writeFileSync(path.join(exeRoot, 'codex.exe'), 'synthetic inaccessible app alias');

    const resolved = resolveWindowsCliCommand('codex', ['--version'], { PATH: `${shimRoot};${exeRoot}` }, 'win32');
    expect(resolved.source).toBe('npm-shim');
    expect(resolved.args).toEqual([entry, '--version']);
  });

  it('leaves unknown commands unchanged so the caller receives the real spawn error', () => {
    expect(resolveWindowsCliCommand('missing-cli', ['--version'], { PATH: '' }, 'win32'))
      .toEqual({ command: 'missing-cli', args: ['--version'], source: 'unchanged' });
  });
});
