import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RealCodexProcessRunner,
  parseCodexJsonlUsage,
  extractCodexJsonlMessageText,
  type CodexProcessRunner,
  type CodexProcessRunResult,
} from '../../src/adapters/codex-process-runner.js';
import { CodexCliReviewer } from '../../src/adapters/codex-cli-reviewer.js';
import { CodexCliBrain } from '../../src/adapters/codex-cli-brain.js';
import { CodexTechnicalClarifier } from '../../src/adapters/codex-technical-clarifier.js';
import type { LedgerSink, InvocationContext } from '../../src/core/token-telemetry.js';
import type { TaskSpec } from '../../src/types/protocol.js';
import type { PiClarificationResult } from '../../src/adapters/pi-clarification.js';

// ── fixtures (raw shapes captured from a real `codex exec --json` probe) ──

const fixtureDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures');
const readFixture = (name: string): string => readFileSync(join(fixtureDir, name), 'utf8');

// ── helpers ──

/** Build a Codex CLI `--json` JSONL envelope around arbitrary model text. */
function jsonlEnvelope(text: string, usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }): string {
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-0000-0000-000000000000' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }),
  ];
  if (usage) {
    lines.push(JSON.stringify({ type: 'turn.completed', usage }));
  } else {
    lines.push(JSON.stringify({ type: 'turn.completed' }));
  }
  return lines.join('\n') + '\n';
}

/** Envelope whose agent_message carries a content-array (rich blocks) shape. */
function jsonlEnvelopeContentArray(blocks: Array<{ type: string; text: string }>): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-0000-0000-000000000000' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', content: blocks } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n') + '\n';
}

class RecordingSink implements LedgerSink {
  estimates: Array<{ ctx: InvocationContext; total: number }> = [];
  unavailable: Array<{ entryId: string; durationMs?: number }> = [];
  confirmed: Array<{ entryId: string; total: number; input: number; output: number; cacheHit: number; durationMs?: number }> = [];

  async writeEstimate(c: InvocationContext, total: number): Promise<string> {
    this.estimates.push({ ctx: c, total });
    return 'entry-' + this.estimates.length;
  }

  async confirmActual(entryId: string, total: number, input: number, output: number, cacheHit: number, durationMs?: number): Promise<void> {
    this.confirmed.push({ entryId, total, input, output, cacheHit, durationMs });
  }

  async markUnavailable(entryId: string, durationMs?: number): Promise<void> {
    this.unavailable.push({ entryId, durationMs });
  }
}

/** A runner that records the invocation and returns a canned stdout/tokenUsage. */
function cannedRunner(stdout: string, tokenUsage?: CodexProcessRunResult['tokenUsage']): { runner: CodexProcessRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CodexProcessRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return { stdout, stderr: '', exitCode: 0, durationMs: 5, ...(tokenUsage ? { tokenUsage } : {}) };
    },
  };
  return { runner, calls };
}

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

const reviewMarker = JSON.stringify({
  taskId: 'task-jsonl', status: 'approved', reviewSummary: 'Looks good from JSONL',
  findings: [], requiredRework: [], qualityGateStatus: 'passed', mergeAllowed: true,
});
const reviewJsonl = jsonlEnvelope(`BEGIN_REVIEW_RESULT_JSON\n${reviewMarker}\nEND_REVIEW_RESULT_JSON`, {
  input_tokens: 9005, output_tokens: 16, cached_input_tokens: 256,
});

const planJson = JSON.stringify({
  stages: [{ stageNumber: 1, title: 'S1', tasks: ['t1'] }],
  tasks: [{
    taskId: 't1', stageNumber: 1, title: 'T1', goal: 'plan', dependencies: [],
    estimatedWritePaths: ['src/'], allowedPaths: ['src/'], forbiddenPaths: [],
    contextFiles: [], acceptanceChecks: [], allowedCommands: [], riskLevel: 'low',
    productDecisionsLocked: true, expectedOutputs: [], heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
  }],
});
const planJsonl = jsonlEnvelope(`\`\`\`json\n${planJson}\n\`\`\``, {
  input_tokens: 4000, output_tokens: 2000, cached_input_tokens: 500,
});

const clarificationAnswer = JSON.stringify({
  status: 'answered', answers: ['a1'], reason: 'ok', categories: ['technical'],
});
const clarificationJsonl = jsonlEnvelope(`BEGIN_CODEX_CLARIFICATION_JSON\n${clarificationAnswer}\nEND_CODEX_CLARIFICATION_JSON`, {
  input_tokens: 100, output_tokens: 40, cached_input_tokens: 10,
});

const expectedUsage = { inputTokens: 9005, outputTokens: 16, cacheHitTokens: 256 };

// ── runner-level parsing ──

describe('parseCodexJsonlUsage', () => {
  it('parses the real DeepSeek probe fixture (turn.completed usage)', () => {
    expect(parseCodexJsonlUsage(readFixture('codex-jsonl-usage-real.jsonl'))).toEqual(expectedUsage);
  });

  it('returns null when the JSONL has no usage field (no guessing)', () => {
    expect(parseCodexJsonlUsage(readFixture('codex-jsonl-no-usage.jsonl'))).toBeNull();
  });

  it('returns null for plain-text / non-JSONL output', () => {
    expect(parseCodexJsonlUsage('BEGIN_REVIEW_RESULT_JSON\n{...}\nEND_REVIEW_RESULT_JSON')).toBeNull();
  });

  it('returns null for empty or malformed input', () => {
    expect(parseCodexJsonlUsage('')).toBeNull();
    expect(parseCodexJsonlUsage('{not json}\n')).toBeNull();
    expect(parseCodexJsonlUsage('{"type":"turn.completed","usage":{"input_tokens":"nope","output_tokens":1}}')).toBeNull();
  });
});

describe('extractCodexJsonlMessageText', () => {
  it('extracts the agent_message text from the real probe fixture', () => {
    expect(extractCodexJsonlMessageText(readFixture('codex-jsonl-usage-real.jsonl'))).toBe('ok');
  });

  it('extracts content-array output_text blocks when present', () => {
    const envelope = jsonlEnvelopeContentArray([
      { type: 'output_text', text: 'line one' },
      { type: 'output_text', text: 'line two' },
    ]);
    expect(extractCodexJsonlMessageText(envelope)).toBe('line one\nline two');
  });

  it('skips input_text blocks (prompt echo) in content arrays', () => {
    const envelope = jsonlEnvelopeContentArray([
      { type: 'input_text', text: 'prompt echo' },
      { type: 'output_text', text: 'real answer' },
    ]);
    expect(extractCodexJsonlMessageText(envelope)).toBe('real answer');
  });

  it('returns empty string for plain-text output', () => {
    expect(extractCodexJsonlMessageText('plain text, not JSONL')).toBe('');
    expect(extractCodexJsonlMessageText('')).toBe('');
  });
});

describe('RealCodexProcessRunner usage wiring', () => {
  const runner = new RealCodexProcessRunner();

  it('surfaces tokenUsage when the child prints a turn.completed usage event', async () => {
    const script = [
      "process.stdout.write(JSON.stringify({type:'thread.started'}) + '\\n');",
      "process.stdout.write(JSON.stringify({type:'turn.started'}) + '\\n');",
      "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ok'}}) + '\\n');",
      "process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:9005,cached_input_tokens:256,cache_write_input_tokens:0,output_tokens:16,reasoning_output_tokens:14}}) + '\\n');",
    ].join('');
    const result = await runner.run(process.execPath, ['-e', script], { cwd: process.cwd(), timeoutMs: 2_000 });
    expect(result.tokenUsage).toEqual(expectedUsage);
  });

  it('leaves tokenUsage absent when the child output has no usage', async () => {
    const script = [
      "process.stdout.write(JSON.stringify({type:'turn.completed'}) + '\\n');",
    ].join('');
    const result = await runner.run(process.execPath, ['-e', script], { cwd: process.cwd(), timeoutMs: 2_000 });
    expect(result.tokenUsage).toBeUndefined();
  });

  it('leaves tokenUsage absent for plain-text child output', async () => {
    const result = await runner.run(process.execPath, ['-e', "process.stdout.write('plain output')"], {
      cwd: process.cwd(), timeoutMs: 2_000,
    });
    expect(result.tokenUsage).toBeUndefined();
  });
});

// ── reviewer path ──

describe('CodexCliReviewer with --json output', () => {
  const diff = 'diff --git a/src/file.ts b/src/file.ts\n+added\n-removed';

  it('passes the --json arg vector and drops --ignore-user-config', async () => {
    const { runner, calls } = cannedRunner('');
    const reviewer = new CodexCliReviewer(
      { allowRealReview: true, workDir: process.cwd(), sessionDir: mkdtempSync(join(tmpdir(), 'rev-args-')), timeoutMs: 5000 },
      { processRunner: runner },
    );
    await reviewer.reviewDiff(diff, 'task-args');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--json');
    expect(calls[0].args).not.toContain('--ignore-user-config');
  });

  it('parses the review conclusion from the JSONL envelope and confirms real usage in the ledger', async () => {
    const sink = new RecordingSink();
    const { runner } = cannedRunner(reviewJsonl, expectedUsage);
    const reviewer = new CodexCliReviewer(
      { allowRealReview: true, workDir: process.cwd(), sessionDir: mkdtempSync(join(tmpdir(), 'rev-ledger-')), timeoutMs: 5000 },
      { processRunner: runner, ledgerSink: sink, invocationContext: { runId: 'r-jsonl', callType: 'codex_review', callId: 'rev-1' } },
    );
    const result = await reviewer.reviewDiff(diff, 'task-jsonl');

    expect(result.status).toBe('approved');
    expect(result.mergeAllowed).toBe(true);
    expect(sink.estimates).toHaveLength(1);
    expect(sink.confirmed).toEqual([
      { entryId: 'entry-1', total: 9277, input: 9005, output: 16, cacheHit: 256, durationMs: expect.any(Number) },
    ]);
    expect(sink.unavailable).toEqual([]);
  });

  it('stays unavailable (never guessed) when the JSONL has no usage', async () => {
    const sink = new RecordingSink();
    const { runner } = cannedRunner(jsonlEnvelope(`BEGIN_REVIEW_RESULT_JSON\n${reviewMarker}\nEND_REVIEW_RESULT_JSON`));
    const reviewer = new CodexCliReviewer(
      { allowRealReview: true, workDir: process.cwd(), sessionDir: mkdtempSync(join(tmpdir(), 'rev-nousage-')), timeoutMs: 5000 },
      { processRunner: runner, ledgerSink: sink, invocationContext: { runId: 'r-nousage', callType: 'codex_review', callId: 'rev-2' } },
    );
    const result = await reviewer.reviewDiff(diff, 'task-jsonl');

    expect(result.status).toBe('approved');
    expect(sink.confirmed).toEqual([]);
    expect(sink.unavailable).toEqual([{ entryId: 'entry-1', durationMs: expect.any(Number) }]);
  });
});

// ── brain path ──

describe('CodexCliBrain with --json output', () => {
  it('passes the --json arg vector and drops --ignore-user-config', async () => {
    const { runner, calls } = cannedRunner(planJsonl);
    const brain = new CodexCliBrain(
      { allowRealPlanning: true, workDir: process.cwd(), sessionDir: mkdtempSync(join(tmpdir(), 'brain-args-')), timeoutMs: 5000 },
      { processRunner: runner },
    );
    await brain.generatePlan('plan safely', 'b-args');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--json');
    expect(calls[0].args).not.toContain('--ignore-user-config');
  });

  it('parses the plan from the JSONL envelope and confirms real usage', async () => {
    const sink = new RecordingSink();
    const { runner } = cannedRunner(planJsonl, { inputTokens: 4000, outputTokens: 2000, cacheHitTokens: 500 });
    const brain = new CodexCliBrain(
      { allowRealPlanning: true, workDir: process.cwd(), sessionDir: mkdtempSync(join(tmpdir(), 'brain-ok-')), timeoutMs: 5000 },
      { processRunner: runner, ledgerSink: sink, invocationContext: { runId: 'b-jsonl', callType: 'codex_plan', callId: 'brain-1' } },
    );
    const result = await brain.generatePlan('build a calculator', 'b-jsonl');

    expect(result.success).toBe(true);
    expect(result.plan?.tasks).toHaveLength(1);
    expect(sink.confirmed).toEqual([
      { entryId: 'entry-1', total: 6500, input: 4000, output: 2000, cacheHit: 500, durationMs: expect.any(Number) },
    ]);
    expect(sink.unavailable).toEqual([]);
  });

  it('stays unavailable when the JSONL has no usage', async () => {
    const sink = new RecordingSink();
    const { runner } = cannedRunner(jsonlEnvelope(`\`\`\`json\n${planJson}\n\`\`\``));
    const brain = new CodexCliBrain(
      { allowRealPlanning: true, workDir: process.cwd(), sessionDir: mkdtempSync(join(tmpdir(), 'brain-nousage-')), timeoutMs: 5000 },
      { processRunner: runner, ledgerSink: sink, invocationContext: { runId: 'b-nousage', callType: 'codex_plan', callId: 'brain-2' } },
    );
    const result = await brain.generatePlan('build', 'b-nousage');

    expect(result.success).toBe(true);
    expect(sink.confirmed).toEqual([]);
    expect(sink.unavailable).toEqual([{ entryId: 'entry-1', durationMs: expect.any(Number) }]);
  });
});

// ── clarifier path ──

describe('CodexTechnicalClarifier with --json output', () => {
  const ctx: InvocationContext = {
    runId: 'r1', stageId: 's1', taskId: 't1', attemptId: 'a1',
    callType: 'codex_clarification', callId: 'a1-clarify',
  };

  it('passes the --json default arg vector and drops --ignore-user-config', async () => {
    const { runner, calls } = cannedRunner(clarificationJsonl);
    const clarifier = new CodexTechnicalClarifier(
      { command: 'codex', args: [], timeoutMs: 1000 },
      runner,
    );
    await clarifier.answerTechnicalQuestions({ taskSpec, clarification, round: 1, worktreePath: '.' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--json');
    expect(calls[0].args).not.toContain('--ignore-user-config');
  });

  it('parses the answer from the JSONL envelope and confirms real usage', async () => {
    const sink = new RecordingSink();
    const { runner } = cannedRunner(clarificationJsonl, { inputTokens: 100, outputTokens: 40, cacheHitTokens: 10 });
    const clarifier = new CodexTechnicalClarifier(
      { command: 'codex', args: [], timeoutMs: 1000 },
      runner,
      { ledgerSink: sink, invocationContext: ctx },
    );
    const answer = await clarifier.answerTechnicalQuestions({ taskSpec, clarification, round: 1, worktreePath: '.' });

    expect(answer.status).toBe('answered');
    expect(answer.answers).toEqual(['a1']);
    expect(sink.confirmed).toEqual([
      { entryId: 'entry-1', total: 150, input: 100, output: 40, cacheHit: 10, durationMs: expect.any(Number) },
    ]);
    expect(sink.unavailable).toEqual([]);
  });

  it('stays unavailable when the JSONL has no usage', async () => {
    const sink = new RecordingSink();
    const { runner } = cannedRunner(jsonlEnvelope(`BEGIN_CODEX_CLARIFICATION_JSON\n${clarificationAnswer}\nEND_CODEX_CLARIFICATION_JSON`));
    const clarifier = new CodexTechnicalClarifier(
      { command: 'codex', args: [], timeoutMs: 1000 },
      runner,
      { ledgerSink: sink, invocationContext: ctx },
    );
    const answer = await clarifier.answerTechnicalQuestions({ taskSpec, clarification, round: 1, worktreePath: '.' });

    expect(answer.status).toBe('answered');
    expect(sink.confirmed).toEqual([]);
    expect(sink.unavailable).toEqual([{ entryId: 'entry-1', durationMs: expect.any(Number) }]);
  });
});

// guard: fixtures stay tracked and small
describe('fixture hygiene', () => {
  it('keeps the real probe fixture parseable and its size tiny', () => {
    const raw = readFixture('codex-jsonl-usage-real.jsonl');
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(1024);
  });
});
