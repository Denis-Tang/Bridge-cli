import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PiRpcWorker, cleanupTemporaryPiSession } from '../../src/adapters/pi-rpc-worker.js';
import { CodexTechnicalClarifier } from '../../src/adapters/codex-technical-clarifier.js';
import { FakeCodexProcessRunner } from '../../src/adapters/codex-process-runner.js';
import {
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
  };
}

describe('Pi 95% clarification protocol', () => {
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
      const sessionIds = pi.calls.map((call) => call.args[call.args.indexOf('--session-id') + 1]);
      expect(new Set(sessionIds).size).toBe(1);
      expect(pi.calls.every((call) => !call.args.includes('--no-session'))).toBe(true);
      expect(readdirSync(path.join(root, 'sessions')).some((name) => name.startsWith('pi-clarify-'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pauses before implementation after two unanswered rounds and final confirmation below 95%', async () => {
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

      expect(result.workerResult?.status).toBe('needs_decision');
      expect(result.workerResult?.productDecisionRequired).toBe(true);
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
