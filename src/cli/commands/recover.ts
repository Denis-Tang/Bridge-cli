import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { SqliteStateStore } from '../../state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../state/sqlite-migration-runner.js';
import { readSqliteConfigFromEnv } from '../../state/sqlite-config.js';
import { DiffScopeValidator } from '../../git/diff-scope-validator.js';
import { QualityGateRunner } from '../../quality/quality-gate-runner.js';
import { qualityGatesToRunnerConfig } from '../../quality/quality-gate-config.js';
import { loadRuntimeProjectConfig } from '../../core/project-runtime-config.js';
import { checkScopeExpansion } from '../../core/scope-guard.js';
import type { StructuredTaskSpec } from '../../types/m2-types.js';
import type { WorkerResult } from '../../types/protocol.js';
import { claimActualPathsInOpenTransaction } from '../../state/actual-path-claims.js';

export const recoverCommand = new Command('recover')
  .description('安全接纳已存在的恢复成果；不会绕过质量门、Review 或集成')
  .addCommand(new Command('attempt')
    .description('把现有 commit 接纳为 worker_completed，随后使用 resume 继续')
    .argument('<attempt-id>', '需要恢复的 attempt ID')
    .requiredOption('--commit <sha>', '待接纳 commit')
    .option('--project <path>', '目标项目路径；默认使用 run 中保存的 projectRoot')
    .option('--db <path>', 'SQLite 状态库路径；优先于 BRAINCTL_SQLITE_PATH')
    .option('--worktree <path>', '包含该 commit 的现有干净 worktree；默认使用 attempt.worktreePath')
    .option('--branch <name>', '该 worktree 的分支；默认使用 attempt.branchName')
    .option('--source <type>', '恢复来源: manual 或 codex_recovery', 'manual')
    .option('--allow-scope-expansion', '显式批准超出 estimatedWritePaths 但仍在 allowedPaths 内的范围扩展')
    .option('--decision-note <text>', '范围扩展裁决说明；与 --allow-scope-expansion 联用')
    .action(async (attemptId: string, options: {
      commit: string; project?: string; db?: string; worktree?: string; branch?: string;
      source: string; allowScopeExpansion?: boolean; decisionNote?: string;
    }) => {
      if (!['manual', 'codex_recovery'].includes(options.source)) throw new Error('--source must be manual or codex_recovery');
      if (options.allowScopeExpansion && !options.decisionNote?.trim()) throw new Error('--allow-scope-expansion requires --decision-note');

      const configured = readSqliteConfigFromEnv(options.project, options.db);
      const dbPath = configured.path;
      // Read legacy state without opening SQLite for writes or applying migrations.
      // Scope/Git/gate failures must leave the database byte-for-byte untouched.
      const context = readRecoveryContextReadOnly(dbPath, attemptId);
      const { attempt, task, stage, run, provenance } = context;
      if (['completed', 'failed', 'canceled'].includes(run.status)) throw new Error(`terminal run cannot adopt recovery: ${run.status}`);

      const projectRoot = resolve(options.project ?? run.projectRoot);
      if (normalizePath(projectRoot) !== normalizePath(run.projectRoot)) throw new Error('--project does not match the run projectRoot');
      const worktreeInput = options.worktree ?? provenance.expectedWorktree;
      if (!worktreeInput?.trim()) throw new Error('recovery worktree is missing; pass --worktree');
      const worktree = resolve(worktreeInput);
      const branch = options.branch ?? provenance.expectedBranch;
      if (!existsSync(worktree)) throw new Error('recovery worktree does not exist; pass --worktree');
      if (!branch) throw new Error('recovery branch is missing; pass --branch');
      if (normalizePath(worktree) !== normalizePath(provenance.expectedWorktree)) throw new Error('recovery worktree does not match immutable attempt provenance');
      if (branch !== provenance.expectedBranch) throw new Error('recovery branch does not match immutable attempt provenance');

      const commit = git(projectRoot, ['rev-parse', '--verify', `${options.commit}^{commit}`]);
      git(projectRoot, ['merge-base', '--is-ancestor', provenance.baseCommit, commit]);
      const head = git(worktree, ['rev-parse', 'HEAD']);
      if (head !== commit) throw new Error(`worktree HEAD ${head} does not match adopted commit ${commit}`);
      const actualBranch = git(worktree, ['branch', '--show-current']);
      if (actualBranch !== branch) throw new Error(`worktree branch ${actualBranch || '(detached)'} does not match ${branch}`);
      if (git(worktree, ['status', '--porcelain'])) throw new Error('recovery worktree is not clean');
      git(projectRoot, ['diff', '--check', `${provenance.baseCommit}..${commit}`, '--']);

      const changedFiles = git(projectRoot, ['diff', '--name-only', `${provenance.baseCommit}..${commit}`, '--'])
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (changedFiles.length === 0) throw new Error('adopted commit has no diff from the stage base');

      const spec = task.specJson;
      const runtime = loadRuntimeProjectConfig(projectRoot, { snapshotText: run.executionConfigSnapshot });
      const scopeDecision = validateRecoveryScope({
        changedFiles,
        estimatedWritePaths: spec.estimatedWritePaths ?? [],
        taskAllowedPaths: spec.allowedPaths ?? [],
        taskForbiddenPaths: spec.forbiddenPaths ?? [],
        projectAllowedPaths: runtime.resolved.allowedPaths,
        projectForbiddenPaths: runtime.resolved.forbiddenPaths,
        sharedLocks: runtime.resolved.sharedLocks,
        repositoryRoot: projectRoot,
        allowScopeExpansion: options.allowScopeExpansion === true,
      });

      const gates = qualityGatesToRunnerConfig(runtime.resolved.qualityGatesTask);
      if (gates.length === 0) throw new Error('task quality gates are not configured');
      const gateResult = await new QualityGateRunner(worktree).runGates(gates, true);
      if (!gateResult.passed) throw new Error(`task quality gates failed: ${gateResult.summary}`);
      if (git(worktree, ['status', '--porcelain'])) throw new Error('quality gates modified the recovery worktree; clean it and retry');
      if (git(worktree, ['rev-parse', 'HEAD']) !== commit) throw new Error('quality gates changed worktree HEAD');

      const workerResult: WorkerResult = {
        taskId: task.id, status: 'completed',
        summary: `Adopted recovery commit ${commit.slice(0, 12)}; normal review and integration still required`,
        filesChanged: changedFiles, commitHash: commit,
        checks: gateResult.results.map((result) => ({ name: result.name, status: result.status, summary: result.stderrTail || result.stdoutTail || result.status })),
        scopeViolations: [], risks: scopeDecision.requiresDecision ? ['scope_expansion_approved'] : [], unresolvedQuestions: [],
        productDecisionRequired: false,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 },
      };

      // Open for writes only after every external validation has passed.
      const store = SqliteStateStore.create(dbPath);
      let recoveryPauseId = '';
      try {
        new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, store.getDatabase()).applyPending();
        recoveryPauseId = adoptRecoveryAtomically(store, {
          runId: run.id, stageId: stage.id, taskId: task.id, attemptId, worktree, branch, commit,
          source: options.source as 'manual' | 'codex_recovery', changedFiles,
          lockPaths: scopeDecision.lockPaths,
          workerResult,
          decisionNote: scopeDecision.requiresDecision ? options.decisionNote!.trim() : null,
          scopeExpansionFiles: scopeDecision.expandedFiles,
          expectedState: {
            runStatus: run.status,
            stageStatus: stage.status,
            taskStatus: task.status,
            attemptStatus: attempt.status,
          },
        });
      } finally {
        await store.close();
      }

      console.log(`Recovery candidate adopted as worker_completed: ${attemptId}`);
      console.log(`Commit: ${commit}`);
      console.log(`Recovery pause confirmation: ${recoveryPauseId}`);
      console.log(`Next: brainctl resume ${run.id} --confirm-pause ${recoveryPauseId} --allow-real-project --db "${dbPath}"`);
    }));

interface RecoveryContext {
  attempt: { id: string; taskId: string; stageId: string; attemptNumber: number; status: string; worktreePath: string | null; branchName: string | null };
  task: { id: string; runId: string; status: string; specJson: StructuredTaskSpec };
  stage: { id: string; runId: string; status: string; baseCommit: string | null };
  run: { id: string; status: string; projectRoot: string; executionConfigSnapshot: string | null };
  provenance: {
    attemptId: string; runId: string; stageId: string; taskId: string; baseCommit: string;
    expectedBranch: string; expectedWorktree: string; taskPacketHash: string;
    implementationPromptHash: string; workerId: string; sessionId: string;
  };
}

/** Read the minimum recovery context without WAL changes or pending migrations. */
export function readRecoveryContextReadOnly(dbPath: string, attemptId: string): RecoveryContext {
  const require = createRequire(import.meta.url);
  const DatabaseSync = require('node:sqlite').DatabaseSync;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const attempt = db.prepare(`SELECT id, task_id, stage_id, attempt_number, status, worktree_path, branch_name
      FROM task_attempts WHERE id = ?`).get(attemptId) as Record<string, unknown> | undefined;
    if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
    const task = db.prepare('SELECT id, run_id, status, spec_json FROM tasks WHERE id = ?')
      .get(String(attempt.task_id)) as Record<string, unknown> | undefined;
    const stage = db.prepare('SELECT id, run_id, status, base_commit FROM stages WHERE id = ?')
      .get(String(attempt.stage_id)) as Record<string, unknown> | undefined;
    if (!task || !stage) throw new Error('attempt is missing its task or stage');
    const run = db.prepare('SELECT id, status, project_root, execution_config_snapshot FROM runs WHERE id = ?')
      .get(String(task.run_id)) as Record<string, unknown> | undefined;
    if (!run) throw new Error('attempt is missing its run');
    if (String(stage.run_id) !== String(run.id)) throw new Error('attempt stage does not belong to the task run');
    const provenanceTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attempt_provenance'").get() as { name?: string } | undefined;
    if (!provenanceTable) throw new Error('attempt provenance missing; legacy recovery requires a protected manual decision');
    const provenance = db.prepare('SELECT * FROM attempt_provenance WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
    if (!provenance) throw new Error('attempt provenance missing; recovery fails closed');
    if (String(provenance.run_id) !== String(run.id) || String(provenance.stage_id) !== String(stage.id)
      || String(provenance.task_id) !== String(task.id)) {
      throw new Error('attempt provenance identity does not match run/stage/task');
    }
    const latestAttempt = db.prepare('SELECT id FROM task_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1')
      .get(String(task.id)) as { id?: string } | undefined;
    if (String(latestAttempt?.id ?? '') !== String(attempt.id)) {
      throw new Error(`attempt ${attemptId} is not the latest attempt for task ${String(task.id)}`);
    }

    let specJson: StructuredTaskSpec;
    try {
      specJson = JSON.parse(String(task.spec_json || '{}')) as StructuredTaskSpec;
    } catch {
      throw new Error(`task ${String(task.id)} has invalid spec_json`);
    }

    return {
      attempt: {
        id: String(attempt.id), taskId: String(attempt.task_id), stageId: String(attempt.stage_id),
        attemptNumber: Number(attempt.attempt_number), status: String(attempt.status),
        worktreePath: attempt.worktree_path ? String(attempt.worktree_path) : null,
        branchName: attempt.branch_name ? String(attempt.branch_name) : null,
      },
      task: { id: String(task.id), runId: String(task.run_id), status: String(task.status), specJson },
      stage: { id: String(stage.id), runId: String(stage.run_id), status: String(stage.status), baseCommit: stage.base_commit ? String(stage.base_commit) : null },
      run: {
        id: String(run.id), status: String(run.status), projectRoot: String(run.project_root),
        executionConfigSnapshot: run.execution_config_snapshot ? String(run.execution_config_snapshot) : null,
      },
      provenance: {
        attemptId: String(provenance.attempt_id), runId: String(provenance.run_id), stageId: String(provenance.stage_id),
        taskId: String(provenance.task_id), baseCommit: String(provenance.base_commit),
        expectedBranch: String(provenance.expected_branch), expectedWorktree: String(provenance.expected_worktree),
        taskPacketHash: String(provenance.task_packet_hash), implementationPromptHash: String(provenance.implementation_prompt_hash),
        workerId: String(provenance.worker_id), sessionId: String(provenance.session_id),
      },
    };
  } finally {
    db.close();
  }
}

export interface RecoveryScopeDecision {
  requiresDecision: boolean;
  expandedFiles: string[];
  lockPaths: string[];
}

/** Keep the run/project scope as the hard ceiling while allowing an explicit legacy TaskSpec expansion. */
export function validateRecoveryScope(input: {
  changedFiles: string[];
  estimatedWritePaths: string[];
  taskAllowedPaths: string[];
  taskForbiddenPaths: string[];
  projectAllowedPaths: string[];
  projectForbiddenPaths: string[];
  sharedLocks: string[];
  repositoryRoot: string;
  allowScopeExpansion: boolean;
}): RecoveryScopeDecision {
  const hardForbidden = [...new Set([...input.projectForbiddenPaths, ...input.taskForbiddenPaths])];
  const validator = new DiffScopeValidator();
  const projectScope = validator.validate(
    input.changedFiles, input.projectAllowedPaths, hardForbidden, input.repositoryRoot,
  );
  if (!projectScope.valid || projectScope.violations.length) {
    throw new Error(`project scope validation failed: ${projectScope.violations.join('; ')}`);
  }

  const expansion = checkScopeExpansion(
    input.changedFiles, input.estimatedWritePaths, input.taskAllowedPaths, 0,
  );
  const expandedFiles = [...new Set([...expansion.expandedFiles, ...expansion.forbiddenFiles])].sort();
  const requiresDecision = expandedFiles.length > 0;
  if (requiresDecision && !input.allowScopeExpansion) {
    throw new Error(
      `candidate expands frozen TaskSpec scope but remains within project allowedPaths (${expandedFiles.join(', ')}); `
      + 'rerun with --allow-scope-expansion --decision-note after reviewing the changed files',
    );
  }

  const normalizedLockPaths = (paths: string[], kind: string): string[] => paths.map((candidate) => {
    const normalized = validator.normalizePathForLock(candidate);
    if (!normalized.ok) throw new Error(`unsafe ${kind} path '${candidate}': ${normalized.reason}`);
    return normalized.path;
  });
  const estimatedLockPaths = input.estimatedWritePaths.length > 0 ? input.estimatedWritePaths : ['src/'];
  const comparedPaths = normalizedLockPaths([...estimatedLockPaths, ...input.changedFiles], 'recovery lock');
  const sharedLocks = normalizedLockPaths(input.sharedLocks, 'shared lock');
  const overlappingSharedLocks = sharedLocks.filter((lock) => comparedPaths.some(
    (candidate) => pathContains(lock, candidate) || pathContains(candidate, lock),
  ));
  return {
    requiresDecision,
    expandedFiles,
    lockPaths: [...new Set([...comparedPaths, ...overlappingSharedLocks])].sort(),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function normalizePath(value: string): string {
  const normalized = resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathContains(parent: string, child: string): boolean {
  const a = parent.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
  const b = child.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return b === a || b.startsWith(a + '/');
}

function lockId(runId: string, taskId: string, filePath: string): string {
  // SHA-256 of the normalized path — must stay byte-identical with
  // SqliteStateStore.createDeterministicLockId and
  // StageScheduler.expectedLockId, or resume verification fails after a
  // recovery adoption.
  const normalized = filePath.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.').join('/').toLowerCase();
  return runId + '-lk-' + taskId + '-' + createHash('sha256').update(normalized).digest('hex');
}

export function adoptRecoveryAtomically(store: SqliteStateStore, input: {
  runId: string; stageId: string; taskId: string; attemptId: string; worktree: string; branch: string;
  commit: string; source: 'manual' | 'codex_recovery'; changedFiles: string[]; lockPaths: string[];
  workerResult: WorkerResult; decisionNote: string | null; scopeExpansionFiles?: string[];
  expectedState?: { runStatus: string; stageStatus: string; taskStatus: string; attemptStatus: string };
}): string {
  const db = store.getDatabase();
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRun = db.prepare('SELECT status FROM runs WHERE id = ?').get(input.runId) as { status?: string } | undefined;
    const currentStage = db.prepare('SELECT status FROM stages WHERE id = ?').get(input.stageId) as { status?: string } | undefined;
    const currentTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(input.taskId) as { status?: string } | undefined;
    const currentAttempt = db.prepare('SELECT status FROM task_attempts WHERE id = ?').get(input.attemptId) as { status?: string } | undefined;
    if (!currentRun || !currentStage || !currentTask || !currentAttempt) {
      throw new Error('recovery state entity missing during atomic adoption');
    }
    if (input.expectedState) {
      const actual = [currentRun?.status, currentStage?.status, currentTask?.status, currentAttempt?.status];
      const expected = [input.expectedState.runStatus, input.expectedState.stageStatus, input.expectedState.taskStatus, input.expectedState.attemptStatus];
      if (actual.some((value, index) => value !== expected[index])) {
        throw new Error(`recovery state changed after read-only validation: expected ${expected.join('/')} but found ${actual.join('/')}`);
      }
    }
    const runStatus = String(currentRun.status);
    const stageStatus = String(currentStage.status);
    const taskStatus = String(currentTask.status);
    const attemptStatus = String(currentAttempt.status);
    if (['completed', 'failed', 'canceled'].includes(runStatus)) {
      throw new Error(`recovery cannot adopt into terminal run: ${runStatus}`);
    }
    if (['completed', 'failed', 'canceled'].includes(stageStatus)) {
      throw new Error(`recovery cannot pause terminal stage: ${stageStatus}`);
    }
    if (!['failed', 'interrupted', 'running', 'worker_completed'].includes(attemptStatus)) {
      throw new Error(`recovery attempt status is not adoptable: ${attemptStatus}`);
    }
    if (!['failed', 'rework_required', 'waiting_decision', 'running', 'worker_completed'].includes(taskStatus)) {
      throw new Error(`recovery task status is not adoptable: ${taskStatus}`);
    }
    const latestAttempt = db.prepare('SELECT id FROM task_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1')
      .get(input.taskId) as { id?: string } | undefined;
    if (String(latestAttempt?.id ?? '') !== input.attemptId) {
      throw new Error(`recovery attempt is no longer latest for task ${input.taskId}`);
    }
    const provenance = db.prepare('SELECT run_id, stage_id, task_id, expected_branch, expected_worktree FROM attempt_provenance WHERE attempt_id = ?')
      .get(input.attemptId) as Record<string, unknown> | undefined;
    if (!provenance) throw new Error('attempt provenance missing; recovery fails closed');
    if (String(provenance.run_id) !== input.runId || String(provenance.stage_id) !== input.stageId
      || String(provenance.task_id) !== input.taskId || String(provenance.expected_branch) !== input.branch
      || normalizePath(String(provenance.expected_worktree)) !== normalizePath(input.worktree)) {
      throw new Error('recovery candidate does not match immutable attempt provenance');
    }
    const claimResult = claimActualPathsInOpenTransaction(db, {
      runId: input.runId, stageId: input.stageId, taskId: input.taskId,
      attemptId: input.attemptId, filePaths: input.changedFiles,
    }, now);
    if (!claimResult.claimed) {
      throw new Error(`recovery actual path claim rejected: ${JSON.stringify({ conflicts: claimResult.conflicts, violations: claimResult.violations })}`);
    }
    const active = db.prepare("SELECT task_id, file_path FROM path_locks WHERE run_id = ? AND status = 'locked' AND task_id != ?")
      .all(input.runId, input.taskId) as Array<{ task_id: string; file_path: string }>;
    for (const candidate of input.lockPaths) {
      const conflict = active.find((lock) => pathContains(lock.file_path, candidate) || pathContains(candidate, lock.file_path));
      if (conflict) throw new Error(`path lock conflict with ${conflict.task_id}: ${conflict.file_path}`);
      const id = lockId(input.runId, input.taskId, candidate);
      db.prepare(`INSERT INTO path_locks (id, run_id, task_id, file_path, lock_type, status, acquired_at)
        VALUES (?, ?, ?, ?, 'exclusive', 'locked', ?)
        ON CONFLICT(id) DO UPDATE SET status='locked', acquired_at=excluded.acquired_at, released_at=NULL`)
        .run(id, input.runId, input.taskId, candidate, now);
    }
    const attemptUpdate = db.prepare(`UPDATE task_attempts SET status='worker_completed', worktree_path=?, branch_name=?, worker_result_json=?,
      exit_reason='recovery_adopted', result_source=?, adopted_commit=?, adoption_metadata_json=?, stopped_at=?, updated_at=? WHERE id=? AND status=?`)
      .run(input.worktree, input.branch, JSON.stringify(input.workerResult), input.source, input.commit,
        JSON.stringify({
          changedFilesHash: hashPathList(input.changedFiles),
          changedFileCount: canonicalPathList(input.changedFiles).length,
          scopeExpansionFilesHash: input.scopeExpansionFiles?.length
            ? hashPathList(input.scopeExpansionFiles) : null,
          scopeExpansionFileCount: canonicalPathList(input.scopeExpansionFiles ?? []).length,
        }),
        now, now, input.attemptId, attemptStatus);
    if (Number(attemptUpdate.changes) !== 1) {
      throw new Error('recovery attempt CAS failed');
    }
    const taskUpdate = db.prepare("UPDATE tasks SET status='worker_completed', updated_at=? WHERE id=? AND status=?")
      .run(now, input.taskId, taskStatus);
    if (Number(taskUpdate.changes) !== 1) {
      throw new Error('recovery task CAS failed');
    }
    if (stageStatus !== 'paused') {
      const stageUpdate = db.prepare("UPDATE stages SET status='paused', updated_at=? WHERE id=? AND status=?")
        .run(now, input.stageId, stageStatus);
      if (Number(stageUpdate.changes) !== 1) {
        throw new Error('recovery stage CAS failed');
      }
    }
    const existingPause = db.prepare('SELECT id FROM pause_records WHERE stage_id = ? AND resolved_at IS NULL')
      .get(input.stageId) as { id?: string } | undefined;
    const pauseId = String(existingPause?.id ?? `${input.runId}-pause-recovery-${randomUUID()}`);
    if (!existingPause) {
      db.prepare(`INSERT INTO pause_records
        (id, run_id, stage_id, reason_code, category, recoverable, required_approval_type,
         decision_id, evidence_summary, created_at, resolved_at, resolution_note)
        VALUES (?, ?, ?, 'recovery_adopted', 'recovery', 1, NULL, NULL, ?, ?, NULL, NULL)`)
        .run(pauseId, input.runId, input.stageId,
          createHash('sha256').update(`${input.attemptId}\0${input.commit}`).digest('hex'), now);
      db.prepare(`INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'stage_paused', ?, ?)`)
        .run(`${input.runId}-ev-recovery-pause-${randomUUID()}`, input.runId, input.stageId, input.taskId, input.attemptId,
          JSON.stringify({ pauseId, reasonCode: 'recovery_adopted', category: 'recovery' }), now);
    }
    db.prepare(`INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'recovery_adopted', ?, ?)`)
      .run(`${input.runId}-ev-recovery-${Date.now()}-${randomUUID()}`, input.runId, input.stageId, input.taskId, input.attemptId,
        JSON.stringify({ source: input.source, commit: input.commit, changedFileCount: canonicalPathList(input.changedFiles).length,
          decision: input.decisionNote ? {
            type: 'scope_expansion', note: input.decisionNote,
            expandedFileCount: canonicalPathList(input.scopeExpansionFiles ?? []).length,
            expandedFilesHash: input.scopeExpansionFiles?.length
              ? hashPathList(input.scopeExpansionFiles) : null,
          } : null,
          nextRequiredAction: 'resume_for_review_and_integration' }), now);
    db.exec('COMMIT');
    return pauseId;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

function canonicalPathList(paths: string[]): string[] {
  return [...new Set(paths.map((value) => value.replace(/\\/g, '/').replace(/^\.\//, '')))].sort();
}

function hashPathList(paths: string[]): string {
  return createHash('sha256').update(canonicalPathList(paths).join('\n')).digest('hex');
}
