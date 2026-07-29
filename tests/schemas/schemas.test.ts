import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(__dirname, '../../src/schemas');

function loadSchema(name: string): object {
  const path = resolve(schemasDir, `${name}.schema.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('JSON Schema Validation', () => {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);

  describe('JobRequest', () => {
    const validate = ajv.compile(loadSchema('job-request'));

    it('validates a correct JobRequest', () => {
      const valid = {
        jobId: 'job_20260726_001',
        projectId: 'test-project',
        projectRoot: 'C:/Users/test/project',
        requestText: '修复文档中的命令示例',
        createdAt: '2026-07-26T03:49:00.000Z',
      };
      expect(validate(valid)).toBe(true);
    });

    it('fails when jobId is missing', () => {
      const invalid = { projectId: 'test', projectRoot: 'C:/path', requestText: 'test', createdAt: '2026-01-01T00:00:00.000Z' };
      expect(validate(invalid)).toBe(false);
    });

    it('accepts Windows paths', () => {
      const valid = {
        jobId: 'job_001',
        projectId: 'test',
        projectRoot: '<PROJECT_ROOT>/项目',
        requestText: '测试中文路径',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      expect(validate(valid)).toBe(true);
    });
  });

  describe('TaskSpec', () => {
    const validate = ajv.compile(loadSchema('task-spec'));

    it('validates a correct TaskSpec', () => {
      const valid = {
        taskId: 'task-001',
        title: '修复文档',
        goal: '更新文档示例',
        dependencies: [],
        allowedPaths: ['docs/README.md'],
        forbiddenPaths: ['.env'],
        contextFiles: ['README.md'],
        acceptanceChecks: ['文档命令可执行'],
        allowedCommands: ['git diff -- docs/README.md'],
        riskLevel: 'low',
        productDecisionsLocked: true,
        expectedOutputs: ['Git commit', 'WorkerResult'],
        heavyCommandSlotsRequired: 0,
        timeoutSeconds: 1800,
      };
      expect(validate(valid)).toBe(true);
    });

    it('fails when taskId is missing', () => {
      const invalid = {
        title: '测试',
        goal: 'test',
        dependencies: [],
        allowedPaths: [],
        forbiddenPaths: [],
        contextFiles: [],
        acceptanceChecks: [],
        allowedCommands: [],
        riskLevel: 'low',
        productDecisionsLocked: true,
        expectedOutputs: [],
        heavyCommandSlotsRequired: 0,
        timeoutSeconds: 600,
      };
      expect(validate(invalid)).toBe(false);
    });

    it('accepts Windows paths with Chinese characters', () => {
      const valid = {
        taskId: 'task-cn',
        title: '中文任务',
        goal: '测试中文字符',
        dependencies: [],
        allowedPaths: ['<PROJECT_ROOT>/项目/docs'],
        forbiddenPaths: ['.env'],
        contextFiles: [],
        acceptanceChecks: ['通过'],
        allowedCommands: [],
        riskLevel: 'low',
        productDecisionsLocked: true,
        expectedOutputs: [],
        heavyCommandSlotsRequired: 0,
        timeoutSeconds: 600,
      };
      expect(validate(valid)).toBe(true);
    });
  });

  describe('WorkerResult', () => {
    const validate = ajv.compile(loadSchema('worker-result'));

    it('validates a correct WorkerResult', () => {
      const valid = {
        taskId: 'task-001',
        status: 'completed',
        summary: '施工完成',
        filesChanged: ['docs/README.md'],
        commitHash: 'abc1234',
        checks: [{ name: 'scope check', status: 'passed', summary: 'ok' }],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: { inputTokens: 100, outputTokens: 200, cacheHitTokens: 0 },
      };
      expect(validate(valid)).toBe(true);
    });

    it('fails when status is missing', () => {
      const invalid = {
        taskId: 'task-001',
        summary: 'test',
        filesChanged: [],
        checks: [],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      };
      expect(validate(invalid)).toBe(false);
    });

    it('fails with invalid status value', () => {
      const invalid = {
        taskId: 'task-001',
        status: 'unknown_status',
        summary: 'test',
        filesChanged: [],
        checks: [],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      };
      expect(validate(invalid)).toBe(false);
    });

    it('accepts Windows paths', () => {
      const valid = {
        taskId: 'task-cn',
        status: 'completed',
        summary: '完成',
        filesChanged: ['<PROJECT_ROOT>/项目/docs/README.md'],
        checks: [{ name: 'scope', status: 'passed', summary: 'ok' }],
        scopeViolations: [],
        risks: [],
        unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: { inputTokens: 50, outputTokens: 100, cacheHitTokens: 0 },
      };
      expect(validate(valid)).toBe(true);
    });
  });

  describe('BrainPlan', () => {
    const validate = ajv.compile(loadSchema('brain-plan'));

    it('validates a correct BrainPlan', () => {
      const valid = {
        jobId: 'job_001',
        summary: '修复文档中的命令示例',
        tasks: ['task-001'],
        dependencies: [],
        parallelGroups: [['task-001']],
        decisionRequests: [],
        riskAssessment: { level: 'low', notes: ['简单文档修复'] },
      };
      expect(validate(valid)).toBe(true);
    });
  });

  describe('ReviewResult', () => {
    const validate = ajv.compile(loadSchema('review-result'));

    it('validates a correct ReviewResult', () => {
      const valid = {
        taskId: 'task-001',
        status: 'approved',
        reviewSummary: 'diff 符合施工单',
        findings: [],
        requiredRework: [],
        qualityGateStatus: 'passed',
        mergeAllowed: true,
      };
      expect(validate(valid)).toBe(true);
    });
  });

  describe('DecisionRequest', () => {
    const validate = ajv.compile(loadSchema('decision-request'));

    it('validates a correct DecisionRequest', () => {
      const valid = {
        decisionId: 'decision-001',
        jobId: 'job_001',
        taskIds: ['task-003'],
        type: 'product_experience',
        question: '错误时是否显示重试按钮？',
        options: [
          { id: 'show_retry', label: '显示重试按钮', impact: '增加可恢复操作' },
          { id: 'message_only', label: '只显示错误信息', impact: '更简洁' },
        ],
        blockingScope: 'affected_tasks_only',
        createdAt: '2026-07-26T03:49:00.000Z',
      };
      expect(validate(valid)).toBe(true);
    });
  });

  describe('MergeResult', () => {
    const validate = ajv.compile(loadSchema('merge-result'));

    it('validates a correct MergeResult', () => {
      const valid = {
        taskId: 'task-001',
        status: 'merged',
        sourceBranch: 'brainctl/task-001',
        targetBranch: 'main',
        commitHash: 'abc1234',
        mergeCommitHash: 'def5678',
        conflicts: [],
        mergedAt: '2026-07-26T03:49:00.000Z',
      };
      expect(validate(valid)).toBe(true);
    });
  });

  describe('RunSummary', () => {
    const validate = ajv.compile(loadSchema('run-summary'));

    it('validates a correct RunSummary', () => {
      const valid = {
        jobId: 'job_001',
        status: 'completed',
        summary: '已完成',
        tasksTotal: 3,
        tasksCompleted: 3,
        tasksFailed: 0,
        decisionsResolved: 0,
        mergedCommits: ['abc1234'],
        qualityGateSummary: '全部通过',
        knownLimitations: [],
        finishedAt: '2026-07-26T03:49:00.000Z',
      };
      expect(validate(valid)).toBe(true);
    });
  });
});
