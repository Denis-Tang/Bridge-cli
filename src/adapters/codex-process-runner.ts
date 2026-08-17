// ── Codex CLI Process Runner — injectable abstraction for Codex CLI calls ──
// Allows fake injection for testing without real CLI.
// Supports optional tokenUsage metadata extraction for ledger integration.

import { spawn } from 'node:child_process';
import { buildMinimalSubprocessEnv } from '../privacy/env-allowlist.js';
import { resolveWindowsCliCommand } from './windows-cli-resolver.js';

export interface CodexProcessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  errorCategory?: 'timeout' | 'aborted' | 'max_buffer' | 'spawn_error' | 'nonzero_exit';
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
      signal?: AbortSignal;
    },
  ): Promise<CodexProcessRunResult>;
}

/**
 * RealCodexProcessRunner — asynchronous, shell-free Codex process execution.
 * Does NOT attempt to parse token usage from Codex CLI output (no structured metadata available).
 */
export class RealCodexProcessRunner implements CodexProcessRunner {
  async run(
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<CodexProcessRunResult> {
    const start = Date.now();
    const subprocessEnv = opts.env ?? buildMinimalSubprocessEnv();
    const resolvedCommand = resolveWindowsCliCommand(command, args, subprocessEnv);
    const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
    if (opts.signal?.aborted) {
      return { stdout: '', stderr: 'Codex process aborted before spawn', exitCode: 1, durationMs: 0, aborted: true, errorCategory: 'aborted' };
    }

    return new Promise<CodexProcessRunResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let bufferedBytes = 0;
      let terminalReason: 'timeout' | 'aborted' | 'max_buffer' | null = null;
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const child = spawn(resolvedCommand.command, resolvedCommand.args, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: subprocessEnv,
        shell: false,
      });

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        process.removeListener('exit', onParentExit);
      };
      const finish = (exitCode: number, fallbackError = '') => {
        if (settled) return;
        settled = true;
        cleanup();
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        let stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (!stderr && fallbackError) stderr = fallbackError;
        const errorCategory = terminalReason ?? (exitCode === 0 ? undefined : 'nonzero_exit');
        resolve({
          stdout,
          stderr,
          exitCode,
          durationMs: Date.now() - start,
          timedOut: terminalReason === 'timeout',
          aborted: terminalReason === 'aborted',
          errorCategory,
        });
      };
      const terminate = (reason: 'timeout' | 'aborted' | 'max_buffer') => {
        if (terminalReason || settled) return;
        terminalReason = reason;
        if (child.pid) {
          void terminateProcessTree(child.pid).finally(() => {
            if (!child.killed) child.kill('SIGKILL');
          });
        } else {
          finish(1, `Codex process ${reason}`);
        }
      };
      const capture = (target: Buffer[], chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (terminalReason === 'max_buffer') return;
        bufferedBytes += buffer.length;
        if (bufferedBytes > maxBuffer) {
          const remaining = Math.max(0, maxBuffer - (bufferedBytes - buffer.length));
          if (remaining > 0) target.push(buffer.subarray(0, remaining));
          stderrChunks.push(Buffer.from('\nCodex process output exceeded maxBuffer'));
          terminate('max_buffer');
          return;
        }
        target.push(buffer);
      };
      const onAbort = () => terminate('aborted');
      const onParentExit = () => { if (child.pid) child.kill('SIGKILL'); };

      child.stdout.on('data', (chunk) => capture(stdoutChunks, chunk));
      child.stderr.on('data', (chunk) => capture(stderrChunks, chunk));
      child.once('error', (error) => finish(1, error.message));
      child.once('close', (code) => finish(code ?? 1, terminalReason ? `Codex process ${terminalReason}` : ''));
      child.stdin.on('error', () => { /* child may close stdin before the write finishes */ });
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();

      opts.signal?.addEventListener('abort', onAbort, { once: true });
      process.once('exit', onParentExit);
      timer = setTimeout(() => terminate('timeout'), Math.max(1, opts.timeoutMs));
      timer.unref();
    });
  }
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, shell: false,
    });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

/**
 * Extract the expected taskId from a Codex review prompt.
 *
 * The review prompt's first line is:
 *   Review the following git diff for task ${taskId}.
 * Fall back to the example JSON field `"taskId": "${taskId}"` if needed.
 */
export function extractCodexReviewTaskId(input?: string): string | null {
  if (!input) return null;
  const firstLine = REVIEW_TASK_ID_FIRST_LINE_RE.exec(input);
  if (firstLine) return firstLine[1].trim();
  const jsonField = REVIEW_TASK_ID_JSON_RE.exec(input);
  if (jsonField) return jsonField[1];
  return null;
}

export interface CodexReviewMarkerPayload {
  taskId: string;
  status: 'approved' | 'rework_required';
  reviewSummary: string;
  findings: string[];
  requiredRework: string[];
  qualityGateStatus: 'passed' | 'failed';
  mergeAllowed: boolean;
}

/**
 * Serialize a strict Codex review marker block.
 */
export function formatCodexReviewResultMarker(result: CodexReviewMarkerPayload): string {
  return ['BEGIN_REVIEW_RESULT_JSON', JSON.stringify(result), 'END_REVIEW_RESULT_JSON'].join('\n');
}

/**
 * Build an approved Codex review marker for a task.
 */
export function formatApprovedCodexReviewMarker(taskId: string): string {
  return formatCodexReviewResultMarker({
    taskId,
    status: 'approved',
    reviewSummary: 'No issues found.',
    findings: [],
    requiredRework: [],
    qualityGateStatus: 'passed',
    mergeAllowed: true,
  });
}

/**
 * Build a rework-required Codex review marker for a task.
 */
export function formatReworkCodexReviewMarker(taskId: string, issue: string): string {
  return formatCodexReviewResultMarker({
    taskId,
    status: 'rework_required',
    reviewSummary: 'Review found required rework.',
    findings: [issue],
    requiredRework: [issue],
    qualityGateStatus: 'failed',
    mergeAllowed: false,
  });
}

const REVIEW_TASK_ID_FIRST_LINE_RE = /^Review the following git diff for task (.+)\.\r?$/m;
const REVIEW_TASK_ID_JSON_RE = /"taskId"\s*:\s*"([^"]+)"/;

/**
 * FakeCodexProcessRunner — for testing. Returns pre-configured results,
 * optionally including tokenUsage metadata for confirmed-actual ledger testing.
 */
export class FakeCodexProcessRunner implements CodexProcessRunner {
  private results: Map<string, CodexProcessRunResult> = new Map();
  private defaultResult: CodexProcessRunResult = {
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 100,
  };
  private defaultResultSet = false;

  setResultFor(command: string, args: string[], result: CodexProcessRunResult): void {
    this.results.set(`${command} ${args.join(' ')}`, result);
  }

  setDefaultResult(result: CodexProcessRunResult): void {
    this.defaultResult = result;
    this.defaultResultSet = true;
  }

  getDefaultResult(): CodexProcessRunResult {
    return this.defaultResult;
  }

  async run(
    command: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; input?: string; maxBuffer?: number; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<CodexProcessRunResult> {
    const key = `${command} ${args.join(' ')}`;
    const configured = this.results.get(key);
    if (configured) return { ...configured };
    if (this.defaultResultSet) return { ...this.defaultResult };

    // Fail closed instead of silently auto-approving a review prompt: an
    // unconfigured fake must not make missing test setup look like a successful
    // Codex review (which would hide regressions in failure/unavailable paths).
    return {
      stdout: '',
      stderr: 'fake codex runner: no result configured for this invocation',
      exitCode: 1,
      durationMs: 100,
    };
  }
}
