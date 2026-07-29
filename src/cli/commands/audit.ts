// ── brainctl audit ──────────────────────────────────────────────────────
// Outputs full auditable chain: approvals, risk snapshots, token ledger,
// budget policies, pause/resume events. Sanitized — no raw secrets/paths.

import { Command } from 'commander';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { getAllPendingApprovals } from '../../core/decision-gate.js';
import { getAllEffectiveBudgets } from '../../core/budget-policy-store.js';

export const auditCommand = new Command('audit')
  .description('输出完整审计链：审批决策、风险快照、Token 账本、预算策略（脱敏）')
  .argument('[run-id]', '可选的 run ID')
  .option('--json', '以 JSON 格式输出审计数据')
  .action(async (runId?: string, options?: { json?: boolean }) => {
    const config = readSqliteConfigFromEnv();
    const store = SqliteStateStore.create(config.path);
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();

    try {
      if (options?.json) {
        const output = await buildAuditJson(store, runId || null);
        console.log(JSON.stringify(output, null, 2));
      } else {
        await buildAuditHuman(store, runId || null);
      }

      await store.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (options?.json) {
        console.log(JSON.stringify({ error: 'audit_failed', message: msg }));
      } else {
        console.error('  ✗ 审计失败: ' + msg);
      }
      process.exitCode = 1;
      await store.close();
    }
  });

async function buildAuditHuman(store: SqliteStateStore, runId: string | null): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  brainctl audit' + (runId ? ' ' + runId : ''));
  console.log('═'.repeat(60));

  if (runId) {
    await showRunAudit(store, runId);
  } else {
    // Show recent runs summary
    const db = (store as any).db;
    const rows = db.prepare(
      'SELECT id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 10'
    ).all() as Record<string, unknown>[];

    if (rows.length === 0) {
      console.log('  无运行记录。');
    } else {
      console.log('  最近 Runs:');
      for (const r of rows) {
        console.log(`    ${r.id}  [${r.status}]  ${String(r.created_at).substring(0, 19)}`);
      }
      console.log('');
      console.log('  使用 "brainctl audit <run-id>" 查看详细信息。');
    }
  }
  console.log('═'.repeat(60));
}

async function showRunAudit(store: SqliteStateStore, runId: string): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) { console.log('  ✗ Run 不存在。'); return; }

  console.log('  Run: ' + run.id);
  console.log('  状态: ' + run.status);
  console.log('  项目: ' + run.projectRoot.substring(0, 60));
  console.log('');

  // ── Approvals ──
  const approvals = await store.listApprovalDecisions(runId);
  if (approvals.length > 0) {
    console.log('  ── 审批决策 (' + approvals.length + ') ──');
    for (const a of approvals) {
      const icon = statusIcon(a.status);
      console.log(`    ${icon} [${a.gate}] ${a.decisionType} — ${a.status}`);
      console.log(`       id: ${a.id}`);
      if (a.approvedAt) console.log(`       确认: ${a.approvedAt.substring(0, 19)}`);
      if (a.expiresAt) console.log(`       过期: ${a.expiresAt.substring(0, 19)}`);
      if (a.revokedAt) console.log(`       撤销: ${a.revokedAt.substring(0, 19)}`);
      console.log('');
    }
  } else {
    console.log('  ── 审批决策: 无 ──');
  }

  // ── Risk Assessments ──
  const risks = await store.listRiskAssessments(runId);
  if (risks.length > 0) {
    console.log('  ── 风险快照 (' + risks.length + ') ──');
    for (const ra of risks) {
      console.log(`    [${ra.riskLevel}] ${ra.assessmentType} — ${ra.trigger}`);
      if (ra.findingsJson) {
        try {
          const findings = JSON.parse(ra.findingsJson);
          for (const f of findings) {
            console.log(`      ${f.category}: ${f.severity} (hash: ${(f.detailHash || '').substring(0, 16)}...)`);
          }
        } catch { console.log('      (parse error)'); }
      }
      console.log(`      已解决: ${ra.resolved ? '是' : '否'}`);
      console.log('');
    }
  }

  // ── Token Ledger ──
  const summary = await store.getTokenUsageSummary(runId);
  if (summary.totalEstimated > 0 || summary.totalActual > 0) {
    console.log('  ── Token 用量 ──');
    console.log(`    Codex 规划: 估算=${summary.codexPlan.estimated}  实际=${summary.codexPlan.actual}`);
    console.log(`    Codex 审查: 估算=${summary.codexReview.estimated}  实际=${summary.codexReview.actual}`);
    console.log(`    Pi 施工:   估算=${summary.piWorker.estimated}  实际=${summary.piWorker.actual}`);
    console.log(`    总计:      估算=${summary.totalEstimated}  实际=${summary.totalActual}`);
    console.log('');
  }

  // ── Budget Policies ──
  const budgets = await getAllEffectiveBudgets(store, runId);
  console.log('  ── 预算策略 ──');
  for (const [pt, b] of Object.entries(budgets)) {
    console.log(`    ${pt}: ${b.tokenLimit} tokens (${b.actionOnExceed}) [${b.source}]`);
  }
  console.log('');

  // ── Events ──
  const events = await store.listEvents(runId);
  const keyEvents = events.filter((e) =>
    ['run_created', 'run_approved', 'run_resumed', 'run_canceled', 'run_completed',
      'stage_paused', 'token_budget_exceeded', 'token_budget_resumed',
      'scope_expansion', 'high_risk_triggered'].includes(e.eventType),
  );
  if (keyEvents.length > 0) {
    console.log('  ── 关键事件 (' + keyEvents.length + ') ──');
    for (const ev of keyEvents.slice(-30)) {
      console.log(`    ${ev.createdAt.substring(11, 19)}  ${ev.eventType}`);
    }
  }
}

function statusIcon(s: string): string {
  switch (s) {
    case 'approved': return '✓';
    case 'pending': return '○';
    case 'denied': return '✗';
    case 'revoked': return '↩';
    case 'expired': return '⏰';
    default: return '?';
  }
}

async function buildAuditJson(store: SqliteStateStore, runId: string | null) {
  if (!runId) {
    const db = (store as any).db;
    const rows = db.prepare('SELECT id, status FROM runs ORDER BY created_at DESC LIMIT 10').all() as Record<string, unknown>[];
    return { runs: rows.map((r) => ({ id: r.id, status: r.status })) };
  }

  const run = await store.getRun(runId);
  if (!run) return { error: 'run_not_found' };

  const [approvals, risks, summary, events] = await Promise.all([
    store.listApprovalDecisions(runId),
    store.listRiskAssessments(runId),
    store.getTokenUsageSummary(runId),
    store.listEvents(runId),
  ]);

  const budgets = await getAllEffectiveBudgets(store, runId);

  return {
    run: {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
    },
    approvals: approvals.map((a) => ({
      id: a.id, gate: a.gate, decisionType: a.decisionType,
      status: a.status, approvedBy: a.approvedBy,
      approvedAt: a.approvedAt, expiresAt: a.expiresAt,
      revokedAt: a.revokedAt, metadata: sanitizeMetadata(a.metadata),
    })),
    risks: risks.map((ra) => ({
      id: ra.id, assessmentType: ra.assessmentType,
      riskLevel: ra.riskLevel, resolved: ra.resolved,
      trigger: ra.trigger,
    })),
    tokenUsage: summary,
    budgets,
    events: events.slice(-50).map((e) => ({
      timestamp: e.createdAt,
      type: e.eventType,
      summary: e.eventDataJson ? e.eventDataJson.substring(0, 120) : '',
    })),
  };
}

function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === 'string' && v.length > 128) {
      out[k] = v.substring(0, 128) + '...(truncated)';
    } else {
      out[k] = v;
    }
  }
  return out;
}
