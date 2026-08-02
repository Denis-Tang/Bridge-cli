import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ReviewResult } from '../types/protocol.js';
import type { LedgerSink, InvocationContext } from '../core/token-telemetry.js';
import { estimateForCallType } from '../core/token-telemetry.js';
import type { CodexProcessRunner } from './codex-process-runner.js';
import { RealCodexProcessRunner } from './codex-process-runner.js';

/**
 * Configuration for the Codex CLI Reviewer.
 */
export interface CodexCliReviewerConfig {
  /** Timeout in ms for Codex CLI calls (default: 120s) */
  timeoutMs: number;
  /** Working directory (worktree path) for git context */
  workDir: string;
  /** Session/log directory for review artifacts */
  sessionDir: string;
  /** Whether to actually call Codex CLI (default: false for safety) */
  allowRealReview: boolean;
  /** Configurable CLI executable and argument vector. The diff stdin argument is caller-owned. */
  command: string;
  args: string[];
  /** Optional environment variables to pass to the Codex CLI subprocess */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export function parseCodexCliReviewOutput(output: string, taskId: string): ReviewResult {
  const lines = output.split('\n');
  const lowerOutput = output.toLowerCase();

  const hasNoIssueStatement =
    /\bno\s+(?:discrete\s+)?(?:correctness\s+)?issues?\b/.test(lowerOutput) ||
    /\bno\s+(?:actionable\s+)?(?:problems?|findings?|warnings?|errors?)\b/.test(lowerOutput) ||
    /\bno\s+.*\bissues?\s+(?:is|are)\s+evident\b/.test(lowerOutput) ||
    /\bno\s+.*\bissues?\s+(?:found|detected)\b/.test(lowerOutput);

  const hasIssueKeyword =
    /\b(issue|warning|error|problem|bug|regression|security|leak|conflict)\b/.test(lowerOutput);

  const hasActionableLanguage =
    /\b(must|should|needs?|requires?|required|fix|change|blocker|failing|failed|incorrect|unsafe)\b/.test(lowerOutput);

  const findings: string[] = [];
  const requiredRework: string[] = [];

  // Try to extract bullet-point findings
  const findingRegex = /(?:^|\n)\s*[-*]\s*(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = findingRegex.exec(output)) !== null) {
    const text = match[1].trim();
    if (text.length > 0 && text.length < 200) {
      findings.push(text);
      const lowerText = text.toLowerCase();
      const bulletLooksActionable =
        /\b(issue|warning|error|problem|bug|regression|security|leak|conflict)\b/.test(lowerText) &&
        !/\bno\s+(?:actionable\s+)?(?:issues?|problems?|findings?|warnings?|errors?)\b/.test(lowerText);
      if (bulletLooksActionable) {
        requiredRework.push(text);
      }
    }
  }

  // If no structured findings found, use the output as-is
  if (findings.length === 0) {
    findings.push(`Codex CLI output (${lines.length} lines)`);
  }

  const approved = hasNoIssueStatement
    ? requiredRework.length === 0
    : !hasIssueKeyword || (requiredRework.length === 0 && !hasActionableLanguage);

  return {
    taskId,
    status: approved ? 'approved' : 'rework_required',
    reviewSummary: `[reviewer: codex-cli] ${approved ? '审查通过' : '审查发现问题'} — ${findings.length} 项, ${requiredRework.length} 项需修改`,
    findings,
    requiredRework,
    qualityGateStatus: approved ? 'passed' : 'failed',
    mergeAllowed: approved,
    reviewer: 'codex-cli',
  };
}

/**
 * CodexCliReviewer — calls a read-only, ephemeral Codex CLI session to review
 * the supplied diff without persisting a Codex session.
 *
 * Marked as 'reviewer: codex-cli' in ReviewResult.
 *
 * M4: Accepts optional LedgerSink + InvocationContext for token telemetry.
 * Governance OFF → no Sink → no ledger writes.
 */
export class CodexCliReviewer {
  private config: CodexCliReviewerConfig;
  private processRunner: CodexProcessRunner;
  private ledgerSink: LedgerSink | null;
  private invocationContext: InvocationContext | null;

  constructor(
    config?: Partial<CodexCliReviewerConfig>,
    options?: {
      processRunner?: CodexProcessRunner;
      ledgerSink?: LedgerSink | null;
      invocationContext?: InvocationContext | null;
    },
  ) {
    this.config = {
      timeoutMs: 120_000,
      workDir: process.cwd(),
      sessionDir: '.brainctl-dev/review-logs',
      allowRealReview: false,
      command: 'codex',
      args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '-'],
      ...config,
    };
    this.processRunner = options?.processRunner ?? new RealCodexProcessRunner();
    this.ledgerSink = options?.ledgerSink ?? null;
    this.invocationContext = options?.invocationContext ?? null;
  }

  /**
   * Set a ledger sink for token telemetry (M4 governance).
   * Returns this for chaining.
   */
  withLedger(sink: LedgerSink | null, ctx: InvocationContext | null): this {
    this.ledgerSink = sink;
    this.invocationContext = ctx;
    return this;
  }

  /**
   * Review a git diff using the real Codex CLI.
   * @param diff - The git diff content (unused directly — we use --uncommitted on worktree)
   * @param taskId - The task ID being reviewed
   */
  async reviewDiff(diff: string, taskId: string): Promise<ReviewResult> {
    if (!diff || diff.trim().length === 0) {
      return {
        taskId,
        status: 'rejected',
        reviewSummary: '[reviewer: codex-cli] 审查失败：没有提供 diff 内容。',
        findings: ['Diff 为空，无法审查'],
        requiredRework: [],
        qualityGateStatus: 'skipped',
        mergeAllowed: false,
        reviewer: 'codex-cli',
      };
    }

    if (!this.config.allowRealReview) {
      return {
        taskId,
        status: 'rejected',
        reviewSummary: '[reviewer: codex-cli] 真实 Codex CLI 审查未启用 (allowRealReview=false)',
        findings: ['Codex CLI review disabled'],
        requiredRework: [],
        qualityGateStatus: 'skipped',
        mergeAllowed: false,
        reviewer: 'codex-cli',
      };
    }

    return this.runRealReview(diff, taskId);
  }

  /**
   * Run the real Codex CLI review subprocess.
   */
  private async runRealReview(diff: string, taskId: string): Promise<ReviewResult> {
    // Ensure session dir exists
    mkdirSync(this.config.sessionDir, { recursive: true });
    const reviewLogPath = resolve(this.config.sessionDir, `${taskId}_codex-review.log`);

    // Build a review prompt with the diff content
    const reviewPrompt = `Review the following git diff for task ${taskId}:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\nProvide a structured review result.`;

    // ── M4: Write estimate BEFORE calling external process ──
    let entryId: string | null = null;
    const ctx = this.invocationContext;
    const sink = this.ledgerSink;
    if (sink && ctx) {
      const diffLines = diff.split('\n').length;
      const est = estimateForCallType('codex_review', { diffLines });
      try {
        entryId = await sink.writeEstimate(ctx, est.total, est.input, est.output, reviewPrompt);
      } catch {
        // Sink failure must not change business semantics
      }
    }

    const startTime = Date.now();
    let failureMetadata: ReviewResult['executionMetadata'] | undefined;
    try {
      const result = await this.processRunner.run(this.config.command, this.config.args, {
        cwd: this.config.workDir,
        timeoutMs: this.config.timeoutMs,
        input: reviewPrompt,
        maxBuffer: 10 * 1024 * 1024,
        env: this.config.env,
        signal: this.config.signal,
      });

      // Non-zero exit code → call failure, propagate as rejection
      if (result.exitCode !== 0) {
        const failureReason = result.timedOut
          ? `Codex CLI timed out after ${this.config.timeoutMs}ms`
          : `Codex CLI exited with code ${result.exitCode}`;
        failureMetadata = {
          errorCategory: result.timedOut ? 'timeout' : 'nonzero_exit',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stderrHash: hashDiagnostic(result.stderr),
        };
        writeFileSync(reviewLogPath, JSON.stringify({
          status: 'failed',
          reason: failureReason,
          durationMs: result.durationMs,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
        }) + '\n', 'utf-8');
        throw new Error(failureReason);
      }

      const parsed = this.parseCodexReviewOutput(result.stdout, taskId);
      parsed.executionMetadata = {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stderrHash: hashDiagnostic(result.stderr),
      };
      writeFileSync(reviewLogPath, JSON.stringify({
        status: parsed.status,
        mergeAllowed: parsed.mergeAllowed,
        durationMs: result.durationMs,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
      }) + '\n', 'utf-8');

      // ── M4: Update ledger entry after call ──
      if (sink && entryId) {
        const durationMs = Date.now() - startTime;
        if (result.tokenUsage) {
          try {
            await sink.confirmActual(
              entryId,
              result.tokenUsage.inputTokens + result.tokenUsage.outputTokens + (result.tokenUsage.cacheHitTokens || 0),
              result.tokenUsage.inputTokens,
              result.tokenUsage.outputTokens,
              result.tokenUsage.cacheHitTokens || 0,
              durationMs,
            );
          } catch { /* sink failure must not change semantics */ }
        } else {
          try {
            await sink.markUnavailable(entryId, durationMs);
          } catch { /* sink failure must not change semantics */ }
        }
      }

      return parsed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const safeErrMsg = /^Codex CLI (?:timed out|exited with code)/.test(errMsg)
        ? errMsg
        : 'Unexpected Codex reviewer failure';
      if (!/^Codex CLI (?:timed out|exited with code)/.test(errMsg)) {
        writeFileSync(reviewLogPath, JSON.stringify({ status: 'failed', reason: safeErrMsg }) + '\n', 'utf-8');
      }

      // ── M4: Mark unavailable on call failure ──
      if (sink && entryId) {
        try {
          await sink.markUnavailable(entryId, Date.now() - startTime);
        } catch { /* sink failure must not change semantics */ }
      }

      return {
        taskId,
        status: 'rejected',
        reviewSummary: `[reviewer: codex-cli] Codex CLI 审查调用失败: ${safeErrMsg}`,
        findings: [`Codex CLI execution error: ${safeErrMsg}`],
        requiredRework: [],
        qualityGateStatus: 'failed',
        mergeAllowed: false,
        reviewer: 'codex-cli',
        reviewerUnavailable: true,
        executionMetadata: failureMetadata ?? {
          errorCategory: errMsg.includes('timed out') ? 'timeout'
            : errMsg.includes('exited with code') ? 'nonzero_exit'
              : 'unexpected',
          exitCode: extractExitCode(errMsg),
          durationMs: Date.now() - startTime,
          stderrHash: null,
        },
      };
    }
  }

  /**
   * Parse Codex CLI review output into a ReviewResult.
   */
  private parseCodexReviewOutput(output: string, taskId: string): ReviewResult {
    return parseCodexCliReviewOutput(output, taskId);
  }
}

function hashDiagnostic(value: string): string | null {
  if (!value) return null;
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function extractExitCode(message: string): number | null {
  const match = message.match(/exited with code (\d+)/);
  return match ? Number(match[1]) : null;
}
