// ── M5 reconcile CLI command ────────────────────────────────────────────
// "brainctl reconcile [run-id] [--apply] [--json]"
// Default: read-only dry-run diagnosis
// --apply: execute safe, provable state convergence
// --json: output report as JSON
// Zero writes for dry-run, --json only, and preflight paths.

import { Command } from 'commander';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { converge } from '../../core/reconciliation/convergence-engine.js';
import { applySafeActions } from '../../core/reconciliation/applicator.js';
import { buildSummaryJson } from '../../core/reconciliation/report-builder.js';
import { DefaultFactGatherer, hashProjectRoot } from '../../core/reconciliation/fact-gatherer.js';
import { getGovernanceConfig, resetGovernanceConfigCache } from '../../core/decision-gate.js';
import {
  checkBranchExists, getGitHead, hasMergeConflict, getConflictFileNames,
} from '../../core/reconciliation/git-fact-checker.js';
import {
  checkWorktreeExists, checkWorktreeRegistered, checkWorktreeDirty,
} from '../../core/reconciliation/worktree-fact-checker.js';
import { isLockOrphaned } from '../../core/reconciliation/lock-validator.js';
import { resolveIntegrationTargetBranch } from '../../core/reconciliation/target-branch-resolver.js';
import { gatherGovernanceFacts } from '../../core/reconciliation/governance-fact-gatherer.js';
import type {
  ReconciliationFactSnapshot,
  ReconciliationPhase,
  ReconciliationInitiatedBy,
  RunFacts,
  StageFacts,
  TaskFacts,
  AttemptFacts,
  LockFacts,
  IntegrationFacts,
  Finding,
} from '../../types/m5-types.js';

export const reconcileCommand = new Command('reconcile')
  .description('M5 crash recovery diagnosis & safe state convergence')
  .argument('[run-id]', 'Run ID (omit for all non-terminal runs)')
  .option('--apply', 'Apply safe, provable state convergence (write SQLite)')
  .option('--json', 'Output reconciliation report as JSON')
  .action(async (runIdArg?: string, options?: { apply?: boolean; json?: boolean }) => {
    const isApply = options?.apply === true;
    const isJson = options?.json === true;
    const phase: ReconciliationPhase = isApply ? 'applied' : 'dry_run';
    const initiatedBy: ReconciliationInitiatedBy = 'user_direct';

    if (!isJson) {
      console.log('═'.repeat(60));
      console.log('  brainctl reconcile');
      console.log('═'.repeat(60));
    }

    try {
      const config = readSqliteConfigFromEnv();
      const store = SqliteStateStore.create(config.path);

      // ── Schema readiness check (read-only) ──
      const db = store.getDatabase();
      const hasRunsTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'"
      ).get() as any;
      if (!hasRunsTable) {
        const msg = 'Database schema not initialized. Run: brainctl db migrate --apply';
        if (isJson) {
          console.log(JSON.stringify({ error: 'schema_not_initialized', message: msg }));
        } else {
          console.log(`  ✗ ${msg}`);
        }
        await store.close();
        process.exit(1);
      }

      // ── Only --apply may trigger migration ──
      if (isApply) {
        const runner = new SqliteMigrationRunner(config, store.getDatabase());
        runner.applyPending();
      }

      const gatherer = new DefaultFactGatherer();
      const allReports: unknown[] = [];

      // Determine run IDs to process
      let runIds: string[];
      if (runIdArg) {
        const run = await store.getRun(runIdArg);
        if (!run) {
          if (isJson) {
            console.log(JSON.stringify({ error: 'run_not_found', runId: runIdArg }));
          } else {
            console.log(`  ✗ Run ${runIdArg} does not exist.`);
          }
          await store.close();
          process.exit(1);
        }
        runIds = [runIdArg];
      } else {
        const runs = await store.listNonTerminalRuns();
        runIds = runs.map((r) => r.id);
        if (runIds.length === 0) {
          if (isJson) {
            console.log(JSON.stringify({ message: 'No non-terminal runs found', runs: [] }));
          } else {
            console.log('  No non-terminal runs found. All runs are in terminal state.');
          }
          await store.close();
          return;
        }
      }

      for (const runId of runIds) {
        // Gather facts for this run
        const facts = await gatherRunFacts(store, gatherer, runId);

        // Classify, sort, derive safe actions
        resetGovernanceConfigCache();
        const run = await store.getRun(runId);
        const govEnabled = run ? getGovernanceConfig(run.projectRoot).enabled : false;

        const { findings, safeActions, report } = converge(facts, govEnabled, phase, initiatedBy);

        if (isApply) {
          // ── APPLY mode: atomic transaction in store ──
          const applyResult = await applySafeActions(store, report, findings, safeActions);

          if (isJson) {
            allReports.push(applyResult.report);
          } else {
            printAppliedReport(applyResult.report);
          }
        } else {
          // ── DRY-RUN mode: zero writes ──
          if (isJson) {
            allReports.push(report);
          } else {
            printDryRunReport(report);
          }
        }
      }

      if (isJson) {
        // Output all reports as JSON array (single run → single object)
        if (runIds.length === 1 && allReports.length === 1) {
          console.log(JSON.stringify(allReports[0], null, 2));
        } else {
          console.log(JSON.stringify(allReports, null, 2));
        }
      }

      await store.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isJson) {
        console.log(JSON.stringify({ error: 'reconcile_failed', message: msg }));
      } else {
        console.error(`  ✗ Error: ${msg}`);
      }
      process.exitCode = 1;
    }

    if (!isJson) {
      console.log('═'.repeat(60));
    }
  });

// ══════════════════════════════════════════════════════════════
// Fact Gathering
// ══════════════════════════════════════════════════════════════

async function gatherRunFacts(
  store: SqliteStateStore,
  gatherer: DefaultFactGatherer,
  runId: string,
): Promise<ReconciliationFactSnapshot> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  // Git facts
  const gitHead = await gatherer.getGitHead(run.projectRoot);
  const gitHeadResolvable = gitHead !== null;
  const conflict = await gatherer.hasMergeConflict(run.projectRoot);
  const conflictFiles = conflict ? await gatherer.getConflictFiles(run.projectRoot) : [];

  const runFacts: RunFacts = {
    runId,
    runStatus: run.status,
    projectRootHash: hashProjectRoot(run.projectRoot),
    governanceEnabled: getGovernanceConfig(run.projectRoot).enabled,
    gitHead,
    gitHeadResolvable,
    mergeConflict: conflict,
    conflictFiles,
  };

  // Stage facts
  const stages = await store.listStages(runId);
  const events = await store.listEvents(runId);
  const governance = runFacts.governanceEnabled
    ? await gatherGovernanceFacts(store, runId)
    : undefined;
  const stageFacts: StageFacts[] = [];

  for (const stage of stages) {
    const tasks = await store.listTasksByStage(stage.id);
    const taskFacts: TaskFacts[] = [];

    for (const task of tasks) {
      const attempts = await store.listAttempts(task.id);
      const attemptFacts: AttemptFacts[] = [];

      for (const attempt of attempts) {
        // PID check
        let pidAlive: 'alive' | 'gone' | 'unknown' = 'unknown';
        if (attempt.piPid != null) {
          pidAlive = await gatherer.checkPidAlive(attempt.piPid);
        }

        // Worktree check
        const worktreePath = attempt.worktreePath;
        const worktreeExists = worktreePath ? await gatherer.pathExists(worktreePath) : false;
        const worktreeRegistered = worktreePath
          ? await gatherer.isWorktreeRegistered(run.projectRoot, worktreePath)
          : false;
        const worktreeDirty = worktreePath
          ? await gatherer.isWorktreeDirty(worktreePath)
          : false;

        // Branch check + divergence detection
        const branchName = attempt.branchName;
        const branchExists = branchName
          ? await gatherer.branchExists(run.projectRoot, branchName)
          : false;
        let branchHeadMatches = true; // default: no evidence of divergence
        if (branchExists && branchName) {
          const actualBranchHead = await gatherer.getBranchHead(run.projectRoot, branchName);
          // Try to find expected commit from WorkerResult or persisted data
          let expectedCommit: string | null = null;
          if (attempt.workerResultJson) {
            try {
              const wr = JSON.parse(attempt.workerResultJson);
              expectedCommit = wr.commitHash || wr.commit || null;
            } catch { /* ignore parse error */ }
          }
          // Fallback: compare with stage baseCommit
          if (!expectedCommit) {
            expectedCommit = stage.baseCommit;
          }
          if (actualBranchHead && expectedCommit) {
            branchHeadMatches = actualBranchHead.startsWith(expectedCommit) ||
                                expectedCommit.startsWith(actualBranchHead);
          } else if (actualBranchHead && !expectedCommit) {
            // Cannot verify: conservative, produce finding later
            branchHeadMatches = false;
          }
        }

        // Worker result and independent Git/path evidence. A WorkerResult is a
        // claim; it is not completion evidence until the attempt branch proves
        // a change against the stage base.
        const workerResultExists = attempt.workerResultJson != null && attempt.workerResultJson.length > 0;
        let workerResultCompleted = false;
        let workerCommitHash: string | null = null;
        if (workerResultExists) {
          try {
            const workerResult = JSON.parse(attempt.workerResultJson!);
            workerResultCompleted = workerResult.status === 'completed';
            workerCommitHash = typeof workerResult.commitHash === 'string' && workerResult.commitHash.trim()
              ? workerResult.commitHash.trim()
              : null;
          } catch { /* malformed persisted result remains unverifiable */ }
        }
        const changedFiles = branchName && branchExists && stage.baseCommit
          ? getChangedFiles(run.projectRoot, stage.baseCommit, branchName)
          : [];
        const taskSpec = (task.specJson || {}) as { estimatedWritePaths?: unknown };
        const expectedWritePaths = Array.isArray(taskSpec.estimatedWritePaths)
          ? taskSpec.estimatedWritePaths.filter((path): path is string => typeof path === 'string')
          : [];
        const expectedWriteEvidence = expectedWritePaths.some((expectedPath) => changedFiles.some((changedPath) =>
          changedPath === expectedPath || changedPath.startsWith(expectedPath.endsWith('/') ? expectedPath : expectedPath + '/'),
        ));

        // Locks held by this attempt's task
        const locks = await store.getActiveLocksForRun(runId);
        const taskLocks = locks.filter((l) => l.taskId === attempt.taskId && l.status === 'locked');
        const locksHeld = taskLocks.length;

        // Lock orphan check: are all of this task's locks safely releasable?
        const locksOrphaned = taskLocks.some((l) => {
          // Check if the owning attempt (if identifiable) is terminal
          // Since locks use deterministic IDs based on run/task/path,
          // we consider them orphaned if the current attempt is not running
          return attempt.status !== 'running';
        });

        // Review check
        const reviews = await store.listReviewsByTask(attempt.taskId);
        const latestReview = reviews[reviews.length - 1];
        const reviewCompleted = latestReview
          ? (latestReview.status === 'approved' || latestReview.status === 'rework_required' || latestReview.status === 'failed')
          : false;
        const reviewStatus = latestReview?.status || null;
        const reviewEvidenceTrusted = isReviewEvidenceTrusted(latestReview?.reviewJson, reviewStatus);

        attemptFacts.push({
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          taskId: attempt.taskId,
          stageId: attempt.stageId,
          pid: attempt.piPid,
          pidAlive,
          worktreePath,
          worktreeExists,
          worktreeRegistered,
          worktreeDirty,
          branchName,
          branchExists,
          branchHeadMatches,
          workerResultExists,
          workerResultJson: attempt.workerResultJson,
          workerResultCompleted,
          workerCommitHash,
          changedFiles,
          expectedWritePaths,
          expectedWriteEvidence,
          locksHeld,
          locksOrphaned,
          reviewCompleted,
          reviewStatus,
          reviewEvidenceTrusted,
        });
      }

      taskFacts.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        attempts: attemptFacts,
      });
    }

    // Integration facts
    let integrationFacts: IntegrationFacts | null = null;
    const batches = await store.listIntegrationBatches(stage.id);
    if (batches.length > 0) {
      const batch = batches[0]; // usually 1 per stage
      const intBranchExists = await gatherer.branchExists(
        run.projectRoot, batch.integrationBranch);
      const mergeCommitInGit = batch.mergeCommitHash
        ? await gatherer.isCommitReachable(run.projectRoot, batch.mergeCommitHash)
        : false;
      const targetBranch = resolveIntegrationTargetBranch(
        events,
        stage.id,
        batch.integrationBranch,
      );
      const targetAlreadyMerged = targetBranch !== null
        ? await gatherer.isBranchMerged(run.projectRoot, batch.integrationBranch, targetBranch)
        : false;

      integrationFacts = {
        batchId: batch.id,
        status: batch.status,
        integrationBranch: batch.integrationBranch,
        integrationBranchExists: intBranchExists,
        mergeCommitInGit,
        targetAlreadyMerged,
        targetBranch,
        targetMergeCommit: batch.targetMergeCommit,
      };
    }
    const locks = await store.getActiveLocksForRun(runId);
    const lockFacts: LockFacts[] = [];
    for (const lock of locks) {
      if (lock.status !== 'locked') continue;
      // Find owning attempt
      let ownerAttemptId: string | null = null;
      let ownerAttemptStatus: string | null = null;
      let ownerPidAlive: 'alive' | 'gone' | 'unknown' | 'n/a' = 'n/a';

      // Try to find attempt by task
      const taskAttempts = taskFacts.flatMap((t) => t.attempts);
      const matchingAttempt = taskAttempts.find((a) => a.taskId === lock.taskId);
      if (matchingAttempt) {
        ownerAttemptId = matchingAttempt.attemptId;
        ownerAttemptStatus = matchingAttempt.status;
        ownerPidAlive = matchingAttempt.pidAlive;
      }

      lockFacts.push({
        lockId: lock.id,
        filePathHash: hashProjectRoot(lock.filePath),
        taskId: lock.taskId,
        lockType: lock.lockType,
        lockStatus: lock.status,
        ownerAttemptId,
        ownerAttemptStatus,
        ownerPidAlive,
        ownerRunStatus: runFacts.runStatus,
      });
    }

    stageFacts.push({
      stageId: stage.id,
      stageNumber: stage.stageNumber,
      status: stage.status,
      baseCommit: stage.baseCommit,
      tasks: taskFacts,
      integration: integrationFacts,
      activeLocks: lockFacts,
    });
  }

  return {
    run: runFacts,
    stages: stageFacts,
    governance,
  };
}

function getChangedFiles(projectRoot: string, baseCommit: string, branchName: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseCommit}..${branchName}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isReviewEvidenceTrusted(reviewJson: string | null | undefined, reviewStatus: string | null): boolean {
  if (reviewStatus !== 'approved' || !reviewJson) return false;
  try {
    const review = JSON.parse(reviewJson) as { reviewer?: unknown; reviewSummary?: unknown };
    const reviewer = typeof review.reviewer === 'string' ? review.reviewer : '';
    const summary = typeof review.reviewSummary === 'string' ? review.reviewSummary : '';
    return reviewer !== 'fake' && !/(?:^|\b)fake(?:\b|_)/i.test(summary);
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// Output formatting
// ══════════════════════════════════════════════════════════════

function printDryRunReport(report: { runId?: string; summary: { totalFindings: number; blockingCount: number; warningCount: number; infoCount: number; appliedCount: number; skippedCount: number; canResume: boolean; canApprove: boolean }; findings: Finding[]; entities: { run: { runId: string; gitHeadResolvable: boolean; mergeConflict: boolean } } }): void {
  const s = report.summary;
  console.log(`\n  Run: ${report.entities.run.runId || report.runId || 'N/A'}`);
  console.log(`  Git HEAD: ${report.entities.run.gitHeadResolvable ? 'OK' : 'UNRESOLVABLE'}`);
  console.log(`  Merge conflict: ${report.entities.run.mergeConflict ? 'YES (BLOCKING)' : 'None'}`);
  console.log(`  Findings: ${s.totalFindings} total (${s.blockingCount} blocking, ${s.warningCount} warning, ${s.infoCount} info)`);
  console.log(`  Resume safe: ${s.canResume ? 'YES' : 'NO (blocking findings present)'}`);
  console.log(`  Approve safe: ${s.canApprove ? 'YES' : 'NO (blocking findings present)'}`);

  if (s.totalFindings === 0) {
    console.log(`  ✓ No anomalies detected.`);
    return;
  }

  console.log(`\n  ── Findings ──`);

  // Group by severity
  const sevOrder = ['blocking', 'warning', 'info'];
  for (const sev of sevOrder) {
    const group = report.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    const label = sev === 'blocking' ? 'BLOCKING' : sev === 'warning' ? 'WARNING' : 'INFO';
    console.log(`\n  [${label}]`);
    for (const f of group) {
      console.log(`    • ${f.kind} (${f.entityType}:${f.entityId.substring(0, 20)})`);
      console.log(`      ${f.proposal.substring(0, 120)}`);
    }
  }

  if (s.blockingCount > 0) {
    console.log(`\n  ! Blocking findings present. To safely repair:`);
    console.log(`    brainctl reconcile <run-id> --apply`);
  } else if (s.warningCount > 0) {
    console.log(`\n  > Warning findings only. Safe to apply or resume.`);
  }
}

function printAppliedReport(report: { summary: { totalFindings: number; blockingCount: number; warningCount: number; infoCount: number; appliedCount: number; skippedCount: number; canResume: boolean; canApprove: boolean }; findings: Finding[] }): void {
  const s = report.summary;
  console.log(`\n  ── Applied ──`);
  console.log(`  Applied: ${s.appliedCount} action(s), Skipped: ${s.skippedCount} finding(s)`);
  console.log(`  Remaining: ${s.blockingCount} blocking, ${s.warningCount} warning`);

  const applied = report.findings.filter((f) => f.status === 'applied');
  if (applied.length > 0) {
    console.log(`\n  Applied actions:`);
    for (const f of applied) {
      console.log(`    ✓ ${f.kind}: ${f.appliedAction || 'applied'}`);
    }
  }

  const skipped = report.findings.filter((f) => f.status === 'skipped');
  if (skipped.length > 0) {
    console.log(`\n  Skipped (no safe action):`);
    for (const f of skipped) {
      console.log(`    - ${f.kind} (${f.entityType}:${f.entityId.substring(0, 20)})`);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Preflight (for approve/resume)
// ══════════════════════════════════════════════════════════════

/**
 * Run a read-only preflight reconciliation. Returns findings.
 * Zero writes to SQLite. Returns blocking findings or empty.
 */
export async function runPreflightReconciliation(
  store: SqliteStateStore,
  runId: string,
  initiatedBy: ReconciliationInitiatedBy,
): Promise<Finding[]> {
  const gatherer = new DefaultFactGatherer();
  const facts = await gatherRunFacts(store, gatherer, runId);

  const run = await store.getRun(runId);
  resetGovernanceConfigCache();
  const govEnabled = run ? getGovernanceConfig(run.projectRoot).enabled : false;

  const { findings } = converge(facts, govEnabled, 'dry_run', initiatedBy);
  return findings;
}

/**
 * Check if findings contain blocking entries.
 */
export function hasBlockingFindings(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'blocking');
}

/**
 * Print preflight blocking findings and usage hint.
 */
export function printPreflightBlocked(findings: Finding[], runId: string): void {
  const blocking = findings.filter((f) => f.severity === 'blocking');
  console.log(`  ✗ Preflight reconciliation found ${blocking.length} blocking issue(s):`);
  for (const f of blocking) {
    console.log(`    • [${f.severity}] ${f.kind}: ${f.proposal.substring(0, 100)}`);
  }
  console.log();
  console.log(`  To diagnose:  brainctl reconcile ${runId}`);
  console.log(`  To safely fix: brainctl reconcile ${runId} --apply`);
  console.log(`  After fixing blocking issues, retry this command.`);
}
