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
{ "taskId": "task-001", "status": "completed", "summary": "ok", "commitHash": "abc1234",
  "filesChanged": [], "checks": [], "scopeViolations": [],
  "risks": [], "unresolvedQuestions": [], "productDecisionRequired": false,
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "cacheHitTokens": 0 } }`;

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult).not.toBeNull();
      expect(result.workerResult!.commitHash).toBe('abc1234');
    });

    it('rejects completed WorkerResult without commitHash (strict contract)', () => {
      const output = `BEGIN_WORKER_RESULT_JSON
{ "taskId": "task-001", "status": "completed", "summary": "ok",
  "filesChanged": ["docs/README.md"], "checks": [], "scopeViolations": [],
  "risks": [], "unresolvedQuestions": [], "productDecisionRequired": false,
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "cacheHitTokens": 0 } }
END_WORKER_RESULT_JSON`;

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('commitHash'))).toBe(true);
    });

    it('parses code-fenced completed result with commitHash', () => {
      const output = '```json\n' + [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(validWorkerResult),
        'END_WORKER_RESULT_JSON',
      ].join('\n') + '\n```';

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.commitHash).toBe('abc1234');
    });

    it('parses markers literally wrapped in backticks (model quotes the prompt instruction)', () => {
      const output = [
        'Some text first',
        '`BEGIN_WORKER_RESULT_JSON`',
        JSON.stringify(validWorkerResult),
        '`END_WORKER_RESULT_JSON`',
        'trailing',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.status).toBe('completed');
      expect(result.workerResult!.taskId).toBe('task-001');
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

  describe('model-realistic shape normalization (regression: A/B impl-turn hang)', () => {
    // The real Pi (DeepSeek V4-Flash) emits `checks` as plain strings and
    // `tokenUsage` as the string "minimal" under the terse minimal-packet
    // contract. The strict schema rejected these, the early-detection kill
    // never fired, and the worker ran until the 40-minute timeout. These
    // shapes must now be accepted (normalized), not treated as evidence.
    const realisticResult = {
      taskId: 'task-001',
      status: 'completed',
      summary: '施工完成',
      filesChanged: ['docs/README.md'],
      commitHash: 'abc1234',
      checks: [
        'Root cause confirmed: map uses `this`, undefined after destructuring',
        'Fix approach identified: replace `this` with the `generator` closure',
        'No .d.ts change needed: map is already a plain callable property',
      ],
      scopeViolations: [],
      risks: ['Existing tests never destructure map, so the bug was uncovered.'],
      unresolvedQuestions: [],
      productDecisionRequired: false,
      tokenUsage: 'minimal',
    };

    it('accepts string checks + "minimal" tokenUsage (the exact failed-run shape)', () => {
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(realisticResult),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.checks).toEqual([
        { name: realisticResult.checks[0], status: 'info', summary: realisticResult.checks[0] },
        { name: realisticResult.checks[1], status: 'info', summary: realisticResult.checks[1] },
        { name: realisticResult.checks[2], status: 'info', summary: realisticResult.checks[2] },
      ]);
      expect(result.workerResult!.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 });
    });

    it('normalizes a missing tokenUsage to zeros', () => {
      const missingUsage = { ...realisticResult };
      delete (missingUsage as Record<string, unknown>).tokenUsage;

      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(missingUsage),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 });
    });

    it('keeps a valid numeric tokenUsage untouched', () => {
      const withNumbers = { ...validWorkerResult };
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(withNumbers),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 200, cacheHitTokens: 0 });
    });

    it('maps status synonyms ("success") to the canonical enum (regression: diagnose-task result)', () => {
      const successStatus = {
        ...validWorkerResult,
        status: 'success',
        scopeViolations: [{ path: 'repro-map.js', note: 'repro artifact for evidence' }],
      };
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(successStatus),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.status).toBe('completed');
      expect(result.workerResult!.scopeViolations).toEqual(['repro-map.js: repro artifact for evidence']);
    });

    it('flattens structured risks/unresolvedQuestions entries to strings', () => {
      const structured = {
        ...validWorkerResult,
        risks: [{ path: 'node_modules', note: 'generated by npm install' }],
        unresolvedQuestions: [{ note: 'none' }],
      };
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(structured),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.risks).toEqual(['node_modules: generated by npm install']);
      expect(result.workerResult!.unresolvedQuestions).toEqual(['{"note":"none"}']);
    });

    it('still rejects an unknown status value after synonym mapping', () => {
      const unknownStatus = { ...validWorkerResult, status: 'in_progress_forever' };
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(unknownStatus),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
    });

    it('accepts a no-change completion: completed + empty filesChanged + empty commitHash (diagnose/report-only task)', () => {
      // The plan may create diagnose-only tasks ("confirm root cause without
      // changing any files"). The model honestly reports no changes and no
      // commit; the schema must accept this shape (the scheduler separately
      // proves the worktree is clean before accepting the completion).
      const noChange = {
        taskId: 'task-001',
        status: 'completed',
        summary: 'Confirmed the root cause via inline repro; no files were changed.',
        filesChanged: [],
        commitHash: '',
        checks: [
          { name: 'inline-repro-throws', status: 'passed', summary: 'destructured map throws TypeError' },
        ],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      };
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(noChange),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.status).toBe('completed');
      expect(result.workerResult!.commitHash).toBe('');
    });

    it('still rejects completed with empty commitHash when filesChanged is non-empty', () => {
      const changedNoHash = { ...validWorkerResult, commitHash: '' };
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(changedNoHash),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('commitHash'))).toBe(true);
    });

    it('normalizes commitHash: null to an empty string (no-change completion shape)', () => {
      const nullHash = {
        taskId: 'task-001',
        status: 'success', // synonym → completed
        summary: 'Confirmed root cause; no files changed.',
        filesChanged: [],
        commitHash: null,
        checks: [],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: 'minimal',
      };
      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(nullHash),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(true);
      expect(result.workerResult!.status).toBe('completed');
      expect(result.workerResult!.commitHash).toBe('');
      expect(result.workerResult!.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 });
    });

    it('still rejects completed result without commitHash after normalization', () => {
      const missingHash = { ...realisticResult };
      delete (missingHash as Record<string, unknown>).commitHash;

      const output = [
        'BEGIN_WORKER_RESULT_JSON',
        JSON.stringify(missingHash),
        'END_WORKER_RESULT_JSON',
      ].join('\n');

      const result = parseWorkerResult(output);
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('commitHash'))).toBe(true);
    });
  });
});
