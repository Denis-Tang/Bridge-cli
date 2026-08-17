// ── M5 reconcile CLI command ────────────────────────────────────────────
// "brainctl reconcile [run-id] [--apply] [--json]"
// Default: read-only dry-run diagnosis
// --apply: execute safe, provable state convergence
// --json: output report as JSON
// Zero writes for dry-run, --json only, and preflight paths.

import { Command } from 'commander';
import { resolve } from 'node:path';
// execFileSync is imported here at the top of the file and used by
// resolveGitRevParse() / getChangedFiles() below (git rev-parse --verify).
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
import type { IntegrationBatchRecord, EventRecord } from '../../types/m2-types.js';
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
  .option('--project <path>', 'Project root used to resolve the default database path')
  .option('--db <path>', 'SQLite state database path; overrides BRAINCTL_SQLITE_PATH')
  .action(async (runIdArg?: string, options?: { apply?: boolean; json?: boolean; project?: string; db?: string }) => {
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
      const config = readSqliteConfigFromEnv(options?.project, options?.db);
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
        if (isApply && store.reconcileStaleCostReservations) {
          await store.reconcileStaleCostReservations(runId, new Date().toISOString());
        }
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
  const events = sortByCreatedAtThenId(await store.listEvents(runId));
  const runTrustedTokenEfficient = isTrustedTokenEfficientExecution(run.executionConfigSnapshot);
  const activeRunLocks = (await store.getActiveLocksForRun(runId))
    .filter((lock) => lock.status === 'locked');
  const governance = runFacts.governanceEnabled
    ? await gatherGovernanceFacts(store, runId)
    : undefined;
  const stageFacts: StageFacts[] = [];

  for (const stage of stages) {
    // Only the latest integration batch may supply a trusted stage review
    // proof. Selection is deterministic (createdAt, then id) and fail-closed:
    // an invalid latest batch never falls back to an older one.
    const batches = sortByCreatedAtThenId(await store.listIntegrationBatches(stage.id));
    const latestBatch = batches.length > 0 ? batches[batches.length - 1] : null;

    let integrationFacts: IntegrationFacts | null = null;
    let gitProof: GitProofResult | null = null;
    if (latestBatch) {
      const batch = latestBatch;
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

      gitProof = resolveTrustedStageReviewGitProof(run.projectRoot, batch);
    }

    const tasks = await store.listTasksByStage(stage.id);
    const taskFacts: TaskFacts[] = [];

    for (const task of tasks) {
      const attempts = await store.listAttempts(task.id);
      const attemptFacts: AttemptFacts[] = [];
      const latestAttemptId = attempts.reduce<string | null>((latestId, candidate) => {
        if (!latestId) return candidate.id;
        const latest = attempts.find((attempt) => attempt.id === latestId);
        return !latest || candidate.attemptNumber > latest.attemptNumber ? candidate.id : latestId;
      }, null);

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

        // Locks are task-scoped in SQLite and reused across attempts. Attribute
        // them only to the latest attempt; older failed/interrupted attempts do
        // not become owners merely because they share the same task id.
        const taskLocks = activeRunLocks.filter((lock) => lock.taskId === attempt.taskId);
        const ownsTaskLocks = attempt.id === latestAttemptId;
        const locksHeld = ownsTaskLocks ? taskLocks.length : 0;
        const locksOrphaned = ownsTaskLocks
          && taskLocks.length > 0
          && isLockOwnerStatusOrphaned(attempt.status);

        // Review check — attempt-scoped: reviews are written per attempt, and
        // a rework_required review on an OLD attempt must not count as
        // completion evidence for the CURRENT attempt (token-efficient skips
        // rely on this to fall back to trusted stage review coverage).
        const reviews = await store.listReviewsByAttempt(attempt.id);
        const latestReview = reviews[reviews.length - 1];
        const reviewCompleted = latestReview
          ? (latestReview.status === 'approved' || latestReview.status === 'rework_required' || latestReview.status === 'failed')
          : false;
        const reviewStatus = latestReview?.status || null;
        const reviewEvidenceTrusted = isReviewEvidenceTrusted(latestReview?.reviewJson, reviewStatus);
        const reviewCoveredByTrustedStageReview = runTrustedTokenEfficient
          && latestBatch !== null
          && gitProof !== null
          && computeTrustedStageReviewCoverage({
            trustedExecutionMode: runTrustedTokenEfficient,
            attempt: {
              attemptId: attempt.id,
              taskId: attempt.taskId,
              stageId: attempt.stageId,
              status: attempt.status,
              reviewCompleted,
            },
            latestBatch,
            events,
            gitProof,
          });

        attemptFacts.push({
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          taskId: attempt.taskId,
          stageId: attempt.stageId,
          pid: attempt.piPid,
          pidAlive,
          dispatchLeaseExpiresAt: findAttemptLeaseExpiry(events, attempt.id),
          spawnEventObserved: events.some((event) => event.attemptId === attempt.id && event.eventType === 'attempt_started'
            && parseEventReason(event.eventDataJson) !== 'retry_scheduled'),
          attemptUpdatedAt: attempt.updatedAt,
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
          reviewCoveredByTrustedStageReview,
        });
      }

      taskFacts.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        attempts: attemptFacts,
      });
    }

    stageFacts.push({
      stageId: stage.id,
      stageNumber: stage.stageNumber,
      status: stage.status,
      baseCommit: stage.baseCommit,
      tasks: taskFacts,
      integration: integrationFacts,
      activeLocks: [],
    });
  }

  // A task-scoped lock belongs to exactly one stage. Attach it to the stage
  // containing that task and select the latest attempt as its current owner.
  // Unknown task ownership remains fail-closed, but is reported only once.
  for (const lock of activeRunLocks) {
    const ownerStage = stageFacts.find((stage) =>
      stage.tasks.some((task) => task.taskId === lock.taskId));
    const reportStage = ownerStage ?? stageFacts[0];
    if (!reportStage) continue;
    const ownerTask = ownerStage?.tasks.find((task) => task.taskId === lock.taskId);
    const matchingAttempt = selectLatestAttemptForLock(ownerTask?.attempts ?? []);
    reportStage.activeLocks.push({
      lockId: lock.id,
      filePathHash: hashProjectRoot(lock.filePath),
      taskId: lock.taskId,
      lockType: lock.lockType,
      lockStatus: lock.status,
      ownerAttemptId: matchingAttempt?.attemptId ?? null,
      ownerAttemptStatus: matchingAttempt?.status ?? null,
      ownerPidAlive: matchingAttempt?.pidAlive ?? 'n/a',
      ownerRunStatus: runFacts.runStatus,
    });
  }

  return {
    run: runFacts,
    stages: stageFacts,
    governance,
  };
}

// ══════════════════════════════════════════════════════════════
// Trusted stage review proof (pure decision helpers)
// ══════════════════════════════════════════════════════════════

/** Sort audit rows deterministically by createdAt, then id. */
export function sortByCreatedAtThenId<T extends { createdAt: string; id: string }>(
  records: readonly T[],
): T[] {
  return [...records].sort((a, b) => {
    const createdAtOrder = a.createdAt.localeCompare(b.createdAt);
    if (createdAtOrder !== 0) return createdAtOrder;
    return a.id.localeCompare(b.id);
  });
}

/** Select only the latest integration batch; never fall back to older batches. */
export function selectLatestIntegrationBatch(
  batches: readonly IntegrationBatchRecord[],
): IntegrationBatchRecord | null {
  const sorted = sortByCreatedAtThenId(batches);
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

/**
 * Parse the persisted execution config snapshot directly as JSON and decide
 * whether it proves token-efficient execution with the codex-cli reviewer.
 * NULL, absent, malformed, wrong types, or wrong values are all untrusted.
 */
export function isTrustedTokenEfficientExecution(
  executionConfigSnapshot: string | null | undefined,
): boolean {
  if (typeof executionConfigSnapshot !== 'string' || executionConfigSnapshot.trim() === '') {
    return false;
  }
  try {
    const parsed = JSON.parse(executionConfigSnapshot) as {
      config?: {
        executionMode?: unknown;
        reviewer?: { type?: unknown };
      } | null;
    } | null;
    if (!parsed || typeof parsed !== 'object') return false;
    const config = parsed.config;
    if (!config || typeof config !== 'object') return false;
    const reviewer = config.reviewer;
    if (!reviewer || typeof reviewer !== 'object') return false;
    return config.executionMode === 'token-efficient' && reviewer.type === 'codex-cli';
  } catch {
    return false;
  }
}

/** Parse reviewMetadataJson and return the reviewer string, if any. */
export function parseReviewMetadataReviewer(reviewMetadataJson: string | null): string | null {
  if (!reviewMetadataJson) return null;
  try {
    const parsed = JSON.parse(reviewMetadataJson) as { reviewer?: unknown };
    return typeof parsed.reviewer === 'string' ? parsed.reviewer : null;
  } catch {
    return null;
  }
}

/**
 * Validate the latest integration batch as a trusted stage review proof.
 * Fail-closed: complete coverage, reviewer available, codex-cli reviewer,
 * non-empty commits, and both commit tree resolutions succeed and are equal
 * (reviewed tree == final merge tree).
 *
 * NOTES on why branch/head equality is intentionally lenient:
 * - We do NOT require reviewedThroughCommit === mergeCommitHash. The normal
 *   path merges the integration branch with `--no-ff` (stage-integration
 *   updates mergeCommitHash to the new target merge commit), so the two hashes
 *   differ by construction while their trees are identical. Requiring hash
 *   equality would make every legitimately completed token-efficient batch
 *   fail trusted-stage-review and be mis-classified as review_evidence_missing.
 * - We do NOT require the integration branch ref to still exist. Successful
 *   real runs delete the integration branch during worktree cleanup
 *   (cleanupMergedStageWorktrees), so a post-cleanup preflight must be able to
 *   trust the proof from persisted commits alone. If the ref still exists it
 *   must point at the reviewed commit (fail closed on a drifted branch); a
 *   deleted ref (null) falls back to the tree-equality invariant.
 */
export function isLatestBatchTrustedStageReview(
  batch: IntegrationBatchRecord,
  gitProof: GitProofResult,
): boolean {
  // Fail-closed: only a completed batch is final trusted stage review
  // evidence. A pending/integrating/conflict/failed batch must never satisfy
  // coverage, even if the remaining fields happen to be populated.
  if (batch.status !== 'completed') return false;
  if (typeof batch.integrationBranch !== 'string' || batch.integrationBranch.trim() === '') return false;
  if (batch.reviewCoverageStatus !== 'complete') return false;
  if (batch.reviewerUnavailable !== false) return false;
  if (parseReviewMetadataReviewer(batch.reviewMetadataJson) !== 'codex-cli') return false;
  if (typeof batch.reviewedThroughCommit !== 'string' || batch.reviewedThroughCommit.trim() === '') return false;
  if (typeof batch.mergeCommitHash !== 'string' || batch.mergeCommitHash.trim() === '') return false;
  if (gitProof.integrationBranchHead !== null && gitProof.integrationBranchHead !== batch.reviewedThroughCommit) {
    return false;
  }
  if (gitProof.reviewedThroughTree === null || gitProof.mergeCommitTree === null) return false;
  if (gitProof.reviewedThroughTree !== gitProof.mergeCommitTree) return false;
  return true;
}

/** Check for the exact task+attempt review_skipped_token_efficient event. */
export function hasReviewSkippedTokenEfficient(
  events: readonly EventRecord[],
  taskId: string,
  attemptId: string,
): boolean {
  return events.some((event) =>
    event.eventType === 'review_skipped_token_efficient'
    && event.taskId === taskId
    && event.attemptId === attemptId,
  );
}

/**
 * Check the stage review evidence chain for the exact stage/commit/task.
 * Events are sorted by createdAt then id before matching, so a later
 * stage_review_completed event approving the exact task must follow the
 * matching stage_review_started event for the exact commit.
 */
export function hasStageReviewEvidence(
  events: readonly EventRecord[],
  stageId: string,
  reviewedThroughCommit: string,
  taskId: string,
): boolean {
  const sorted = sortByCreatedAtThenId(events);
  let matchingStartSeen = false;
  for (const event of sorted) {
    if (event.stageId !== stageId) continue;
    if (event.eventType === 'stage_review_started') {
      // A start event for a different commit must reset the flag: completion
      // may only pair with the start for the exact reviewed commit, never be
      // borrowed from a later review of another commit.
      matchingStartSeen = parseEventDataString(event.eventDataJson, 'reviewedCommit') === reviewedThroughCommit;
    } else if (matchingStartSeen && event.eventType === 'stage_review_completed') {
      // Hardening: if the completed event itself carries a reviewedCommit it
      // must also equal the exact reviewed commit. Events without the field
      // (the current writer omits it) stay paired with the armed start.
      const completedCommit = parseEventDataString(event.eventDataJson, 'reviewedCommit');
      if (completedCommit !== null && completedCommit !== reviewedThroughCommit) {
        matchingStartSeen = false;
        continue;
      }
      const approvedTasks = parseEventDataStringArray(event.eventDataJson, 'approvedTasks');
      if (approvedTasks.includes(taskId)) return true;
    }
  }
  return false;
}

export interface TrustedStageReviewAttemptContext {
  attemptId: string;
  taskId: string;
  stageId: string;
  status: string;
  reviewCompleted: boolean;
}

export interface GitProofResult {
  integrationBranchHead: string | null;
  reviewedThroughTree: string | null;
  mergeCommitTree: string | null;
}

/**
 * Pure decision: can an approved attempt substitute its missing per-task
 * review with a valid trusted stage review? Every check is strict and no
 * event/approval may be borrowed from another task, attempt, or stage.
 */
export function computeTrustedStageReviewCoverage(input: {
  trustedExecutionMode: boolean;
  attempt: TrustedStageReviewAttemptContext;
  latestBatch: IntegrationBatchRecord;
  events: readonly EventRecord[];
  gitProof: GitProofResult;
}): boolean {
  if (!input.trustedExecutionMode) return false;
  if (input.attempt.status !== 'approved') return false;
  if (input.attempt.reviewCompleted) return false;
  if (!hasReviewSkippedTokenEfficient(input.events, input.attempt.taskId, input.attempt.attemptId)) return false;
  if (!isLatestBatchTrustedStageReview(input.latestBatch, input.gitProof)) return false;
  if (!hasStageReviewEvidence(
    input.events,
    input.attempt.stageId,
    input.latestBatch.reviewedThroughCommit ?? '',
    input.attempt.taskId,
  )) return false;
  return true;
}

/** Resolve the Git facts required for the fail-closed stage review proof. */
function resolveTrustedStageReviewGitProof(
  projectRoot: string,
  batch: IntegrationBatchRecord,
): GitProofResult {
  return {
    integrationBranchHead: resolveGitRevParse(projectRoot, batch.integrationBranch),
    reviewedThroughTree: batch.reviewedThroughCommit
      ? resolveGitRevParse(projectRoot, `${batch.reviewedThroughCommit}^{tree}`)
      : null,
    mergeCommitTree: batch.mergeCommitHash
      ? resolveGitRevParse(projectRoot, `${batch.mergeCommitHash}^{tree}`)
      : null,
  };
}

function resolveGitRevParse(projectRoot: string, spec: string): string | null {
  if (!spec) return null;
  try {
    const output = execFileSync('git', ['rev-parse', '--verify', spec], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function parseEventDataString(eventDataJson: string | null, field: string): string | null {
  if (!eventDataJson) return null;
  try {
    const parsed = JSON.parse(eventDataJson) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function parseEventDataStringArray(eventDataJson: string | null, field: string): string[] {
  if (!eventDataJson) return [];
  try {
    const parsed = JSON.parse(eventDataJson) as Record<string, unknown>;
    const value = parsed[field];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function findAttemptLeaseExpiry(events: Awaited<ReturnType<SqliteStateStore['listEvents']>>, attemptId: string): string | null {
  const lease = events.filter((event) => event.attemptId === attemptId && event.eventType === 'attempt_dispatch_lease').at(-1);
  if (!lease?.eventDataJson) return null;
  try {
    const parsed = JSON.parse(lease.eventDataJson) as { leaseExpiresAt?: unknown };
    return typeof parsed.leaseExpiresAt === 'string' ? parsed.leaseExpiresAt : null;
  } catch {
    return null;
  }
}

function parseEventReason(eventDataJson: string | null): string | null {
  if (!eventDataJson) return null;
  try {
    const parsed = JSON.parse(eventDataJson) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

const INTENTIONAL_LOCK_OWNER_STATUSES = new Set([
  'running',
  'worker_completed',
  'validating',
  'reviewing',
]);

export function isLockOwnerStatusOrphaned(status: string): boolean {
  return !INTENTIONAL_LOCK_OWNER_STATUSES.has(status);
}

export function selectLatestAttemptForLock(attempts: AttemptFacts[]): AttemptFacts | null {
  return attempts.reduce<AttemptFacts | null>((latest, candidate) =>
    !latest || candidate.attemptNumber > latest.attemptNumber ? candidate : latest, null);
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

export async function runAutomaticReconciliation(
  store: SqliteStateStore,
  runId: string,
): Promise<{ findings: Finding[]; appliedCount: number }> {
  const staleCostSettled = store.reconcileStaleCostReservations
    ? await store.reconcileStaleCostReservations(runId, new Date().toISOString())
    : 0;
  const gatherer = new DefaultFactGatherer();
  const facts = await gatherRunFacts(store, gatherer, runId);
  const run = await store.getRun(runId);
  resetGovernanceConfigCache();
  const govEnabled = run ? getGovernanceConfig(run.projectRoot).enabled : false;
  const { findings, safeActions, report } = converge(facts, govEnabled, 'dry_run', 'scheduler');
  if (safeActions.length === 0) return { findings, appliedCount: staleCostSettled };
  const applied = await applySafeActions(store, report, findings, safeActions);
  return { findings: applied.report.findings, appliedCount: applied.atomicResult.appliedCount + staleCostSettled };
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
