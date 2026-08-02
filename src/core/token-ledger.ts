// ── M4 Token Ledger — Budget estimation & actual tracking ──────────────
// Only stores SHA256 hashes, never raw prompts/responses.
// Call status: 'estimated' | 'confirmed' | 'unavailable'

import type { StateStore } from '../state/state-store.js';
import type { TokenLedgerEntry, CallType, LedgerStatus } from '../types/m4-types.js';
import { promptHash } from '../utils/sanitize.js';

export interface TokenEstimate {
  total: number;
  input: number;
  output: number;
}

export interface TokenActual {
  total: number;
  input: number;
  output: number;
  cacheHit: number;
}

export interface TokenLedgerInput {
  runId: string;
  stageId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  callType: CallType;
  callId: string;
  model?: string | null;
  durationMs?: number | null;
  synthetic?: boolean;
}

/**
 * Write an estimated token entry. No actual data yet.
 */
export async function writeTokenEstimate(
  store: StateStore,
  input: TokenLedgerInput,
  estimate: TokenEstimate,
  promptText?: string,
): Promise<TokenLedgerEntry> {
  return store.insertTokenLedgerEntry({
    id: `${input.runId}-tl-${input.callType}-${Date.now()}`,
    runId: input.runId,
    stageId: input.stageId ?? null,
    taskId: input.taskId ?? null,
    attemptId: input.attemptId ?? null,
    callType: input.callType,
    callId: input.callId,
    estimatedTotal: estimate.total,
    estimatedInput: estimate.input,
    estimatedOutput: estimate.output,
    promptHash: promptText ? promptHash(promptText) : null,
    model: input.model ?? null,
    durationMs: input.durationMs ?? null,
    status: 'estimated',
    isSynthetic: input.synthetic ?? false,
  });
}

/**
 * Confirm a previously estimated entry with actual token usage.
 * Creates a new confirmed entry if no existing estimate found.
 */
export async function writeTokenActual(
  store: StateStore,
  input: TokenLedgerInput,
  actual: TokenActual,
  promptText?: string,
): Promise<TokenLedgerEntry> {
  return store.insertTokenLedgerEntry({
    id: `${input.runId}-tl-${input.callType}-${Date.now()}`,
    runId: input.runId,
    stageId: input.stageId ?? null,
    taskId: input.taskId ?? null,
    attemptId: input.attemptId ?? null,
    callType: input.callType,
    callId: input.callId,
    actualTotal: actual.total,
    actualInput: actual.input,
    actualOutput: actual.output,
    actualCacheHit: actual.cacheHit,
    promptHash: promptText ? promptHash(promptText) : null,
    model: input.model ?? null,
    durationMs: input.durationMs ?? null,
    status: 'confirmed',
    isSynthetic: input.synthetic ?? false,
  });
}

/**
 * Estimate tokens for a stage-level aggregated review.
 * Based on total diff size across all tasks in the stage.
 */
export function estimateStageReviewTokens(diffLines: number, taskCount: number): TokenEstimate {
  const base = 1000;
  const perLine = 1;
  const perTask = 300;
  return {
    total: base + diffLines * perLine + taskCount * perTask,
    input: base + diffLines * perLine * 0.7 + taskCount * perTask * 0.8,
    output: diffLines * perLine * 0.3 + taskCount * perTask * 0.2,
  };
}

/**
 * Write an unavailable entry (no actual token data obtainable).
 */
export async function writeTokenUnavailable(
  store: StateStore,
  input: TokenLedgerInput,
  estimate?: TokenEstimate,
  promptText?: string,
): Promise<TokenLedgerEntry> {
  return store.insertTokenLedgerEntry({
    id: `${input.runId}-tl-${input.callType}-${Date.now()}`,
    runId: input.runId,
    stageId: input.stageId ?? null,
    taskId: input.taskId ?? null,
    attemptId: input.attemptId ?? null,
    callType: input.callType,
    callId: input.callId,
    estimatedTotal: estimate?.total ?? null,
    estimatedInput: estimate?.input ?? null,
    estimatedOutput: estimate?.output ?? null,
    promptHash: promptText ? promptHash(promptText) : null,
    model: input.model ?? null,
    durationMs: input.durationMs ?? null,
    status: 'unavailable',
    isSynthetic: input.synthetic ?? false,
  });
}

/**
 * Estimate tokens for a Codex plan call based on request text length.
 * Default: 2000 + request.length * 10 per character
 */
export function estimateCodexPlanTokens(requestText: string): TokenEstimate {
  const base = 2000;
  const perChar = 10;
  return {
    total: base + requestText.length * perChar,
    input: base + requestText.length * perChar * 0.7,
    output: requestText.length * perChar * 0.3,
  };
}

/**
 * Estimate tokens for a Codex review based on diff size.
 * Default: 500 + 2 per diff line
 */
export function estimateCodexReviewTokens(diffLines: number): TokenEstimate {
  const base = 500;
  const perLine = 2;
  return {
    total: base + diffLines * perLine,
    input: base + diffLines * perLine * 0.6,
    output: diffLines * perLine * 0.4,
  };
}

/**
 * Estimate tokens for one Codex technical-clarification answer during the
 * 95%-understanding gate. The prompt is a bounded task summary plus Pi's
 * questions, so it is far smaller than a diff review.
 * Default: 800 + 20 per prompt char
 */
export function estimateCodexClarificationTokens(promptChars: number): TokenEstimate {
  const base = 800;
  const perChar = 20;
  return {
    total: base + promptChars * perChar,
    input: base + promptChars * perChar * 0.75,
    output: promptChars * perChar * 0.25,
  };
}

/**
 * Estimate tokens for a Pi worker execution based on task complexity.
 * Default: 2000 + 500 per estimatedWritePath
 */
export function estimatePiWorkerTokens(
  goalLength: number,
  pathCount: number,
): TokenEstimate {
  const base = 2000;
  const perPath = 500;
  return {
    total: base + pathCount * perPath + goalLength * 5,
    input: base + pathCount * perPath * 0.6 + goalLength * 3,
    output: pathCount * perPath * 0.4 + goalLength * 2,
  };
}
