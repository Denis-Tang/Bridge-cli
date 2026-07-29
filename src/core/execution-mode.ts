// ── Execution Mode — Mode selection & configuration ────────────────────
// Default mode is fully backward-compatible. Token-efficient and simple
// modes reduce Codex review calls without lowering quality gates.

import type { ExecutionMode } from '../types/m2-types.js';
import type { StructuredPlan } from '../types/m2-types.js';
import type { SchedulerConfig } from './stage-scheduler.js';

export type { ExecutionMode } from '../types/m2-types.js';

export interface ExecutionModeConfig {
  mode: ExecutionMode;
  autoSelected: boolean;
  selectionReason: string;
}

const SENSITIVE_PATH_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', 'credentials.*', '*secret*', '*token*',
  'Dockerfile', 'docker-compose.yml', '.github/workflows/', 'Jenkinsfile',
];

function hasSensitivePaths(plan: StructuredPlan): boolean {
  return plan.tasks.some((t) =>
    t.estimatedWritePaths?.some((p) =>
      SENSITIVE_PATH_PATTERNS.some((pattern) => {
        const r = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$', 'i');
        return r.test(p) || p.includes(pattern);
      }),
    ),
  );
}

function hasAnyHighRisk(plan: StructuredPlan): boolean {
  if ((plan.riskAssessment?.level || 'low') === 'high') return true;
  return plan.tasks.some((t) => t.riskLevel === 'high');
}

function totalWritePaths(plan: StructuredPlan): number {
  let count = 0;
  for (const t of plan.tasks) {
    count += t.estimatedWritePaths?.length ?? 0;
  }
  return count;
}

/**
 * Auto-select execution mode based on plan characteristics.
 * Always explainable — selection reason is logged as event.
 */
export function selectExecutionMode(plan: StructuredPlan): ExecutionModeConfig {
  const taskCount = plan.tasks.length;
  const stageCount = plan.stages?.length ?? 1;
  const maxRiskAny = plan.tasks.some((t) => t.riskLevel === 'high') ? 'high'
    : plan.tasks.some((t) => t.riskLevel === 'medium') ? 'medium' : 'low';
  const hasHigh = hasAnyHighRisk(plan);
  const hasSensitive = hasSensitivePaths(plan);
  const writePaths = totalWritePaths(plan);

  // Simple mode: small tasks, no high risk, few files
  if (taskCount <= 3 && maxRiskAny !== 'high' && writePaths <= 5 && !hasSensitive) {
    return {
      mode: 'simple',
      autoSelected: true,
      selectionReason: `小任务（${taskCount} tasks, ${writePaths} write paths, risk=${maxRiskAny}），绕过编排以避免额外 Codex 开销`,
    };
  }

  // Token-efficient: multiple tasks or stages
  if (taskCount > 3 || stageCount > 1 || hasHigh) {
    return {
      mode: 'token-efficient',
      autoSelected: true,
      selectionReason: `多任务编排（${taskCount} tasks, ${stageCount} stages, risk=${hasHigh ? 'high_present' : 'medium_ok'}），减少逐任务 Codex 审查`,
    };
  }

  // Default: conservative
  return {
    mode: 'token-efficient',
    autoSelected: true,
    selectionReason: `条件不确定，默认使用 token-efficient 模式`,
  };
}

/**
 * Resolve final execution mode.
 * Explicit config overrides auto-selection.
 */
export function resolveExecutionMode(
  config: Partial<SchedulerConfig>,
  plan?: StructuredPlan,
): ExecutionModeConfig {
  if (config.executionMode && config.executionMode !== 'default') {
    return {
      mode: config.executionMode,
      autoSelected: false,
      selectionReason: '用户显式指定模式',
    };
  }

  if (plan) {
    return selectExecutionMode(plan);
  }

  return {
    mode: 'default',
    autoSelected: true,
    selectionReason: '无计划可用，回退到 default 模式',
  };
}

/**
 * Check if a given mode is token-efficient (enables review skipping).
 */
export function isTokenEfficientMode(mode: ExecutionMode): boolean {
  return mode === 'token-efficient' || mode === 'simple';
}

/**
 * Check if the given mode should skip governance for simple tasks.
 */
export function isSimpleMode(mode: ExecutionMode): boolean {
  return mode === 'simple';
}
