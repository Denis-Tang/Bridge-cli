// ── Codex CLI Process Runner — injectable abstraction for Codex CLI calls ──
// Allows fake injection for testing without real CLI.
// Supports optional tokenUsage metadata extraction for ledger integration.

import { execFileSync } from 'node:child_process';
import { buildMinimalSubprocessEnv } from '../privacy/env-allowlist.js';
import { resolveWindowsCliCommand } from './windows-cli-resolver.js';

export interface CodexProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  /** Optional structured token usage metadata from the provider (if available) */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens?: number;
  };
}

export interface CodexProcessRunner {
  run(
    command: string,
    args: string[],
    opts: {
      cwd: string;
      timeoutMs: number;
      input?: string;
      maxBuffer?: number;
      env?: Record<string, string>;
    },
  ): Promise<CodexProcessRunResult>;
}

/**
 * RealCodexProcessRunner — wraps Node's execSync for production use.
 * Does NOT attempt to parse token usage from Codex CLI output (no structured metadata available).
 */
export class RealCodexProcessRunner implements CodexProcessRunner {
  async run(
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string> },
  ): Promise<CodexProcessRunResult> {
    const start = Date.now();
    try {
      const subprocessEnv = opts.env ?? buildMinimalSubprocessEnv();
      const resolvedCommand = resolveWindowsCliCommand(command, args, subprocessEnv);
      const stdout = execFileSync(resolvedCommand.command, resolvedCommand.args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        input: opts.input,
        maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
        encoding: 'utf-8',
        stdio: 'pipe',
        windowsHide: true,
        env: subprocessEnv,
      });
      return {
        stdout: String(stdout),
        stderr: '',
        exitCode: 0,
        durationMs: Date.now() - start,
        timedOut: false,
      };
    } catch (err: any) {
      return {
        stdout: err.stdout ? String(err.stdout) : '',
        stderr: err.stderr ? String(err.stderr) : err.message || String(err),
        exitCode: err.status || 1,
        durationMs: Date.now() - start,
        timedOut: err.code === 'ETIMEDOUT' || (err.status == null && err.signal === 'SIGTERM'),
      };
    }
  }
}

/**
 * FakeCodexProcessRunner — for testing. Returns pre-configured results,
 * optionally including tokenUsage metadata for confirmed-actual ledger testing.
 */
export class FakeCodexProcessRunner implements CodexProcessRunner {
  private results: Map<string, CodexProcessRunResult> = new Map();
  private defaultResult: CodexProcessRunResult = {
    stdout: 'fake codex output',
    stderr: '',
    exitCode: 0,
    durationMs: 100,
  };

  setResultFor(command: string, args: string[], result: CodexProcessRunResult): void {
    this.results.set(`${command} ${args.join(' ')}`, result);
  }

  setDefaultResult(result: CodexProcessRunResult): void {
    this.defaultResult = result;
  }

  getDefaultResult(): CodexProcessRunResult {
    return this.defaultResult;
  }

  async run(
    command: string,
    args: string[],
    _opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string> },
  ): Promise<CodexProcessRunResult> {
    const key = `${command} ${args.join(' ')}`;
    return this.results.get(key) ?? { ...this.defaultResult };
  }
}
