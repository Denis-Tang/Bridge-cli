// ── M4 Decision Gate — G1 (Plan Gate) ───────────────────────────────────
// Handles risk assessment, approval creation/query/expiry/revoke for G1.
// G2/G3 are NOT implemented here (future phases).
// Governance is OFF by default; all M2/M3 paths unchanged when disabled.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve as pathResolve, dirname as pathDirname } from 'node:path';
import type { StateStore } from '../state/state-store.js';
import type { StructuredPlan } from '../types/m2-types.js';
import type {
  ApprovalDecision,
  RiskLevel,
} from '../types/m4-types.js';
import { promptHash } from '../utils/sanitize.js';

// ══════════════════════════════════════════════════════════════
// Governance Config
// ══════════════════════════════════════════════════════════════

export interface GovernanceConfig {
  enabled: boolean;
}

let cachedConfig: GovernanceConfig | null = null;

/**
 * Read governance config from the project-level config file.
 * Cached in-process; reset cache externally if needed.
 */
export function getGovernanceConfig(projectRoot: string): GovernanceConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = readGovernanceConfigFile(projectRoot);
  return cachedConfig;
}

/** Reset cached config (for tests, after config changes). */
export function resetGovernanceConfigCache(): void {
  cachedConfig = null;
}

function readGovernanceConfigFile(projectRoot: string): GovernanceConfig {
  try {
    const configPath = pathResolve(projectRoot, '.brainctl', 'config.json');
    if (!existsSync(configPath)) return { enabled: false };
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const govAny = parsed?.governance as Record<string, unknown> | undefined;
    return {
      enabled: parsed?.['governance.enabled'] === true || govAny?.enabled === true,
    };
  } catch {
    return { enabled: false };
  }
}

/**
 * Write governance config to the project-level config file.
 * Only sets governance.enabled for now. Returns the written config.
 */
export function setGovernanceEnabled(projectRoot: string, enabled: boolean): void {
  const configPath = pathResolve(projectRoot, '.brainctl', 'config.json');
  mkdirSync(pathDirname(configPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch { /* ignore */ }
  }

  // Support both flat and nested formats
  existing['governance.enabled'] = enabled;
  if (existing.governance && typeof existing.governance === 'object') {
    (existing.governance as Record<string, unknown>).enabled = enabled;
  } else {
    existing.governance = { enabled };
  }

  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  cachedConfig = { enabled };
}

// ══════════════════════════════════════════════════════════════
// Risk Categories for G1
// ══════════════════════════════════════════════════════════════

export interface G1RiskFinding {
  category: string;
  severity: RiskLevel;
  detail: string;
  requiresApproval: boolean;
}

const PROD_CONFIG_PATTERNS = [
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.github/workflows/', 'Jenkinsfile', 'k8s/', 'helm/',
  'terraform/', '*.tf', 'nginx.conf',
];

const SENSITIVE_PATH_PATTERNS = [
  '.env', '.env.*', '*.pem', '*.key', 'credentials.*', '*secret*', '*token*',
];

/**
 * Assess G1 risk for a plan and project.
 */
export function assessG1Risk(
  plan: StructuredPlan,
  isRealProject: boolean,
): G1RiskFinding[] {
  const findings: G1RiskFinding[] = [];

  if (isRealProject) {
    findings.push({
      category: 'real_project',
      severity: 'high',
      detail: 'Target is a real (non-disposable) project path',
      requiresApproval: true,
    });
  }

  const planRisk: string = plan.riskAssessment?.level || 'low';
  if (planRisk === 'high' || planRisk === 'critical') {
    findings.push({
      category: 'plan_risk',
      severity: planRisk,
      detail: `Plan risk level is ${planRisk}`,
      requiresApproval: true,
    });
  } else if (planRisk === 'medium') {
    findings.push({
      category: 'plan_risk',
      severity: 'medium',
      detail: 'Plan risk level is medium',
      requiresApproval: false,
    });
  }

  const highRiskTasks = plan.tasks.filter((t) => t.riskLevel === 'high');
  if (highRiskTasks.length > 0) {
    findings.push({
      category: 'high_risk_task',
      severity: 'high',
      detail: `${highRiskTasks.length} task(s) marked high risk: ${highRiskTasks.map((t) => t.taskId || t.title).join(', ')}`,
      requiresApproval: true,
    });
  }

  const prodConfigTasks = plan.tasks.filter((t) =>
    t.estimatedWritePaths?.some((p) =>
      PROD_CONFIG_PATTERNS.some((pattern) => matchesPattern(p, pattern)),
    ),
  );
  if (prodConfigTasks.length > 0) {
    findings.push({
      category: 'prod_config',
      severity: 'high',
      detail: `${prodConfigTasks.length} task(s) touch production config`,
      requiresApproval: true,
    });
  }

  const sensitiveTasks = plan.tasks.filter((t) =>
    t.estimatedWritePaths?.some((p) =>
      SENSITIVE_PATH_PATTERNS.some((pattern) => matchesPattern(p, pattern)),
    ),
  );
  if (sensitiveTasks.length > 0) {
    const nonCore = sensitiveTasks.filter((t) =>
      t.estimatedWritePaths?.some((p) => !p.startsWith('src/core/')),
    );
    if (nonCore.length > 0) {
      findings.push({
        category: 'sensitive_path',
        severity: 'medium',
        detail: `${nonCore.length} task(s) may touch sensitive paths`,
        requiresApproval: true,
      });
    }
  }

  return findings;
}

// ══════════════════════════════════════════════════════════════
// G1 Approval Management
// ══════════════════════════════════════════════════════════════

export async function createG1Approvals(
  store: StateStore,
  runId: string,
  plan: StructuredPlan,
  isRealProject: boolean,
): Promise<ApprovalDecision[]> {
  const findings = assessG1Risk(plan, isRealProject);
  const riskLevel = deriveOverallRiskLevel(findings, plan.riskAssessment?.level || 'low');

  await store.createRiskAssessment({
    id: `${runId}-g1-risk`,
    runId,
    assessmentType: 'plan',
    riskLevel,
    findingsJson: JSON.stringify(findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      detailHash: promptHash(f.detail),
    }))),
    trigger: 'auto',
  });

  const decisions: ApprovalDecision[] = [];
  for (const finding of findings) {
    if (!finding.requiresApproval) continue;

    const decision = await store.createApprovalDecision({
      id: `${runId}-g1-${finding.category}`,
      runId,
      gate: 'G1',
      decisionType: mapCategoryToDecisionType(finding.category),
      scope: 'run',
      status: 'pending',
      approvedBy: 'user',
      expiresAt: null,
      metadata: {
        category: finding.category,
        severity: finding.severity,
        detailHash: promptHash(finding.detail),
      },
    });
    decisions.push(decision);
  }

  return decisions;
}

export async function getPendingG1Approvals(
  store: StateStore,
  runId: string,
): Promise<ApprovalDecision[]> {
  const pending = await store.getPendingApprovals(runId);
  return pending.filter((a) => a.gate === 'G1');
}

export async function checkG1Approvable(
  store: StateStore,
  runId: string,
): Promise<{ approvable: boolean; pendingDecisions: ApprovalDecision[] }> {
  const pending = await getPendingG1Approvals(store, runId);
  return { approvable: pending.length === 0, pendingDecisions: pending };
}

export async function approveG1Decision(
  store: StateStore,
  decisionId: string,
): Promise<boolean> {
  const decision = await store.getApprovalDecision(decisionId);
  if (!decision || decision.gate !== 'G1') return false;
  if (decision.status !== 'pending') return false;

  const now = new Date().toISOString();
  return store.updateApprovalDecisionStatus(decisionId, 'approved', now);
}

export async function revokeDecision(
  store: StateStore,
  decisionId: string,
): Promise<{ success: boolean; message: string }> {
  const decision = await store.getApprovalDecision(decisionId);
  if (!decision) {
    return { success: false, message: `Decision ${decisionId} not found` };
  }
  if (decision.status === 'revoked') {
    return { success: false, message: `Decision ${decisionId} already revoked` };
  }
  if (decision.status === 'expired') {
    return { success: false, message: `Decision ${decisionId} already expired` };
  }

  const now = new Date().toISOString();
  await store.updateApprovalDecisionStatus(decisionId, 'revoked', now);
  return { success: true, message: `Decision ${decisionId} revoked` };
}

export async function expireRunDecisions(
  store: StateStore,
  runId: string,
): Promise<number> {
  const decisions = await store.listApprovalDecisions(runId);
  let count = 0;
  for (const d of decisions) {
    if (d.status === 'pending' || d.status === 'approved') {
      await store.updateApprovalDecisionStatus(d.id, 'expired', new Date().toISOString());
      count++;
    }
  }
  return count;
}

// ══════════════════════════════════════════════════════════════
// G2: Execution Gate (task dispatch, scope expansion, rework, budget)
// ══════════════════════════════════════════════════════════════

export async function createG2Approval(
  store: StateStore,
  runId: string,
  taskId: string,
  decisionType: string,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<ApprovalDecision> {
  return store.createApprovalDecision({
    id: `${runId}-g2-${taskId}-${decisionType}-${Date.now()}`,
    runId,
    gate: 'G2',
    decisionType,
    scope: 'task',
    status: 'pending',
    approvedBy: 'user',
    expiresAt: null,
    metadata: {
      taskId,
      reasonHash: promptHash(reason),
      ...(metadata || {}),
    },
  });
}

export async function getPendingG2Approvals(
  store: StateStore,
  runId: string,
): Promise<ApprovalDecision[]> {
  const pending = await store.getPendingApprovals(runId);
  return pending.filter((a) => a.gate === 'G2');
}

export async function checkG2Approvable(
  store: StateStore,
  runId: string,
  taskId?: string,
): Promise<{ approvable: boolean; pendingDecisions: ApprovalDecision[] }> {
  const pending = await getPendingG2Approvals(store, runId);
  const relevant = taskId
    ? pending.filter((d) => (d.metadata as any)?.taskId === taskId)
    : pending;
  return { approvable: relevant.length === 0, pendingDecisions: relevant };
}

// ══════════════════════════════════════════════════════════════
// G3: Merge Gate (integration, large diff, conflicts, prod config)
// ══════════════════════════════════════════════════════════════

export async function createG3Approval(
  store: StateStore,
  runId: string,
  stageId: string,
  decisionType: string,
  reason: string,
  metadata?: Record<string, unknown>,
): Promise<ApprovalDecision> {
  return store.createApprovalDecision({
    id: `${runId}-g3-${stageId}-${decisionType}-${Date.now()}`,
    runId,
    gate: 'G3',
    decisionType,
    scope: 'stage',
    status: 'pending',
    approvedBy: 'user',
    expiresAt: null,
    metadata: {
      stageId,
      reasonHash: promptHash(reason),
      ...(metadata || {}),
    },
  });
}

export async function getPendingG3Approvals(
  store: StateStore,
  runId: string,
): Promise<ApprovalDecision[]> {
  const pending = await store.getPendingApprovals(runId);
  return pending.filter((a) => a.gate === 'G3');
}

export async function checkG3Approvable(
  store: StateStore,
  runId: string,
  stageId?: string,
): Promise<{ approvable: boolean; pendingDecisions: ApprovalDecision[] }> {
  const pending = await getPendingG3Approvals(store, runId);
  const relevant = stageId
    ? pending.filter((d) => (d.metadata as any)?.stageId === stageId)
    : pending;
  return { approvable: relevant.length === 0, pendingDecisions: relevant };
}

/** Generic approve for any gate (G1/G2/G3). */
export async function approveDecision(
  store: StateStore,
  decisionId: string,
  expectedGate?: 'G1' | 'G2' | 'G3',
): Promise<boolean> {
  const decision = await store.getApprovalDecision(decisionId);
  if (!decision) return false;
  if (expectedGate && decision.gate !== expectedGate) return false;
  if (decision.status !== 'pending') return false;
  const now = new Date().toISOString();
  return store.updateApprovalDecisionStatus(decisionId, 'approved', now);
}

/** Get all pending approvals across all gates for a run. */
export async function getAllPendingApprovals(
  store: StateStore,
  runId: string,
): Promise<{ g1: ApprovalDecision[]; g2: ApprovalDecision[]; g3: ApprovalDecision[] }> {
  const pending = await store.getPendingApprovals(runId);
  return {
    g1: pending.filter((a) => a.gate === 'G1'),
    g2: pending.filter((a) => a.gate === 'G2'),
    g3: pending.filter((a) => a.gate === 'G3'),
  };
}

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function mapCategoryToDecisionType(category: string): string {
  const map: Record<string, string> = {
    real_project: 'real_project_auth',
    plan_risk: 'run_budget',
    high_risk_task: 'high_risk_task',
    prod_config: 'prod_config_touch',
    sensitive_path: 'prod_config_touch',
  };
  return map[category] || 'run_budget';
}

function deriveOverallRiskLevel(
  findings: G1RiskFinding[],
  planLevel: string,
): RiskLevel {
  if (findings.some((f) => f.severity === 'critical')) return 'critical';
  if (findings.some((f) => f.severity === 'high' && f.requiresApproval)) return 'high';
  if (planLevel === 'high' || planLevel === 'critical') return 'high';
  if (findings.some((f) => f.severity === 'medium' && f.requiresApproval)) return 'medium';
  if (planLevel === 'medium') return 'medium';
  return 'low' as RiskLevel;
}

function matchesPattern(inputPath: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
    'i',
  );
  return regex.test(inputPath) || inputPath.includes(pattern);
}

export function isDisposableProject(projectPath: string): boolean {
  const normalized = projectPath.replace(/\\/g, '/');
  return normalized.includes('.brainctl-dev/') || normalized.endsWith('.brainctl-dev');
}
