import { describe, it, expect } from 'vitest';
import { LocalRuleReviewer } from '../../src/adapters/local-rule-reviewer.js';
import { CodexReviewer } from '../../src/adapters/codex-reviewer.js';
import { CodexCliReviewer } from '../../src/adapters/codex-cli-reviewer.js';

describe('Reviewer identification', () => {
  describe('LocalRuleReviewer', () => {
    const reviewer = new LocalRuleReviewer();

    it('marks results as reviewer: local-rule', () => {
      const result = reviewer.reviewDiff('diff --git a/file.ts b/file.ts\n+console.log("hi")', 'task-001');
      expect(result.reviewer).toBe('local-rule');
      expect(result.reviewSummary).toContain('[reviewer: local-rule]');
    });

    it('does not accept codex-cli or codex-sdk label', () => {
      const result = reviewer.reviewDiff('diff --git a/file.ts b/file.ts\n+console.log("hi")', 'task-001');
      expect(result.reviewer).not.toBe('codex-cli');
      expect(result.reviewer).not.toBe('codex-sdk');
    });
  });

  describe('CodexReviewer (mock, allowRealReview=false)', () => {
    const reviewer = new CodexReviewer({ allowRealReview: false });

    it('marks results with configured label', async () => {
      const result = await reviewer.reviewDiff('diff --git a/file.ts b/file.ts\n+console.log("hi")', 'task-001');
      // Default label is local-rule unless overridden
      expect(result.reviewer).toBe('local-rule');
    });

    it('accepts custom reviewer label', async () => {
      const customReviewer = new CodexReviewer({ allowRealReview: false, reviewerLabel: 'codex-sdk' });
      const result = await customReviewer.reviewDiff('diff --git a/file.ts b/file.ts\n+console.log("hi")', 'task-001');
      expect(result.reviewer).toBe('codex-sdk');
    });
  });

  describe('CodexCliReviewer', () => {
    it('marks results as reviewer: codex-cli even when disabled', async () => {
      const reviewer = new CodexCliReviewer({ allowRealReview: false });
      const result = await reviewer.reviewDiff('some diff', 'task-001');
      expect(result.reviewer).toBe('codex-cli');
    });

    it('cannot produce local-rule label', async () => {
      const reviewer = new CodexCliReviewer({ allowRealReview: false });
      const result = await reviewer.reviewDiff('some diff', 'task-001');
      expect(result.reviewer).not.toBe('local-rule');
    });
  });
});
