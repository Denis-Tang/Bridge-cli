// ── B: guard block-semantics probe tests ─────────────────────────────────
// Fake/injected runner only — NO real inference in tests. Covers the 5
// outcome classes (pass / guard_ineffective / provider_unavailable /
// probe_timeout / inconclusive) and the authorization + cache gate at the
// scheduler layer.

import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeProcessRunner, PiRpcWorker } from '../../src/adapters/pi-rpc-worker.js';
import {
  runGuardBlockProbe,
  buildGuardBlockProbePrompt,
  decideProbeSettleOutcome,
} from '../../src/adapters/pi-guard-block-probe.js';
import type { ProcessRunInput, ProcessRunResult } from '../../src/adapters/pi-worker-types.js';

class BlockProbeFakeRunner extends FakeProcessRunner {
  constructor(private mode: 'pass' | 'guard_ineffective' | 'provider_unavailable' | 'inconclusive' | 'timeout' | 'usage_429' | 'maybe_sent') { super(); }
  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    const extIdx = input.args.indexOf('--extension');
    const guardPath = extIdx >= 0 ? input.args[extIdx + 1] : '';
    const probeRoot = dirname(guardPath);
    const marker = join(probeRoot, 'guard-block-probe-violation');
    if (this.mode === 'timeout') {
      await new Promise((r) => setTimeout(r, 5000)); // exceeds probe timeout
    }
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    if (this.mode === 'pass') {
      try { writeFileSync(marker, 'blocked', { encoding: 'utf8', flag: 'wx' }); } catch { /* exists */ }
    } else if (this.mode === 'guard_ineffective') {
      // First layer failed: a violating tool actually started executing.
      stdout = JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'C:/definitely/outside/path.txt' } });
    } else if (this.mode === 'provider_unavailable') {
      stderr = '401 Unauthorized: invalid api key';
      exitCode = 1;
    } else if (this.mode === 'usage_429') {
      // Real provider usage evidence (non-zero tokens) + a rate-limit error:
      // money was provably spent AND the request reached the provider.
      stdout = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } } }] });
      stderr = '429 Too Many Requests';
      exitCode = 1;
    } else if (this.mode === 'maybe_sent') {
      // 429/rate-limit: request DID reach the provider (money may be spent).
      stderr = '429 rate limit exceeded';
      exitCode = 1;
    }
    // inconclusive: empty stdout, no marker, no error — model never requested the tool.
    return { pid: 4400, exitCode, stdout, stderr, timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: 1 };
  }
}

let markerDir: string;

beforeEach(() => {
  markerDir = path.join(tmpdir(), `guard-block-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(markerDir, { recursive: true });
});

function runProbe(mode: 'pass' | 'guard_ineffective' | 'provider_unavailable' | 'inconclusive' | 'timeout', timeoutMs = 400) {
  return runGuardBlockProbe({ markerDir, runner: new BlockProbeFakeRunner(mode), timeoutMs, model: 'deepseek/deepseek-v4-flash' });
}

describe('B guard block-semantics probe', () => {
  it('B1: guard really blocks the violating call → pass (violation marker appears)', async () => {
    const r = await runProbe('pass');
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe('pass');
    expect(r.failureCategory).toBeNull();
  });

  it('B2: violating tool_execution_start observed without block → guard_ineffective (first layer failed)', async () => {
    const r = await runProbe('guard_ineffective');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('guard_ineffective');
    expect(r.failureCategory).toBe('guard_ineffective');
  });

  it('B3: provider auth/balance/rate-limit failure → provider_unavailable, NOT guard failure', async () => {
    const r = await runProbe('provider_unavailable');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('provider_unavailable');
    expect(r.failureCategory).toBe('provider_unavailable');
    expect(r.stderrHash).toBeTypeOf('string');
  });

  it('B4: probe timeout → probe_timeout (treated as cannot-verify)', async () => {
    const r = await runProbe('timeout', 200);
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('probe_timeout');
  });

  it('B5: model never requested the tool → inconclusive (nothing to verify, NOT guard failure)', async () => {
    const r = await runProbe('inconclusive');
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe('inconclusive');
  });

  it('B13 (ledger): real provider usage (non-zero tokens) HARD-VETOES released even when outcome is provider_unavailable', async () => {
    const r = await runProbe('usage_429');
    expect(r.outcome).toBe('provider_unavailable');
    expect((r.providerUsage?.totalTokens ?? 0)).toBeGreaterThan(0); // money provably spent
    expect(r.neverSentEvidence).toBe(false);
    expect(decideProbeSettleOutcome(r)).toBe('unavailable'); // NOT released
  });

  it('B14 (ledger): stderr 429 rate-limit (no usage, request reached provider) settles unavailable, not released', async () => {
    const r = await runProbe('maybe_sent');
    expect(r.outcome).toBe('provider_unavailable');
    expect(r.neverSentEvidence).toBe(false); // 429 is a reached-provider signal
    expect(decideProbeSettleOutcome(r)).toBe('unavailable');
  });

  it('B6: probe prompt requests a read of a path OUTSIDE the probe root', () => {
    const prompt = buildGuardBlockProbePrompt('C:/probe/root', 'C:/outside/target.txt');
    expect(prompt).toContain('read');
    expect(prompt).toContain('C:/outside/target.txt');
    expect(prompt).not.toContain('C:/probe/root'); // root itself is not the target
  });

  it('B7: probe isolates its artifacts under markerDir (never a task worktree)', async () => {
    const worktree = path.join(markerDir, 'task-worktree');
    mkdirSync(worktree, { recursive: true });
    const r = await runProbe('pass');
    expect(r.markerRoot.startsWith(markerDir)).toBe(true);
    // artifacts cleaned up after the run
    expect(rmSyncAttempt(r.markerRoot)).toBe(false);
    expect(rmSyncAttempt(path.join(markerDir, 'guard-block-probe-target-outside.txt'))).toBe(false);
  });
});

function rmSyncAttempt(p: string): boolean {
  return existsSync(p);
}

describe('B PiRpcWorker integration — inference probe gate', () => {
  const task = {
    taskId: 'clarify-task', title: 't', goal: 'g', dependencies: [],
    allowedPaths: ['docs/guide.md'], forbiddenPaths: ['.env'], contextFiles: [],
    acceptanceChecks: [], allowedCommands: [], riskLevel: 'low',
    productDecisionsLocked: true, expectedOutputs: [], heavyCommandSlotsRequired: 0,
    timeoutSeconds: 120,
  };

  class FixedResponder {
    calls = 0;
    async answerTechnicalQuestions() { this.calls += 1; return { status: 'answered', answers: ['x'], reason: 'r', categories: ['technical'] }; }
  }

  class ClarifyOkRunner extends FakeProcessRunner {
    calls = 0;
    override async run(): Promise<ProcessRunResult> {
      this.calls += 1;
      const body = { taskId: task.taskId, understandingSummary: 'u', confidencePercent: 96, questions: [], categories: ['technical'] };
      const text = `BEGIN_CLARIFICATION_JSON\n${JSON.stringify(body)}\nEND_CLARIFICATION_JSON`;
      const stdout = JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text }] }] });
      return { pid: 4401, exitCode: 0, stdout, stderr: '', timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: 1 };
    }
  }

  // Zero-cost A-probe runner: writes the .loaded/.registered/.session markers
  // the A probe checks (a pass for the load+registration self-check).
  class ZeroCostProbeRunner extends FakeProcessRunner {
    override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
      const extIdx = input.args.indexOf('--extension');
      const probePath = extIdx >= 0 ? input.args[extIdx + 1] : '';
      const markerRoot = probePath.replace(/\.mjs$/, '');
      const write = (p2: string, c: string) => { try { writeFileSync(p2, c, { encoding: 'utf8', flag: 'wx' }); } catch { /* exists */ } };
      write(markerRoot + '.loaded', 'loaded');
      write(markerRoot + '.registered', 'registered');
      write(markerRoot + '.session', 'session');
      return { pid: 4400, exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: 1 };
    }
  }

  function makeWorker(opts: {
    runner: ProcessRunner;
    probeMode: 'pass' | 'guard_ineffective' | 'provider_unavailable' | 'inconclusive';
    inferenceEnabled: boolean;
    cacheOutcome: string | null;
    track: { reserve: number; settle: number; cacheSet: number; probeRuns: number; settleOutcome?: string };
  }): PiRpcWorker {
    const root = path.join(markerDir, `bworker-${Math.random().toString(36).slice(2)}`);
    const sessions = path.join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    return new PiRpcWorker({
      workerId: 'w', command: 'pi', args: ['--mode', 'rpc'],
      workingDirectory: root, sessionDirectory: sessions, rawLogPath: path.join(sessions, 'w.log'),
      timeoutMs: 5000, allowRealPiExecution: true, requireClarification: true,
      clarificationResponder: new FixedResponder() as never,
      guardSelfCheck: {
        markerDir,
        runner: new ZeroCostProbeRunner(), // zero-cost A probe always passes
        timeoutMs: 300,
        verifiedPiVersion: '0.82.1',
        inferenceProbe: {
          enabled: opts.inferenceEnabled,
          model: 'deepseek/deepseek-v4-flash',
          runner: new BlockProbeFakeRunner(opts.probeMode),
          timeoutMs: 300,
          reserveCost: async () => { opts.track.reserve += 1; return { allowed: true }; },
          settleCost: async (o) => { opts.track.settle += 1; opts.track.settleOutcome = o; return true; },
          cacheGet: async () => (opts.cacheOutcome ? { outcome: opts.cacheOutcome, failureCategory: null, checkedAt: new Date().toISOString() } : null),
          cacheSet: async () => { opts.track.cacheSet += 1; },
          onResult: async () => { opts.track.probeRuns += 1; },
        },
      },
    }, opts.runner);
  }

  function worktreeOf(worker: PiRpcWorker): string {
    return (worker as unknown as { config: { workingDirectory: string } }).config.workingDirectory;
  }

  it('B8: inference probe NOT authorized (default) → never runs, no cost reserved', async () => {
    const track = { reserve: 0, settle: 0, cacheSet: 0, probeRuns: 0 };
    const clarifier = new ClarifyOkRunner();
    const worker = makeWorker({ runner: clarifier, probeMode: 'pass', inferenceEnabled: false, cacheOutcome: null, track });
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: worktreeOf(worker), runId: 'run-b8' });
    expect(track.reserve).toBe(0);
    expect(track.probeRuns).toBe(0);
    expect(clarifier.calls).toBeGreaterThan(0); // clarification proceeded with zero-cost A only
  });

  it('B9: cached pass for this Pi version → probe reused, NO money spent', async () => {
    const track = { reserve: 0, settle: 0, cacheSet: 0, probeRuns: 0 };
    const clarifier = new ClarifyOkRunner();
    const worker = makeWorker({ runner: clarifier, probeMode: 'pass', inferenceEnabled: true, cacheOutcome: 'pass', track });
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: worktreeOf(worker), runId: 'run-b9' });
    expect(track.reserve).toBe(0);
    expect(track.settle).toBe(0);
    expect(clarifier.calls).toBeGreaterThan(0);
  });

  it('B10: authorized + no cache → probe runs (cost reserved + settled + cached), pass proceeds', async () => {
    const track = { reserve: 0, settle: 0, cacheSet: 0, probeRuns: 0 };
    const clarifier = new ClarifyOkRunner();
    const worker = makeWorker({ runner: clarifier, probeMode: 'pass', inferenceEnabled: true, cacheOutcome: null, track });
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: worktreeOf(worker), runId: 'run-b10' });
    expect(track.reserve).toBe(1);
    expect(track.settle).toBe(1);
    expect(track.cacheSet).toBe(1);
    expect(track.probeRuns).toBe(1);
    expect(clarifier.calls).toBeGreaterThan(0);
  });

  it('B11 (hard guard): guard_ineffective → refuse to start (read-only boundary broken), runner NOT reached', async () => {
    const track = { reserve: 0, settle: 0, cacheSet: 0, probeRuns: 0 };
    class NeverRunner extends FakeProcessRunner {
      calls = 0;
      override async run(): Promise<ProcessRunResult> { this.calls += 1; throw new Error('must not run'); }
    }
    const runner = new NeverRunner();
    const worker = makeWorker({ runner, probeMode: 'guard_ineffective', inferenceEnabled: true, cacheOutcome: null, track });
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: worktreeOf(worker), runId: 'run-b11' });
    expect(track.reserve).toBe(1);
    expect(result.workerResult?.status).toBe('failed');
    expect(result.workerResult?.summary).toContain('guard 阻断失效');
    expect(runner.calls).toBe(0);
  });

  it('B15 (ledger, integration): 429 rate-limit settles UNAVAILABLE (not released) while wording stays "cannot verify"', async () => {
    const track = { reserve: 0, settle: 0, cacheSet: 0, probeRuns: 0 };
    class NeverRunner extends FakeProcessRunner {
      calls = 0;
      override async run(): Promise<ProcessRunResult> { this.calls += 1; throw new Error('must not run'); }
    }
    const runner = new NeverRunner();
    const worker = makeWorker({ runner, probeMode: 'maybe_sent', inferenceEnabled: true, cacheOutcome: null, track });
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: worktreeOf(worker), runId: 'run-b15' });
    expect(track.settle).toBe(1);
    expect(track.settleOutcome).toBe('unavailable'); // conservative ledger
    expect(result.workerResult?.summary).toContain('无法验证'); // wording unchanged
    expect(result.workerResult?.summary).not.toContain('guard 阻断失效');
    expect(runner.calls).toBe(0);
  });

  it('B12: provider_unavailable → pause with "cannot verify" wording (NOT guard failure)', async () => {
    const track = { reserve: 0, settle: 0, cacheSet: 0, probeRuns: 0 };
    class NeverRunner extends FakeProcessRunner {
      calls = 0;
      override async run(): Promise<ProcessRunResult> { this.calls += 1; throw new Error('must not run'); }
    }
    const runner = new NeverRunner();
    const worker = makeWorker({ runner, probeMode: 'provider_unavailable', inferenceEnabled: true, cacheOutcome: null, track });
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: worktreeOf(worker), runId: 'run-b12' });
    expect(result.workerResult?.status).toBe('failed');
    expect(result.workerResult?.summary).toContain('无法验证');
    expect(result.workerResult?.summary).not.toContain('guard 阻断失效'); // distinct from B11 wording
    expect(runner.calls).toBe(0);
    // provider_unavailable is settled as released (proven no money spent)
    expect(track.settle).toBe(1);
  });
});
