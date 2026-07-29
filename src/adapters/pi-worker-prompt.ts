import type { TaskSpec } from '../types/protocol.js';
import type { MinimalTaskPacket, RetryPacket } from '../types/m2-types.js';
import { buildMinimalPacketPrompt, buildRetryPacketPrompt } from './task-packet-builder.js';

/**
 * Build a Pi Worker prompt from a MinimalTaskPacket (token-efficient mode).
 */
export function buildPiWorkerMinimalPrompt(packet: MinimalTaskPacket): string {
  return buildMinimalPacketPrompt(packet);
}

/**
 * Build a Pi Worker retry prompt from a RetryPacket.
 */
export function buildPiWorkerRetryPrompt(packet: RetryPacket): string {
  return buildRetryPacketPrompt(packet);
}

/**
 * Build a strict construction prompt for Pi Worker from a TaskSpec.
 * The prompt enforces a machine-readable WorkerResult output contract at the end.
 */
export function buildPiWorkerPrompt(input: { taskSpec: TaskSpec }): string {
  const { taskSpec } = input;

  const allowedPaths = taskSpec.allowedPaths.map((p) => '- `' + p + '`').join('\n');
  const forbiddenPaths = taskSpec.forbiddenPaths.length > 0
    ? taskSpec.forbiddenPaths.map((p) => '- `' + p + '`').join('\n')
    : '(无)';
  const contextFiles = taskSpec.contextFiles.length > 0
    ? taskSpec.contextFiles.map((f) => '- `' + f + '`').join('\n')
    : '(无)';
  const acceptanceChecks = taskSpec.acceptanceChecks.map((c, i) => (i + 1) + '. ' + c).join('\n');
  const allowedCommands = taskSpec.allowedCommands.length > 0
    ? taskSpec.allowedCommands.map((c) => '- `' + c + '`').join('\n')
    : '(仅限 Git 基本操作)';

  const exampleWorkerResult = [
    'BEGIN_WORKER_RESULT_JSON',
    '{',
    '  "taskId": "' + taskSpec.taskId + '",',
    '  "status": "completed",',
    '  "summary": "用中文总结你做了什么",',
    '  "filesChanged": ["src/message.txt"],',
    '  "commitHash": "abc1234def5678",',
    '  "checks": [',
    '    { "name": "git diff", "status": "passed", "summary": "ok" }',
    '  ],',
    '  "scopeViolations": [],',
    '  "risks": [],',
    '  "unresolvedQuestions": [],',
    '  "productDecisionRequired": false,',
    '  "tokenUsage": {',
    '    "inputTokens": 100,',
    '    "outputTokens": 200,',
    '    "cacheHitTokens": 0',
    '  }',
    '}',
    'END_WORKER_RESULT_JSON',
  ].join('\n');

  return [
    '# 施工单 - ' + taskSpec.taskId,
    '',
    '## 角色边界',
    '',
    '你是 Pi Worker。你只执行以下明确的施工单。你不能：',
    '- 修改产品需求、架构决策或范围。',
    '- 读取或上传密钥、token 或凭证。',
    '- 向用户直接提问（遇到问题请结构化上报）。',
    '- 运行未在 allowedCommands 中列出的命令。',
    '',
    '## 任务',
    '',
    '- **Task ID**: ' + taskSpec.taskId,
    '- **标题**: ' + taskSpec.title,
    '- **目标**: ' + taskSpec.goal,
    '',
    '## 授权路径',
    '',
    '你只能修改以下路径中的文件：',
    '',
    allowedPaths,
    '',
    '## 禁止路径',
    '',
    forbiddenPaths,
    '',
    '## 上下文文件',
    '',
    contextFiles,
    '',
    '## 验收标准',
    '',
    acceptanceChecks,
    '',
    '## 允许的命令',
    '',
    allowedCommands,
    '',
    '## 风险等级',
    '',
    '- **风险**: ' + taskSpec.riskLevel,
    '- **产品决策已锁定**: ' + (taskSpec.productDecisionsLocked ? '是（不允许更改产品行为）' : '否'),
    '',
    '## 输出合约 - 必须严格遵守',
    '',
    '你的最终输出（即整个回复的末尾部分）必须且只能包含以下内容。',
    '',
    '### 规则',
    '',
    '1. 不要用 Markdown 代码块（三个反引号）包裹 WorkerResult JSON。直接输出纯文本标记块。',
    '2. 不要省略任何字段。即使无内容，也要写空数组或 null。',
    '3. 如果任务失败，也必须输出 WorkerResult，status 为 failed 或 blocked，',
    '   并在 risks / unresolvedQuestions 中说明原因。',
    '4. taskId 必须等于 "' + taskSpec.taskId + '"。',
    '5. filesChanged 必须是相对路径字符串数组。',
    '6. commitHash 如果已提交则填写真实 commit hash；如果未提交则填空字符串。',
    '7. 整个字段名和字符串必须使用半角英文双引号。',
    '',
    '### 输出格式（纯文本，无代码块标记）',
    '',
    exampleWorkerResult,
    '',
    '### status 合法值',
    '',
    '- completed: 施工完成，commit 已提交',
    '- failed: 施工失败，无法继续',
    '- blocked: 遇到外部依赖阻塞',
    '- needs_decision: 需要用户决策',
    '- scope_violation: 修改了授权路径外的文件',
    '',
    '### 验证',
    '',
    '如果输出中没有找到 BEGIN_WORKER_RESULT_JSON ... END_WORKER_RESULT_JSON 标记对，',
    '你的施工结果将被视为无效。',
    '',
  ].join('\n');
}
