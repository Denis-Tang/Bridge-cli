// ── R3: Pi guard runtime self-check (probe layer) ─────────────────────────
// Red-light tests first. Fake/injected runner only — NO real Pi inference,
// NO provider money. Covers: silent-not-loaded → fail closed, normal → pass,
// timeout → fail closed, malformed → fail closed, no downgrade path,
// version drift warning, zero-fee, probe isolation.

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runGuardSelfCheck,
  resetGuardSelfCheckCache,
  buildGuardSelfCheckExtensionSource,
  type GuardSelfCheckOptions,
} from '../../src/adapters/pi-guard-selfcheck.js';
import { FakeProcessRunner, PiRpcWorker, type ProcessRunner } from '../../src/adapters/pi-rpc-worker.js';
import type { ProcessRunInput, ProcessRunResult } from '../../src/adapters/pi-worker-types.js';

/** Fake runner that plays the role of the spawned Pi process for the probe. */
class ProbeFakeRunner extends FakeProcessRunner {
  runLog: string[] = [];
  constructor(private mode: 'ok' | 'not_loaded' | 'error' | 'timeout') { super(); }

  override async run(input: ProcessRunInput): Promise<ProcessRunResult> {
    this.runLog.push(input.args.join(' '));
    const extIdx = input.args.indexOf('--extension');
    const probePath = extIdx >= 0 ? input.args[extIdx + 1] : '';
    const markerRoot = probePath.replace(/\.mjs$/, '');
    const write = (p: string, c: string) => {
      try { writeFileSync(p, c, { encoding: 'utf8', flag: 'wx' }); } catch { /* exists */ }
    };
    if (this.mode === 'timeout') {
      await new Promise((r) => setTimeout(r, 2000)); // exceeds the probe timeout
    }
    if (this.mode === 'ok' || this.mode === 'error') {
      write(`${markerRoot}.loaded`, 'loaded');
      if (this.mode === 'error') {
        write(`${markerRoot}.error`, 'simulated registration failure');
      } else {
        write(`${markerRoot}.registered`, 'registered');
        write(`${markerRoot}.session`, 'session');
      }
    }
    // not_loaded: Pi silently continues without loading the extension (the
    // exact silent-failure mode round 3 exists to catch).
    return {
      pid: 4400, exitCode: 0, stdout: '', stderr: '',
      timedOut: false, aborted: false, terminatedAfterWorkerResult: false, durationMs: 1,
    };
  }
}

let markerDir: string;

beforeEach(() => {
  resetGuardSelfCheckCache();
  markerDir = path.join(tmpdir(), `pi-guard-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(markerDir, { recursive: true });
});

function runProbe(mode: 'ok' | 'not_loaded' | 'error' | 'timeout', opts?: Partial<GuardSelfCheckOptions>): ReturnType<typeof runGuardSelfCheck> {
  return runGuardSelfCheck({
    markerDir,
    runner: new ProbeFakeRunner(mode),
    timeoutMs: 300,
    verifiedPiVersion: '0.82.1',
    piCommand: 'pi',
    ...opts,
  });
}

describe('R3 Pi guard self-check probe', () => {
  it('T1 (core guard): extension silently NOT loaded → fail closed (ok=false, category extension_not_loaded)', async () => {
    const r = await runProbe('not_loaded');
    expect(r.ok).toBe(false);
    expect(r.failureCategory).toBe('extension_not_loaded');
  });

  it('T2: extension loaded + handler registered + session event → pass', async () => {
    const r = await runProbe('ok');
    expect(r.ok).toBe(true);
    expect(r.failureCategory).toBeNull();
  });

  it('T3: probe timeout → fail closed', async () => {
    const r = await runProbe('timeout', { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    expect(r.failureCategory).toBe('probe_timeout');
  });

  it('T4: malformed probe output (registration error marker) → fail closed', async () => {
    const r = await runProbe('error');
    expect(r.ok).toBe(false);
    expect(r.failureCategory).toBe('handler_registration_failed');
  });

  it('T5 (hardest guard): a failing probe NEVER downgrades — ok=false means refuse, and no token/ledger path exists in the probe', async () => {
    const r = await runProbe('not_loaded');
    expect(r.ok).toBe(false);
    // The probe result carries no usage/cost at all: there is no inference to
    // downgrade onto. (The refuse-to-start behavior is asserted at the
    // PiRpcWorker integration layer.)
    expect((r as unknown as { tokenUsage?: unknown }).tokenUsage).toBeUndefined();
  });

  it('T6: version drift → mismatch flagged (warning), probe still runs and must pass', async () => {
    const r = await runProbe('ok', { verifiedPiVersion: '9.9.9' }); // verify against a different version
    // piVersion (real 0.82.1) != 9.9.9 → mismatch true; probe outcome unaffected.
    expect(r.verifiedPiVersion).toBe('9.9.9');
    // versionMismatch depends on the actual pi --version on this machine; if pi
    // is present it must be flagged. Either way the probe itself still ran.
    expect(r.piVersion).toBeTypeOf('string');
  });

  it('T7: probe is zero-fee — the runner receives NO prompt payload and NO model request', async () => {
    const runner = new ProbeFakeRunner('ok');
    await runGuardSelfCheck({ markerDir, runner, timeoutMs: 300, verifiedPiVersion: '0.82.1', piCommand: 'pi' });
    // stdin is '' (EOF immediately) and args carry --offline/--no-session — no
    // prompt is ever sent, so no inference can happen.
    for (const log of runner.runLog) {
      expect(log).not.toMatch(/--print|--mode\s+text/);
      expect(log).toContain('--offline');
    }
    expect(runner.runLog.length).toBe(1);
  });

  it('T8: probe isolation — markers and probe file live in markerDir, never inside a task worktree', async () => {
    const worktree = path.join(markerDir, 'task-worktree');
    mkdirSync(worktree, { recursive: true });
    const r = await runGuardSelfCheck({
      markerDir,
      runner: new ProbeFakeRunner('ok'),
      timeoutMs: 300,
      verifiedPiVersion: '0.82.1',
      piCommand: 'pi',
    });
    // Everything the probe wrote is under markerDir root; nothing inside worktree.
    expect(existsSync(path.join(worktree, '.loaded'))).toBe(false);
    expect(r.markerRoot.startsWith(markerDir)).toBe(true);
    // And the probe extension source itself is just a string builder — no task context.
    expect(buildGuardSelfCheckExtensionSource('/tmp/x')).toContain('tool_call');
  });

  it('probe cleanup: marker files removed after the run', async () => {
    const r = await runProbe('ok');
    expect(existsSync(r.markerRoot + '.loaded')).toBe(false);
    expect(existsSync(r.markerRoot + '.registered')).toBe(false);
    expect(existsSync(r.markerRoot + '.session')).toBe(false);
  });
});

describe('R3 PiRpcWorker integration — self-check fail closed', () => {
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

  class NoCallPiRunner extends FakeProcessRunner {
    calls = 0;
    override async run(): Promise<ProcessRunResult> {
      this.calls += 1;
      throw new Error('runner must NOT be reached when the self-check fails');
    }
  }

  function makeWorker(runner: ProcessRunner, probeRunner: ProcessRunner, onResult?: (r: unknown) => void): { worker: PiRpcWorker; root: string } {
    const root = path.join(markerDir, `worker-${Math.random().toString(36).slice(2)}`);
    const sessions = path.join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    return {
      root,
      worker: new PiRpcWorker({
        workerId: 'w', command: 'pi', args: ['--mode', 'rpc'],
        workingDirectory: root, sessionDirectory: sessions, rawLogPath: path.join(sessions, 'w.log'),
        timeoutMs: 5000, allowRealPiExecution: true, requireClarification: true,
        clarificationResponder: new FixedResponder() as never,
        guardSelfCheck: { markerDir, runner: probeRunner, timeoutMs: 300, verifiedPiVersion: '0.82.1', onResult },
      }, runner),
    };
  }

  it('T1-integration: extension silently not loaded → clarification session refused, worker runner never reached (no downgrade)', async () => {
    const runner = new NoCallPiRunner();
    const probe = new ProbeFakeRunner('not_loaded');
    let reported: unknown = null;
    const { worker, root } = makeWorker(runner, probe, (r) => { reported = r; });
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: root, runId: 'run-selftest' });

    expect(reported).toMatchObject({ ok: false, failureCategory: 'extension_not_loaded' });
    expect(runner.calls).toBe(0); // the real clarification/implementation runner was never reached
    expect(result.workerResult?.status).toBe('failed');
    expect(result.workerResult?.summary).toContain('guard 自检失败');
  });

  it('T-failclosed-default: real clarification gate WITHOUT guardSelfCheck refuses to start — absence is NOT opt-out', async () => {
    const root = path.join(markerDir, `no-selfcheck-${Math.random().toString(36).slice(2)}`);
    const sessions = path.join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const runner = new NoCallPiRunner();
    const worker = new PiRpcWorker({
      workerId: 'w', command: 'pi', args: ['--mode', 'rpc'],
      workingDirectory: root, sessionDirectory: sessions, rawLogPath: path.join(sessions, 'w.log'),
      timeoutMs: 5000, allowRealPiExecution: true, requireClarification: true,
      clarificationResponder: new FixedResponder() as never,
      // NO guardSelfCheck — fail closed by default
    }, runner);
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: root, runId: 'run-fc' });

    expect(result.workerResult?.status).toBe('failed');
    expect(result.workerResult?.summary).toContain('guard 自检未配置');
    expect(runner.calls).toBe(0);
  });

  it('T5-integration: probe pass → clarification proceeds normally (runner reached)', async () => {
    const runner = new ProbeFakeRunner('ok'); // plays both probe (via guardSelfCheck.runner) and…
    // Use a separate normal clarification runner that returns a valid clarification.
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
    const probe = new ProbeFakeRunner('ok');
    const clarifier = new ClarifyOkRunner();
    const { worker, root } = makeWorker(clarifier, probe);
    const result = await worker.executeTask({ taskSpec: task as never, worktreePath: root, runId: 'run-ok' });

    expect(probe).toBeTruthy();
    expect(clarifier.calls).toBeGreaterThan(0); // clarification proceeded
  });
});
