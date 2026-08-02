import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PiRpcWorker, FakeProcessRunner, RealProcessRunner, parsePiProviderUsageFromJsonl } from '../../src/adapters/pi-rpc-worker.js';
import type { PiWorkerConfig, PiWorkerTaskInput, ProcessRunInput, ProcessRunResult, ProcessRunner } from '../../src/adapters/pi-worker-types.js';
import type { TaskSpec } from '../../src/types/protocol.js';

let tmpDir: string;
let sessionDir: string;

const sampleTaskSpec: TaskSpec = {
  taskId: 'test-task-001',
  title: '测试任务',
  goal: '验证 Worker 适配器',
  dependencies: [],
  allowedPaths: ['docs/'],
  forbiddenPaths: ['.env'],
  contextFiles: [],
  acceptanceChecks: ['任务完成'],
  allowedCommands: ['git diff'],
  riskLevel: 'low',
  productDecisionsLocked: true,
  expectedOutputs: ['WorkerResult'],
  heavyCommandSlotsRequired: 0,
  timeoutSeconds: 600,
};

function createWorkerConfig(overrides?: Partial<PiWorkerConfig>): PiWorkerConfig {
  return {
    workerId: 'test-worker',
    command: 'echo',
    args: ['hello'],
    workingDirectory: tmpDir,
    sessionDirectory: sessionDir,
    rawLogPath: path.join(sessionDir, 'test-run.log'),
    timeoutMs: 5000,
    allowRealPiExecution: false,
    ...overrides,
  };
}

function createTaskInput(overrides?: Partial<PiWorkerTaskInput>): PiWorkerTaskInput {
  return {
    taskSpec: sampleTaskSpec,
    worktreePath: tmpDir,
    runId: 'test-run-001',
    ...overrides,
  };
}

const validWorkerResultJson = {
  taskId: 'test-task-001',
  status: 'completed',
  summary: '任务完成',
  filesChanged: ['docs/guide.md'],
  commitHash: 'abc1234',
  checks: [{ name: 'scope', status: 'passed', summary: 'ok' }],
  scopeViolations: [],
  risks: [],
  unresolvedQuestions: [],
  productDecisionRequired: false,
  tokenUsage: { inputTokens: 100, outputTokens: 200, cacheHitTokens: 0 },
};

describe('PiRpcWorker', () => {
  beforeAll(() => {
    tmpDir = path.join(tmpdir(), `brainctl-pi-test-${Date.now()}`);
    sessionDir = path.join(tmpDir, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('with FakeProcessRunner', () => {
    it('extracts provider-confirmed usage once from repeated JSONL events', () => {
      const first = {
        role: 'assistant', id: 'm1',
        usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, totalTokens: 120, cost: { total: 0.00002 } },
      };
      const second = {
        role: 'assistant', id: 'm2',
        usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 5, totalTokens: 60, cost: { total: 0.00001 } },
      };
      const output = [
        JSON.stringify({ type: 'message_end', message: first }),
        JSON.stringify({ type: 'message_update', message: first }),
        JSON.stringify({ type: 'message_end', message: second }),
        JSON.stringify({ type: 'agent_end', messages: [first, second] }),
        JSON.stringify({ type: 'agent_end', messages: [first, second] }),
      ].join('\n');

      const usage = parsePiProviderUsageFromJsonl(output);
      expect(usage).toMatchObject({
        inputTokens: 150,
        outputTokens: 30,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        totalTokens: 180,
      });
      expect(usage?.costTotal).toBeCloseTo(0.00003, 10);
    });

    it('returns provider usage separately from an agent self-report', async () => {
      const fakeRunner = new FakeProcessRunner();
      const assistantMessage = {
        role: 'assistant', id: 'provider-message',
        content: 'BEGIN_WORKER_RESULT_JSON\n' + JSON.stringify(validWorkerResultJson) + '\nEND_WORKER_RESULT_JSON',
        usage: { input: 321, output: 45, cacheRead: 123, cacheWrite: 0, totalTokens: 366, cost: { total: 0.000123 } },
      };
      fakeRunner.setDefaultResult({
        exitCode: 0,
        stdout: JSON.stringify({ type: 'agent_end', messages: [assistantMessage] }),
        stderr: '', timedOut: false, aborted: false, durationMs: 10,
      });

      const worker = new PiRpcWorker(createWorkerConfig({ allowRealPiExecution: true }), fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.workerResult?.tokenUsage.inputTokens).toBe(100);
      expect(result.providerUsage).toEqual({
        inputTokens: 321, outputTokens: 45, cacheReadTokens: 123,
        cacheWriteTokens: 0, totalTokens: 366, costTotal: 0.000123,
      });
      const log = readFileSync(result.rawLogPath, 'utf-8');
      expect(log).toContain('"totalTokens":366');
      expect(log).not.toContain('provider-message');
      expect(log).not.toContain('BEGIN_WORKER_RESULT_JSON');
      expect(existsSync(path.join(sessionDir, 'test-task-001_prompt.txt'))).toBe(false);
    });

    it('executes successfully and returns parsed WorkerResult', async () => {
      const fakeRunner = new FakeProcessRunner();
      const markedOutput = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(validWorkerResultJson),
        'END_WORKER_RESULT_JSON',
      ].join('\n');
      fakeRunner.setDefaultResult({
        exitCode: 0,
        stdout: markedOutput,
        stderr: '',
        timedOut: false,
        aborted: false,
        durationMs: 100,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.workerResult).not.toBeNull();
      expect(result.workerResult!.status).toBe('completed');
      expect(result.workerResult!.taskId).toBe('test-task-001');
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
    });

    it('CANCEL-01 surfaces PID through onProcessSpawn before completion', async () => {
      const fakeRunner = new FakeProcessRunner();
      const markedOutput = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(validWorkerResultJson),
        'END_WORKER_RESULT_JSON',
      ].join('\n');
      fakeRunner.setDefaultResult({
        pid: 43210,
        exitCode: 0,
        stdout: markedOutput,
        stderr: '',
        timedOut: false,
        aborted: false,
        terminatedAfterWorkerResult: false,
        durationMs: 100,
      });
      const spawned: number[] = [];
      const config = createWorkerConfig({
        allowRealPiExecution: true,
        onProcessSpawn(pid) {
          spawned.push(pid);
        },
      });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(spawned).toEqual([43210]);
      expect(result.pid).toBe(43210);
      expect(result.workerResult!.status).toBe('completed');
    });

    it('returns failure when Pi outputs invalid JSON', async () => {
      const fakeRunner = new FakeProcessRunner();
      fakeRunner.setDefaultResult({
        exitCode: 0,
        stdout: 'Some random output without JSON markers',
        stderr: '',
        timedOut: false,
        aborted: false,
        durationMs: 50,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.workerResult).toBeNull();
      expect(result.errorMessage).toBeTruthy();
    });

    it('detects timeout', async () => {
      const fakeRunner = new FakeProcessRunner();
      fakeRunner.setDefaultResult({
        exitCode: null,
        stdout: 'timed out',
        stderr: '',
        timedOut: true,
        aborted: false,
        durationMs: 5000,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.timedOut).toBe(true);
      expect(result.workerResult).toBeNull();
    });

    it('returns schema validation errors for missing status', async () => {
      const fakeRunner = new FakeProcessRunner();
      const invalidResult = { ...validWorkerResultJson };
      delete (invalidResult as any).status;
      const markedOutput = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(invalidResult),
        'END_WORKER_RESULT_JSON',
      ].join('\n');
      fakeRunner.setDefaultResult({
        exitCode: 0,
        stdout: markedOutput,
        stderr: '',
        timedOut: false,
        aborted: false,
        durationMs: 50,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.workerResult).toBeNull();
      expect(result.errorMessage).toContain('WorkerResult');
    });

    it('handles non-zero exit code', async () => {
      const fakeRunner = new FakeProcessRunner();
      fakeRunner.setDefaultResult({
        exitCode: 1,
        stdout: 'Error occurred',
        stderr: 'Something went wrong',
        timedOut: false,
        aborted: false,
        durationMs: 50,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.exitCode).toBe(1);
    });
  });

  describe('safety mode', () => {
    it('returns error when allowRealPiExecution is false (default)', async () => {
      const config = createWorkerConfig({ allowRealPiExecution: false });
      const worker = new PiRpcWorker(config);
      const result = await worker.executeTask(createTaskInput());

      expect(result.workerResult).toBeNull();
      expect(result.errorMessage).toContain('allowRealPiExecution');
    });

    it('writes prompt file even in safe mode', async () => {
      const config = createWorkerConfig({ allowRealPiExecution: false });
      const worker = new PiRpcWorker(config);
      await worker.executeTask(createTaskInput());

      const promptPath = path.join(sessionDir, 'test-task-001_prompt.txt');
      expect(existsSync(promptPath)).toBe(true);
      const promptContent = readFileSync(promptPath, 'utf-8');
      expect(promptContent).toContain('施工单');
    });
  });

  describe('early-complete and timeout handling', () => {
    it('processes a multi-megabyte agent_end line once and keeps only bounded stdout', async () => {
      const highVolumeLogPath = path.join(sessionDir, 'high-volume-stream.log');
      class HighVolumeJsonlRunner implements ProcessRunner {
        observedCaptureLimit: number | undefined;

        async run(input: ProcessRunInput): Promise<ProcessRunResult> {
          this.observedCaptureLimit = input.maxCapturedStdoutChars;
          const markedResult = 'BEGIN_WORKER_RESULT_JSON\n' + JSON.stringify(validWorkerResultJson) + '\nEND_WORKER_RESULT_JSON';
          const assistantMessage = {
            role: 'assistant', id: 'high-volume-provider-message',
            content: [
              { type: 'text', text: 'x'.repeat(6 * 1024 * 1024) },
              { type: 'text', text: markedResult },
            ],
            usage: { input: 900, output: 100, cacheRead: 500, cacheWrite: 0, totalTokens: 1000, cost: { total: 0.0025 } },
          };
          const jsonl = JSON.stringify({ type: 'agent_end', messages: [assistantMessage] }) + '\n';
          let terminated = false;
          for (let offset = 0; offset < jsonl.length; offset += 4096) {
            const chunk = jsonl.slice(offset, offset + 4096);
            const signal = input.onStdoutChunk?.(chunk, '');
            if (signal?.terminateProcess) {
              terminated = true;
              break;
            }
          }
          const captureLimit = input.maxCapturedStdoutChars ?? jsonl.length;
          return {
            pid: 24680,
            exitCode: terminated ? null : 0,
            stdout: jsonl.slice(-captureLimit),
            stderr: '',
            stdoutLength: jsonl.length,
            stderrLength: 0,
            timedOut: false,
            aborted: false,
            terminatedAfterWorkerResult: terminated,
            durationMs: 25,
          };
        }
      }

      const runner = new HighVolumeJsonlRunner();
      const worker = new PiRpcWorker(createWorkerConfig({
        allowRealPiExecution: true,
        rawLogPath: highVolumeLogPath,
      }), runner);
      const result = await worker.executeTask(createTaskInput());

      expect(runner.observedCaptureLimit).toBe(1_048_576);
      expect(result.workerResult?.status).toBe('completed');
      expect(result.providerUsage).toEqual({
        inputTokens: 900, outputTokens: 100, cacheReadTokens: 500,
        cacheWriteTokens: 0, totalTokens: 1000, costTotal: 0.0025,
      });
      const log = readFileSync(highVolumeLogPath, 'utf-8');
      expect(log).toContain('captured 1048576');
      expect(log).not.toContain('high-volume-provider-message');
    }, 15_000);

    it('keeps WorkerResult detection bounded after historical agent_end events', async () => {
      const boundedLogPath = path.join(sessionDir, 'bounded-stream.log');
      class ChunkedJsonlRunner implements ProcessRunner {
        async run(input: ProcessRunInput): Promise<ProcessRunResult> {
          const historical = JSON.stringify({
            type: 'agent_end',
            messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Historical clarification only' }] }],
          }) + '\n';
          const noise = Array.from({ length: 200 }, (_, index) => JSON.stringify({
            type: 'message_update',
            assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `noise-${index}` },
          }) + '\n');
          const markedResult = 'BEGIN_WORKER_RESULT_JSON\n' + JSON.stringify(validWorkerResultJson) + '\nEND_WORKER_RESULT_JSON';
          const finalSplit = [markedResult.slice(0, 17), markedResult.slice(17, 71), markedResult.slice(71)]
            .map((delta) => JSON.stringify({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
            }) + '\n');
          let stdout = '';
          let terminated = false;
          for (const chunk of [historical, ...noise, ...finalSplit]) {
            stdout += chunk;
            const signal = input.onStdoutChunk?.(chunk, stdout);
            if (signal?.terminateProcess) {
              terminated = true;
              break;
            }
          }
          return {
            pid: 12345,
            exitCode: terminated ? null : 0,
            stdout,
            stderr: '',
            timedOut: false,
            aborted: false,
            terminatedAfterWorkerResult: terminated,
            durationMs: 10,
          };
        }
      }

      const config = createWorkerConfig({
        allowRealPiExecution: true,
        rawLogPath: boundedLogPath,
      });
      const worker = new PiRpcWorker(config, new ChunkedJsonlRunner());
      const result = await worker.executeTask(createTaskInput());
      const debugChecks = (readFileSync(boundedLogPath, 'utf-8').match(/DEBUG parse check:/g) ?? []).length;

      expect(result.workerResult?.status).toBe('completed');
      expect(result.workerResult?.taskId).toBe('test-task-001');
      expect(result.errorMessage).toBeUndefined();
      expect(debugChecks).toBeLessThan(10);
    });

    it('parses WorkerResult from JSONL agent_end event', async () => {
      const fakeRunner = new FakeProcessRunner();
      const agentEndEvent = JSON.stringify({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          content: [
            { type: 'text', text: 'BEGIN_WORKER_RESULT_JSON\n' + JSON.stringify(validWorkerResultJson) + '\nEND_WORKER_RESULT_JSON' }
          ]
        }]
      });
      fakeRunner.setDefaultResult({
        exitCode: 0,
        stdout: agentEndEvent + '\n',
        stderr: '',
        timedOut: false,
        aborted: false,
        terminatedAfterWorkerResult: false,
        durationMs: 5000,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.workerResult).not.toBeNull();
      expect(result.workerResult!.status).toBe('completed');
      expect(result.workerResult!.taskId).toBe('test-task-001');
    });

    it('returns WorkerResult even when timedOut but result was parsed', async () => {
      const fakeRunner = new FakeProcessRunner();
      const agentEndEvent = JSON.stringify({
        type: 'agent_end',
        messages: [{
          role: 'assistant',
          content: [
            { type: 'text', text: 'BEGIN_WORKER_RESULT_JSON\n' + JSON.stringify(validWorkerResultJson) + '\nEND_WORKER_RESULT_JSON' }
          ]
        }]
      });
      fakeRunner.setDefaultResult({
        exitCode: null,
        stdout: agentEndEvent + '\n',
        stderr: '',
        timedOut: true,
        aborted: false,
        terminatedAfterWorkerResult: true,
        durationMs: 60000,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      // Should still succeed because WorkerResult was found
      expect(result.workerResult).not.toBeNull();
      expect(result.workerResult!.status).toBe('completed');
    });

    it('fails on timedOut without WorkerResult', async () => {
      const fakeRunner = new FakeProcessRunner();
      fakeRunner.setDefaultResult({
        exitCode: null,
        stdout: 'only some text without markers',
        stderr: '',
        timedOut: true,
        aborted: false,
        terminatedAfterWorkerResult: false,
        durationMs: 60000,
      });

      const config = createWorkerConfig({ allowRealPiExecution: true });
      const worker = new PiRpcWorker(config, fakeRunner);
      const result = await worker.executeTask(createTaskInput());

      expect(result.workerResult).toBeNull();
      expect(result.errorMessage).toBeTruthy();
    });
  });

  describe('RealProcessRunner lifecycle', () => {
    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it('delivers each stdout chunk to the observer exactly once', async () => {
      const runner = new RealProcessRunner();
      const observedChunks: string[] = [];
      const script = [
        'process.stdout.write("one\\n");',
        'setTimeout(() => { process.stdout.write("two\\n"); }, 40);',
        'setTimeout(() => process.exit(0), 100);',
      ].join('');

      const result = await runner.run({
        command: process.execPath,
        args: ['-e', script],
        cwd: tmpDir,
        timeoutMs: 5000,
        onStdoutChunk(chunk) {
          observedChunks.push(chunk);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(observedChunks.length).toBeGreaterThan(0);
      expect(observedChunks.every((chunk) => chunk.length > 0)).toBe(true);
      expect(observedChunks.join('')).toBe(result.stdout);
    });

    it('bounds retained stdout while reporting the full observed length', async () => {
      const runner = new RealProcessRunner();
      const totalChars = 2 * 1024 * 1024;
      const result = await runner.run({
        command: process.execPath,
        args: ['-e', `process.stdout.write('x'.repeat(${totalChars}))`],
        cwd: tmpDir,
        timeoutMs: 5000,
        maxCapturedStdoutChars: 64 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdoutLength).toBe(totalChars);
      expect(result.stdout.length).toBe(64 * 1024);
    });

    it('CANCEL-02 aborts a controlled process tree and waits for exit', async () => {
      const pidFile = path.join(tmpDir, `child-${Date.now()}.txt`);
      const controller = new AbortController();
      const runner = new RealProcessRunner();
      let parentPid: number | null = null;
      const script = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        'setInterval(() => {}, 1000);',
      ].join('');

      const running = runner.run({
        command: process.execPath,
        args: ['-e', script],
        cwd: tmpDir,
        timeoutMs: 10000,
        signal: controller.signal,
        onSpawn(pid) {
          parentPid = pid;
          setTimeout(() => controller.abort(), 250);
        },
      });

      const result = await running;
      const childPid = Number(readFileSync(pidFile, 'utf-8'));

      expect(result.aborted).toBe(true);
      expect(result.pid).toBe(parentPid);
      expect(parentPid == null ? false : isAlive(parentPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
    });
  });
});
