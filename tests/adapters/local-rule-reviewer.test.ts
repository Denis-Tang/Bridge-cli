import { describe, it, expect } from 'vitest';
import { LocalRuleReviewer } from '../../src/adapters/local-rule-reviewer.js';

describe('LocalRuleReviewer', () => {
  const reviewer = new LocalRuleReviewer();

  it('rejects empty diff', () => {
    const result = reviewer.reviewDiff('', 'task-001');
    expect(result.status).toBe('rejected');
    expect(result.mergeAllowed).toBe(false);
    expect(result.reviewSummary).toContain('local-rule');
  });

  it('rejects whitespace-only diff', () => {
    const result = reviewer.reviewDiff('   \n  ', 'task-001');
    expect(result.status).toBe('rejected');
  });

  it('approves clean diff', () => {
    const diff = `diff --git a/src/message.txt b/src/message.txt
index abc..def 100644
--- a/src/message.txt
+++ b/src/message.txt
@@ -1 +1 @@
-Hello World
+Hello brainctl!`;
    const result = reviewer.reviewDiff(diff, 'task-001');
    expect(result.status).toBe('approved');
    expect(result.mergeAllowed).toBe(true);
  });

  it('rejects .env file changes', () => {
    const diff = `diff --git a/.env b/.env
index abc..def 100644
--- a/.env
+++ b/.env
@@ -1 +1 @@
-SECRET=old
+SECRET=new`;
    const result = reviewer.reviewDiff(diff, 'task-001');
    expect(result.status).toBe('rework_required');
    expect(result.mergeAllowed).toBe(false);
    expect(result.findings.some((f) => f.includes('.env'))).toBe(true);
  });

  it('rejects conflict markers', () => {
    const diff = `diff --git a/file.txt b/file.txt
<<<<<<< HEAD
old content
=======
new content
>>>>>>> branch`;
    const result = reviewer.reviewDiff(diff, 'task-001');
    expect(result.status).toBe('rework_required');
    expect(result.mergeAllowed).toBe(false);
  });

  it('flags sensitive content in added lines', () => {
    const diff = `diff --git a/config.ts b/config.ts
+const password = "supersecret123";`;
    const result = reviewer.reviewDiff(diff, 'task-001');
    expect(result.mergeAllowed).toBe(false);
  });
});
