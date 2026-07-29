import type { ReviewResult } from '../types/protocol.js';

/**
 * LocalRuleReviewer — a fallback reviewer that checks diffs using local rules.
 * Does NOT call Codex. Results are marked as 'reviewer: local-rule'.
 *
 * Rules:
 * - Empty diff → rejected
 * - .env file changes → rejected
 * - Conflict markers → rejected
 * - Binary files → warning (allowed)
 * - Everything else → approved
 */
export class LocalRuleReviewer {
  /**
   * Review a diff using local rules.
   */
  reviewDiff(diff: string, taskId: string): ReviewResult {
    if (!diff || diff.trim().length === 0) {
      return {
        taskId,
        status: 'rejected',
        reviewSummary: '[reviewer: local-rule] Diff is empty — no changes to review.',
        findings: ['No changes detected'],
        requiredRework: [],
        qualityGateStatus: 'skipped',
        mergeAllowed: false,
        reviewer: 'local-rule',
      };
    }

    const lines = diff.split('\n');
    const findings: string[] = [];
    const requiredRework: string[] = [];

    // Check for .env changes
    const envChanges = lines.filter((l) => l.startsWith('diff --git') && l.includes('.env'));
    if (envChanges.length > 0) {
      findings.push(`Diff modifies .env files: ${envChanges.join(', ')}`);
      requiredRework.push('Remove .env file changes from the commit');
    }

    // Check for conflict markers
    const hasConflicts = lines.some((l) => l.includes('<<<<<<<') || l.includes('>>>>>>>') || l.includes('======='));
    if (hasConflicts) {
      findings.push('Diff contains unresolved conflict markers');
      requiredRework.push('Resolve all conflict markers before merging');
    }

    // Check for binary files
    const binaryFiles = lines.filter((l) => l.startsWith('diff --git') && lines.some((l2) => l2.includes('Binary files')));
    if (binaryFiles.length > 0) {
      findings.push(`Diff contains binary file changes (allowed but flagged)`);
    }

    // Check for forbidden path patterns
    const forbiddenPatterns = ['.env', '.env.', 'secret', 'password', 'credential', 'apikey', 'token'];
    const contentLines = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    for (const pattern of forbiddenPatterns) {
      const matches = contentLines.filter((l) => l.toLowerCase().includes(pattern));
      if (matches.length > 0) {
        findings.push(`Added lines may contain sensitive content (matched: '${pattern}')`);
        requiredRework.push(`Review and remove hardcoded '${pattern}' values`);
        break;
      }
    }

    if (requiredRework.length > 0) {
      return {
        taskId,
        status: 'rework_required',
        reviewSummary: `[reviewer: local-rule] ${findings.join('; ')}`,
        findings,
        requiredRework,
        qualityGateStatus: findings.includes('Unresolved conflict markers') ? 'failed' : 'passed',
        mergeAllowed: false,
        reviewer: 'local-rule',
      };
    }

    return {
      taskId,
      status: 'approved',
      reviewSummary: `[reviewer: local-rule] ${lines.length} lines diff reviewed, no issues found.`,
      findings,
      requiredRework: [],
      qualityGateStatus: 'passed',
      mergeAllowed: true,
      reviewer: 'local-rule',
    };
  }
}
