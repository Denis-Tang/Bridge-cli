import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { RealCodexProcessRunner } from '../../src/adapters/codex-process-runner.js';

const runner = new RealCodexProcessRunner();

describe('RealCodexProcessRunner async process safety', () => {
  it('keeps the event loop responsive and captures stdin/stdout/stderr', async () => {
    let ticked = false;
    setTimeout(() => { ticked = true; }, 20);
    const result = await runner.run(process.execPath, ['-e', `
      let input=''; process.stdin.on('data', c => input += c);
      process.stdin.on('end', () => setTimeout(() => {
        process.stdout.write('OUT:' + input); process.stderr.write('ERR');
      }, 80));
    `], { cwd: process.cwd(), timeoutMs: 2_000, input: 'hello' });
    expect(ticked).toBe(true);
    expect(result).toMatchObject({ stdout: 'OUT:hello', stderr: 'ERR', exitCode: 0, timedOut: false });
  });

  it('classifies non-zero exit, timeout, cancellation, and live max-buffer overflow', async () => {
    const nonzero = await runner.run(process.execPath, ['-e', "process.stderr.write('bad');process.exit(7)"], {
      cwd: process.cwd(), timeoutMs: 2_000,
    });
    expect(nonzero).toMatchObject({ exitCode: 7, stderr: 'bad', errorCategory: 'nonzero_exit' });

    const timedOut = await runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(), timeoutMs: 80,
    });
    expect(timedOut).toMatchObject({ timedOut: true, errorCategory: 'timeout' });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const aborted = await runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(), timeoutMs: 2_000, signal: controller.signal,
    });
    expect(aborted).toMatchObject({ aborted: true, errorCategory: 'aborted' });

    const overflow = await runner.run(process.execPath, ['-e', "process.stdout.write('x'.repeat(200000));setInterval(()=>{},1000)"], {
      cwd: process.cwd(), timeoutMs: 2_000, maxBuffer: 1_024,
    });
    expect(overflow.errorCategory).toBe('max_buffer');
    expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(1_024);
  });

  it.runIf(process.platform === 'win32')('terminates a real synthetic child + grandchild tree with no Codex spawn', async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const grand = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
      process.stdout.write(JSON.stringify({ child: process.pid, grand: grand.pid }) + '\\n');
      setInterval(()=>{},1000);
    `;
    const result = await runner.run(process.execPath, ['-e', script], {
      cwd: process.cwd(), timeoutMs: 180,
    });
    expect(result.errorCategory).toBe('timeout');
    const pids = JSON.parse(result.stdout.trim().split('\n')[0]) as { child: number; grand: number };
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isWindowsPidAlive(pids.child)).toBe(false);
    expect(isWindowsPidAlive(pids.grand)).toBe(false);
  });
});

function isWindowsPidAlive(pid: number): boolean {
  try {
    const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true,
    });
    return output.includes(`"${pid}"`);
  } catch {
    return false;
  }
}
