import { describe, it, expect } from 'vitest';
import { buildPiWorkerPrompt } from '../../src/adapters/pi-worker-prompt.js';
import type { TaskSpec } from '../../src/types/protocol.js';

const sampleTask: TaskSpec = {
  taskId: 'task-001',
  title: '修复文档命令示例',
  goal: '让快速上手文档可在 PowerShell 中运行',
  dependencies: [],
  allowedPaths: ['docs/USER-QUICKSTART.md'],
  forbiddenPaths: ['.env'],
  contextFiles: ['README.md', 'docs/USER-QUICKSTART.md'],
  acceptanceChecks: ['文档命令使用 PowerShell 可执行格式', '不修改代码文件'],
  allowedCommands: ['git diff -- docs/USER-QUICKSTART.md'],
  riskLevel: 'low',
  productDecisionsLocked: true,
  expectedOutputs: ['Git commit', 'WorkerResult'],
  heavyCommandSlotsRequired: 0,
  timeoutSeconds: 1800,
};

describe('buildPiWorkerPrompt', () => {
  it('includes taskId and goal', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('task-001');
    expect(prompt).toContain('让快速上手文档可在 PowerShell 中运行');
  });

  it('includes allowedPaths', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('docs/USER-QUICKSTART.md');
  });

  it('includes forbiddenPaths', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('.env');
  });

  it('includes allowedCommands', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('git diff -- docs/USER-QUICKSTART.md');
  });

  it('includes acceptanceChecks', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('PowerShell');
  });

  it('includes BEGIN_WORKER_RESULT_JSON marker', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('BEGIN_WORKER_RESULT_JSON');
    expect(prompt).toContain('END_WORKER_RESULT_JSON');
  });

  it('includes risk level', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('low');
  });

  it('includes product decisions locked status', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('产品决策已锁定');
  });

  it('includes role boundary instructions', () => {
    const prompt = buildPiWorkerPrompt({ taskSpec: sampleTask });
    expect(prompt).toContain('Pi Worker');
    expect(prompt).toContain('allowedCommands');
  });

  it('handles empty optional arrays', () => {
    const minimalTask: TaskSpec = {
      ...sampleTask,
      forbiddenPaths: [],
      contextFiles: [],
      allowedCommands: [],
    };
    const prompt = buildPiWorkerPrompt({ taskSpec: minimalTask });
    expect(prompt).toContain('(无)');
  });
});
