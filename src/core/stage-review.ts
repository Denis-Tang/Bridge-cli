// ── Stage Review — Stage-level aggregated Codex review ─────────────────
// In token-efficient mode, all low/medium-risk tasks in a stage have their
// per-task Codex reviews skipped. Instead, one aggregated review runs on
// the integration diff before target merge.

import type { StageRecord } from '../types/m2-types.js';
import type { StageReviewInput } from '../types/m2-types.js';
import type { ReviewResult } from '../types/protocol.js';
import { ReviewResultCache, computeReviewCacheKey, type ReviewCacheKey } from './review-cache.js';
import type { StateStore } from '../state/state-store.js';
import type { CallType, PolicyType } from '../types/m4-types.js';

export interface StageReviewRunnerConfig {
  workDir: string;
  sessionDir: string;
  allowRealReview: boolean;
  timeoutMs: number;
  command?: string;
  args?: string[];
  /** Privacy-filtered environment for the real Codex reviewer. */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Injected Codex process runner (e.g., BenchCodexRunner for tests) */
  codexProcessRunner?: import('../adapters/codex-process-runner.js').CodexProcessRunner;
  /** Ledger sink for recording token usage */
  ledgerSink?: import('./token-telemetry.js').SqliteLedgerSink;
  invocationContext?: import('./token-telemetry.js').InvocationContext;
}

export interface StageReviewResult {
  passed: boolean;
  reviewResult: ReviewResult;
  cacheHit: boolean;
}

export interface StageReviewInputLimits {
  /** UTF-8 bytes are an operational proxy ceiling, not a Provider token count. */
  maxBytes: number;
  /** Lines are an operational proxy ceiling, not a Provider token count. */
  maxLines: number;
}

export interface StageReviewInputCoverage {
  complete: boolean;
  inputBytes: number;
  inputLines: number;
  limits: StageReviewInputLimits;
  reason: string | null;
  metricKind: 'proxy_not_token';
}

export const DEFAULT_STAGE_REVIEW_INPUT_LIMITS: StageReviewInputLimits = {
  maxBytes: 524_288,
  maxLines: 20_000,
};

export function assessStageReviewInputCoverage(
  input: StageReviewInput,
  overrides: Partial<StageReviewInputLimits> = {},
): StageReviewInputCoverage {
  const limits = { ...DEFAULT_STAGE_REVIEW_INPUT_LIMITS, ...overrides };
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0
    || !Number.isSafeInteger(limits.maxLines) || limits.maxLines <= 0) {
    throw new Error('stage review input limits must be positive safe integers');
  }
  const prompt = buildStageReviewPrompt(input);
  const inputBytes = Buffer.byteLength(prompt, 'utf8');
  const inputLines = prompt.split(/\r?\n/).length;
  const exceeded: string[] = [];
  if (inputBytes > limits.maxBytes) exceeded.push(`bytes ${inputBytes}>${limits.maxBytes}`);
  if (inputLines > limits.maxLines) exceeded.push(`lines ${inputLines}>${limits.maxLines}`);
  return {
    complete: exceeded.length === 0,
    inputBytes,
    inputLines,
    limits,
    reason: exceeded.length > 0 ? `review_input_limit_exceeded: ${exceeded.join(', ')}` : null,
    metricKind: 'proxy_not_token',
  };
}

/**
 * Prepare stage review input from completed tasks.
 */
export function prepareStageReviewInput(
  stage: StageRecord,
  aggregatedDiff: string,
  taskResults: Array<{ taskId: string; passed: boolean; summary: string }>,
): StageReviewInput {
  return {
    stageId: stage.id,
    stageNumber: stage.stageNumber,
    aggregatedDiff,
    taskIds: taskResults.map((t) => t.taskId),
    qualityGateResults: taskResults,
  };
}

/**
 * Format the complete final integration diff for mandatory review. This
 * function never truncates. Callers must pause with partial coverage when
 * assessStageReviewInputCoverage() reports that the operational input ceiling
 * was exceeded.
 */
export function buildStageReviewPrompt(input: StageReviewInput): string {
  const gateSummary = input.qualityGateResults
    .map((r) => `- ${r.taskId}: ${r.passed ? '✅' : '❌'} ${r.summary}`)
    .join('\n');

  const fileLines = input.aggregatedDiff
    ? input.aggregatedDiff.split('\n').filter((l) => l.startsWith('--- ') || l.startsWith('+++ '))
    : [];

  return [
    '# 阶段审查 — Stage ' + String(input.stageNumber),
    '',
    '## 概述',
    `- 阶段: ${input.stageNumber}`,
    `- 任务数: ${input.taskIds.length}`,
    `- 任务: ${input.taskIds.join(', ')}`,
    '',
    '## 质量门摘要',
    gateSummary,
    '',
    '## 文件清单',
    ...fileLines,
    '',
    '## 聚合差异',
    '```diff',
    input.aggregatedDiff || '(无变更)',
    '```',
    '',
    '## 审查指令',
    '- 检查是否有行为冲突（多个任务修改同一逻辑）',
    '- 检查是否有范围越界',
    '- 检查安全/密钥相关变更',
    '- 输出结构化 ReviewResult: status, reviewSummary, findings, requiredRework, mergeAllowed',
  ].join('\n');
}

/**
 * Run stage-level aggregated Codex review.
 * Checks cache first; falls back to fake review if not real.
 */
export async function runStageReview(
  input: StageReviewInput,
  baseCommit: string,
  cache: ReviewResultCache,
  store: StateStore,
  runId: string,
  stageId: string,
  config: StageReviewRunnerConfig,
): Promise<StageReviewResult> {
  // Compute cache key
  const cacheKey = computeReviewCacheKey({
    baseCommit,
    diff: input.aggregatedDiff,
    qualityGateConfig: input.qualityGateResults,
    reviewerModel: 'codex-cli',
    reviewerVersion: 'default',
  });

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) {
    await store.createEvent({
      id: `${runId}-ev-cache-hit-${Date.now()}`,
      runId,
      stageId,
      eventType: 'review_cache_hit',
      eventData: { cacheKey: cacheKey.toString(), stageId },
    });
    return { passed: true, reviewResult: cached, cacheHit: true };
  }

  await store.createEvent({
    id: `${runId}-ev-cache-miss-${Date.now()}`,
    runId,
    stageId,
    eventType: 'review_cache_miss',
    eventData: { cacheKey: cacheKey.toString(), stageId },
  });

  // Run review
  let reviewResult: ReviewResult;

  if (config.allowRealReview) {
    // Import CodexCliReviewer dynamically to avoid circular deps
    const { CodexCliReviewer } = await import('../adapters/codex-cli-reviewer.js');
    const reviewer = new CodexCliReviewer(
      {
        workDir: config.workDir,
        sessionDir: config.sessionDir,
        allowRealReview: true,
        timeoutMs: config.timeoutMs,
        command: config.command,
        args: config.args,
        env: config.env,
        signal: config.signal,
      },
      {
        processRunner: config.codexProcessRunner,
        ledgerSink: config.ledgerSink,
        invocationContext: config.invocationContext,
      },
    );
    reviewResult = await reviewer.reviewDiff(input.aggregatedDiff, input.stageId);
  } else {
    // Fake review for testing
    reviewResult = {
      taskId: input.stageId,
      status: 'approved',
      reviewSummary: 'fake stage review passed',
      findings: [],
      requiredRework: [],
      qualityGateStatus: 'passed',
      mergeAllowed: true,
      reviewer: 'codex-cli',
    };
  }

  // A real verdict requires a real reviewer: an unavailable reviewer or a
  // failed subprocess (errorCategory present) is never a pass, even if the
  // shape would otherwise look approved.
  const passed = reviewResult.status === 'approved'
    && reviewResult.mergeAllowed
    && reviewResult.reviewerUnavailable !== true
    && (reviewResult.executionMetadata?.errorCategory === undefined);

  // Cache the result if passed
  if (passed) {
    cache.set(cacheKey, reviewResult);
  }

  return { passed, reviewResult, cacheHit: false };
}
