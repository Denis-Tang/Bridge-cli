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

  it('fails on empty output', () => {
    const result = parseReviewResult('');
    expect(result.success).toBe(false);
  });

  it('fails on missing markers', () => {
    const result = parseReviewResult('just some text');
    expect(result.success).toBe(false);
  });

  it('fails on missing status field', () => {
    const invalid = { taskId: 'task-001', reviewSummary: 'test', findings: [], requiredRework: [], qualityGateStatus: 'skipped', mergeAllowed: false };
    const output = `BEGIN_REVIEW_RESULT_JSON\n${JSON.stringify(invalid)}\nEND_REVIEW_RESULT_JSON`;
    const result = parseReviewResult(output);
    expect(result.success).toBe(false);
    expect(result.error).toContain('status');
  });

  it('fails on invalid status enum', () => {
    const invalid = { ...validResult, status: 'unknown_status' };
    const output = `BEGIN_REVIEW_RESULT_JSON\n${JSON.stringify(invalid)}\nEND_REVIEW_RESULT_JSON`;
    const result = parseReviewResult(output);
    expect(result.success).toBe(false);
  });

  it('fails when mergeAllowed is not boolean', () => {
    const invalid = { ...validResult, mergeAllowed: 'yes' };
    const output = `BEGIN_REVIEW_RESULT_JSON\n${JSON.stringify(invalid)}\nEND_REVIEW_RESULT_JSON`;
    const result = parseReviewResult(output);
    expect(result.success).toBe(false);
  });
});
