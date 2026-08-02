import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexCliReviewer, parseCodexCliReviewOutput } from '../../src/adapters/codex-cli-reviewer.js';
import { FakeCodexProcessRunner } from '../../src/adapters/codex-process-runner.js';

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
    it('approves no-issue wording without false positives', () => {
      const output = [
        'codex',
        'The diff only replaces the contents of a text fixture/message file,',
        'and no discrete correctness issue is evident from the provided change.',
      ].join('\n');

      const result = parseCodexCliReviewOutput(output, 'task-no-issue');

      expect(result.status).toBe('approved');
      expect(result.mergeAllowed).toBe(true);
      expect(result.requiredRework).toEqual([]);
      expect(result.reviewer).toBe('codex-cli');
    });

    it('requires rework for explicit actionable issue bullets', () => {
      const output = [
        '- Issue: package.json contains invalid JSON and npm test will fail.',
      ].join('\n');

      const result = parseCodexCliReviewOutput(output, 'task-issue');

      expect(result.status).toBe('rework_required');
      expect(result.mergeAllowed).toBe(false);
      expect(result.requiredRework).toHaveLength(1);
      expect(result.reviewer).toBe('codex-cli');
    });
  });
});
