import type { TaskSpec } from '../types/protocol.js';
import type { CodexProcessRunner } from './codex-process-runner.js';
import { RealCodexProcessRunner } from './codex-process-runner.js';
import {
  parseCodexClarificationAnswer,
  type CodexClarificationAnswer,
  type PiClarificationResult,
  type TechnicalClarificationResponder,
} from './pi-clarification.js';

export interface CodexTechnicalClarifierConfig {
  command: string;
  args: string[];
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export class CodexTechnicalClarifier implements TechnicalClarificationResponder {
  constructor(
    private readonly config: CodexTechnicalClarifierConfig,
    private readonly processRunner: CodexProcessRunner = new RealCodexProcessRunner(),
  ) {}

  async answerTechnicalQuestions(input: {
    taskSpec: TaskSpec;
    clarification: PiClarificationResult;
    round: number;
    worktreePath: string;
  }): Promise<CodexClarificationAnswer> {
    const prompt = this.buildPrompt(input.taskSpec, input.clarification, input.round);
    const args = this.config.args.length > 0
      ? this.config.args
      : ['exec', '--ephemeral', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '-'];
    const result = await this.processRunner.run(this.config.command || 'codex', args, {
      cwd: input.worktreePath,
      timeoutMs: this.config.timeoutMs,
      input: prompt,
      maxBuffer: 2 * 1024 * 1024,
      env: this.config.env,
      signal: this.config.signal,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      return {
        status: 'requires_user',
        answers: [],
        reason: result.timedOut ? 'Codex 技术答疑超时' : 'Codex 技术答疑调用失败',
        categories: ['technical'],
      };
    }
    return parseCodexClarificationAnswer(result.stdout) ?? {
      status: 'requires_user',
      answers: [],
      reason: 'Codex 技术答疑输出无法验证，按失败闭锁处理',
      categories: ['technical'],
    };
  }

  private buildPrompt(taskSpec: TaskSpec, clarification: PiClarificationResult, round: number): string {
    return [
      '你是 Codex 技术答疑器。Pi Worker 处于只读理解阶段，尚未获准施工。',
      `这是最多两轮答疑中的第 ${round} 轮。`,
      '',
      `任务标题：${taskSpec.title}`,
      `任务目标：${taskSpec.goal}`,
      `允许路径：${taskSpec.allowedPaths.join(', ') || '(无)'}`,
      `禁止路径：${taskSpec.forbiddenPaths.join(', ') || '(无)'}`,
      `验收标准：${taskSpec.acceptanceChecks.join('；')}`,
      `Pi 当前理解：${clarification.understandingSummary}`,
      `Pi 当前理解度：${clarification.confidencePercent}%`,
      `Pi 问题：${clarification.questions.join('；') || '(无)'}`,
      `Pi 分类：${clarification.categories.join(', ') || '(无)'}`,
      '',
      '你可以只读检查仓库来回答纯技术问题。不得修改任何文件。',
      '如果任何问题涉及需求选择、隐私、费用扩大或范围变化，必须返回 requires_user；不得替用户决定。',
      '如果仓库事实不足、问题含糊或回答可能改变产品行为，也必须返回 requires_user。',
      'answered 状态下 answers 必须逐项对应 Pi 的 questions，且不能扩大允许路径、命令或预算。',
      '',
      '只输出以下标记块：',
      'BEGIN_CODEX_CLARIFICATION_JSON',
      JSON.stringify({
        status: 'answered',
        answers: ['逐项技术回答'],
        reason: '为什么可自动回答或为什么必须询问用户',
        categories: ['technical'],
      }, null, 2),
      'END_CODEX_CLARIFICATION_JSON',
    ].join('\n');
  }
}
