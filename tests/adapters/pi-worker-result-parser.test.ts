import { describe, it, expect } from 'vitest';
import { parseWorkerResult } from '../../src/adapters/pi-worker-result-parser.js';

describe('parseWorkerResult', () => {
  const validWorkerResult = {
    taskId: 'task-001',
    status: 'completed',
    summary: '施工完成',
    filesChanged: ['docs/README.md'],
    commitHash: 'abc1234',
    checks: [{ name: 'scope', status: 'passed', summary: 'ok' }],
    scopeViolations: [],
    risks: [],
    unresolvedQuestions: [],
    productDecisionRequired: false,
    tokenUsage: { inputTokens: 100, outputTokens: 200, cacheHitTokens: 0 },
  };

  describe('marked block extraction', () => {
    it('parses valid marked block', () => {
      const output = [
        'Some natural language output...',
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(validWorkerResult, null, 2),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult).not.toBeNull();
      expect(result.workerResult!.taskId).toBe('task-001');
      expect(result.workerResult!.status).toBe('completed');
    });

    it('ignores text after END marker', () => {
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(validWorkerResult),
        'END_WORKER_RESULT_JSON',
        'Some trailing text',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
    });

    it('parses marked block even with surrounding text', () => {
      const output = `Here is the result:
BEGIN_WORKER_RESULT_JSON
${JSON.stringify(validWorkerResult)}
END_WORKER_RESULT_JSON
Hope this helps!`;

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
    });

    it('fails gracefully with no markers', () => {
      const result = parseWorkerResult('just some text');
      expect(result.success).toBe(false);
      expect(result.workerResult).toBeNull();
    });

    it('fails with malformed JSON in markers', () => {
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        '{ broken json',
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
    });

    it('fails when status is missing in the JSON', () => {
      const invalid = {
        taskId: 'task-001',
        // missing status
        summary: 'test',
      };

      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(invalid),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('fallback JSON extraction', () => {
    it('falls back to last JSON object when no markers', () => {
      const output = `Some text
{ "taskId": "task-001", "status": "completed", "summary": "ok",
  "filesChanged": [], "checks": [], "scopeViolations": [],
  "risks": [], "unresolvedQuestions": [], "productDecisionRequired": false,
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "cacheHitTokens": 0 } }`;

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult).not.toBeNull();
    });
  });

  describe('schema validation', () => {
    it('rejects WorkerResult missing status', () => {
      const invalid = {
        taskId: 'task-001',
        // status intentionally omitted
        summary: 'test',
        filesChanged: [],
        checks: [],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      };

      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(invalid),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('status'))).toBe(true);
    });

    it('rejects invalid status enum value', () => {
      const invalid = { ...validWorkerResult, status: 'unknown_status' };

      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(invalid),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
    });
  });
});
