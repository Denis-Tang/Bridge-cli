import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PiWorkerConfig, PiWorkerTaskInput, PiWorkerExecutionResult, PiProviderUsage, ProcessRunner, ProcessRunInput, ProcessRunResult, ProcessEarlyCompletion } from './pi-worker-types.js';
import type { WorkerResult } from '../types/protocol.js';
import type { LedgerSink, InvocationContext } from '../core/token-telemetry.js';
import { estimateForCallType } from '../core/token-telemetry.js';
import { buildPiWorkerPrompt } from './pi-worker-prompt.js';
import { parseWorkerResult } from './pi-worker-result-parser.js';
import { sanitizeLogContent } from '../privacy/sanitizer.js';
import { buildMinimalSubprocessEnv } from '../privacy/env-allowlist.js';
import {
  appendClarificationTranscriptToWorkerPrompt,
  buildPiClarificationPrompt,
  clarificationPauseResult,
  isReadyToImplement,
  parsePiClarification,
  requiresUserDecision,
  type ClarificationTranscriptEntry,
} from './pi-clarification.js';
import { resolveWindowsCliCommand } from './windows-cli-resolver.js';

type JsonRecord = Record<string, unknown>;

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageFromMessage(value: unknown): PiProviderUsage | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as JsonRecord;
  if (message.role !== 'assistant' || !message.usage || typeof message.usage !== 'object') return null;
  const usage = message.usage as JsonRecord;
  const inputTokens = finiteNonNegative(usage.input);
  const outputTokens = finiteNonNegative(usage.output);
  const cacheReadTokens = finiteNonNegative(usage.cacheRead);
  const cacheWriteTokens = finiteNonNegative(usage.cacheWrite);
  const computedTotal = inputTokens + outputTokens;
  const reportedTotal = finiteNonNegative(usage.totalTokens);
  const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost as JsonRecord : {};
  const costTotal = finiteNonNegative(cost.total);
  if (reportedTotal === 0 && computedTotal === 0 && costTotal === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : computedTotal,
    costTotal,
  };
}

function sumUsage(items: PiProviderUsage[]): PiProviderUsage | null {
  if (items.length === 0) return null;
  return items.reduce<PiProviderUsage>((sum, item) => ({
    inputTokens: sum.inputTokens + item.inputTokens,
    outputTokens: sum.outputTokens + item.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + item.cacheWriteTokens,
    totalTokens: sum.totalTokens + item.totalTokens,
    costTotal: sum.costTotal + item.costTotal,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costTotal: 0 });
}

export async function cleanupTemporaryPiSession(sessionRoot: string): Promise<boolean> {
  const delays = [25, 75, 200, 500, 1000];
  for (const delayMs of delays) {
    try {
      rmSync(sessionRoot, { recursive: true, force: true });
    } catch {
      // Retry after processes and antivirus release handles.
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
    if (!existsSync(sessionRoot)) return true;
  }
  try {
    rmSync(sessionRoot, { recursive: true, force: true });
  } catch {
    // The caller records the unresolved residue without exposing session content.
  }
  return !existsSync(sessionRoot);
}

/**
 * Extract authoritative numeric usage from Pi JSONL without retaining provider text.
 * agent_end is a complete snapshot and may repeat earlier message_end events, so the
 * largest final snapshot wins instead of double-counting streamed duplicates.
 */
export function parsePiProviderUsageFromJsonl(output: string): PiProviderUsage | null {
  const finalSnapshots: PiProviderUsage[] = [];
  const completedMessages = new Map<string, PiProviderUsage>();

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      event = parsed as JsonRecord;
    } catch {
      continue;
    }

    if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      const snapshot = sumUsage(event.messages.map(usageFromMessage).filter((item): item is PiProviderUsage => item !== null));
      if (snapshot) finalSnapshots.push(snapshot);
      continue;
    }

    if (event.type === 'message_end') {
      const usage = usageFromMessage(event.message);
      if (usage) {
        const message = event.message as JsonRecord;
        const identity = typeof message.id === 'string'
          ? `id:${message.id}`
          : JSON.stringify([message.timestamp ?? null, message.model ?? null, usage]);
        completedMessages.set(identity, usage);
      }
    }
  }

  if (finalSnapshots.length > 0) {
    return finalSnapshots.reduce((best, item) => item.totalTokens > best.totalTokens ? item : best);
  }
  return sumUsage([...completedMessages.values()]);
}

/**
 * Real process runner using Node child_process.spawn.
 */
export class RealProcessRunner implements ProcessRunner {
  async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    const startTime = Date.now();
    const resolvedCommand = resolveWindowsCliCommand(input.command, input.args, input.env ?? buildMinimalSubprocessEnv());
    const child = spawn(resolvedCommand.command, resolvedCommand.args, {
      cwd: input.cwd,
      env: input.env ?? buildMinimalSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let terminatedAfterWorkerResult = false;
    let terminationStarted = false;
    const childPid = child.pid ?? null;

    if (childPid != null && input.onSpawn) {
      await Promise.resolve(input.onSpawn(childPid));
    }

    // Write stdin if provided. Do NOT close stdin immediately — Pi RPC mode
    // needs stdin to stay open for the duration of processing.
    if (input.stdin && child.stdin) {
      child.stdin.write(input.stdin);
    }

    // Helper to check for early completion on accumulated output
    const checkEarlyComplete = (accStdout: string, _accStderr: string): boolean => {
      if (input.onStdoutChunk) {
        const signal = input.onStdoutChunk('', accStdout);
        if (signal && signal.terminateProcess) {
          terminatedAfterWorkerResult = true;
          return true;
        }
      }
      return false;
    };

    // Collect stdout
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8');
      stdout += chunk;
      // Check for early completion after each chunk
      if (checkEarlyComplete(stdout, stderr)) {
        terminateTree('SIGTERM');
      }
      // Also call per-chunk callback if provided
      if (input.onStdoutChunk) {
        const signal = input.onStdoutChunk(chunk, stdout);
        if (signal && signal.terminateProcess) {
          terminatedAfterWorkerResult = true;
          terminateTree('SIGTERM');
        }
      }
    });

    // Collect stderr
    child.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8');
      stderr += chunk;
    });

    const terminateTree = (signal: NodeJS.Signals = 'SIGTERM') => {
      if (terminationStarted) return;
      terminationStarted = true;
      if (childPid == null) return;
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(-childPid, signal);
        }
      } catch {
        try { child.kill(signal); } catch { /* ignore */ }
      }
      setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore' });
          } else {
            process.kill(-childPid, 'SIGKILL');
          }
        } catch {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 3000).unref();
    };

    // Timeout handling
    const timeoutId = setTimeout(() => {
      timedOut = true;
      terminateTree('SIGTERM');
    }, input.timeoutMs);
    input.signal?.addEventListener('abort', () => {
      aborted = true;
      terminateTree('SIGTERM');
    }, { once: true });

    return new Promise<ProcessRunResult>((resolvePromise) => {
      child.on('close', (exitCode) => {
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;
        resolvePromise({
          pid: childPid,
          exitCode,
          stdout,
          stderr,
          timedOut,
          aborted,
          terminatedAfterWorkerResult,
          durationMs,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;
        stderr += `\nProcess error: ${err.message}`;
        resolvePromise({
          pid: childPid,
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          aborted,
          terminatedAfterWorkerResult,
          durationMs,
        });
      });
    });
  }
}

/**
 * Fake process runner for testing, returns configurable results.
 */
export class FakeProcessRunner implements ProcessRunner {
  private results: Map<string, ProcessRunResult> = new Map();
  private defaultResult?: ProcessRunResult;

  /**
   * Register a result for a specific command pattern.
   */
  setResult(command: string, result: ProcessRunResult): void {
    this.results.set(command, result);
  }

  /**
   * Set a default result for any unmatched command.
   */
  setDefaultResult(result: ProcessRunResult): void {
    this.defaultResult = result;
  }

  async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    const key = `${input.command} ${input.args.join(' ')}`;
    const result = this.results.get(key) ?? this.defaultResult;
    if (result?.pid != null && input.onSpawn) {
      await Promise.resolve(input.onSpawn(result.pid));
    }
    if (!result) {
      return {
        pid: null,
        exitCode: 1,
        stdout: '',
        stderr: `No fake result configured for command: ${key}`,
        timedOut: false,
        aborted: false,
        terminatedAfterWorkerResult: false,
        durationMs: 0,
      };
    }
    return { ...result };
  }
}

/**
 * Pi RPC Worker Adapter.
 * Manages Pi subprocess execution with timeout, abort, logging, and result parsing.
 *
 * M4: Accepts optional LedgerSink + InvocationContext for token telemetry.
 * Governance OFF → no Sink → no ledger writes.
 */
export class PiRpcWorker {
  private config: PiWorkerConfig;
  private processRunner: ProcessRunner;
  private abortController: AbortController | null = null;
  private _currentRun: Promise<PiWorkerExecutionResult> | null = null;
  private ledgerSink: LedgerSink | null;
  private invocationContext: InvocationContext | null;

  constructor(
    config: PiWorkerConfig,
    processRunner?: ProcessRunner,
    options?: {
      ledgerSink?: LedgerSink | null;
      invocationContext?: InvocationContext | null;
    },
  ) {
    const defaults = {
      command: 'pi',
      args: ['--mode', 'rpc', '--no-session'],
      model: undefined,
      timeoutMs: 120000,
      allowRealPiExecution: false,
      requireClarification: false,
    };
    this.config = { ...defaults, ...config };
    this.processRunner = processRunner ?? new RealProcessRunner();
    this.abortController = null;
    this.ledgerSink = options?.ledgerSink ?? null;
    this.invocationContext = options?.invocationContext ?? null;
  }

  /**
   * Set a ledger sink for token telemetry (M4 governance).
   * Returns this for chaining.
   */
  withLedger(sink: LedgerSink | null, ctx: InvocationContext | null): this {
    this.ledgerSink = sink;
    this.invocationContext = ctx;
    return this;
  }

  /**
   * Execute a task on Pi Worker.
   */
  async executeTask(input: PiWorkerTaskInput): Promise<PiWorkerExecutionResult> {
    this.abortController = new AbortController();

    // Ensure session directory exists
    mkdirSync(this.config.sessionDirectory, { recursive: true });

    // Build the prompt
    const prompt = buildPiWorkerPrompt({ taskSpec: input.taskSpec });

    // Safe/mock mode leaves a prompt artifact for manual inspection. Real mode
    // sends it only over stdin and persists numeric/hash metadata, never text.
    const promptPath = resolve(this.config.sessionDirectory, `${input.taskSpec.taskId}_prompt.txt`);
    if (!this.config.allowRealPiExecution) {
      writeFileSync(promptPath, prompt, 'utf-8');
    }

    // Initialize log file
    const promptLog = this.config.allowRealPiExecution
      ? `Prompt metadata: length=${prompt.length}, sha256=${createHash('sha256').update(prompt).digest('hex')}`
      : `Prompt (redacted):\n${sanitizeLogContent(prompt)}`;
    const logLines: string[] = [
      `=== Pi Worker Execution Log ===`,
      `Worker ID: ${this.config.workerId}`,
      `Task ID: ${input.taskSpec.taskId}`,
      `Run ID: ${input.runId}`,
      `Worktree: ${sanitizeLogContent(input.worktreePath)}`,
      `Started at: ${new Date().toISOString()}`,
      `Timeout: ${this.config.timeoutMs}ms`,
      `---`,
      promptLog,
      `---`,
      `Output:`,
    ];
    this.writeLog(logLines.join('\n'));

    // ── M4: Write estimate BEFORE calling external process ──
    let entryId: string | null = null;
    const ctx = this.invocationContext;
    const sink = this.ledgerSink;
    if (sink && ctx) {
      const est = estimateForCallType('pi_worker', {
        goalLength: input.taskSpec.goal.length,
        pathCount: input.taskSpec.allowedPaths?.length || 0,
      });
      try {
        entryId = await sink.writeEstimate(ctx, est.total, est.input, est.output, prompt);
      } catch {
        // Sink failure must not change business semantics
      }
    }

    this._currentRun = this.config.requireClarification
      ? this.runWithClarification(input, prompt)
      : this.runInternal(input, prompt);
    const result = await this._currentRun;

    // ── M4: Update ledger entry after call ──
    if (sink && entryId) {
      const providerUsage = result.providerUsage;
      if (providerUsage) {
        // Provider-backed Pi JSONL usage is authoritative; never trust agent self-report.
        try {
          await sink.confirmActual(
            entryId,
            providerUsage.totalTokens,
            providerUsage.inputTokens,
            providerUsage.outputTokens,
            providerUsage.cacheReadTokens,
          );
        } catch { /* sink failure must not change semantics */ }
      } else {
        // No reliable usage metadata → unavailable (preserves estimate)
        try {
          await sink.markUnavailable(entryId);
        } catch { /* sink failure must not change semantics */ }
      }
    }

    return result;
  }

  /**
   * Abort the current execution.
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async runWithClarification(
    input: PiWorkerTaskInput,
    workerPrompt: string,
  ): Promise<PiWorkerExecutionResult> {
    if (!this.config.allowRealPiExecution) return this.runInternal(input, workerPrompt);

    const sessionRoot = mkdtempSync(resolve(this.config.sessionDirectory, 'pi-clarify-'));
    const sessionId = randomUUID();
    const transcript: ClarificationTranscriptEntry[] = [];
    const usage: PiProviderUsage[] = [];
    let lastPid: number | null = null;

    try {
      for (let round = 1; round <= 2; round += 1) {
        const turn = await this.runClarificationTurn(
          input,
          buildPiClarificationPrompt(input.taskSpec, transcript),
          this.buildSessionArgs(sessionId, sessionRoot, true),
        );
        lastPid = turn.pid;
        if (turn.providerUsage) usage.push(turn.providerUsage);
        if (!turn.clarification) {
          return this.pauseForClarification(
            input,
            usage,
            lastPid,
            'Pi 理解阶段没有返回可验证的 ClarificationResult',
            [],
          );
        }

        const entry: ClarificationTranscriptEntry = { round, pi: turn.clarification };
        transcript.push(entry);

        if (requiresUserDecision(turn.clarification.categories)) {
          return this.pauseForClarification(
            input,
            usage,
            lastPid,
            'Pi 的问题涉及需求选择、隐私、费用或范围，需要用户决定',
            turn.clarification.questions,
          );
        }
        if (isReadyToImplement(turn.clarification)) {
          return this.runImplementationAfterClarification(input, workerPrompt, transcript, usage, sessionId, sessionRoot);
        }
        if (turn.clarification.questions.length === 0) {
          return this.pauseForClarification(
            input,
            usage,
            lastPid,
            `Pi 理解度为 ${turn.clarification.confidencePercent}%，但没有提出可回答的问题`,
            [],
          );
        }
        if (!this.config.clarificationResponder) {
          return this.pauseForClarification(input, usage, lastPid, '未配置 Codex 技术答疑器', turn.clarification.questions);
        }

        const answer = await this.config.clarificationResponder.answerTechnicalQuestions({
          taskSpec: input.taskSpec,
          clarification: turn.clarification,
          round,
          worktreePath: input.worktreePath,
        });
        entry.codex = answer;
        if (answer.status === 'requires_user' || requiresUserDecision(answer.categories)) {
          return this.pauseForClarification(
            input,
            usage,
            lastPid,
            answer.reason || 'Codex 判断该问题必须由用户决定',
            turn.clarification.questions,
          );
        }
        if (answer.answers.length !== turn.clarification.questions.length) {
          return this.pauseForClarification(
            input,
            usage,
            lastPid,
            'Codex 技术回答与 Pi 问题数量不一致，无法可靠继续',
            turn.clarification.questions,
          );
        }
      }

      const finalTurn = await this.runClarificationTurn(
        input,
        buildPiClarificationPrompt(input.taskSpec, transcript, true),
        this.buildSessionArgs(sessionId, sessionRoot, true),
      );
      lastPid = finalTurn.pid;
      if (finalTurn.providerUsage) usage.push(finalTurn.providerUsage);
      if (!finalTurn.clarification || !isReadyToImplement(finalTurn.clarification)) {
        return this.pauseForClarification(
          input,
          usage,
          lastPid,
          finalTurn.clarification
            ? `两轮答疑后 Pi 理解度仍为 ${finalTurn.clarification.confidencePercent}%`
            : '两轮答疑后的最终理解确认无法验证',
          finalTurn.clarification?.questions ?? [],
        );
      }
      transcript.push({ round: 3, pi: finalTurn.clarification });
      return this.runImplementationAfterClarification(input, workerPrompt, transcript, usage, sessionId, sessionRoot);
    } finally {
      const cleaned = await cleanupTemporaryPiSession(sessionRoot);
      if (!cleaned) this.appendLog('Temporary Pi clarification session cleanup warning: residue remains after bounded retries');
    }
  }

  private async runImplementationAfterClarification(
    input: PiWorkerTaskInput,
    workerPrompt: string,
    transcript: ClarificationTranscriptEntry[],
    priorUsage: PiProviderUsage[],
    sessionId: string,
    sessionRoot: string,
  ): Promise<PiWorkerExecutionResult> {
    const result = await this.runInternal(
      input,
      appendClarificationTranscriptToWorkerPrompt(workerPrompt, transcript),
      this.buildSessionArgs(sessionId, sessionRoot, false),
    );
    const providerUsage = sumUsage([
      ...priorUsage,
      ...(result.providerUsage ? [result.providerUsage] : []),
    ]);
    return { ...result, providerUsage };
  }

  private async runClarificationTurn(
    input: PiWorkerTaskInput,
    prompt: string,
    args: string[],
  ): Promise<{
    clarification: ReturnType<typeof parsePiClarification>;
    providerUsage: PiProviderUsage | null;
    pid: number | null;
  }> {
    let clarification: ReturnType<typeof parsePiClarification> = null;
    const rpcPrompt = JSON.stringify({
      id: `clarify-${input.taskSpec.taskId}-${randomUUID()}`,
      type: 'prompt',
      message: prompt,
    }) + '\n';
    const runArgs = this.config.model ? [...args, '--model', this.config.model] : args;
    const result = await this.processRunner.run({
      command: this.config.command,
      args: runArgs,
      cwd: this.config.workingDirectory,
      env: this.config.env,
      timeoutMs: this.config.timeoutMs,
      stdin: rpcPrompt,
      signal: this.abortController?.signal,
      onSpawn: this.config.onProcessSpawn,
      onStdoutChunk: (_chunk, accumulated) => {
        const parsed = parsePiClarification(accumulated, input.taskSpec.taskId);
        if (!parsed) return;
        clarification = parsed;
        return { reason: 'worker_result_found' as const, terminateProcess: true };
      },
    });
    clarification = clarification ?? parsePiClarification(result.stdout, input.taskSpec.taskId);
    const providerUsage = parsePiProviderUsageFromJsonl(result.stdout);
    this.appendLog([
      'Clarification turn completed',
      `Exit code: ${result.exitCode}`,
      `Timed out: ${result.timedOut}`,
      `Output length: ${result.stdout.length}`,
      `Provider usage: ${providerUsage ? JSON.stringify(providerUsage) : 'unavailable'}`,
    ].join('\n'));
    return { clarification, providerUsage, pid: result.pid };
  }

  private pauseForClarification(
    input: PiWorkerTaskInput,
    usage: PiProviderUsage[],
    pid: number | null,
    reason: string,
    questions: string[],
  ): PiWorkerExecutionResult {
    const providerUsage = sumUsage(usage);
    const workerResult = clarificationPauseResult(input.taskSpec.taskId, questions, reason);
    if (providerUsage) {
      workerResult.tokenUsage = {
        inputTokens: providerUsage.inputTokens,
        outputTokens: providerUsage.outputTokens,
        cacheHitTokens: providerUsage.cacheReadTokens,
      };
    }
    this.appendLog(`Clarification gate paused before implementation: ${sanitizeLogContent(reason)}`);
    return {
      workerResult,
      providerUsage,
      rawLogPath: this.config.rawLogPath,
      pid,
      exitCode: null,
      timedOut: false,
      aborted: this.abortController?.signal.aborted ?? false,
      errorMessage: `clarification_required: ${reason}`,
    };
  }

  private buildSessionArgs(sessionId: string, sessionRoot: string, readOnly: boolean): string[] {
    const withValue = new Set(['--session', '--session-id', '--session-dir', '--tools', '-t']);
    const withoutValue = new Set(['--no-session', '--no-tools', '-nt']);
    const cleaned: string[] = [];
    for (let index = 0; index < this.config.args.length; index += 1) {
      const arg = this.config.args[index];
      if (withoutValue.has(arg)) continue;
      if (withValue.has(arg)) {
        index += 1;
        continue;
      }
      if ([...withValue].some((flag) => arg.startsWith(`${flag}=`))) continue;
      cleaned.push(arg);
    }
    const sessionArgs = [...cleaned, '--session-id', sessionId, '--session-dir', sessionRoot];
    return readOnly ? [...sessionArgs, '--tools', 'read,grep,find,ls'] : sessionArgs;
  }

  /**
   * Internal run method.
   */
  private async runInternal(
    input: PiWorkerTaskInput,
    prompt: string,
    argsOverride?: string[],
  ): Promise<PiWorkerExecutionResult> {
    const { taskSpec } = input;
    const isRealPi = this.config.allowRealPiExecution;

    if (!isRealPi) {
      // In test/mock mode, write the prompt and return a placeholder
      return {
        workerResult: null,
        providerUsage: null,
        rawLogPath: this.config.rawLogPath,
        pid: null,
        exitCode: null,
        timedOut: false,
        aborted: false,
        errorMessage: `Real Pi execution disabled (allowRealPiExecution=false). ` +
          `Prompt written to ${resolve(this.config.sessionDirectory, `${taskSpec.taskId}_prompt.txt`)}. ` +
          `Use a FakeProcessRunner or set allowRealPiExecution=true to execute.`,
      };
    }

    try {
      // Pi RPC mode uses JSONL protocol: wrap the prompt as a JSON RPC request
      const rpcPrompt = JSON.stringify({
        id: `prompt-${input.taskSpec.taskId}`,
        type: 'prompt',
        message: prompt,
      }) + '\n';

      // Determine args with optional model flag
      const baseArgs = argsOverride ?? this.config.args;
      const runArgs = this.config.model
        ? [...baseArgs, '--model', this.config.model]
        : baseArgs;

      // Use onStdoutChunk for early WorkerResult detection
      let earlyWorkerResult: WorkerResult | null = null;
      const self = this;

      const abortSignal = this.abortController?.signal;
      const result = await this.processRunner.run({
        command: this.config.command,
        args: runArgs,
        cwd: this.config.workingDirectory,
        env: this.config.env,
        timeoutMs: this.config.timeoutMs,
        stdin: rpcPrompt,
        signal: abortSignal,
        onSpawn: this.config.onProcessSpawn,
        onStdoutChunk(chunk: string, accStdout: string) {
          // Skip empty chunks
          if (!accStdout) return;
          // Only check agent_end events to reduce overhead
          if (!accStdout.includes('agent_end')) return;
          // Try to extract WorkerResult from accumulated JSONL output
          const parseResult = self.extractWorkerResultFromJsonlEvents(accStdout);
          if (parseResult.success && parseResult.workerResult) {
            earlyWorkerResult = parseResult.workerResult;
            return { reason: 'worker_result_found' as const, terminateProcess: true };
          }
        },
      });

      // Combine stdout and stderr for result extraction
      const fullOutput = `${result.stdout}\n${result.stderr}`;

      const providerUsage = parsePiProviderUsageFromJsonl(result.stdout);

      // Persist only bounded diagnostics and numeric usage, never raw provider output.
      const logOutput = [
        `---`,
        `Exit code: ${result.exitCode}`,
        `Timed out: ${result.timedOut}`,
        `Aborted: ${result.aborted}`,
        `Duration: ${result.durationMs}ms`,
        `---`,
        `Stdout length: ${result.stdout.length} chars`,
        `Stderr length: ${result.stderr.length} chars`,
        `Provider usage: ${providerUsage ? JSON.stringify(providerUsage) : 'unavailable'}`,
      ];
      this.appendLog(logOutput.join('\n'));

      // Determine final WorkerResult
      let parseResult: ReturnType<typeof parseWorkerResult>;

      if (earlyWorkerResult) {
        // Early detection succeeded — use it directly
        parseResult = { success: true, workerResult: earlyWorkerResult, errors: [] };
        this.appendLog('WorkerResult found via early detection (agent_end event)');
        this.appendLog('Process terminated after WorkerResult: ' + result.terminatedAfterWorkerResult);
      } else {
        // Parse WorkerResult from accumulated output
        parseResult = this.extractWorkerResultFromJsonlEvents(fullOutput);

        if (!parseResult.success) {
          parseResult = parseWorkerResult(fullOutput);
        }

        if (!parseResult.success) {
          parseResult = this.extractFromAssistantMessages(fullOutput);
        }
      }

      // Log the parsing outcome
      if (parseResult.success) {
        this.appendLog('WorkerResult status: ' + parseResult.workerResult!.status);
      } else {
        this.appendLog(`WorkerResult parsing failed: ${parseResult.errors.join('; ')}`);
        this.appendLog(`Stdout length: ${result.stdout.length} chars`);
      }

      return {
        workerResult: parseResult.success ? parseResult.workerResult : null,
        providerUsage,
        rawLogPath: this.config.rawLogPath,
        pid: result.pid ?? null,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        errorMessage: parseResult.success
          ? undefined
          : `WorkerResult parsing failed: ${parseResult.errors.join('; ')}`,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.appendLog(`\n---\nError: ${sanitizeLogContent(errMsg)}`);
      return {
        workerResult: null,
        providerUsage: null,
        rawLogPath: this.config.rawLogPath,
        pid: null,
        exitCode: null,
        timedOut: false,
        aborted: this.abortController?.signal.aborted ?? false,
        errorMessage: errMsg,
      };
    }
  }

  /**
   * Extract WorkerResult from JSONL events stream.
   * Assembles assistant text deltas in order and searches for WorkerResult markers.
   */
  private extractWorkerResultFromJsonlEvents(output: string): ReturnType<typeof parseWorkerResult> {
    const lines = output.split('\n');
    // Track text blocks by contentIndex for ordered assembly
    const textBlocks: Map<number, string[]> = new Map();
    let assistantText = '';

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // agent_end: contains final messages with full text
        if (event.type === 'agent_end' && Array.isArray(event.messages)) {
          // Collect ALL assistant text blocks, keeping the last one that has text
          for (const msg of event.messages) {
            if (msg.role === 'assistant' && msg.content) {
              const text = this.extractTextFromContent(msg.content);
              if (text && text.trim()) assistantText = text;
            }
          }
        }

        // message_update text_delta: partial streaming text
        if (event.type === 'message_update' && event.assistantMessageEvent) {
          const evt = event.assistantMessageEvent;
          if (evt.type === 'text_delta') {
            const idx = evt.contentIndex ?? 0;
            if (!textBlocks.has(idx)) textBlocks.set(idx, []);
            textBlocks.get(idx)!.push(evt.delta || '');
          }
        }

        // message_end: complete message
        if (event.type === 'message_end' && event.message) {
          const msg = event.message;
          if (msg.role === 'assistant' && msg.content) {
            const text = this.extractTextFromContent(msg.content);
            if (text && text.trim()) assistantText = text;
          }
        }
      } catch {
        // Not JSON, skip
      }
    }

    // Reassemble text deltas in order
    const deltaText = Array.from(textBlocks.entries())
      .sort(([a], [b]) => a - b)
      .map(([, chunks]) => chunks.join(''))
      .join('\n');

    // Debug: log markers presence
    const check = (text: string, label: string) => {
      const begin = text.indexOf('BEGIN_WORKER_RESULT_JSON');
      const end = text.indexOf('END_WORKER_RESULT_JSON');
      return `${label}: begin=${begin} end=${end} len=${text.length}`;
    };

    // Try each text source
    const candidates = [
      { source: 'assistantText', text: assistantText },
      { source: 'deltaText', text: deltaText },
      { source: 'rawOutput', text: output },
    ];

    for (const { source, text } of candidates) {
      if (!text) continue;
      // Debug
      const info = check(text, source);
      this.appendLog('DEBUG parse check: ' + info);
      // Try direct parseWorkerResult
      let result = parseWorkerResult(text);
      if (result.success) {
        this.appendLog(`WorkerResult found in ${source}`);
        return result;
      }
      // Try with code fence unwrapping (Pi might wrap in markdown)
      result = this.tryParseWithCodeFenceUnwrap(text);
      if (result.success) {
        this.appendLog('WorkerResult found after unwrapping code fence');
        return result;
      }
    }

    // Log assistant text length for debugging
    const textLen = assistantText.length || deltaText.length;
    const sample = (assistantText || deltaText).substring(0, 200).replace(/[\r\n]/g, '\\n');
    return {
      success: false,
      workerResult: null,
      errors: [
        `No WorkerResult found in assistant messages (captured ${textLen} chars)`,
        `Sample: ${sample}...`,
      ],
    };
  }

  /**
   * Extract text from content array.
   */
  private extractTextFromContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // Collect all text blocks (skip thinking and toolCall)
      const texts = content
        .filter((c: any) => c.type === 'text' && c.text)
        .map((c: any) => c.text);
      // If no text blocks found, fall back to any non-thinking content
      if (texts.length === 0) {
        return content
          .filter((c: any) => typeof c === 'string')
          .join('\n');
      }
      return texts.join('\n');
    }
    return '';
  }

  /**
   * Try to parse WorkerResult when wrapped in Markdown code fences.
   */
  private tryParseWithCodeFenceUnwrap(text: string): ReturnType<typeof parseWorkerResult> {
    // Remove markdown code fences: ```json ... ``` or ``` ... ```
    const unwrapped = text.replace(/```json\s*/gi, '').replace(/```\s*\n?/g, '');
    return parseWorkerResult(unwrapped);
  }

  /**
   * Last resort: search ALL JSONL events for WorkerResult markers.
   * Parses each event's text content to find BEGIN_WORKER_RESULT_JSON markers.
   */
  private extractFromAssistantMessages(output: string): ReturnType<typeof parseWorkerResult> {
    // Search raw output for markers
    if (output.includes('BEGIN_WORKER_RESULT_JSON')) {
      const rawResult = parseWorkerResult(output);
      if (rawResult.success) return rawResult;
    }

    // Collect ALL text from all events (messages, tool results, etc.)
    const allTexts: string[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        this.collectTextRecursive(event, allTexts);
      } catch {
        // skip non-JSON lines
      }
    }

    // Try parsing the combined text
    const combined = allTexts.join('\n');
    if (combined.includes('BEGIN_WORKER_RESULT_JSON')) {
      const result = parseWorkerResult(combined);
      if (result.success) return result;
    }

    return {
      success: false,
      workerResult: null,
      errors: [
        'No WorkerResult found in assistant messages',
        'Searched ' + lines.length + ' lines, collected ' + combined.length + ' chars of text',
      ],
    };
  }

  /**
   * Recursively collect all text content from a JSON event.
   */
  private collectTextRecursive(obj: any, texts: string[]): void {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'text' && typeof obj.text === 'string') {
      texts.push(obj.text);
    }
    if (typeof obj.text === 'string' && obj.text.includes('BEGIN_WORKER_RESULT_JSON')) {
      texts.push(obj.text);
    }
    if (typeof obj.thinking === 'string') {
      // Skip thinking blocks
    }
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        for (const item of value) this.collectTextRecursive(item, texts);
      } else if (value && typeof value === 'object') {
        this.collectTextRecursive(value, texts);
      }
    }
  }

  /**
   * Write initial content to the log file.
   */
  private writeLog(content: string): void {
    try {
      mkdirSync(this.config.sessionDirectory, { recursive: true });
      writeFileSync(this.config.rawLogPath, content, 'utf-8');
    } catch {
      // Silently fail logging
    }
  }

  /**
   * Append content to the log file.
   */
  private appendLog(content: string): void {
    try {
      appendFileSync(this.config.rawLogPath, `\n${content}`, 'utf-8');
    } catch {
      // Silently fail logging
    }
  }
}
