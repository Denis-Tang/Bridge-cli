import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexCliReviewer, parseCodexCliReviewOutput } from '../../src/adapters/codex-cli-reviewer.js';
import { FakeCodexProcessRunner } from '../../src/adapters/codex-process-runner.js';

const UNAVAILABLE_SUMMARY =
  '[reviewer: codex-cli] Review output could not be parsed into a valid ReviewResult.';
const UNAVAILABLE_FINDING =
  'Review output could not be parsed into a valid ReviewResult.';

const block = (body: unknown): string =>
  `BEGIN_REVIEW_RESULT_JSON\n${JSON.stringify(body)}\nEND_REVIEW_RESULT_JSON`;

const approvedResult = {
  taskId: 'task-001',
  status: 'approved',
  reviewSummary: 'Looks good',
  findings: [],
  requiredRework: [],
  qualityGateStatus: 'passed',
  mergeAllowed: true,
};

describe('CodexCliReviewer', () => {
  describe('reviewDiff with allowRealReview=false (default)', () => {
    it('rejects empty diff', async () => {
      const reviewer = new CodexCliReviewer({ allowRealReview: false });
      const result = await reviewer.reviewDiff('', 'task-001');
      expect(result.status).toBe('rejected');
      expect(result.mergeAllowed).toBe(false);
      expect(result.reviewer).toBe('codex-cli');
    });

    it('rejects when allowRealReview is false', async () => {
      const reviewer = new CodexCliReviewer({ allowRealReview: false });
      const result = await reviewer.reviewDiff('some diff content', 'task-001');
      expect(result.status).toBe('rejected');
      expect(result.reviewSummary).toContain('allowRealReview=false');
      expect(result.reviewer).toBe('codex-cli');
    });

    it('marks reviewer as codex-cli', async () => {
      const reviewer = new CodexCliReviewer({ allowRealReview: false });
      const result = await reviewer.reviewDiff('', 'task-001');
      expect(result.reviewer).toBe('codex-cli');
    });
  });

  describe('reviewer field', () => {
    it('always sets reviewer to codex-cli', async () => {
      const reviewer = new CodexCliReviewer({ allowRealReview: false });
      const result1 = await reviewer.reviewDiff('', 'task-001');
      expect(result1.reviewer).toBe('codex-cli');

      const result2 = await reviewer.reviewDiff('some diff', 'task-002');
      expect(result2.reviewer).toBe('codex-cli');
    });
  });

  it('does not persist raw diff or CLI output on failure', async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'brainctl-review-privacy-'));
    try {
      const runner = new FakeCodexProcessRunner();
      runner.setDefaultResult({
        stdout: 'PRIVATE_SOURCE_FROM_STDOUT',
        stderr: 'PRIVATE_SOURCE_FROM_STDERR',
        exitCode: 1,
        durationMs: 55,
        timedOut: true,
      });
      const reviewer = new CodexCliReviewer(
        { allowRealReview: true, sessionDir, workDir: sessionDir, timeoutMs: 1234 },
        { processRunner: runner },
      );
      const result = await reviewer.reviewDiff('PRIVATE_DIFF_CONTENT', 'privacy-test');
      const log = readFileSync(join(sessionDir, 'privacy-test_codex-review.log'), 'utf8');

      expect(result.reviewSummary).toContain('timed out after 1234ms');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.executionMetadata).toMatchObject({ errorCategory: 'timeout', exitCode: 1, durationMs: 55 });
      expect(result.executionMetadata?.stderrHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE');
      expect(log).not.toContain('PRIVATE_SOURCE');
      expect(log).not.toContain('PRIVATE_DIFF_CONTENT');
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  describe('parseCodexCliReviewOutput', () => {
    it('returns unavailable/rejected for headings with no JSON block', () => {
      const output = [
        'Findings',
        'Suggested Fixes',
        'Test Gap',
        'The change is correct and no actionable issue is evident.',
      ].join('\n');

      const result = parseCodexCliReviewOutput(output, 'task-headings');

      expect(result.status).toBe('rejected');
      expect(result.mergeAllowed).toBe(false);
      expect(result.qualityGateStatus).toBe('failed');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.requiredRework).toEqual([]);
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
      expect(result.findings).toEqual([UNAVAILABLE_FINDING]);
    });

    it('does not leak raw output in the unavailable fallback', () => {
      const output = 'Findings\nPRIVATE_SECRET_WORD\nno JSON block here';

      const result = parseCodexCliReviewOutput(output, 'task-no-json');

      expect(result.reviewerUnavailable).toBe(true);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET_WORD');
      expect(result.findings).toEqual([UNAVAILABLE_FINDING]);
    });

    it('approves a valid approved JSON block even with prose around it', () => {
      const output = [
        'Here is some prose before the block.',
        'It mentions findings and suggested fixes outside the markers.',
        block(approvedResult),
        'And some trailing prose after the block.',
      ].join('\n');

      const result = parseCodexCliReviewOutput(output, 'task-001');

      expect(result.status).toBe('approved');
      expect(result.mergeAllowed).toBe(true);
      expect(result.qualityGateStatus).toBe('passed');
      expect(result.requiredRework).toEqual([]);
      expect(result.reviewer).toBe('codex-cli');
    });

    it('forces reviewer to codex-cli on successful parse', () => {
      const result = parseCodexCliReviewOutput(
        block({ ...approvedResult, reviewer: 'local-rule' }),
        'task-001',
      );
      expect(result.reviewer).toBe('codex-cli');
    });

    it('parses a valid rework_required block', () => {
      const reworkResult = {
        taskId: 'task-rework',
        status: 'rework_required',
        reviewSummary: 'Please fix the conflict marker',
        findings: ['Conflict marker present'],
        requiredRework: ['Remove conflict marker'],
        qualityGateStatus: 'failed',
        mergeAllowed: false,
      };

      const result = parseCodexCliReviewOutput(block(reworkResult), 'task-rework');

      expect(result.status).toBe('rework_required');
      expect(result.mergeAllowed).toBe(false);
      expect(result.qualityGateStatus).toBe('failed');
      expect(result.requiredRework).toEqual(['Remove conflict marker']);
      expect(result.reviewer).toBe('codex-cli');
    });

    it('falls back to unavailable for duplicate markers', () => {
      const output = [
        'BEGIN_REVIEW_RESULT_JSON',
        'BEGIN_REVIEW_RESULT_JSON',
        JSON.stringify(approvedResult),
        'END_REVIEW_RESULT_JSON',
      ].join('\n');

      const result = parseCodexCliReviewOutput(output, 'task-001');

      expect(result.status).toBe('rejected');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
      expect(result.executionMetadata).toBeUndefined();
    });

    it('falls back to unavailable for malformed JSON', () => {
      const result = parseCodexCliReviewOutput(
        'BEGIN_REVIEW_RESULT_JSON\n{not valid json}\nEND_REVIEW_RESULT_JSON',
        'task-001',
      );

      expect(result.status).toBe('rejected');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
    });

    it('falls back to unavailable for wrong taskId', () => {
      const result = parseCodexCliReviewOutput(block(approvedResult), 'task-other');

      expect(result.status).toBe('rejected');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.taskId).toBe('task-other');
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
    });

    it('falls back to unavailable for a non-string array value', () => {
      const invalid = { ...approvedResult, findings: [123] };
      const result = parseCodexCliReviewOutput(block(invalid), 'task-001');

      expect(result.status).toBe('rejected');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
    });

    it('falls back to unavailable for an empty string array value', () => {
      const invalid = { ...approvedResult, requiredRework: ['   '] };
      const result = parseCodexCliReviewOutput(block(invalid), 'task-001');

      expect(result.status).toBe('rejected');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
    });

    it('falls back to unavailable for approved with requiredRework', () => {
      const invalid = { ...approvedResult, requiredRework: ['Fix this'] };
      const result = parseCodexCliReviewOutput(block(invalid), 'task-001');

      expect(result.status).toBe('rejected');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
    });

    it('falls back to unavailable for rework_required without required rework', () => {
      const invalid = {
        ...approvedResult,
        status: 'rework_required',
        qualityGateStatus: 'failed',
        mergeAllowed: false,
        requiredRework: [],
      };
      const result = parseCodexCliReviewOutput(block(invalid), 'task-001');

      expect(result.status).toBe('rejected');
      expect(result.reviewerUnavailable).toBe(true);
      expect(result.reviewSummary).toBe(UNAVAILABLE_SUMMARY);
    });
  });
});
