import type { TaskSpec, WorkerResult } from '../types/protocol.js';

export type ClarificationCategory =
  | 'technical'
  | 'requirement_choice'
  | 'privacy'
  | 'budget'
  | 'scope';

export interface PiClarificationResult {
  taskId: string;
  understandingSummary: string;
  confidencePercent: number;
  questions: string[];
  categories: ClarificationCategory[];
}

export interface CodexClarificationAnswer {
  status: 'answered' | 'requires_user';
  answers: string[];
  reason: string;
  categories: ClarificationCategory[];
}

export interface ClarificationTranscriptEntry {
  round: number;
  pi: PiClarificationResult;
  codex?: CodexClarificationAnswer;
}

export interface TechnicalClarificationResponder {
  answerTechnicalQuestions(input: {
    taskSpec: TaskSpec;
    clarification: PiClarificationResult;
    round: number;
    worktreePath: string;
  }): Promise<CodexClarificationAnswer>;
}

const PROTECTED_CATEGORIES = new Set<ClarificationCategory>([
  'requirement_choice',
  'privacy',
  'budget',
  'scope',
]);

function extractMarkedJson(output: string, begin: string, end: string): string | null {
  const start = output.lastIndexOf(begin);
  if (start < 0) return null;
  const finish = output.indexOf(end, start + begin.length);
  if (finish < 0) return null;
  // Strip markdown backticks the model may have wrapped around the markers.
  return output.slice(start + begin.length, finish).trim().replace(/^`+/, '').replace(/`+$/, '').trim();
}

export function parsePiClarification(output: string, expectedTaskId: string): PiClarificationResult | null {
  const candidates = [output, ...extractAssistantTextsFromJsonl(output)];
  for (const candidate of candidates) {
    const raw = extractMarkedJson(candidate, 'BEGIN_CLARIFICATION_JSON', 'END_CLARIFICATION_JSON');
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<PiClarificationResult>;
      if (parsed.taskId !== expectedTaskId) continue;
      if (typeof parsed.understandingSummary !== 'string' || !parsed.understandingSummary.trim()) continue;
      if (typeof parsed.confidencePercent !== 'number' || !Number.isFinite(parsed.confidencePercent)) continue;
      if (parsed.confidencePercent < 0 || parsed.confidencePercent > 100) continue;
      if (!Array.isArray(parsed.questions) || !parsed.questions.every((item) => typeof item === 'string')) continue;
      if (!Array.isArray(parsed.categories) || !parsed.categories.every(isClarificationCategory)) continue;
      return parsed as PiClarificationResult;
    } catch {
      // Try another assistant message candidate.
    }
  }
  return null;
}

export function parseCodexClarificationAnswer(output: string): CodexClarificationAnswer | null {
  const marked = extractMarkedJson(output, 'BEGIN_CODEX_CLARIFICATION_JSON', 'END_CODEX_CLARIFICATION_JSON');
  const candidates = [marked, output.trim()];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<CodexClarificationAnswer>;
      if (parsed.status !== 'answered' && parsed.status !== 'requires_user') continue;
      if (!Array.isArray(parsed.answers) || !parsed.answers.every((item) => typeof item === 'string')) continue;
      if (typeof parsed.reason !== 'string') continue;
      if (!Array.isArray(parsed.categories) || !parsed.categories.every(isClarificationCategory)) continue;
      if (parsed.categories.some((item) => PROTECTED_CATEGORIES.has(item)) && parsed.status !== 'requires_user') continue;
      return parsed as CodexClarificationAnswer;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function requiresUserDecision(categories: ClarificationCategory[]): boolean {
  return categories.some((item) => PROTECTED_CATEGORIES.has(item));
}

export function isReadyToImplement(result: PiClarificationResult): boolean {
  return result.confidencePercent >= 95 && result.questions.length === 0 && !requiresUserDecision(result.categories);
}

export function clarificationPauseResult(taskId: string, questions: string[], reason: string): WorkerResult {
  const productDecisionRequired = questions.length > 0;
  return {
    taskId,
    status: productDecisionRequired ? 'needs_decision' : 'failed',
    summary: `理解阶段暂停：${reason}`,
    filesChanged: [],
    commitHash: '',
    checks: [{ name: '95% clarification gate', status: 'failed', summary: reason }],
    scopeViolations: [],
    risks: [reason],
    unresolvedQuestions: questions,
    productDecisionRequired,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
  };
}

export function buildPiClarificationPrompt(
  taskSpec: TaskSpec,
  transcript: ClarificationTranscriptEntry[],
  finalConfirmation = false,
): string {
  const prior = transcript.length === 0
    ? '(无，这是第一轮理解检查)'
    : transcript.map((entry) => [
      `第 ${entry.round} 轮 Pi 理解：${entry.pi.understandingSummary}`,
      `第 ${entry.round} 轮 Pi 问题：${entry.pi.questions.join('；') || '(无)'}`,
      entry.codex ? `Codex 回答：${entry.codex.answers.join('；') || '(无)'}` : '',
    ].filter(Boolean).join('\n')).join('\n\n');

  return [
    `# 任务理解检查 - ${taskSpec.taskId}`,
    '',
    '先只阅读，不要做任何改动，可以向我（Codex）提问，直到你对任务的理解有95%之后再执行。',
    '你只能 direct read 上面明列的精确上下文文件（contextFiles）。',
    '禁止使用 ls、find、grep 或任何目录枚举；禁止访问 “.”、仓库根目录或任何父目录。',
    '本回合严禁 edit、write、bash、提交 Git 或产生任何项目文件。',
    finalConfirmation ? '这是两轮答疑后的最终只读确认；如果仍未达到 95%，如实报告，不要猜测。' : '',
    '',
    '## 任务',
    `标题：${taskSpec.title}`,
    `目标：${taskSpec.goal}`,
    `允许路径：${taskSpec.allowedPaths.join(', ') || '(无)'}`,
    `禁止路径：${taskSpec.forbiddenPaths.join(', ') || '(无)'}`,
    `上下文文件：${taskSpec.contextFiles.join(', ') || '(无)'}`,
    `验收标准：${taskSpec.acceptanceChecks.join('；')}`,
    `产品决策已锁定：${taskSpec.productDecisionsLocked ? '是' : '否'}`,
    '',
    '## 既有问答',
    prior,
    '',
    '## 分类规则',
    '- technical：可由 Codex 根据已锁定需求和仓库事实回答的实现问题。',
    '- requirement_choice：需要选择或改变需求。',
    '- privacy：可能读取、输出或扩大处理个人信息、凭据或隐私数据。',
    '- budget：可能扩大费用、模型调用或资源预算。',
    '- scope：可能扩大允许修改路径、命令或任务范围。',
    '- 只要问题涉及后四类，就必须保留对应分类，不能伪装成 technical。',
    '',
    '最终仅输出以下标记块，不要输出 WorkerResult，不要施工：',
    'BEGIN_CLARIFICATION_JSON',
    JSON.stringify({
      taskId: taskSpec.taskId,
      understandingSummary: '用中文简要复述你理解的任务与边界',
      confidencePercent: 0,
      questions: ['仍需 Codex 回答的问题；没有则为空数组'],
      categories: ['technical'],
    }, null, 2),
    'END_CLARIFICATION_JSON',
  ].filter(Boolean).join('\n');
}

export function appendClarificationTranscriptToWorkerPrompt(
  workerPrompt: string,
  transcript: ClarificationTranscriptEntry[],
): string {
  const summary = transcript.map((entry) => [
    `### 第 ${entry.round} 轮`,
    `- Pi 理解：${entry.pi.understandingSummary}`,
    `- 理解度：${entry.pi.confidencePercent}%`,
    `- Pi 问题：${entry.pi.questions.join('；') || '(无)'}`,
    entry.codex ? `- Codex 回答：${entry.codex.answers.join('；') || '(无)'}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    workerPrompt,
    '',
    '## 已完成的 95% 理解门',
    '',
    '以下问答属于已锁定施工上下文。不得借此扩大需求、隐私、预算或路径范围。',
    summary || '(Pi 首轮即确认达到 95%，无问题。)',
  ].join('\n');
}

function isClarificationCategory(value: unknown): value is ClarificationCategory {
  return value === 'technical'
    || value === 'requirement_choice'
    || value === 'privacy'
    || value === 'budget'
    || value === 'scope';
}

function extractAssistantTextsFromJsonl(output: string): string[] {
  const texts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as any;
      if (event?.type === 'agent_end' && Array.isArray(event.messages)) {
        for (const message of event.messages) {
          if (message?.role === 'assistant') collectContentText(message.content, texts);
        }
      }
      if (event?.type === 'message_end' && event.message?.role === 'assistant') {
        collectContentText(event.message.content, texts);
      }
    } catch {
      // Non-JSON output is already covered by the direct candidate.
    }
  }
  return texts;
}

function collectContentText(content: unknown, texts: string[]): void {
  if (typeof content === 'string') {
    texts.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  const joined = content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text)
    .join('\n');
  if (joined) texts.push(joined);
}
