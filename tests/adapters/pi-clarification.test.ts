import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PiRpcWorker,
  buildPiClarificationGuardExtensionSource,
  buildPiClarificationToolPolicy,
  cleanupTemporaryPiSession,
} from '../../src/adapters/pi-rpc-worker.js';
import { CodexTechnicalClarifier } from '../../src/adapters/codex-technical-clarifier.js';
import { FakeCodexProcessRunner } from '../../src/adapters/codex-process-runner.js';
import {
  clarificationPauseResult,
  isReadyToImplement,
  parseCodexClarificationAnswer,
  parsePiClarification,
  type CodexClarificationAnswer,
  type PiClarificationResult,
  type TechnicalClarificationResponder,
} from '../../src/adapters/pi-clarification.js';
import type { PiWorkerConfig, ProcessRunInput, ProcessRunResult, ProcessRunner } from '../../src/adapters/pi-worker-types.js';
import type { TaskSpec } from '../../src/types/protocol.js';

const task: TaskSpec = {
  taskId: 'clarify-task',
  title: '澄清测试',
  goal: '只在理解达到 95% 后修改 docs/guide.md',
  dependencies: [],
  allowedPaths: ['docs/guide.md'],
  forbiddenPaths: ['.env'],
  contextFiles: ['docs/guide.md'],
  acceptanceChecks: ['精确测试通过'],
  allowedCommands: ['git diff', 'git add', 'git commit', 'npm test'],
  riskLevel: 'low',
  productDecisionsLocked: true,
  expectedOutputs: ['WorkerResult'],
  heavyCommandSlotsRequired: 0,
  timeoutSeconds: 120,
};

function clarification(confidencePercent: number, questions: string[], categories: PiClarificationResult['categories'] = ['technical']): string {
  const body: PiClarificationResult = {
    taskId: task.taskId,
    understandingSummary: '只修改授权文档并运行精确测试',
    confidencePercent,
    questions,
    categories,
  };
  const text = `BEGIN_CLARIFICATION_JSON\n${JSON.stringify(body)}\nEND_CLARIFICATION_JSON`;
  return JSON.stringify({ type: 'agent_end', messages: [{ role: 'user', content: text }, { role: 'assistant', content: [{ type: 'text', text }] }] });
}

const workerResult = {
  taskId: task.taskId,
  status: 'completed',
  summary: '完成',
  filesChanged: ['docs/guide.md'],
  commitHash: 'abc1234',
  checks: [{ name: 'test', status: 'passed', summary: 'ok' }],
  scopeViolations: [],
  risks: [],
  unresolvedQuestions: [],
  productDecisionRequired: false,
  tokenUsage: { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0 },
};

function completedWorkerOutput(): string {
  const text = `BEGIN_WORKER_RESULT_JSON\n${JSON.stringify(workerResult)}\nEND_WORKER_RESULT_JSON`;
  return JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
}

class QueuePiRunner implements ProcessRunner {
  readonly calls: ProcessRunInput[] = [];
  constructor(private readonly outputs: string[]) {}

  async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.calls.push(input);
    const stdout = this.outputs.shift() ?? '';
    input.onStdoutChunk?.(stdout, stdout);
    return {
      pid: 1000 + this.calls.length,
      exitCode: 0,
      stdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      terminatedAfterWorkerResult: true,
      durationMs: 1,
    };
  }
}

class StreamingQueuePiRunner implements ProcessRunner {
  readonly calls: ProcessRunInput[] = [];
  constructor(private readonly outputs: string[]) {}

  async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.calls.push(input);
    const output = this.outputs.shift() ?? '';
    const chunks = output.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let stdout = '';
    let terminated = false;
    for (const chunk of chunks) {
      stdout += chunk;
      const signal = input.onStdoutChunk?.(chunk, stdout);
      if (signal?.terminateProcess) {
        terminated = true;
        break;
      }
    }
    return {
      pid: 2000 + this.calls.length,
      exitCode: terminated ? null : 0,
      stdout,
      stderr: '',
      timedOut: false,
      aborted: false,
      terminatedAfterWorkerResult: terminated,
      durationMs: 1,
    };
  }
}

class FixedResponder implements TechnicalClarificationResponder {
  calls = 0;
  constructor(private readonly answers: CodexClarificationAnswer[]) {}
  async answerTechnicalQuestions(): Promise<CodexClarificationAnswer> {
    this.calls += 1;
    return this.answers.shift() ?? { status: 'requires_user', answers: [], reason: 'no answer', categories: ['technical'] };
  }
}

function config(root: string, responder: TechnicalClarificationResponder): PiWorkerConfig {
  const sessions = path.join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  return {
    workerId: 'clarify-worker',
    command: 'pi',
    args: ['--mode', 'rpc', '--no-session', '--no-extensions'],
    workingDirectory: root,
    sessionDirectory: sessions,
    rawLogPath: path.join(sessions, 'worker.log'),
    timeoutMs: 5000,
    allowRealPiExecution: true,
    requireClarification: true,
    clarificationResponder: responder,
    // R3: these tests exercise the clarification protocol itself, not the
    // guard self-check — explicitly opt out (fail-closed default otherwise
    // refuses to start a real clarification session without guardSelfCheck).
    guardSelfCheck: { enabled: false },
  };
}

describe('Pi 95% clarification protocol', () => {
  it('retries no-question uncertainty but keeps real questions behind a user decision', () => {
    const uncertain = clarificationPauseResult(task.taskId, [], 'Pi 理解度为 93%，但没有提出可回答的问题');
    expect(uncertain.status).toBe('failed');
    expect(uncertain.productDecisionRequired).toBe(false);
    expect(uncertain.unresolvedQuestions).toEqual([]);

    const protectedQuestion = clarificationPauseResult(task.taskId, ['是否扩大修改范围？'], '需要用户决定');
    expect(protectedQuestion.status).toBe('needs_decision');
    expect(protectedQuestion.productDecisionRequired).toBe(true);
    expect(protectedQuestion.unresolvedQuestions).toEqual(['是否扩大修改范围？']);
  });

  it('parses only the assistant clarification and enforces protected categories', () => {
    const parsed = parsePiClarification(clarification(96, []), task.taskId);
    expect(parsed?.confidencePercent).toBe(96);
    expect(isReadyToImplement(parsed!)).toBe(true);
    expect(isReadyToImplement({ ...parsed!, categories: ['scope'] })).toBe(false);
  });

  it('rejects a Codex answer that disguises protected decisions as auto-answered', () => {
    const invalid = [
      'BEGIN_CODEX_CLARIFICATION_JSON',
      JSON.stringify({ status: 'answered', answers: ['扩大范围'], reason: 'ok', categories: ['scope'] }),
      'END_CODEX_CLARIFICATION_JSON',
    ].join('\n');
    expect(parseCodexClarificationAnswer(invalid)).toBeNull();
  });

  it('keeps one Pi session, uses read-only tools first, then enables implementation', async () => {
    const root = path.join(tmpdir(), `bridge-clarify-${Date.now()}-ready`);
    mkdirSync(root, { recursive: true });
    try {
      const pi = new QueuePiRunner([
        clarification(70, ['这个函数已有测试入口在哪里？']),
        clarification(97, []),
        completedWorkerOutput(),
      ]);
      const responder = new FixedResponder([{ status: 'answered', answers: ['运行 tests/unit/guide.test.ts'], reason: '仓库事实可确定', categories: ['technical'] }]);
      const worker = new PiRpcWorker(config(root, responder), pi);
      const result = await worker.executeTask({ taskSpec: task, worktreePath: root, runId: 'run-ready' });

      expect(result.workerResult?.status).toBe('completed');
      expect(responder.calls).toBe(1);
      expect(pi.calls).toHaveLength(3);
      expect(pi.calls[0].args).toContain('read,grep,find,ls');
      expect(pi.calls[1].args).toContain('read,grep,find,ls');
      expect(pi.calls[2].args).not.toContain('read,grep,find,ls');
      for (const call of pi.calls.slice(0, 2)) {
        expect(call.args).toEqual(expect.arrayContaining([
          '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve',
        ]));
        const extensionPath = call.args[call.args.indexOf('--extension') + 1];
        expect(extensionPath).toMatch(/bridge-clarification-guard\.mjs$/);
      }
      const sessionIds = pi.calls.map((call) => call.args[call.args.indexOf('--session-id') + 1]);
      expect(new Set(sessionIds).size).toBe(1);
      expect(pi.calls.every((call) => !call.args.includes('--no-session'))).toBe(true);
      expect(readdirSync(path.join(root, 'sessions')).some((name) => name.startsWith('pi-clarify-'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('native allowlist plus pre-execution guard fails closed on a forbidden tool request', async () => {
    const root = path.join(tmpdir(), `bridge-clarify-${Date.now()}-tool-block`);
    mkdirSync(root, { recursive: true });
    try {
      const rogueToolEvent = JSON.stringify({
        type: 'tool_execution_start', toolCallId: 'call-write', toolName: 'write',
        args: { path: 'docs/guide.md', content: 'must never execute' },
      }) + '\n' + clarification(99, []) + '\n';
      const pi = new StreamingQueuePiRunner([rogueToolEvent]);
      const worker = new PiRpcWorker(config(root, new FixedResponder([])), pi);
      const result = await worker.executeTask({ taskSpec: task, worktreePath: root, runId: 'run-tool-block' });

      expect(result.workerResult?.status).toBe('failed');
      expect(result.errorMessage).toContain('澄清工具策略违规');
      expect(pi.calls).toHaveLength(1);
      expect(existsSync(path.join(root, 'docs', 'guide.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('generated guard blocks forbidden, external, and write paths before tool execution', async () => {
    const root = path.join(tmpdir(), `bridge-clarify-${Date.now()}-guard`);
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    const marker = path.join(root, 'guard-blocked');
    const extensionPath = path.join(root, 'guard.mjs');
    writeFileSync(
      extensionPath,
      buildPiClarificationGuardExtensionSource(buildPiClarificationToolPolicy(root, task), marker),
      'utf8',
    );
    try {
      type GuardHandler = (
        event: { toolName: string; input: Record<string, unknown> },
        context: { cwd: string },
      ) => { block?: boolean; reason?: string } | undefined;
      let handler: GuardHandler | null = null;
      const module = await import(`${pathToFileURL(extensionPath).href}?${Date.now()}`) as {
        default: (pi: { on: (event: string, callback: GuardHandler) => void }) => void;
      };
      module.default({ on: (_event, callback) => { handler = callback; } });
      expect(handler).not.toBeNull();
      const invoke = (toolName: string, input: Record<string, unknown>) => handler!({ toolName, input }, { cwd: root });

      expect(invoke('read', { path: 'docs/guide.md' })).toBeUndefined();
      expect(invoke('read', { path: '.env' })?.block).toBe(true);
      expect(invoke('read', { path: '..' })?.block).toBe(true);
      expect(invoke('write', { path: 'docs/guide.md' })?.block).toBe(true);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a complete clarification streamed only through text_delta events', async () => {
    const root = path.join(tmpdir(), `bridge-clarify-${Date.now()}-delta`);
    mkdirSync(root, { recursive: true });
    try {
      const body: PiClarificationResult = {
        taskId: task.taskId,
        understandingSummary: '只修改授权文档并运行精确测试',
        confidencePercent: 97,
        questions: [],
        categories: ['technical'],
      };
      const marked = `BEGIN_CLARIFICATION_JSON\n${JSON.stringify(body)}\nEND_CLARIFICATION_JSON`;
      const split = [marked.slice(0, 11), marked.slice(11, 67), marked.slice(67)];
      const deltaOutput = split.map((delta) => JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      })).join('\n') + '\n';
      const pi = new StreamingQueuePiRunner([deltaOutput, completedWorkerOutput() + '\n']);
      const responder = new FixedResponder([]);
      const worker = new PiRpcWorker(config(root, responder), pi);
      const result = await worker.executeTask({ taskSpec: task, worktreePath: root, runId: 'run-delta' });

      expect(result.workerResult?.status).toBe('completed');
      expect(responder.calls).toBe(0);
      expect(pi.calls).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed before implementation and permits a fresh bounded retry when final confidence stays below 95% without questions', async () => {
    const root = path.join(tmpdir(), `bridge-clarify-${Date.now()}-pause`);
    mkdirSync(root, { recursive: true });
    try {
      const pi = new QueuePiRunner([
        clarification(60, ['问题一？']),
        clarification(80, ['问题二？']),
        clarification(94, []),
      ]);
      const responder = new FixedResponder([
        { status: 'answered', answers: ['回答一'], reason: '技术问题', categories: ['technical'] },
        { status: 'answered', answers: ['回答二'], reason: '技术问题', categories: ['technical'] },
      ]);
      const worker = new PiRpcWorker(config(root, responder), pi);
      const result = await worker.executeTask({ taskSpec: task, worktreePath: root, runId: 'run-pause' });

      expect(result.workerResult?.status).toBe('failed');
      expect(result.workerResult?.productDecisionRequired).toBe(false);
      expect(result.workerResult?.unresolvedQuestions).toEqual([]);
      expect(responder.calls).toBe(2);
      expect(pi.calls).toHaveLength(3);
      expect(pi.calls.every((call) => call.args.includes('read,grep,find,ls'))).toBe(true);
      expect(existsSync(path.join(root, 'docs', 'guide.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Codex clarifier fails closed when its structured output cannot be verified', async () => {
    const runner = new FakeCodexProcessRunner();
    runner.setDefaultResult({ stdout: 'not json', stderr: '', exitCode: 0, durationMs: 1 });
    const clarifier = new CodexTechnicalClarifier({ command: 'codex', args: ['exec', '-'], timeoutMs: 1000 }, runner);
    const answer = await clarifier.answerTechnicalQuestions({
      taskSpec: task,
      clarification: parsePiClarification(clarification(70, ['测试在哪里？']), task.taskId)!,
      round: 1,
      worktreePath: process.cwd(),
    });
    expect(answer.status).toBe('requires_user');
  });

  it('retries cleanup when a late writer recreates the temporary Pi session directory', async () => {
    const root = path.join(tmpdir(), `bridge-clarify-${Date.now()}-late-writer`);
    mkdirSync(root, { recursive: true });
    const interval = setInterval(() => mkdirSync(root, { recursive: true }), 10);
    const stop = setTimeout(() => clearInterval(interval), 140);
    try {
      expect(await cleanupTemporaryPiSession(root)).toBe(true);
      expect(existsSync(root)).toBe(false);
    } finally {
      clearInterval(interval);
      clearTimeout(stop);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
