import { AtomicMarkdownWriter } from './atomic-markdown-writer.js';
import path from 'node:path';

/**
 * Configuration for Obsidian recording.
 */
export interface ObsidianRecorderConfig {
  /** Root path for Obsidian vault records */
  recordsRoot: string;
  /** Project-specific folder name under recordsRoot */
  projectFolder: string;
}

/**
 * Obsidian Recorder — writes human-readable Markdown records.
 * Uses AtomicMarkdownWriter for safe file writes.
 */
export class ObsidianRecorder {
  private writer: AtomicMarkdownWriter;
  private config: ObsidianRecorderConfig;

  constructor(config: ObsidianRecorderConfig, writer?: AtomicMarkdownWriter) {
    this.config = config;
    this.writer = writer ?? new AtomicMarkdownWriter();
  }

  /**
   * Get the full path to the project records folder.
   */
  private getProjectDir(): string {
    return path.join(this.config.recordsRoot, this.config.projectFolder);
  }

  /**
   * Write a file in the project records folder.
   */
  private async writeRecord(filename: string, content: string): Promise<void> {
    const filePath = path.join(this.getProjectDir(), filename);
    await this.writer.write(filePath, content);
  }

  /**
   * Write or update 00-项目说明.md
   */
  async recordProjectDescription(description: string): Promise<void> {
    const content = `# ${this.config.projectFolder} 项目说明

${description}

---
*由 brainctl 自动生成 | ${new Date().toISOString()}*
`;
    await this.writeRecord('00-项目说明.md', content);
  }

  /**
   * Write or update 01-当前开工计划.md
   */
  async recordCurrentPlan(runId: string, requestText: string, tasks: Array<{ id: string; title: string; status: string }>): Promise<void> {
    const taskList = tasks
      .map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] **${t.id}**: ${t.title} (${t.status})`)
      .join('\n');

    const content = `# 当前开工计划

## 运行 ID
\`${runId}\`

## 需求
${requestText}

## 任务
${taskList}

---
*由 brainctl 自动生成 | ${new Date().toISOString()}*
`;
    await this.writeRecord('01-当前开工计划.md', content);
  }

  /**
   * Write or update 02-待我决定.md
   */
  async recordPendingDecisions(decisions: Array<{ id: string; question: string; options: Array<{ id: string; label: string }> }>): Promise<void> {
    if (decisions.length === 0) {
      const content = `# 待我决定

目前没有待处理的决策。

---
*由 brainctl 自动生成 | ${new Date().toISOString()}*
`;
      await this.writeRecord('02-待我决定.md', content);
      return;
    }

    const decisionList = decisions
      .map((d) => {
        const options = d.options.map((o) => `  - [ ] ${o.id}: ${o.label}`).join('\n');
        return `### ${d.id}\n${d.question}\n\n${options}`;
      })
      .join('\n\n');

    const content = `# 待我决定

${decisionList}

---
*由 brainctl 自动生成 | ${new Date().toISOString()}*
`;
    await this.writeRecord('02-待我决定.md', content);
  }

  /**
   * Write or update 03-总体进度.md
   */
  async recordOverallProgress(summary: string, runCount: number, taskStats: { total: number; completed: number; failed: number }): Promise<void> {
    const content = `# 总体进度

## 运行次数
${runCount}

## 任务统计
- 总计: ${taskStats.total}
- 已完成: ${taskStats.completed}
- 失败: ${taskStats.failed}

## 当前状态
${summary}

---
*由 brainctl 自动生成 | ${new Date().toISOString()}*
`;
    await this.writeRecord('03-总体进度.md', content);
  }

  /**
   * Write or update 04-最终结果.md
   */
  async recordFinalResult(runId: string, summary: string, taskResults: Array<{ taskId: string; status: string; summary: string }>): Promise<void> {
    const taskList = taskResults
      .map((t) => {
        const icon = t.status === 'completed' ? '✅' : t.status === 'failed' ? '❌' : '⬜';
        return `${icon} **${t.taskId}**: ${t.summary}`;
      })
      .join('\n\n');

    const content = `# 最终结果

## 运行 ID
\`${runId}\`

## 总结
${summary}

## 任务结果
${taskList}

---
*由 brainctl 自动生成 | ${new Date().toISOString()}*
`;
    await this.writeRecord('04-最终结果.md', content);
  }

  /**
   * Write施工记录/<taskId>.md
   */
  async recordTaskExecution(taskId: string, taskTitle: string, specSummary: string, resultSummary: string, logsPath?: string): Promise<void> {
    const recordsDir = '施工记录';
    const filename = `${taskId}.md`;
    const filePath = path.join(this.getProjectDir(), recordsDir, filename);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });

    const content = `# 施工记录: ${taskId} - ${taskTitle}

## 任务规范
${specSummary}

## 执行结果
${resultSummary}

${logsPath ? `## 日志\n\`${logsPath}\`` : ''}

---
*由 brainctl 自动生成 | ${new Date().toISOString()}*
`;
    await this.writer.write(filePath, content);
  }
}
