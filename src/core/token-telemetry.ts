// ── M4 Token Telemetry — LedgerSink for adapters ────────────────────────
// Adapters accept an optional LedgerSink; governance OFF → no Sink → no ledger.
// One logical call = one ledger record: estimated → updated to confirmed/unavailable.
// All IDs are concurrent-safe. All data is sanitized (SHA256 hashes only).

import { randomBytes } from 'node:crypto';
import type { StateStore } from '../state/state-store.js';
import type { TokenLedgerEntry, CallType, LedgerStatus } from '../types/m4-types.js';
import { promptHash } from '../utils/sanitize.js';
import { estimateCodexPlanTokens, estimateCodexReviewTokens, estimatePiWorkerTokens, estimateStageReviewTokens } from './token-ledger.js';

// ══════════════════════════════════════════════════════════════
// Invocation Context
// ══════════════════════════════════════════════════════════════

export interface InvocationContext {
  runId: string;
  stageId?: string | null;
  taskId?: string | null;
  attemptId?: string | null;
  callType: CallType;
  callId: string;
  model?: string | null;
  synthetic?: boolean;
}

// ══════════════════════════════════════════════════════════════
// LedgerSink — optional, injectable interface for adapters
// ══════════════════════════════════════════════════════════════

export interface LedgerSink {
  /** Write estimated usage before the call. Returns the ledger entry id. */
  writeEstimate(ctx: InvocationContext, total: number, input: number, output: number, promptText?: string): Promise<string>;
  /** Update the entry with confirmed actual usage after the call. */
  confirmActual(entryId: string, total: number, input: number, output: number, cacheHit: number, durationMs?: number): Promise<void>;
  /** Mark the entry as unavailable (no actual data obtainable). */
  markUnavailable(entryId: string, durationMs?: number): Promise<void>;
}

// ══════════════════════════════════════════════════════════════
// SqliteLedgerSink — production implementation
// ══════════════════════════════════════════════════════════════

export class SqliteLedgerSink implements LedgerSink {
  private store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  async writeEstimate(
    ctx: InvocationContext, total: number, input: number, output: number, promptText?: string,
  ): Promise<string> {
    const id = generateLedgerId(ctx.runId, ctx.callType);
    await this.store.insertTokenLedgerEntry({
      id,
      runId: ctx.runId,
      stageId: ctx.stageId ?? null,
      taskId: ctx.taskId ?? null,
      attemptId: ctx.attemptId ?? null,
      callType: ctx.callType,
      callId: ctx.callId,
      estimatedTotal: total,
      estimatedInput: input,
      estimatedOutput: output,
      promptHash: promptText ? promptHash(promptText) : null,
      model: ctx.model ?? null,
      durationMs: null,
      status: 'estimated',
      isSynthetic: ctx.synthetic ?? false,
    });
    return id;
  }

  async confirmActual(
    entryId: string, total: number, input: number, output: number, cacheHit: number, durationMs?: number,
  ): Promise<void> {
    await this.store.updateTokenLedgerEntry(entryId, {
      status: 'confirmed',
      actualTotal: total,
      actualInput: input,
      actualOutput: output,
      actualCacheHit: cacheHit,
      durationMs: durationMs ?? null,
    });
  }

  async markUnavailable(entryId: string, durationMs?: number): Promise<void> {
    await this.store.updateTokenLedgerEntry(entryId, {
      status: 'unavailable',
      durationMs: durationMs ?? null,
    });
  }
}

// ══════════════════════════════════════════════════════════════
// Helper: estimate tokens for a call type
// ══════════════════════════════════════════════════════════════

export function estimateForCallType(
  callType: CallType,
  context: { requestText?: string; diffLines?: number; goalLength?: number; pathCount?: number },
): { total: number; input: number; output: number } {
  switch (callType) {
    case 'codex_plan':
      return estimateCodexPlanTokens(context.requestText || '');
    case 'codex_review':
      return estimateCodexReviewTokens(context.diffLines || 0);
    case 'stage_review':
      return estimateStageReviewTokens(context.diffLines || 0, context.pathCount || 0);
    case 'codex_review_skipped':
      return { total: 0, input: 0, output: 0 };
    case 'pi_worker':
      return estimatePiWorkerTokens(context.goalLength || 0, context.pathCount || 0);
    default:
      return { total: 1000, input: 600, output: 400 };
  }
}

// ══════════════════════════════════════════════════════════════
// Concurrent-safe ID generation
// ══════════════════════════════════════════════════════════════

let seqCounter = 0;
function generateLedgerId(runId: string, callType: string): string {
  const ts = Date.now();
  const seq = ++seqCounter;
  const rand = randomBytes(4).toString('hex');
  return `${runId}-tl-${callType}-${ts}-${seq}-${rand}`;
}
