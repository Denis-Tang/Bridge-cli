import { describe, it, expect } from 'vitest';
import { CodexReviewer } from '../../src/adapters/codex-reviewer.js';
import { parseReviewResult } from '../../src/adapters/codex-review-result-parser.js';

describe('CodexReviewer', () => {
  const reviewer = new CodexReviewer({ allowRealReview: false });

  describe('reviewDiff', () => {
    it('rejects empty diff', async () => {
      const result = await reviewer.reviewDiff('', 'task-001');
      expect(result.status).toBe('rejected');
      expect(result.mergeAllowed).toBe(false);
    });

    it('rejects whitespace-only diff', async () => {
      const result = await reviewer.reviewDiff('   \n  ', 'task-001');
      expect(result.status).toBe('rejected');
    });

    it('approves clean diff', async () => {
      const diff = `diff --git a/docs/guide.md b/docs/guide.md
index abc..def 100644
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1 +1 @@
-# Old Title
+# New Title`;
      const result = await reviewer.reviewDiff(diff, 'task-001');
      expect(result.status).toBe('approved');
      expect(result.mergeAllowed).toBe(true);
    });

    it('flags .env file changes', async () => {
      const diff = `diff --git a/.env b/.env
index abc..def 100644
--- a/.env
+++ b/.env
@@ -1 +1 @@
-SECRET=old
+SECRET=new`;
      const result = await reviewer.reviewDiff(diff, 'task-001');
      expect(result.findings.some((f) => f.includes('.env'))).toBe(true);
    });

    it('flags conflict markers', async () => {
      const diff = `<<<<<<< HEAD
old content
=======
new content
>>>>>>> branch`;
      const result = await reviewer.reviewDiff(diff, 'task-001');
      expect(result.status).toBe('rework_required');
      expect(result.mergeAllowed).toBe(false);
    });

    it('flags secret-like content', async () => {
      const diff = `+const password = "supersecret123";`;
      const result = await reviewer.reviewDiff(diff, 'task-001');
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  describe('buildReviewPrompt', () => {
    it('includes diff content', () => {
      const prompt = reviewer.buildReviewPrompt('my diff content', 'task-001');
      expect(prompt).toContain('my diff content');
      expect(prompt).toContain('task-001');
      expect(prompt).toContain('BEGIN_REVIEW_RESULT_JSON');
      expect(prompt).toContain('END_REVIEW_RESULT_JSON');
    });
  });
});

describe('parseReviewResult', () => {
  const validResult = {
    taskId: 'task-001',
    status: 'approved',
    reviewSummary: 'Looks good',
    findings: [],
    requiredRework: [],
    qualityGateStatus: 'passed',
    mergeAllowed: true,
  };

  const block = (body: unknown): string =>
    `BEGIN_REVIEW_RESULT_JSON\n${JSON.stringify(body)}\nEND_REVIEW_RESULT_JSON`;

  it('parses valid marked block', () => {
    const output = `Some text
BEGIN_REVIEW_RESULT_JSON
${JSON.stringify(validResult)}
END_REVIEW_RESULT_JSON
trailing`;
    const result = parseReviewResult(output);
    expect(result.success).toBe(true);
    expect(result.result?.status).toBe('approved');
    expect(result.result?.mergeAllowed).toBe(true);
  });

  it('accepts a taskId mismatch when no expectedTaskId is supplied', () => {
    const result = parseReviewResult(block(validResult));
    expect(result.success).toBe(true);
    expect(result.result?.taskId).toBe('task-001');
  });

  it('fails on empty output', () => {
    const result = parseReviewResult('');
    expect(result.success).toBe(false);
  });

  it('fails on missing markers', () => {
    const result = parseReviewResult('just some text');
    expect(result.success).toBe(false);
  });

  it('fails when the begin marker is missing', () => {
    const result = parseReviewResult(`{"taskId":"task-001"}\nEND_REVIEW_RESULT_JSON`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('BEGIN_REVIEW_RESULT_JSON');
  });

  it('fails when the end marker is missing', () => {
    const result = parseReviewResult(`BEGIN_REVIEW_RESULT_JSON\n{"taskId":"task-001"}`);
    expect(result.success).toBe(false);
    expect(result.error).toContain('END_REVIEW_RESULT_JSON');
  });

  it('ignores headings, prose, and keywords outside the marked block', () => {
    const output = [
      'Findings',
      'Suggested Fixes',
      'Test Gap',
      'no actionable issues found',
      'BEGIN_REVIEW_RESULT_JSON',
      JSON.stringify(validResult),
      'END_REVIEW_RESULT_JSON',
      'error warning problem must fix',
    ].join('\n');

    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(true);
    expect(result.result?.status).toBe('approved');
    expect(result.result?.findings).toEqual([]);
  });

  it('fails when a marker appears inline with other text', () => {
    const output = `BEGIN_REVIEW_RESULT_JSON extra\n${JSON.stringify(validResult)}\nEND_REVIEW_RESULT_JSON`;
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
  });

  it('fails on duplicate begin markers', () => {
    const output = [
      'BEGIN_REVIEW_RESULT_JSON',
      'BEGIN_REVIEW_RESULT_JSON',
      JSON.stringify(validResult),
      'END_REVIEW_RESULT_JSON',
    ].join('\n');
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('exactly one');
  });

  it('fails on duplicate end markers', () => {
    const output = [
      'BEGIN_REVIEW_RESULT_JSON',
      JSON.stringify(validResult),
      'END_REVIEW_RESULT_JSON',
      'END_REVIEW_RESULT_JSON',
    ].join('\n');
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('exactly one');
  });

  it('fails on multiple complete blocks', () => {
    const output = [
      'BEGIN_REVIEW_RESULT_JSON',
      JSON.stringify(validResult),
      'END_REVIEW_RESULT_JSON',
      'BEGIN_REVIEW_RESULT_JSON',
      JSON.stringify(validResult),
      'END_REVIEW_RESULT_JSON',
    ].join('\n');
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
  });

  it('fails when the end marker precedes the begin marker', () => {
    const output = [
      'END_REVIEW_RESULT_JSON',
      JSON.stringify(validResult),
      'BEGIN_REVIEW_RESULT_JSON',
    ].join('\n');
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('before');
  });

  it('fails on empty JSON block', () => {
    const output = 'BEGIN_REVIEW_RESULT_JSON\n   \nEND_REVIEW_RESULT_JSON';
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Empty JSON block');
  });

  it('fails on malformed JSON', () => {
    const output = 'BEGIN_REVIEW_RESULT_JSON\n{not valid json}\nEND_REVIEW_RESULT_JSON';
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });

  it('fails when the parsed value is not an object', () => {
    const result = parseReviewResult(block(['a', 'b']), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not an object');
  });

  it('fails when expectedTaskId does not match', () => {
    const result = parseReviewResult(block(validResult), 'task-other');
    expect(result.success).toBe(false);
    expect(result.error).toContain('taskId');
  });

  it('fails on missing status field', () => {
    const invalid = { taskId: 'task-001', reviewSummary: 'test', findings: [], requiredRework: [], qualityGateStatus: 'skipped', mergeAllowed: false };
    const output = `BEGIN_REVIEW_RESULT_JSON\n${JSON.stringify(invalid)}\nEND_REVIEW_RESULT_JSON`;
    const result = parseReviewResult(output, 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('status');
  });

  it('fails on invalid status enum', () => {
    const invalid = { ...validResult, status: 'unknown_status' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('status');
  });

  it('fails on invalid qualityGateStatus enum', () => {
    const invalid = { ...validResult, qualityGateStatus: 'uncertain' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('qualityGateStatus');
  });

  it('fails when mergeAllowed is not boolean', () => {
    const invalid = { ...validResult, mergeAllowed: 'yes' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('mergeAllowed');
  });

  it('fails when reviewSummary is empty', () => {
    const invalid = { ...validResult, reviewSummary: '   ' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('reviewSummary');
  });

  it('fails when findings is not an array', () => {
    const invalid = { ...validResult, findings: 'looks fine' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('findings');
  });

  it('fails when requiredRework is not an array', () => {
    const invalid = { ...validResult, requiredRework: 'nothing' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('requiredRework');
  });

  it('fails when findings contains a non-string value', () => {
    const invalid = { ...validResult, findings: [123] };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('findings');
  });

  it('fails when findings contains an empty string value', () => {
    const invalid = { ...validResult, findings: ['   '] };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('findings');
  });

  it('fails when requiredRework contains a non-string value', () => {
    const invalid = { ...validResult, requiredRework: [true] };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('requiredRework');
  });

  it('fails when requiredRework contains an empty string value', () => {
    const invalid = { ...validResult, requiredRework: [''] };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('requiredRework');
  });

  it('fails when reviewer is not a string', () => {
    const invalid = { ...validResult, reviewer: 123 };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('reviewer');
  });

  it('fails when reviewerUnavailable is not a boolean', () => {
    const invalid = { ...validResult, reviewerUnavailable: 'yes' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('reviewerUnavailable');
  });

  it('fails when approved carries reviewerUnavailable=true (semantic contradiction)', () => {
    const invalid = { ...validResult, reviewerUnavailable: true };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('reviewerUnavailable');
  });

  it('fails when rework_required carries reviewerUnavailable=true (semantic contradiction)', () => {
    const invalid = {
      ...validResult,
      status: 'rework_required',
      reviewSummary: 'Please fix',
      findings: ['issue'],
      requiredRework: ['Fix it'],
      qualityGateStatus: 'failed',
      mergeAllowed: false,
      reviewerUnavailable: true,
    };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('reviewerUnavailable');
  });

  it('fails when approved carries a failed executionMetadata errorCategory', () => {
    const invalid = { ...validResult, executionMetadata: { errorCategory: 'timeout', exitCode: 1 } };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('errorCategory');
  });

  it('accepts sanitized executionMetadata fields on a non-verdict status', () => {
    // approved may never carry an errorCategory (semantic contradiction), but a
    // non-verdict status (needs_user_decision) may carry sanitized subprocess
    // metadata that must still be parsed and preserved.
    const valid = {
      ...validResult,
      status: 'needs_user_decision',
      mergeAllowed: false,
      executionMetadata: {
        errorCategory: 'timeout',
        exitCode: null,
        durationMs: 1200,
        stderrHash: 'abc123',
      },
    };
    const result = parseReviewResult(block(valid), 'task-001');
    expect(result.success).toBe(true);
    expect(result.result?.executionMetadata).toMatchObject({ errorCategory: 'timeout', durationMs: 1200 });
  });

  it('accepts sanitized executionMetadata without errorCategory on approved', () => {
    const valid = {
      ...validResult,
      executionMetadata: {
        durationMs: 1200,
        stderrHash: 'abc123',
      },
    };
    const result = parseReviewResult(block(valid), 'task-001');
    expect(result.success).toBe(true);
    expect(result.result?.executionMetadata).toMatchObject({ durationMs: 1200, stderrHash: 'abc123' });
  });

  it('fails when executionMetadata contains an unsupported field', () => {
    const invalid = {
      ...validResult,
      executionMetadata: { stdout: 'raw stdout must not be allowed' },
    };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('executionMetadata');
  });

  it('fails when executionMetadata.errorCategory is invalid', () => {
    const invalid = {
      ...validResult,
      executionMetadata: { errorCategory: 'raw_stderr' },
    };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('errorCategory');
  });

  it('fails on approved with requiredRework', () => {
    const invalid = { ...validResult, requiredRework: ['Fix this'] };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('approved');
  });

  it('fails on approved with failed quality gate', () => {
    const invalid = { ...validResult, qualityGateStatus: 'failed' };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('approved');
  });

  it('fails on approved with mergeAllowed false', () => {
    const invalid = { ...validResult, mergeAllowed: false };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('approved');
  });

  it('accepts valid rework_required', () => {
    const valid = {
      ...validResult,
      status: 'rework_required',
      reviewSummary: 'Please fix the conflict',
      findings: ['Conflict markers present'],
      requiredRework: ['Remove conflict markers'],
      qualityGateStatus: 'failed',
      mergeAllowed: false,
    };
    const result = parseReviewResult(block(valid), 'task-001');
    expect(result.success).toBe(true);
    expect(result.result?.status).toBe('rework_required');
    expect(result.result?.requiredRework).toEqual(['Remove conflict markers']);
  });

  it('fails on rework_required without requiredRework', () => {
    const invalid = {
      ...validResult,
      status: 'rework_required',
      qualityGateStatus: 'failed',
      mergeAllowed: false,
      requiredRework: [],
    };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('rework_required');
  });

  it('fails on rework_required with passed quality gate', () => {
    const invalid = {
      ...validResult,
      status: 'rework_required',
      mergeAllowed: false,
      requiredRework: ['Fix this'],
      qualityGateStatus: 'passed',
    };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('rework_required');
  });

  it('fails on rework_required with mergeAllowed true', () => {
    const invalid = {
      ...validResult,
      status: 'rework_required',
      requiredRework: ['Fix this'],
      qualityGateStatus: 'failed',
      mergeAllowed: true,
    };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('rework_required');
  });

  it('accepts rejected with mergeAllowed false', () => {
    const valid = {
      ...validResult,
      status: 'rejected',
      reviewSummary: 'Rejected by policy',
      qualityGateStatus: 'skipped',
      mergeAllowed: false,
    };
    const result = parseReviewResult(block(valid), 'task-001');
    expect(result.success).toBe(true);
    expect(result.result?.status).toBe('rejected');
  });

  it('fails on rejected with mergeAllowed true', () => {
    const invalid = { ...validResult, status: 'rejected', mergeAllowed: true };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('rejected');
  });

  it('accepts needs_user_decision with mergeAllowed false', () => {
    const valid = {
      ...validResult,
      status: 'needs_user_decision',
      reviewSummary: 'A human must decide',
      qualityGateStatus: 'skipped',
      mergeAllowed: false,
    };
    const result = parseReviewResult(block(valid), 'task-001');
    expect(result.success).toBe(true);
    expect(result.result?.status).toBe('needs_user_decision');
  });

  it('fails on needs_user_decision with mergeAllowed true', () => {
    const invalid = { ...validResult, status: 'needs_user_decision', mergeAllowed: true };
    const result = parseReviewResult(block(invalid), 'task-001');
    expect(result.success).toBe(false);
    expect(result.error).toContain('needs_user_decision');
  });
});
