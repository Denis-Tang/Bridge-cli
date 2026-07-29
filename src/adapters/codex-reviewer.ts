import type { ReviewResult } from '../types/protocol.js';
import { parseReviewResult } from './codex-review-result-parser.js';

/**
 * Configuration for the Codex Reviewer.
 */
export interface CodexReviewerConfig {
  /** Whether real Codex SDK integration is enabled (default: false) */
  allowRealReview: boolean;
  /** Model to use for review */
  model?: string;
  /** Reviewer label to embed in results */
  reviewerLabel?: 'local-rule' | 'codex-cli' | 'codex-sdk';
}

/**
 * Codex Reviewer — reviews Git diffs and produces ReviewResult.
 * In M1, this uses a mock review instead of real Codex SDK.
 */
export class CodexReviewer {
  private config: CodexReviewerConfig;

  constructor(config?: Partial<CodexReviewerConfig>) {
    this.config = {
      allowRealReview: false,
      reviewerLabel: 'local-rule',
      ...config,
    };
  }

  /**
   * Review a Git diff for a task.
   * @param diff - The Git diff content to review
   * @param taskId - The task ID being reviewed
   * @returns ReviewResult
   */
  async reviewDiff(diff: string, taskId: string): Promise<ReviewResult> {
    if (!diff || diff.trim().length === 0) {
      return {
        taskId,
        status: 'rejected',
        reviewSummary: '审查失败：没有提供 diff 内容。',
        findings: ['Diff 为空，无法审查'],
        requiredRework: [],
        qualityGateStatus: 'skipped',
        mergeAllowed: false,
        reviewer: this.config.reviewerLabel,
      };
    }

    if (!this.config.allowRealReview) {
      // Mock review: auto-approve for simple changes
      return this.mockReview(diff, taskId);
    }

    // Real Codex review would go here
    return this.mockReview(diff, taskId);
  }

  /**
   * Build a review prompt for Codex.
   * (Used when real review is enabled)
   */
  buildReviewPrompt(diff: string, taskId: string): string {
    return `# Code Review Request

## Task ID
${taskId}

## Git Diff

\`\`\`diff
${diff}
\`\`\`

## Instructions

Review the diff above and provide a structured ReviewResult.
Only approve if the changes are correct, safe, and aligned with the task requirements.

Output format:
\`\`\`
BEGIN_REVIEW_RESULT_JSON
{
  "taskId": "${taskId}",
  "status": "approved | rework_required | rejected | needs_user_decision",
  "reviewSummary": "...",
  "findings": ["..."],
  "requiredRework": ["..."],
  "qualityGateStatus": "passed | failed | skipped",
  "mergeAllowed": true | false
}
END_REVIEW_RESULT_JSON
\`\`\`
`;
  }

  /**
   * Mock review logic for M1: heuristic-based auto-approval.
   */
  private mockReview(diff: string, taskId: string): ReviewResult {
    const lines = diff.split('\n');

    // Check for dangerous patterns
    const hasEnvFileChanges = diff.includes('.env');
    const hasSecretChanges = diff.toLowerCase().includes('secret') || diff.toLowerCase().includes('password');
    const hasBinaryChanges = diff.includes('Binary files');
    const hasConflicts = diff.includes('<<<<<<<') || diff.includes('>>>>>>>') || diff.includes('=======');

    const findings: string[] = [];
    const requiredRework: string[] = [];

    if (hasEnvFileChanges) {
      findings.push('Diff 包含 .env 文件变更，需要确认');
      requiredRework.push('移除 .env 文件变更');
    }

    if (hasSecretChanges) {
      findings.push('Diff 可能包含敏感信息');
      requiredRework.push('移除硬编码的密钥或密码');
    }

    if (hasBinaryChanges) {
      findings.push('Diff 包含二进制文件变更');
      requiredRework.push('二进制文件变更需要人工确认');
    }

    if (hasConflicts) {
      findings.push('Diff 包含冲突标记');
      requiredRework.push('解决冲突标记');
    }

    const reviewerLabel = this.config.reviewerLabel || 'local-rule';

    if (findings.length === 0) {
      return {
        taskId,
        status: 'approved',
        reviewSummary: `[reviewer: ${reviewerLabel}] 审查通过：${lines.length} 行 diff，未发现安全问题。`,
        findings: [],
        requiredRework: [],
        qualityGateStatus: 'passed',
        mergeAllowed: true,
        reviewer: reviewerLabel,
      };
    }

    // If only warnings (not blocking), still allow merge with notes
    if (findings.length <= 1 && !hasConflicts) {
      return {
        taskId,
        status: 'approved',
        reviewSummary: `[reviewer: ${reviewerLabel}] 审查通过（有警告）：${findings.join('; ')}`,
        findings,
        requiredRework,
        qualityGateStatus: 'passed',
        mergeAllowed: true,
        reviewer: reviewerLabel,
      };
    }

    return {
      taskId,
      status: 'rework_required',
      reviewSummary: `[reviewer: ${reviewerLabel}] 审查未通过：${findings.join('; ')}`,
      findings,
      requiredRework,
      qualityGateStatus: 'failed',
      mergeAllowed: false,
      reviewer: reviewerLabel,
    };
  }
}

export { parseReviewResult };
