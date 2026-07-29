import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObsidianRecorder } from '../../src/recorder/obsidian-recorder.js';

let tmpDir: string;
let recordsRoot: string;
let recorder: ObsidianRecorder;

describe('ObsidianRecorder', () => {
  beforeAll(() => {
    tmpDir = path.join(tmpdir(), `brainctl-obsidian-test-${Date.now()}`);
    recordsRoot = path.join(tmpDir, 'obsidian-vault');
    mkdirSync(recordsRoot, { recursive: true });
    recorder = new ObsidianRecorder({
      recordsRoot,
      projectFolder: 'test-project',
    });
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('recordProjectDescription', () => {
    it('writes 00-项目说明.md', async () => {
      await recorder.recordProjectDescription('这是一个测试项目。');
      const filePath = path.join(recordsRoot, 'test-project', '00-项目说明.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('项目说明');
      expect(content).toContain('这是一个测试项目。');
    });
  });

  describe('recordCurrentPlan', () => {
    it('writes 01-当前开工计划.md', async () => {
      await recorder.recordCurrentPlan('run-001', '修复文档', [
        { id: 'task-001', title: '更新 README', status: 'pending' },
        { id: 'task-002', title: '修复命令示例', status: 'completed' },
      ]);
      const filePath = path.join(recordsRoot, 'test-project', '01-当前开工计划.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('run-001');
      expect(content).toContain('修复文档');
      expect(content).toContain('task-001');
      expect(content).toContain('[ ]'); // pending
      expect(content).toContain('[x]'); // completed
    });
  });

  describe('recordPendingDecisions', () => {
    it('writes 02-待我决定.md with decisions', async () => {
      await recorder.recordPendingDecisions([
        {
          id: 'decision-001',
          question: '是否显示重试按钮？',
          options: [
            { id: 'yes', label: '显示' },
            { id: 'no', label: '不显示' },
          ],
        },
      ]);
      const filePath = path.join(recordsRoot, 'test-project', '02-待我决定.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('decision-001');
      expect(content).toContain('是否显示重试按钮？');
    });

    it('writes empty state when no decisions', async () => {
      await recorder.recordPendingDecisions([]);
      const filePath = path.join(recordsRoot, 'test-project', '02-待我决定.md');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('没有待处理的决策');
    });
  });

  describe('recordOverallProgress', () => {
    it('writes 03-总体进度.md', async () => {
      await recorder.recordOverallProgress('正在施工中', 3, { total: 5, completed: 3, failed: 1 });
      const filePath = path.join(recordsRoot, 'test-project', '03-总体进度.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('3');
      expect(content).toContain('5');
      expect(content).toContain('1');
    });
  });

  describe('recordFinalResult', () => {
    it('writes 04-最终结果.md', async () => {
      await recorder.recordFinalResult('run-001', '全部完成', [
        { taskId: 'task-001', status: 'completed', summary: '更新文档' },
        { taskId: 'task-002', status: 'failed', summary: '测试未通过' },
      ]);
      const filePath = path.join(recordsRoot, 'test-project', '04-最终结果.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('✅');
      expect(content).toContain('❌');
    });
  });

  describe('recordTaskExecution', () => {
    it('writes施工记录/<taskId>.md', async () => {
      await recorder.recordTaskExecution(
        'task-001',
        '修复文档',
        '更新 README 中的命令示例',
        '已完成，commit abc1234',
        '/tmp/logs/task-001.log',
      );
      const filePath = path.join(recordsRoot, 'test-project', '施工记录', 'task-001.md');
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('task-001');
      expect(content).toContain('修复文档');
      expect(content).toContain('abc1234');
      expect(content).toContain('/tmp/logs/task-001.log');
    });
  });

  describe('atomic write safety', () => {
    it('writes complete file content', async () => {
      await recorder.recordProjectDescription('原子写入测试');
      const filePath = path.join(recordsRoot, 'test-project', '00-项目说明.md');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('原子写入测试');
      expect(content).toContain('brainctl');
    });
  });
});
