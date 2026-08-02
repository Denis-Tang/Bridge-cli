import { describe, expect, it } from 'vitest';
import { CodexTechnicalClarifier } from '../../src/adapters/codex-technical-clarifier.js';
import { estimateForCallType } from '../../src/core/token-telemetry.js';
import type { InvocationContext, LedgerSink } from '../../src/core/token-telemetry.js';
import type { CodexProcessRunner } from '../../src/adapters/codex-process-runner.js';
import type { TaskSpec } from '../../src/types/protocol.js';
import type { PiClarificationResult } from '../../src/adapters/pi-clarification.js';

const taskSpec: TaskSpec = {
  taskId: 't1', title: 'T', goal: 'G',
  allowedPaths: ['src/'], forbiddenPaths: [], contextFiles: [],
  acceptanceChecks: ['builds'], allowedCommands: [], riskLevel: 'low',
  productDecisionsLocked: true, expectedOutputs: [],
  heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
} as unknown as TaskSpec;

const clarification: PiClarificationResult = {
  taskId: 't1', understandingSummary: 'S', confidencePercent: 80,
  questions: ['q1'], categories: ['technical'],
};

const ctx: InvocationContext = {
  runId: 'r1', stageId: 's1', taskId: 't1', attemptId: 'a1',
  callType: 'codex_clarification', callId: 'a1-clarify',
};

class RecordingSink implements LedgerSink {
  estimates: Array<{ ctx: InvocationContext; total: number }> = [];
  unavailable: string[] = [];
  confirmed: string[] = [];
  async writeEstimate(c: InvocationContext, total: number): Promise<string> {
    this.estimates.push({ ctx: c, total });
    return 'entry-' + this.estimates.length;
  }
  async confirmActual(entryId: string): Promise<void> { this.confirmed.push(entryId); }
  async markUnavailable(entryId: string): Promise<void> { this.unavailable.push(entryId); }
}

function runner(result: { exitCode: number; stdout: string; timedOut?: boolean }): CodexProcessRunner {
  return {
    async run() {
      return {
        exitCode: result.exitCode, stdout: result.stdout, stderr: '',
        timedOut: result.timedOut ?? false, durationMs: 5,
      };
    },
  } as unknown as CodexProcessRunner;
}

const answeredStdout = [
  'BEGIN_CODEX_CLARIFICATION_JSON',
  JSON.stringify({ status: 'answered', answers: ['a1'], reason: 'ok', categories: ['technical'] }),
  'END_CODEX_CLARIFICATION_JSON',
].join('\n');

describe('codex_clarification ledger (H3)', () => {
  it('estimates a clarification call type instead of falling through to the generic default', () => {
    const est = estimateForCallType('codex_clarification', { promptChars: 100 });
    // Generic fallback is a flat 1000/600/400 — a real estimator must differ.
    expect(est).not.toEqual({ total: 1000, input: 600, output: 400 });
    expect(est.total).toBeGreaterThan(0);
    expect(estimateForCallType('codex_clarification', { promptChars: 500 }).total)
      .toBeGreaterThan(est.total);
  });

  it('records one ledger entry per clarification round, marked unavailable', async () => {
    const sink = new RecordingSink();
    const clarifier = new CodexTechnicalClarifier(
      { command: 'codex', args: [], timeoutMs: 1000 },
      runner({ exitCode: 0, stdout: answeredStdout }),
      { ledgerSink: sink, invocationContext: ctx },
    );
    const answer = await clarifier.answerTechnicalQuestions({ taskSpec, clarification, round: 1, worktreePath: '.' });

    expect(answer.status).toBe('answered');
    expect(sink.estimates).toHaveLength(1);
    expect(sink.estimates[0].ctx.callType).toBe('codex_clarification');
    // Codex CLI returns no structured usage: never invent confirmed actuals.
    expect(sink.unavailable).toEqual(['entry-1']);
    expect(sink.confirmed).toEqual([]);
  });

  it('still records the attempted call when the clarification fails', async () => {
    const sink = new RecordingSink();
    const clarifier = new CodexTechnicalClarifier(
      { command: 'codex', args: [], timeoutMs: 1000 },
      runner({ exitCode: 1, stdout: '', timedOut: true }),
      { ledgerSink: sink, invocationContext: ctx },
    );
    const answer = await clarifier.answerTechnicalQuestions({ taskSpec, clarification, round: 1, worktreePath: '.' });

    expect(answer.status).toBe('requires_user');
    // A paid round was spent even though it produced no usable answer.
    expect(sink.estimates).toHaveLength(1);
    expect(sink.unavailable).toEqual(['entry-1']);
  });

  it('works with no sink attached (governance off) and does not throw', async () => {
    const clarifier = new CodexTechnicalClarifier(
      { command: 'codex', args: [], timeoutMs: 1000 },
      runner({ exitCode: 0, stdout: answeredStdout }),
    );
    const answer = await clarifier.answerTechnicalQuestions({ taskSpec, clarification, round: 1, worktreePath: '.' });
    expect(answer.status).toBe('answered');
  });

  it('a failing sink never changes clarification semantics', async () => {
    const brokenSink: LedgerSink = {
      async writeEstimate() { throw new Error('sink down'); },
      async confirmActual() { throw new Error('sink down'); },
      async markUnavailable() { throw new Error('sink down'); },
    };
    const clarifier = new CodexTechnicalClarifier(
      { command: 'codex', args: [], timeoutMs: 1000 },
      runner({ exitCode: 0, stdout: answeredStdout }),
      { ledgerSink: brokenSink, invocationContext: ctx },
    );
    const answer = await clarifier.answerTechnicalQuestions({ taskSpec, clarification, round: 1, worktreePath: '.' });
    expect(answer.status).toBe('answered');
  });
});
