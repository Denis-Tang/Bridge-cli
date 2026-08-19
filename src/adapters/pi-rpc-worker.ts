import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
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
import { runGuardSelfCheckCached, detectPiVersion as detectPiVersionFull } from './pi-guard-selfcheck.js';
import { runGuardBlockProbe, decideProbeSettleOutcome } from './pi-guard-block-probe.js';

type JsonRecord = Record<string, unknown>;

export const PI_CLARIFICATION_READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

export interface PiClarificationToolPolicy {
  root: string;
  allowedPatterns: string[];
  forbiddenPatterns: string[];
}

const HARD_CLARIFICATION_FORBIDDEN_PATTERNS = [
  '.env', '.env.*', '**/.env', '**/.env.*',
  '.git/', '**/.git/', '.brainctl/', '**/.brainctl/', '.brainctl-dev/', '**/.brainctl-dev/',
  'node_modules/', '**/node_modules/', '**/*.pem', '**/*.key', '**/id_rsa', '**/id_ed25519',
  '**/credentials', '**/credentials.*', '**/secrets', '**/secrets.*',
];

function pathComparisonValue(value: string): string {
  const normalized = resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeRelativePattern(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function globPatternToRegExp(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      expression += '.*';
      index += 1;
      if (pattern[index + 1] === '/') index += 1;
    } else if (char === '*') {
      expression += '[^/]*';
    } else if (char === '?') {
      expression += '[^/]';
    } else {
      expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'i');
}

function matchesClarificationPattern(relativePath: string, rawPattern: string): boolean {
  const candidate = normalizeRelativePattern(relativePath || '.');
  const pattern = normalizeRelativePattern(rawPattern);
  if (!pattern) return false;
  if (candidate === pattern || (!pattern.includes('*') && candidate.startsWith(`${pattern.replace(/\/$/, '')}/`))) return true;
  return pattern.includes('*') ? globPatternToRegExp(pattern).test(candidate) : false;
}

function staticPatternPrefix(rawPattern: string): string {
  const pattern = normalizeRelativePattern(rawPattern);
  const wildcard = pattern.search(/[?*]/);
  return (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/\/$/, '');
}

function requestedPathCouldTraversePattern(relativePath: string, rawPattern: string): boolean {
  const candidate = normalizeRelativePattern(relativePath || '.').replace(/\/$/, '');
  const prefix = staticPatternPrefix(rawPattern);
  if (!prefix || candidate === '.') return prefix.length > 0;
  return prefix === candidate || prefix.startsWith(`${candidate}/`);
}

function resolveClarificationCandidate(root: string, requestedPath: string): { absolute: string; relative: string } | null {
  const lexical = resolve(root, requestedPath || '.');
  const canonicalRoot = existsSync(root) ? realpathSync.native(root) : resolve(root);
  const canonicalCandidate = existsSync(lexical) ? realpathSync.native(lexical) : lexical;
  const comparableRoot = pathComparisonValue(canonicalRoot);
  const comparableCandidate = pathComparisonValue(canonicalCandidate);
  if (comparableCandidate !== comparableRoot && !comparableCandidate.startsWith(`${comparableRoot}/`)) return null;
  const relativePath = relative(canonicalRoot, canonicalCandidate).replace(/\\/g, '/') || '.';
  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) return null;
  return { absolute: canonicalCandidate, relative: relativePath };
}

export function buildPiClarificationToolPolicy(
  root: string,
  taskSpec: PiWorkerTaskInput['taskSpec'],
): PiClarificationToolPolicy {
  return {
    root: resolve(root),
    allowedPatterns: [...(taskSpec.allowedPaths ?? []), ...(taskSpec.contextFiles ?? [])],
    // Only the hard sensitive patterns guard clarification READS. The task's
    // write-forbiddenPaths must NOT be merged here: clarification is a read-only
    // understanding phase whose whole point is reading the code under
    // investigation (which the plan may legitimately list as write-forbidden,
    // e.g. a diagnose-only task). Regression: real Pi clarification was blocked
    // with 'forbidden path requested: index.js' because the plan forbade
    // writing index.js for that task.
    forbiddenPatterns: [...HARD_CLARIFICATION_FORBIDDEN_PATTERNS],
  };
}

export function inspectPiClarificationToolRequest(
  event: JsonRecord,
  policy: PiClarificationToolPolicy,
): string | null {
  if (event.type !== 'tool_execution_start') return null;
  const toolName = typeof event.toolName === 'string' ? event.toolName : '';
  if (!(PI_CLARIFICATION_READ_TOOLS as readonly string[]).includes(toolName)) {
    return `non-read-only tool requested: ${toolName || '(missing)'}`;
  }
  const args = event.args && typeof event.args === 'object' ? event.args as JsonRecord : {};
  const requestedPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
  const candidate = resolveClarificationCandidate(policy.root, requestedPath);
  if (!candidate) return 'path escapes the task worktree';
  if (policy.forbiddenPatterns.some((pattern) => matchesClarificationPattern(candidate.relative, pattern))) {
    return `forbidden path requested: ${candidate.relative}`;
  }
  if (['grep', 'find', 'ls'].includes(toolName)
    && policy.forbiddenPatterns.some((pattern) => requestedPathCouldTraversePattern(candidate.relative, pattern))) {
    return `directory request could traverse a forbidden path: ${candidate.relative}`;
  }
  if (policy.allowedPatterns.length > 0
    && !policy.allowedPatterns.some((pattern) => matchesClarificationPattern(candidate.relative, pattern))) {
    return `path is outside the bounded clarification context: ${candidate.relative}`;
  }
  return null;
}

/**
 * Build the one-shot Pi extension used only during clarification. Pi's native
 * tool allowlist removes write-capable tools; this pre-execution hook adds a
 * path boundary for the remaining read tools. The adapter independently
 * validates streamed tool_execution_start events and fails the gate on any
 * violation, so this is enforcement rather than a prompt convention.
 */
export function buildPiClarificationGuardExtensionSource(
  policy: PiClarificationToolPolicy,
  violationMarkerPath: string,
): string {
  const serializedPolicy = JSON.stringify(policy);
  const serializedMarker = JSON.stringify(violationMarkerPath);
  const serializedTools = JSON.stringify(PI_CLARIFICATION_READ_TOOLS);
  return [
    `import { existsSync, realpathSync, writeFileSync } from 'node:fs';`,
    `import { isAbsolute, relative, resolve } from 'node:path';`,
    `const policy = ${serializedPolicy};`,
    `const marker = ${serializedMarker};`,
    `const allowedTools = new Set(${serializedTools});`,
    `const cmp = (value) => { const normalized = resolve(value).replace(/\\\\/g, '/').replace(/\\/$/, ''); return process.platform === 'win32' ? normalized.toLowerCase() : normalized; };`,
    `const norm = (value) => String(value || '').trim().replace(/\\\\/g, '/').replace(/^\\.\\//, '').replace(/^\\/+/, '').toLowerCase();`,
    `const glob = (pattern) => { let out = '^'; for (let i = 0; i < pattern.length; i += 1) { const ch = pattern[i]; if (ch === '*' && pattern[i + 1] === '*') { out += '.*'; i += 1; if (pattern[i + 1] === '/') i += 1; } else if (ch === '*') out += '[^/]*'; else if (ch === '?') out += '[^/]'; else out += ch.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&'); } return new RegExp(out + '$', 'i'); };`,
    `const matches = (value, raw) => { const candidate = norm(value || '.'); const pattern = norm(raw); if (!pattern) return false; if (candidate === pattern || (!pattern.includes('*') && candidate.startsWith(pattern.replace(/\\/$/, '') + '/'))) return true; return pattern.includes('*') ? glob(pattern).test(candidate) : false; };`,
    `const prefix = (raw) => { const pattern = norm(raw); const at = pattern.search(/[?*]/); return (at < 0 ? pattern : pattern.slice(0, at)).replace(/\\/$/, ''); };`,
    `const canTraverse = (value, raw) => { const candidate = norm(value || '.').replace(/\\/$/, ''); const fixed = prefix(raw); if (!fixed || candidate === '.') return fixed.length > 0; return fixed === candidate || fixed.startsWith(candidate + '/'); };`,
    `const inspect = (toolName, input, cwd) => { if (!allowedTools.has(toolName)) return 'non-read-only tool requested'; if (cmp(cwd) !== cmp(policy.root)) return 'clarification cwd mismatch'; const requested = input && typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '.'; const lexical = resolve(policy.root, requested); const rootReal = existsSync(policy.root) ? realpathSync.native(policy.root) : resolve(policy.root); const targetReal = existsSync(lexical) ? realpathSync.native(lexical) : lexical; const rootCmp = cmp(rootReal); const targetCmp = cmp(targetReal); if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + '/')) return 'path escapes the task worktree'; const rel = relative(rootReal, targetReal).replace(/\\\\/g, '/') || '.'; if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return 'path escapes the task worktree'; if (policy.forbiddenPatterns.some((item) => matches(rel, item))) return 'forbidden path requested'; if (['grep', 'find', 'ls'].includes(toolName) && policy.forbiddenPatterns.some((item) => canTraverse(rel, item))) return 'directory request could traverse a forbidden path'; if (policy.allowedPatterns.length > 0 && !policy.allowedPatterns.some((item) => matches(rel, item))) return 'path is outside the bounded clarification context'; return null; };`,
    `export default function bridgeClarificationGuard(pi) { pi.on('tool_call', (event, ctx) => { const reason = inspect(event.toolName, event.input, ctx.cwd); if (!reason) return; try { writeFileSync(marker, 'blocked', { encoding: 'utf8', flag: 'wx' }); } catch (error) { if (!existsSync(marker)) throw error; } return { block: true, reason: 'BRIDGE_CLARIFICATION_POLICY_BLOCK: ' + reason }; }); }`,
    '',
  ].join('\n');
}

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

class JsonlLineAccumulator {
  private parts: string[] = [];

  push(chunk: string): string[] {
    if (!chunk) return [];
    const segments = chunk.split('\n');
    if (segments.length === 1) {
      this.parts.push(chunk);
      return [];
    }

    const lines: string[] = [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      this.parts.push(segments[index]);
      let line = this.parts.join('');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
      this.parts = [];
    }
    const tail = segments.at(-1);
    if (tail) this.parts.push(tail);
    return lines;
  }

  finish(): string | null {
    if (this.parts.length === 0) return null;
    let line = this.parts.join('');
    this.parts = [];
    if (line.endsWith('\r')) line = line.slice(0, -1);
    return line;
  }
}

const MAX_STREAMED_RESULT_CHARS = 1_048_576;
const MAX_CAPTURED_STDOUT_CHARS = 1_048_576;
const MAX_CAPTURED_STDERR_CHARS = 262_144;

class MarkedTextAccumulator {
  private prefixTail = '';
  private captured = '';
  private capturing = false;

  constructor(
    private readonly begin: string,
    private readonly end: string,
    private readonly maxChars = MAX_STREAMED_RESULT_CHARS,
  ) {}

  push(text: string): string | null {
    if (!text) return null;
    if (!this.capturing) {
      const candidate = this.prefixTail + text;
      const start = candidate.lastIndexOf(this.begin);
      if (start < 0) {
        this.prefixTail = candidate.slice(-Math.max(0, this.begin.length - 1));
        return null;
      }
      this.capturing = true;
      this.captured = candidate.slice(start);
      this.prefixTail = '';
    } else {
      this.captured += text;
    }

    if (this.captured.length > this.maxChars) {
      const restart = this.captured.lastIndexOf(this.begin, this.captured.length - 1);
      if (restart > 0) this.captured = this.captured.slice(restart);
      if (this.captured.length > this.maxChars) {
        this.prefixTail = this.captured.slice(-Math.max(0, this.begin.length - 1));
        this.captured = '';
        this.capturing = false;
        return null;
      }
    }

    const finish = this.captured.indexOf(this.end, this.begin.length);
    if (finish < 0) return null;
    const block = this.captured.slice(0, finish + this.end.length);
    // Consume the returned block so a LATER marked block in the same stream can
    // still be captured (an early fragment must not starve the complete one).
    const tail = this.captured.slice(finish + this.end.length);
    this.captured = '';
    this.capturing = false;
    if (tail) this.push(tail);
    return block;
  }
}

function parseJsonlEvent(line: string): JsonRecord | null {
  if (!line.trim()) return null;
  try {
    const event = JSON.parse(line) as unknown;
    return event && typeof event === 'object' ? event as JsonRecord : null;
  } catch {
    return null;
  }
}

function extractAssistantTextDeltas(event: JsonRecord | null, rawLine: string): string[] {
  if (!event) return rawLine.trim() ? [`${rawLine}\n`] : [];
  const assistantEvent = event.assistantMessageEvent as JsonRecord | undefined;
  if (event.type === 'message_update'
    && assistantEvent?.type === 'text_delta'
    && typeof assistantEvent.delta === 'string') {
    return [assistantEvent.delta];
  }
  return [];
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
export class PiProviderUsageAccumulator {
  private bestFinalSnapshot: PiProviderUsage | null = null;
  private completedMessages = new Map<string, PiProviderUsage>();

  pushEvent(event: JsonRecord): void {
    if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      const snapshot = sumUsage(event.messages.map(usageFromMessage).filter((item): item is PiProviderUsage => item !== null));
      if (snapshot && (!this.bestFinalSnapshot || snapshot.totalTokens > this.bestFinalSnapshot.totalTokens)) {
        this.bestFinalSnapshot = snapshot;
      }
      return;
    }

    if (event.type !== 'message_end') return;
    const usage = usageFromMessage(event.message);
    if (!usage) return;
    const message = event.message as JsonRecord;
    const identity = typeof message.id === 'string'
      ? `id:${message.id}`
      : JSON.stringify([message.timestamp ?? null, message.model ?? null, usage]);
    this.completedMessages.set(identity, usage);
  }

  result(): PiProviderUsage | null {
    return this.bestFinalSnapshot ?? sumUsage([...this.completedMessages.values()]);
  }
}

export function parsePiProviderUsageFromJsonl(output: string): PiProviderUsage | null {
  const accumulator = new PiProviderUsageAccumulator();

  for (const line of output.split(/\r?\n/)) {
    const event = parseJsonlEvent(line);
    if (event) accumulator.pushEvent(event);
  }
  return accumulator.result();
}

function appendBounded(current: string, chunk: string, limit?: number): string {
  if (limit === undefined) return current + chunk;
  if (limit <= 0) return '';
  if (chunk.length >= limit) return chunk.slice(-limit);
  return current.slice(-Math.max(0, limit - chunk.length)) + chunk;
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
    let stdoutLength = 0;
    let stderrLength = 0;
    let timedOut = false;
    let aborted = false;
    let terminatedAfterWorkerResult = false;
    let terminationStarted = false;
    const childPid = child.pid ?? null;

    if (childPid != null && input.onSpawn) {
      await Promise.resolve(input.onSpawn(childPid));
    }

    // Write stdin if provided. Do NOT close stdin immediately — Pi RPC mode
    // needs stdin to stay open for the duration of processing; closing it makes
    // Pi 0.82.1 exit after echoing the prompt without processing it. The caller
    // terminates the process via onStdoutChunk early-detection or the timeout.
    if (input.stdin && child.stdin) {
      child.stdin.write(input.stdin);
    }

    // Collect stdout
    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8');
      stdoutLength += chunk.length;
      stdout = appendBounded(stdout, chunk, input.maxCapturedStdoutChars);
      // Call the observer exactly once per chunk. The observer receives the
      // accumulated output for compatibility, but streaming parsers should use
      // the chunk argument so a long JSONL session stays O(n).
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
      stderrLength += chunk.length;
      stderr = appendBounded(stderr, chunk, input.maxCapturedStderrChars);
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
          stdoutLength,
          stderrLength,
          timedOut,
          aborted,
          terminatedAfterWorkerResult,
          durationMs,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;
        const errorChunk = `\nProcess error: ${err.message}`;
        stderrLength += errorChunk.length;
        stderr = appendBounded(stderr, errorChunk, input.maxCapturedStderrChars);
        resolvePromise({
          pid: childPid,
          exitCode: null,
          stdout,
          stderr,
          stdoutLength,
          stderrLength,
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
    const prompt = input.implementationPrompt ?? buildPiWorkerPrompt({ taskSpec: input.taskSpec });

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

    if (pathComparisonValue(this.config.workingDirectory) !== pathComparisonValue(input.worktreePath)) {
      return this.pauseForClarification(input, [], null, 'Pi 澄清工作目录与 task worktree 不一致', []);
    }

    // ── R3: guard runtime self-check (zero inference). If the guard extension
    // cannot be PROVEN loaded + registered, refuse to start the clarification
    // session — never downgrade to second-layer-only. Cached per process/version.
    const selfCheckCfg = this.config.guardSelfCheck;
    // Fail closed by DEFAULT: a real clarification gate that cannot prove its
    // read-only guard is missing → refuse to run. Explicit `enabled: false`
    // remains the only opt-out (tests), but absence is NOT opt-out — otherwise
    // any future PiRpcWorker construction site silently inherits the hole.
    if (selfCheckCfg === undefined) {
      return this.pauseForClarification(
        input,
        [],
        null,
        'Pi guard 自检未配置（guardSelfCheck 缺失）：真实 Pi 澄清会话禁止在未验证只读 guard 的情况下启动',
        [],
      );
    }
    if (selfCheckCfg.enabled === false) {
      // Explicit opt-out (tests / deliberate choice): skip the probe, proceed.
    } else {
      const probeMarkerDir = selfCheckCfg.markerDir
        ?? resolve(this.config.sessionDirectory, 'guard-selfcheck');
      const probeResult = await runGuardSelfCheckCached({
        markerDir: probeMarkerDir,
        piCommand: this.config.command,
        piArgs: this.config.args,
        timeoutMs: selfCheckCfg.timeoutMs ?? 20_000,
        verifiedPiVersion: selfCheckCfg.verifiedPiVersion ?? '0.82.1',
        runner: selfCheckCfg.runner,
        env: this.config.env,
      });
      if (selfCheckCfg.onResult) {
        try { await selfCheckCfg.onResult(probeResult); } catch { /* audit sink failure is not fatal */ }
      }
      if (probeResult.versionMismatch) {
        console.warn(`[Scheduler] Pi CLI 版本漂移：检测到 ${probeResult.piVersion}，已验证版本为 ${probeResult.verifiedPiVersion}。guard 自检必须通过才能继续。`);
      }
      if (!probeResult.ok) {
        return this.pauseForClarification(
          input,
          [],
          null,
          `Pi guard 自检失败（${probeResult.failureCategory}）：无法证明只读 guard 扩展被加载。可能是 Pi CLI 版本变更；升级后需重新核对 tool_call 语义。`,
          [],
        );
      }

      // ── B (authorized): block-semantics probe — ONE minimal inference. ──
      // Persistently cached per full Pi CLI version: a version already verified
      // as pass is reused (no money spent again). Requires explicit
      // authorization (inferenceProbe.enabled) — absence is NOT opt-in.
      const inferenceProbe = selfCheckCfg.inferenceProbe;
      if (inferenceProbe && inferenceProbe.enabled === true) {
        const probeVersion = detectPiVersionFull(this.config.command);
        const cached = probeVersion ? (await inferenceProbe.cacheGet?.(probeVersion)) ?? null : null;
        if (cached && cached.outcome === 'pass') {
          // Reuse: this Pi version was already verified end-to-end.
        } else {
          const gate = inferenceProbe.reserveCost
            ? await inferenceProbe.reserveCost()
            : { allowed: false, reason: 'reserve_cost_unavailable' };
          if (!gate.allowed) {
            return this.pauseForClarification(
              input, [], null,
              `Pi guard 推理探针成本预留失败（${gate.reason}）：无法验证阻断语义，暂停。`,
              [],
            );
          }
          const blockResult = await runGuardBlockProbe({
            markerDir: probeMarkerDir,
            piCommand: this.config.command,
            piArgs: this.config.args,
            model: inferenceProbe.model,
            timeoutMs: inferenceProbe.timeoutMs ?? 60_000,
            runner: inferenceProbe.runner,
            env: this.config.env,
          });
          // Ledger settlement is EVIDENCE-BASED, not outcome-string based:
          // real provider usage is a hard veto on `released`; `released` only
          // when the probe provably never reached the Provider.
          const settleOutcome = decideProbeSettleOutcome(blockResult);
          await inferenceProbe.settleCost?.(settleOutcome, `guard_block_probe_${blockResult.outcome}`);
          if (probeVersion) {
            await inferenceProbe.cacheSet?.(probeVersion, blockResult.outcome, blockResult.failureCategory);
          }
          if (inferenceProbe.onResult) {
            try { await inferenceProbe.onResult(blockResult); } catch { /* audit sink failure is not fatal */ }
          }
          if (!blockResult.ok) {
            if (blockResult.outcome === 'guard_ineffective') {
              return this.pauseForClarification(
                input, [], null,
                'Pi guard 阻断失效（guard_ineffective）：tool_call 未被第一层拦截，只读边界已破坏，禁止启动澄清会话。',
                [],
              );
            }
            return this.pauseForClarification(
              input, [], null,
              `Pi guard 阻断无法验证（${blockResult.outcome}）：可能是 Provider 不可用、超时或模型未发起工具调用，不是 guard 失效结论；暂停待重试。`,
              [],
            );
          }
        }
      }
    }

    const sessionRoot = mkdtempSync(resolve(this.config.sessionDirectory, 'pi-clarify-'));
    const sessionId = randomUUID();
    const policy = buildPiClarificationToolPolicy(input.worktreePath, input.taskSpec);
    const guardPath = resolve(sessionRoot, 'bridge-clarification-guard.mjs');
    const violationMarkerPath = resolve(sessionRoot, 'clarification-policy-violation');
    writeFileSync(guardPath, buildPiClarificationGuardExtensionSource(policy, violationMarkerPath), { encoding: 'utf8', flag: 'wx' });
    const transcript: ClarificationTranscriptEntry[] = [];
    const usage: PiProviderUsage[] = [];
    let lastPid: number | null = null;

    try {
      for (let round = 1; round <= 2; round += 1) {
        const turn = await this.runClarificationTurn(
          input,
          buildPiClarificationPrompt(input.taskSpec, transcript),
          this.buildSessionArgs(sessionId, sessionRoot, true, guardPath),
          policy,
          violationMarkerPath,
        );
        lastPid = turn.pid;
        if (turn.providerUsage) usage.push(turn.providerUsage);
        if (turn.policyViolation) {
          return this.pauseForClarification(input, usage, lastPid, `Pi 澄清工具策略违规：${turn.policyViolation}`, []);
        }
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
        this.buildSessionArgs(sessionId, sessionRoot, true, guardPath),
        policy,
        violationMarkerPath,
      );
      lastPid = finalTurn.pid;
      if (finalTurn.providerUsage) usage.push(finalTurn.providerUsage);
      if (finalTurn.policyViolation) {
        return this.pauseForClarification(input, usage, lastPid, `Pi 澄清工具策略违规：${finalTurn.policyViolation}`, []);
      }
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
    policy: PiClarificationToolPolicy,
    violationMarkerPath: string,
  ): Promise<{
    clarification: ReturnType<typeof parsePiClarification>;
    providerUsage: PiProviderUsage | null;
    pid: number | null;
    policyViolation: string | null;
  }> {
    let clarification: ReturnType<typeof parsePiClarification> = null;
    const clarificationLines = new JsonlLineAccumulator();
    const clarificationText = new MarkedTextAccumulator('BEGIN_CLARIFICATION_JSON', 'END_CLARIFICATION_JSON');
    const providerUsageAccumulator = new PiProviderUsageAccumulator();
    let policyViolation: string | null = null;
    let sawStreamChunk = false;
    const consumeLine = (line: string): ProcessEarlyCompletion | void => {
      const event = parseJsonlEvent(line);
      if (event) providerUsageAccumulator.pushEvent(event);
      if (event) {
        const violation = inspectPiClarificationToolRequest(event, policy);
        if (violation) {
          policyViolation = violation;
          return { reason: 'user_abort', terminateProcess: true };
        }
      }
      for (const delta of extractAssistantTextDeltas(event, line)) {
        const marked = clarificationText.push(delta);
        if (!marked) continue;
        const parsed = parsePiClarification(marked, input.taskSpec.taskId);
        if (!parsed) continue;
        clarification = parsed;
        return { reason: 'worker_result_found', terminateProcess: true };
      }
      if (!event || (event.type !== 'agent_end' && event.type !== 'message_end')) return;
      const parsed = this.extractClarificationFromEvent(event, input.taskSpec.taskId);
      if (!parsed) return;
      clarification = parsed;
      return { reason: 'worker_result_found', terminateProcess: true };
    };
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
      maxCapturedStdoutChars: MAX_CAPTURED_STDOUT_CHARS,
      maxCapturedStderrChars: MAX_CAPTURED_STDERR_CHARS,
      stdin: rpcPrompt,
      signal: this.abortController?.signal,
      onSpawn: this.config.onProcessSpawn,
      onStdoutChunk: (chunk) => {
        if (!chunk) return;
        sawStreamChunk = true;
        for (const line of clarificationLines.push(chunk)) {
          const signal = consumeLine(line);
          if (signal) return signal;
        }
      },
    });
    if (!sawStreamChunk) {
      for (const line of clarificationLines.push(result.stdout)) consumeLine(line);
    }
    const trailingLine = clarificationLines.finish();
    if (trailingLine) consumeLine(trailingLine);
    clarification = clarification ?? parsePiClarification(result.stdout, input.taskSpec.taskId);
    const providerUsage = providerUsageAccumulator.result();
    if (!policyViolation && existsSync(violationMarkerPath)) {
      policyViolation = 'pre-execution guard blocked a tool request';
    }
    const stdoutLength = result.stdoutLength ?? result.stdout.length;
    this.appendLog([
      'Clarification turn completed',
      `Exit code: ${result.exitCode}`,
      `Timed out: ${result.timedOut}`,
      `Output length: ${stdoutLength}`,
      `Provider usage: ${providerUsage ? JSON.stringify(providerUsage) : 'unavailable'}`,
    ].join('\n'));
    return { clarification: policyViolation ? null : clarification, providerUsage, pid: result.pid, policyViolation };
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

  private buildSessionArgs(sessionId: string, sessionRoot: string, readOnly: boolean, guardPath?: string): string[] {
    const sessionWithValue = new Set(['--session', '--session-id', '--session-dir']);
    const sessionWithoutValue = new Set(['--no-session']);
    const clarificationWithValue = new Set([
      '--tools', '-t', '--exclude-tools', '-xt', '--extension', '-e', '--skill',
      '--prompt-template', '--system-prompt', '--append-system-prompt',
    ]);
    const clarificationWithoutValue = new Set([
      '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--no-extensions', '-ne',
      '--no-skills', '-ns', '--no-prompt-templates', '-np', '--no-context-files', '-nc',
      '--approve', '-a', '--no-approve', '-na',
    ]);
    const cleaned: string[] = [];
    for (let index = 0; index < this.config.args.length; index += 1) {
      const arg = this.config.args[index];
      if (sessionWithoutValue.has(arg) || (readOnly && clarificationWithoutValue.has(arg))) continue;
      const withValue = readOnly
        ? new Set([...sessionWithValue, ...clarificationWithValue])
        : sessionWithValue;
      if (withValue.has(arg)) {
        index += 1;
        continue;
      }
      if ([...withValue].some((flag) => arg.startsWith(`${flag}=`))) continue;
      cleaned.push(arg);
    }
    const sessionArgs = [...cleaned, '--session-id', sessionId, '--session-dir', sessionRoot];
    if (!readOnly) return sessionArgs;
    if (!guardPath) throw new Error('clarification guard path is required for read-only Pi execution');
    return [
      ...sessionArgs,
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve',
      '--extension', guardPath,
      '--tools', PI_CLARIFICATION_READ_TOOLS.join(','),
    ];
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
      const implementationLines = new JsonlLineAccumulator();
      const workerResultText = new MarkedTextAccumulator('BEGIN_WORKER_RESULT_JSON', 'END_WORKER_RESULT_JSON');
      const providerUsageAccumulator = new PiProviderUsageAccumulator();
      let sawStreamChunk = false;
      // A complete BEGIN…END block was streamed but failed validation. The model
      // has already answered; waiting only lets its agent loop churn until the
      // worker timeout. Fail fast at the next message boundary instead.
      let invalidBlockError: string | null = null;
      const self = this;
      const consumeLine = (line: string): ProcessEarlyCompletion | void => {
        const event = parseJsonlEvent(line);
        if (event) providerUsageAccumulator.pushEvent(event);
        for (const delta of extractAssistantTextDeltas(event, line)) {
          const marked = workerResultText.push(delta);
          if (!marked) continue;
          const parseResult = parseWorkerResult(marked);
          if (parseResult.success && parseResult.workerResult) {
            earlyWorkerResult = parseResult.workerResult;
            return { reason: 'worker_result_found', terminateProcess: true };
          }
          if (invalidBlockError === null) {
            invalidBlockError = parseResult.errors.join('; ') || 'WorkerResult block failed validation';
          }
        }
        if (!event || (event.type !== 'agent_end' && event.type !== 'message_end')) return;
        const parseResult = self.extractWorkerResultFromEvent(event);
        if (parseResult.success && parseResult.workerResult) {
          earlyWorkerResult = parseResult.workerResult;
          return { reason: 'worker_result_found', terminateProcess: true };
        }
        // The model completed a message whose WorkerResult block is invalid and
        // no valid block was found. Do not let the agent loop run until the
        // worker timeout — terminate now and fail with the recorded error.
        if (invalidBlockError !== null) {
          return { reason: 'worker_result_invalid', terminateProcess: true };
        }
      };

      const abortSignal = this.abortController?.signal;
      const result = await this.processRunner.run({
        command: this.config.command,
        args: runArgs,
        cwd: this.config.workingDirectory,
        env: this.config.env,
        timeoutMs: this.config.timeoutMs,
        maxCapturedStdoutChars: MAX_CAPTURED_STDOUT_CHARS,
        maxCapturedStderrChars: MAX_CAPTURED_STDERR_CHARS,
        stdin: rpcPrompt,
        signal: abortSignal,
        onSpawn: this.config.onProcessSpawn,
        onStdoutChunk(chunk: string) {
          if (!chunk) return;
          sawStreamChunk = true;
          for (const line of implementationLines.push(chunk)) {
            const signal = consumeLine(line);
            if (signal) return signal;
          }
        },
      });

      if (!sawStreamChunk) {
        for (const line of implementationLines.push(result.stdout)) consumeLine(line);
      }
      const trailingLine = implementationLines.finish();
      if (trailingLine) consumeLine(trailingLine);

      // Combine stdout and stderr for result extraction
      const fullOutput = `${result.stdout}\n${result.stderr}`;

      const providerUsage = providerUsageAccumulator.result();
      const stdoutLength = result.stdoutLength ?? result.stdout.length;
      const stderrLength = result.stderrLength ?? result.stderr.length;

      // Persist only bounded diagnostics and numeric usage, never raw provider output.
      const logOutput = [
        `---`,
        `Exit code: ${result.exitCode}`,
        `Timed out: ${result.timedOut}`,
        `Aborted: ${result.aborted}`,
        `Duration: ${result.durationMs}ms`,
        `---`,
        `Stdout length: ${stdoutLength} chars (captured ${result.stdout.length})`,
        `Stderr length: ${stderrLength} chars (captured ${result.stderr.length})`,
        `Provider usage: ${providerUsage ? JSON.stringify(providerUsage) : 'unavailable'}`,
        ...(invalidBlockError !== null ? [`Invalid WorkerResult block seen: ${invalidBlockError}`] : []),
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
        const invalidDetail = invalidBlockError !== null
          ? `; streamed invalid block: ${invalidBlockError}`
          : '';
        this.appendLog(`WorkerResult parsing failed: ${parseResult.errors.join('; ')}${invalidDetail}`);
        this.appendLog(`Stdout length: ${stdoutLength} chars`);
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
          : `WorkerResult parsing failed: ${parseResult.errors.join('; ')}${invalidBlockError !== null ? `; streamed invalid block: ${invalidBlockError}` : ''}`,
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

  private eventAssistantTextCandidates(event: JsonRecord): string[] {
    const messages: unknown[] = event.type === 'agent_end' && Array.isArray(event.messages)
      ? event.messages
      : event.type === 'message_end' && event.message
        ? [event.message]
        : [];
    const candidates: string[] = [];
    for (const value of messages) {
      if (!value || typeof value !== 'object') continue;
      const message = value as JsonRecord;
      if (message.role !== 'assistant') continue;
      const content = message.content;
      if (typeof content === 'string') {
        candidates.push(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block === 'string') {
          candidates.push(block);
          continue;
        }
        if (!block || typeof block !== 'object') continue;
        const record = block as JsonRecord;
        if (record.type === 'text' && typeof record.text === 'string') candidates.push(record.text);
      }
    }
    return candidates;
  }

  private boundedMarkedCandidate(text: string, begin: string, end: string): string | null {
    if (text.length <= MAX_STREAMED_RESULT_CHARS) return text;
    const start = text.lastIndexOf(begin);
    if (start < 0) return null;
    const finish = text.indexOf(end, start + begin.length);
    if (finish < 0) return null;
    const candidate = text.slice(start, finish + end.length);
    return candidate.length <= MAX_STREAMED_RESULT_CHARS ? candidate : null;
  }

  private extractClarificationFromEvent(
    event: JsonRecord,
    taskId: string,
  ): ReturnType<typeof parsePiClarification> {
    for (const text of this.eventAssistantTextCandidates(event)) {
      const candidate = this.boundedMarkedCandidate(text, 'BEGIN_CLARIFICATION_JSON', 'END_CLARIFICATION_JSON');
      if (!candidate) continue;
      const parsed = parsePiClarification(candidate, taskId);
      if (parsed) return parsed;
    }
    return null;
  }

  private extractWorkerResultFromEvent(event: JsonRecord): ReturnType<typeof parseWorkerResult> {
    const errors: string[] = [];
    for (const text of this.eventAssistantTextCandidates(event)) {
      const candidate = this.boundedMarkedCandidate(text, 'BEGIN_WORKER_RESULT_JSON', 'END_WORKER_RESULT_JSON');
      if (!candidate) continue;
      let parsed = parseWorkerResult(candidate);
      if (parsed.success) return parsed;
      errors.push(...parsed.errors);
      parsed = this.tryParseWithCodeFenceUnwrap(candidate);
      if (parsed.success) return parsed;
      errors.push(...parsed.errors);
    }
    return {
      success: false,
      workerResult: null,
      errors: errors.length > 0 ? errors : ['No bounded WorkerResult candidate in completed assistant event'],
    };
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
