// ── Task Packet Builder — Minimal TaskPacket & RetryPacket construction ──
// Builds lightweight packets for Pi Worker in token-efficient mode.
// Excludes: full context file contents, project history, prior conversations.
import { createHash } from 'node:crypto';
import type {
  MinimalTaskPacket,
  RetryPacket,
  TaskContextFileSummary,
  StructuredTaskSpec,
} from '../types/m2-types.js';
import type { AttemptRecord } from '../types/m2-types.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface TaskPacketConfig {
  maxContextFiles: number;
  maxContextFileChars: number;
  allowContextExpansion: boolean;
}

export const DEFAULT_TASK_PACKET_CONFIG: TaskPacketConfig = {
  maxContextFiles: 5,
  maxContextFileChars: 500,
  allowContextExpansion: false,
};

/**
 * Summarize a context file: truncate content, keep hash.
 */
export function summarizeContextFile(
  filePath: string,
  content: string,
  maxChars: number,
): TaskContextFileSummary {
  const truncated = content.length > maxChars
    ? content.slice(0, maxChars) + '…'
    : content;
  return {
    path: filePath,
    hash: sha256(content),
    summary: truncated,
    size: content.length,
  };
}

/**
 * Check if context file list would overflow max count.
 * Returns truncation info; does NOT truncate — caller handles.
 */
export function checkContextOverflow(
  contextFiles: string[],
  maxCount: number,
): { truncated: boolean; truncatedFiles: string[]; reason: string } {
  if (contextFiles.length <= maxCount) {
    return { truncated: false, truncatedFiles: [], reason: '' };
  }
  const truncatedFiles = contextFiles.slice(maxCount);
  return {
    truncated: true,
    truncatedFiles,
    reason: `上下文文件数量（${contextFiles.length}）超过上限 ${maxCount}，截断 ${truncatedFiles.length} 个文件`,
  };
}

/**
 * Build a minimal TaskPacket from a StructuredTaskSpec.
 * Reduces context to summaries + hashes; excludes raw file contents.
 */
export function buildMinimalTaskPacket(
  spec: StructuredTaskSpec,
  contextFileContents: Map<string, string>,
  config: TaskPacketConfig = DEFAULT_TASK_PACKET_CONFIG,
): { packet: MinimalTaskPacket; overflow: string[] } {
  // Optional spec fields must be defaulted: the brain's plan JSON is not
  // guaranteed to carry them (observed missing: contextFiles, forbiddenPaths),
  // and a missing field must never crash the prompt build.
  const contextFiles = spec.contextFiles ?? [];
  const dependencies = spec.dependencies ?? [];
  const overflowCheck = checkContextOverflow(contextFiles, config.maxContextFiles);
  const filesToInclude = contextFiles.slice(0, config.maxContextFiles);

  const contextFilesSummary: TaskContextFileSummary[] = filesToInclude.map((f) => {
    const content = contextFileContents.get(f) || '';
    return summarizeContextFile(f, content, config.maxContextFileChars);
  });

  // Compute dependency hash from dependency task IDs
  const depHash = sha256(dependencies.sort().join(','));

  // Build dependency summary (minimal: just task IDs, not their outputs)
  const dependencySummary = dependencies.length > 0
    ? `依赖任务: ${dependencies.join(', ')}（结果摘要和hash见上下文文件）`
    : '无依赖';

  const packet: MinimalTaskPacket = {
    taskId: spec.taskId,
    title: spec.title,
    goal: spec.goal,
    // Optional spec fields must be defaulted: the brain's plan JSON is not
    // guaranteed to carry them, and a missing field must never crash the
    // prompt build (regression: 'Cannot read properties of undefined').
    allowedPaths: spec.allowedPaths ?? [],
    forbiddenPaths: spec.forbiddenPaths ?? [],
    contextFilesSummary,
    dependencyHash: depHash,
    dependencySummary,
    acceptanceCommands: spec.acceptanceChecks || [],
    allowedCommands: spec.allowedCommands || [],
    productDecisionsLocked: spec.productDecisionsLocked,
    expectedOutputs: spec.expectedOutputs || [],
    outputFormat: 'worker_result_json',
    riskLevel: spec.riskLevel,
    heavyCommandSlotsRequired: spec.heavyCommandSlotsRequired ?? 0,
    timeoutSeconds: spec.timeoutSeconds ?? 180,
  };

  return { packet, overflow: overflowCheck.truncatedFiles };
}

/**
 * Build a RetryPacket from the previous attempt's structured failure info.
 * Only sends: failure summary, findings, diff delta — NOT full initial requirements.
 */
export function buildRetryPacket(
  previousAttempt: AttemptRecord,
  failureSummary: string,
  findings: string[],
  diffDelta: string,
  repairGoal: string,
  spec: StructuredTaskSpec,
): RetryPacket {
  return {
    originalTaskId: previousAttempt.taskId,
    previousAttemptNumber: previousAttempt.attemptNumber,
    failureSummary,
    findings,
    diffDelta,
    repairGoal,
    allowedPaths: spec.allowedPaths ?? [],
    forbiddenPaths: spec.forbiddenPaths ?? [],
    acceptanceCommands: spec.acceptanceChecks || [],
    allowedCommands: spec.allowedCommands || [],
    productDecisionsLocked: spec.productDecisionsLocked,
  };
}

/**
 * Build Pi Worker prompt from MinimalTaskPacket (lightweight).
 */
export function buildMinimalPacketPrompt(packet: MinimalTaskPacket): string {
  const contextLines = packet.contextFilesSummary.map((f) =>
    `- \`${f.path}\` (hash: ${f.hash.slice(0, 16)}…, ${f.size}B): ${f.summary}`,
  ).join('\n');

  const acceptanceLines = packet.acceptanceCommands.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const commandLines = packet.allowedCommands.map((c) => `- \`${c}\``).join('\n');

  return [
    '# 最小施工包 - ' + packet.taskId,
    '',
    '## 角色边界',
    '你是 Pi Worker。只能修改授权路径中的文件。不能扩大范围、修改产品行为或读取密钥。',
    '',
    '## 任务',
    `- **Task ID**: ${packet.taskId}`,
    `- **标题**: ${packet.title}`,
    `- **目标**: ${packet.goal}`,
    `- **风险**: ${packet.riskLevel}`,
    '',
    '## 授权路径',
    packet.allowedPaths.map((p) => `- \`${p}\``).join('\n'),
    '',
    '## 禁止路径',
    packet.forbiddenPaths.length > 0
      ? packet.forbiddenPaths.map((p) => `- \`${p}\``).join('\n')
      : '(无)',
    '',
    '## 上下文文件（摘要）',
    contextLines || '(无)',
    '',
    '## 依赖',
    packet.dependencySummary,
    '',
    '## 验收命令',
    acceptanceLines || '(无；由编排器质量门兜底)',
    '',
    '## 允许命令',
    commandLines || '(仅允许只读检查与 Git 基本操作)',
    '',
    `## 产品决策已锁定: ${packet.productDecisionsLocked ? '是' : '否'}`,
    packet.expectedOutputs.length > 0 ? `预期产物: ${packet.expectedOutputs.join(', ')}` : '预期产物: 以任务目标为准',
    '',
    '## 输出合约',
    '必须输出 `BEGIN_WORKER_RESULT_JSON` … `END_WORKER_RESULT_JSON` 标记块。',
    `taskId 必须为 "${packet.taskId}"。`,
    '包含字段: taskId, status, summary, filesChanged, commitHash, checks, scopeViolations, risks, unresolvedQuestions, productDecisionRequired, tokenUsage',
  ].join('\n');
}

/**
 * Build Pi Worker retry prompt from RetryPacket.
 */
export function buildRetryPacketPrompt(packet: RetryPacket): string {
  return [
    '# 返工施工包 - ' + packet.originalTaskId,
    '',
    `## 上次 Attempt #${packet.previousAttemptNumber} 失败`,
    `**原因**: ${packet.failureSummary}`,
    '',
    '## 审查发现',
    ...packet.findings.map((f) => `- ${f}`),
    '',
    '## 修复目标',
    packet.repairGoal,
    '',
    '## 不可变范围',
    '允许路径:',
    ...packet.allowedPaths.map((p) => `- \`${p}\``),
    '禁止路径:',
    ...(packet.forbiddenPaths.length > 0 ? packet.forbiddenPaths.map((p) => `- \`${p}\``) : ['(无)']),
    '',
    '## 验收命令',
    ...(packet.acceptanceCommands.length > 0 ? packet.acceptanceCommands.map((c, i) => `${i + 1}. ${c}`) : ['(无；由编排器质量门兜底)']),
    '',
    '## 允许命令',
    ...(packet.allowedCommands.length > 0 ? packet.allowedCommands.map((c) => `- \`${c}\``) : ['(仅允许只读检查与 Git 基本操作)']),
    `产品决策已锁定: ${packet.productDecisionsLocked ? '是' : '否'}`,
    '',
    '## 差异增量',
    '```diff',
    packet.diffDelta,
    '```',
    '',
    '## 输出合约',
    '必须输出 `BEGIN_WORKER_RESULT_JSON` … `END_WORKER_RESULT_JSON` 标记块。',
    `taskId 必须为 "${packet.originalTaskId}"。`,
    '必须包含 taskId, status, summary, filesChanged, commitHash, checks, scopeViolations, risks, unresolvedQuestions, productDecisionRequired, tokenUsage。',
  ].join('\n');
}
