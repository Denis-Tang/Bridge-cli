import { existsSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type {
  StateStore, CreateRunInput, RunRecord, CreateTaskInput, TaskRecord,
  CreateResourceSampleInput, CreateDispatchDecisionInput,
  CreateApprovalDecisionInput, CreateTokenLedgerEntryInput,
  CreateBudgetPolicyInput, CreateRiskAssessmentInput, TokenUsageSummary,
  ReviewRetryInput, RunConvergenceFailureInput,
} from './state-store.js';
import type { PrivacyService } from '../privacy/privacy-service.js';
import type {
  StageRecord, CreateStageInput,
  AttemptRecord, CreateAttemptInput,
  PathLockRecord, CreatePathLockInput,
  ReviewRecord, CreateReviewInput,
  IntegrationBatchRecord, CreateIntegrationBatchInput,
  EventRecord, CreateEventInput,
  ActualPathClaimRecord, AttemptProvenanceRecord,
} from '../types/m2-types.js';
import type { ResourceSampleRecord, DispatchDecisionRecord } from '../types/m3-types.js';
import type {
  ApprovalDecision, TokenLedgerEntry, BudgetPolicy, RiskAssessment,
} from '../types/m4-types.js';
import type {
  ReconciliationReportRecord,
  ReconciliationFindingRecord,
  CreateReconciliationReportInput,
  CreateReconciliationFindingInput,
} from '../types/m5-types.js';
import type { AtomicApplyInput, AtomicApplyResult, AcquirePathLocksInput, AcquirePathLocksResult, ClaimActualPathsInput, ClaimActualPathsResult, CreateAttemptProvenanceInput } from './state-store.js';
import type { StateQueryStore } from './state-store.js';
import {
  assertTransitionRun,
  assertTransitionStage,
  assertTransitionTask,
  assertTransitionAttempt,
  TERMINAL_RUN_STATUSES,
  TERMINAL_STAGE_STATUSES,
  TERMINAL_TASK_STATUSES,
  TERMINAL_ATTEMPT_STATUSES,
  type RunStatus,
  type StageStatus,
  type TaskStatus,
  type AttemptStatus,
} from '../core/state-machine.js';
import type {
  PauseRecord,
  CreateStagePauseInput,
  ResolveStagePauseInput,
} from '../types/pause-types.js';
import { claimActualPathsInOpenTransaction, mapActualPathClaimRow } from './actual-path-claims.js';

// Use createRequire to load node:sqlite (avoids bundler resolution issues)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DatabaseSyncCtor: any = null;
function getDatabaseSync(): any {
  if (!DatabaseSyncCtor) {
    const require = createRequire(import.meta.url);
    DatabaseSyncCtor = require('node:sqlite').DatabaseSync;
  }
  return DatabaseSyncCtor;
}

/**
 * SQLite implementation of StateStore using Node.js built-in `node:sqlite`.
 */
export class SqliteStateStore implements StateStore {
  private db: any;
  private dbPath: string;
  private privacyService: PrivacyService | null;

  private constructor(dbPath: string, db: any, privacyService?: PrivacyService | null) {
    this.dbPath = dbPath;
    this.db = db;
    this.privacyService = privacyService ?? null;
  }

  /**
   * Static factory method: create and initialize a SqliteStateStore.
   */
  static create(
    dbPath: string,
    privacyService?: PrivacyService | null,
    options: { busyTimeoutMs?: number } = {},
  ): SqliteStateStore {
    mkdirSync(dirname(dbPath), { recursive: true });
    const DatabaseSync = getDatabaseSync();
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    const db = new DatabaseSync(dbPath, { timeout: busyTimeoutMs });
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyTimeoutMs))}`);
    return new SqliteStateStore(dbPath, db, privacyService);
  }

  static openReadonly(dbPath: string, options: { busyTimeoutMs?: number } = {}): StateQueryStore {
    const DatabaseSync = getDatabaseSync();
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    const walExists = existsSync(`${dbPath}-wal`);
    const shmExists = existsSync(`${dbPath}-shm`);
    if (walExists !== shmExists) {
      throw new Error('SQLite WAL sidecar set is incomplete; read-only open refused');
    }
    const readPath = walExists
      ? dbPath
      : (() => {
          const url = pathToFileURL(dbPath);
          url.searchParams.set('immutable', '1');
          return url;
        })();
    const db = new DatabaseSync(readPath, { readOnly: true, timeout: busyTimeoutMs });
    db.exec('PRAGMA query_only=ON');
    db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(busyTimeoutMs))}`);
    return new SqliteStateStore(dbPath, db, null);
  }

  /**
   * Get the raw DatabaseSync instance (for migration runner access).
   */
  getDatabase(): any {
    return this.db;
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Create a new run record.
   */
  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    const hasSnapshotColumn = runColumns.some((column) => column.name === 'execution_config_snapshot');
    let stmt = hasSnapshotColumn
      ? this.db.prepare(`
        INSERT INTO runs (id, project_id, project_root, request_text, status, codex_thread_id, execution_config_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      : this.db.prepare(`
        INSERT INTO runs (id, project_id, project_root, request_text, status, codex_thread_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const now = new Date().toISOString();
    // ── Privacy: prepare request text for encrypted storage ──
    let storedRequestText: string = input.requestText;
    let encryptedRequestText: string | null = null;
    if (this.privacyService) {
      const prepared = this.privacyService.prepareForPersistence(input.requestText, 'request_text');
      // request_text is NOT NULL, so store a marker if plaintext is null
      storedRequestText = prepared.plaintext ?? (prepared.status === 'encrypted' ? '[ENCRYPTED]' : '[UNAVAILABLE]');
      encryptedRequestText = prepared.encrypted;
    }
    // Check if encrypted_request_text column exists
    const hasEncryptedRequestCol = runColumns.some((column) => column.name === 'encrypted_request_text');
    if (hasSnapshotColumn && hasEncryptedRequestCol) {
      stmt = this.db.prepare(`
        INSERT INTO runs (id, project_id, project_root, request_text, encrypted_request_text, status, codex_thread_id, execution_config_snapshot, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(input.id, input.projectId, input.projectRoot, storedRequestText, encryptedRequestText, input.status || 'planning', input.codexThreadId || null, input.executionConfigSnapshot ?? null, now, now);
    } else if (hasEncryptedRequestCol) {
      stmt = this.db.prepare(`
        INSERT INTO runs (id, project_id, project_root, request_text, encrypted_request_text, status, codex_thread_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(input.id, input.projectId, input.projectRoot, storedRequestText, encryptedRequestText, input.status || 'planning', input.codexThreadId || null, now, now);
    } else if (hasSnapshotColumn) {
      stmt.run(input.id, input.projectId, input.projectRoot, storedRequestText, input.status || 'planning', input.codexThreadId || null, input.executionConfigSnapshot ?? null, now, now);
    } else {
      stmt.run(input.id, input.projectId, input.projectRoot, storedRequestText, input.status || 'planning', input.codexThreadId || null, now, now);
    }
    return {
      id: input.id,
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      requestText: storedRequestText ?? '',
      status: input.status || 'planning',
      codexThreadId: input.codexThreadId || null,
      executionConfigSnapshot: input.executionConfigSnapshot ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get a run by ID.
   */
  async getRun(runId: string): Promise<RunRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM runs WHERE id = ?');
    const row = stmt.get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToRunRecord(row);
  }

  /**
   * Update run status with terminal state protection.
   */
  async updateRunStatus(runId: string, status: RunStatus, updatedAt: string): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status?: string } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const current = String(row.status) as RunStatus;
      if (current === status) {
        this.db.exec('COMMIT');
        return true;
      }
      if (TERMINAL_RUN_STATUSES.includes(current)) {
        this.db.exec('ROLLBACK');
        return false;
      }
      assertTransitionRun(current, status);
      if (status === 'completed') {
        const unfinished = this.db.prepare(
          "SELECT id, status FROM stages WHERE run_id = ? AND status NOT IN ('completed', 'canceled') LIMIT 1"
        ).get(runId) as { id: string; status: string } | undefined;
        if (unfinished) {
          throw new Error(`Run ${runId} cannot complete while Stage ${unfinished.id} is ${unfinished.status}`);
        }
      }
      const result = this.db.prepare(
        'UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
      ).run(status, updatedAt, runId, current);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async failRunForConvergenceAtomically(input: RunConvergenceFailureInput): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status FROM runs WHERE id = ?').get(input.runId) as { status?: string } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const current = String(row.status) as RunStatus;
      if (current === 'canceled') {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (current === 'failed') {
        this.db.exec('COMMIT');
        return true;
      }
      if (current !== 'completed') {
        assertTransitionRun(current, 'failed');
      }
      const result = this.db.prepare(
        "UPDATE runs SET status = 'failed', finished_at = ?, updated_at = ? WHERE id = ? AND status = ?"
      ).run(input.failedAt, input.failedAt, input.runId, current);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare(`INSERT INTO events
        (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
        VALUES (?, ?, NULL, NULL, NULL, 'run_convergence_failed', ?, ?)`)
        .run(`${input.runId}-ev-convergence-fail-${randomUUID()}`, input.runId,
          JSON.stringify({ reason: input.reason, previousStatus: current, terminalOverride: current === 'completed' }), input.failedAt);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /**
   * Create a new task record.
   */
  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, run_id, title, status, spec_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    stmt.run(
      input.id,
      input.runId,
      input.title,
      input.status,
      input.specJson ? JSON.stringify(input.specJson) : null,
      now,
      now,
    );
    return {
      id: input.id,
      runId: input.runId,
      title: input.title,
      status: input.status,
      specJson: input.specJson || null,
      branchName: null,
      worktreePath: null,
      workerId: null,
      commitHash: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get a task by ID.
   */
  async getTask(taskId: string): Promise<TaskRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToTaskRecord(row);
  }

  /**
   * List all tasks for a given run.
   */
  async listTasks(runId: string): Promise<TaskRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(runId) as Record<string, unknown>[];
    return rows.map(mapRowToTaskRecord);
  }

  /**
   * Get a run by project ID (active runs only).
   */
  async getActiveRunByProject(projectRoot: string): Promise<RunRecord | null> {
    const stmt = this.db.prepare(
      "SELECT * FROM runs WHERE project_root = ? AND status NOT IN ('completed', 'failed', 'canceled') ORDER BY created_at DESC LIMIT 1"
    );
    const row = stmt.get(projectRoot) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToRunRecord(row);
  }

  async updateRunFinishedAt(runId: string, finishedAt: string): Promise<boolean> {
    const existing = await this.getRun(runId);
    if (!existing) return false;
    const stmt = this.db.prepare('UPDATE runs SET finished_at = ?, updated_at = ? WHERE id = ?');
    stmt.run(finishedAt, finishedAt, runId);
    return true;
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, updatedAt: string): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status?: string } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const current = String(row.status) as TaskStatus;
      if (current === status) {
        this.db.exec('COMMIT');
        return true;
      }
      if (TERMINAL_TASK_STATUSES.includes(current)) {
        this.db.exec('ROLLBACK');
        return false;
      }
      assertTransitionTask(current, status);
      const result = this.db.prepare(
        'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
      ).run(status, updatedAt, taskId, current);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async updateTaskRetryCount(taskId: string, retryCount: number, updatedAt: string): Promise<boolean> {
    const stmt = this.db.prepare('UPDATE tasks SET retry_count = ?, updated_at = ? WHERE id = ?');
    stmt.run(retryCount, updatedAt, taskId);
    return true;
  }

  async listTasksByStage(stageId: string): Promise<TaskRecord[]> {
    const attemptStmt = this.db.prepare(
      'SELECT DISTINCT task_id FROM task_attempts WHERE stage_id = ?'
    );
    const attemptRows = attemptStmt.all(stageId) as Record<string, unknown>[];
    const taskIds = attemptRows.map((r: any) => String(r.task_id));
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => '?').join(',');
    const tasksStmt = this.db.prepare(
      'SELECT * FROM tasks WHERE id IN (' + placeholders + ') ORDER BY created_at ASC'
    );
    const rows = tasksStmt.all(...taskIds) as Record<string, unknown>[];
    return rows.map(mapRowToTaskRecord);
  }

  // ══════════════════════════════════════════════════════════════
  // Stage operations
  // ══════════════════════════════════════════════════════════════

  async createStage(input: CreateStageInput): Promise<StageRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO stages (id, run_id, stage_number, title, status, base_commit, integration_branch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(
      input.id, input.runId, input.stageNumber, input.title,
      input.status || 'pending', input.baseCommit || null, input.integrationBranch || null,
      now, now,
    );
    return {
      id: input.id, runId: input.runId, stageNumber: input.stageNumber,
      title: input.title, status: (input.status || 'pending') as any,
      baseCommit: input.baseCommit || null, integrationBranch: input.integrationBranch || null,
      createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    };
  }

  async getStage(stageId: string): Promise<StageRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM stages WHERE id = ?');
    const row = stmt.get(stageId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToStageRecord(row);
  }

  async updateStageStatus(stageId: string, status: StageStatus, updatedAt: string): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status FROM stages WHERE id = ?').get(stageId) as { status?: string } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const current = String(row.status) as StageStatus;
      if (current === status) {
        this.db.exec('COMMIT');
        return true;
      }
      if (current === 'paused' && status === 'ready') {
        throw new Error('Paused Stage can only leave paused through resolveStagePause');
      }
      if (TERMINAL_STAGE_STATUSES.includes(current)) {
        this.db.exec('ROLLBACK');
        return false;
      }
      assertTransitionStage(current, status);
      const result = this.db.prepare(
        'UPDATE stages SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
      ).run(status, updatedAt, stageId, current);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async updateStageBaseCommit(stageId: string, commit: string): Promise<boolean> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE stages SET base_commit = ?, updated_at = ? WHERE id = ?');
    stmt.run(commit, now, stageId);
    return true;
  }

  async updateStageIntegrationBranch(stageId: string, branch: string): Promise<boolean> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE stages SET integration_branch = ?, updated_at = ? WHERE id = ?');
    stmt.run(branch, now, stageId);
    return true;
  }

  async listStages(runId: string): Promise<StageRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM stages WHERE run_id = ? ORDER BY stage_number ASC');
    const rows = stmt.all(runId) as Record<string, unknown>[];
    return rows.map(mapRowToStageRecord);
  }

  async createStagePause(input: CreateStagePauseInput): Promise<PauseRecord> {
    const stage = await this.getStage(input.stageId);
    if (!stage || stage.runId !== input.runId) {
      throw new Error(`Stage ${input.stageId} does not belong to run ${input.runId}`);
    }
    assertTransitionStage(stage.status as StageStatus, 'paused');

    const createdAt = input.createdAt ?? new Date().toISOString();
    const requiredApprovalType = input.requiredApprovalType ?? null;
    const decisionId = input.decisionId ?? null;
    if ((requiredApprovalType === null) !== (decisionId === null)) {
      throw new Error('Protected pauses require both requiredApprovalType and decisionId');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.db.prepare(
        'SELECT id FROM pause_records WHERE stage_id = ? AND resolved_at IS NULL'
      ).get(input.stageId) as { id: string } | undefined;
      if (active) {
        throw new Error(`Stage ${input.stageId} already has active pause ${active.id}`);
      }

      const stageUpdate = this.db.prepare(
        "UPDATE stages SET status = 'paused', updated_at = ? WHERE id = ? AND status = ?"
      ).run(createdAt, input.stageId, stage.status);
      if (Number(stageUpdate.changes) !== 1) {
        throw new Error(`Stage ${input.stageId} changed while pause was being created`);
      }

      this.db.prepare(
        `INSERT INTO pause_records
         (id, run_id, stage_id, reason_code, category, recoverable,
          required_approval_type, decision_id, evidence_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id, input.runId, input.stageId, input.reasonCode, input.category,
        input.recoverable ? 1 : 0, requiredApprovalType, decisionId,
        input.evidenceSummary, createdAt,
      );

      const eventData = JSON.stringify({
        pauseId: input.id,
        reason: input.reasonCode,
        category: input.category,
        recoverable: input.recoverable,
        requiredApprovalType,
        decisionId,
        evidenceSummary: input.evidenceSummary,
        ...(input.eventData ?? {}),
      });
      const eventColumns = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
      const hasPrivacyProfile = eventColumns.some((column) => column.name === 'privacy_profile');
      if (hasPrivacyProfile) {
        this.db.prepare(
          `INSERT INTO events
           (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, privacy_profile, created_at)
           VALUES (?, ?, ?, ?, ?, 'stage_paused', ?, ?, ?)`
        ).run(input.eventId, input.runId, input.stageId, input.taskId ?? null, input.attemptId ?? null, eventData, null, createdAt);
      } else {
        this.db.prepare(
          `INSERT INTO events
           (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
           VALUES (?, ?, ?, ?, ?, 'stage_paused', ?, ?)`
        ).run(input.eventId, input.runId, input.stageId, input.taskId ?? null, input.attemptId ?? null, eventData, createdAt);
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const record = await this.getPauseRecord(input.id);
    if (!record) throw new Error(`PauseRecord ${input.id} was not persisted`);
    return record;
  }

  async getPauseRecord(pauseId: string): Promise<PauseRecord | null> {
    const row = this.db.prepare('SELECT * FROM pause_records WHERE id = ?')
      .get(pauseId) as Record<string, unknown> | undefined;
    return row ? mapRowToPauseRecord(row) : null;
  }

  async getActivePauseForStage(stageId: string): Promise<PauseRecord | null> {
    const row = this.db.prepare(
      'SELECT * FROM pause_records WHERE stage_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1'
    ).get(stageId) as Record<string, unknown> | undefined;
    return row ? mapRowToPauseRecord(row) : null;
  }

  async getLatestResolvedPauseForAttempt(attemptId: string): Promise<PauseRecord | null> {
    const rows = this.db.prepare(
      `SELECT * FROM events
       WHERE attempt_id = ? AND event_type = 'stage_paused'
       ORDER BY created_at DESC, id DESC`
    ).all(attemptId) as Record<string, unknown>[];

    for (const row of rows) {
      let eventData: Record<string, unknown> | null = null;
      try {
        if (row.event_data_json) {
          eventData = JSON.parse(String(row.event_data_json)) as Record<string, unknown>;
        }
      } catch {
        continue;
      }
      const pauseId = eventData?.pauseId;
      if (typeof pauseId !== 'string' || pauseId.trim() === '') continue;
      const pause = await this.getPauseRecord(pauseId);
      if (!pause || pause.category !== 'product_decision' || !pause.resolvedAt) continue;
      if (!(pause.resolutionNote?.trim() ?? '')) continue;
      return pause;
    }
    return null;
  }

  async resolveStagePause(input: ResolveStagePauseInput): Promise<boolean> {
    const resolutionNote = typeof input.resolutionNote === 'string'
      ? input.resolutionNote.trim()
      : input.resolutionNote;
    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pause = this.db.prepare(
        'SELECT * FROM pause_records WHERE id = ? AND stage_id = ? AND resolved_at IS NULL'
      ).get(input.pauseId, input.stageId) as Record<string, unknown> | undefined;
      if (!pause) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (!(pause.recoverable === 1 || pause.recoverable === true)) {
        this.db.exec('ROLLBACK');
        return false;
      }

      const requiredApprovalType = pause.required_approval_type
        ? String(pause.required_approval_type)
        : null;
      const decisionId = pause.decision_id ? String(pause.decision_id) : null;
      if (requiredApprovalType) {
        if (!decisionId || input.approvalDecisionId !== decisionId) {
          this.db.exec('ROLLBACK');
          return false;
        }
        const approval = this.db.prepare(
          `SELECT id FROM approval_decisions
           WHERE id = ? AND run_id = ? AND decision_type = ? AND status = 'approved'
             AND (expires_at IS NULL OR expires_at > ?)`
        ).get(decisionId, pause.run_id, requiredApprovalType, resolvedAt);
        if (!approval) {
          this.db.exec('ROLLBACK');
          return false;
        }
      }

      const stageUpdate = this.db.prepare(
        "UPDATE stages SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'paused'"
      ).run(resolvedAt, input.stageId);
      if (Number(stageUpdate.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const pauseUpdate = this.db.prepare(
        `UPDATE pause_records SET resolved_at = ?, resolution_note = ?
         WHERE id = ? AND stage_id = ? AND resolved_at IS NULL`
      ).run(resolvedAt, resolutionNote, input.pauseId, input.stageId);
      if (Number(pauseUpdate.changes) !== 1) {
        throw new Error(`PauseRecord ${input.pauseId} changed during resolution`);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Attempt operations
  // ══════════════════════════════════════════════════════════════

  async createAttempt(input: CreateAttemptInput): Promise<AttemptRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO task_attempts (id, task_id, stage_id, attempt_number, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(input.id, input.taskId, input.stageId, input.attemptNumber, input.status || 'pending', now, now);
    return {
      id: input.id, taskId: input.taskId, stageId: input.stageId,
      attemptNumber: input.attemptNumber, status: (input.status || 'pending') as any,
      piPid: null, startedAt: null, stoppedAt: null, worktreePath: null,
      branchName: null, promptHash: null, workerResultJson: null, exitReason: null,
      logPath: null, rawLogPath: null, resultSource: 'pi', adoptedCommit: null,
      adoptionMetadataJson: null, createdAt: now, updatedAt: now,
    };
  }

  async getAttempt(attemptId: string): Promise<AttemptRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM task_attempts WHERE id = ?');
    const row = stmt.get(attemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToAttemptRecord(row);
  }

  async updateAttemptStatus(attemptId: string, status: AttemptStatus, updatedAt: string): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status FROM task_attempts WHERE id = ?').get(attemptId) as { status?: string } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const current = String(row.status) as AttemptStatus;
      if (current === status) {
        this.db.exec('COMMIT');
        return true;
      }
      if (TERMINAL_ATTEMPT_STATUSES.includes(current)) {
        this.db.exec('ROLLBACK');
        return false;
      }
      assertTransitionAttempt(current, status);
      const result = this.db.prepare(
        'UPDATE task_attempts SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
      ).run(status, updatedAt, attemptId, current);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async retryReviewAtomically(input: ReviewRetryInput): Promise<boolean> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const attempt = this.db.prepare('SELECT status FROM task_attempts WHERE id = ? AND task_id = ? AND stage_id = ?')
        .get(input.attemptId, input.taskId, input.stageId) as { status?: string } | undefined;
      const task = this.db.prepare('SELECT status, run_id FROM tasks WHERE id = ?')
        .get(input.taskId) as { status?: string; run_id?: string } | undefined;
      if (!attempt || !task || String(task.run_id) !== input.runId) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (attempt.status === 'worker_completed' && task.status === 'worker_completed') {
        this.db.exec('COMMIT');
        return true;
      }
      if (attempt.status !== 'reviewing' || task.status !== 'reviewing') {
        this.db.exec('ROLLBACK');
        return false;
      }
      const attemptUpdate = this.db.prepare(
        "UPDATE task_attempts SET status = 'worker_completed', updated_at = ? WHERE id = ? AND status = 'reviewing'"
      ).run(input.updatedAt, input.attemptId);
      const taskUpdate = this.db.prepare(
        "UPDATE tasks SET status = 'worker_completed', updated_at = ? WHERE id = ? AND status = 'reviewing'"
      ).run(input.updatedAt, input.taskId);
      if (Number(attemptUpdate.changes) !== 1 || Number(taskUpdate.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare(`INSERT INTO events
        (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'review_retry_scheduled', ?, ?)`)
        .run(`${input.runId}-ev-review-retry-${randomUUID()}`, input.runId, input.stageId, input.taskId, input.attemptId,
          JSON.stringify({ reason: input.reason, fromStatus: 'reviewing', toStatus: 'worker_completed' }), input.updatedAt);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async updateAttemptResult(attemptId: string, u: Partial<Pick<AttemptRecord, 'piPid' | 'startedAt' | 'stoppedAt' | 'worktreePath' | 'branchName' | 'promptHash' | 'workerResultJson' | 'exitReason' | 'logPath' | 'rawLogPath' | 'resultSource' | 'adoptedCommit' | 'adoptionMetadataJson'>>): Promise<boolean> {
    const existing = await this.getAttempt(attemptId);
    if (!existing) return false;
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: any[] = [now];
    // Check if encrypted column exists
    const attemptColumns = this.db.prepare('PRAGMA table_info(task_attempts)').all() as Array<{ name: string }>;
    const hasEncryptedCol = attemptColumns.some((column) => column.name === 'encrypted_worker_result_json');
    for (const [key, value] of Object.entries(u)) {
      if (value !== undefined) {
        // ── Privacy: encrypt workerResultJson if applicable ──
        if (key === 'workerResultJson' && this.privacyService && hasEncryptedCol && typeof value === 'string') {
          const prepared = this.privacyService.prepareForPersistence(value as string, 'worker_result');
          const col = 'worker_result_json';
          const plaintext = prepared.plaintext ?? (prepared.status === 'encrypted' ? '[ENCRYPTED]' : null);
          sets.push(col + ' = ?');
          values.push(plaintext);
          sets.push('encrypted_worker_result_json = ?');
          values.push(prepared.encrypted);
        } else {
          // Convert camelCase to snake_case for column names
          const col = key.replace(/([A-Z])/g, (m) => '_' + m.toLowerCase()).toLowerCase();
          sets.push(col + ' = ?');
          values.push(value);
        }
      }
    }
    values.push(attemptId);
    const stmt = this.db.prepare('UPDATE task_attempts SET ' + sets.join(', ') + ' WHERE id = ?');
    stmt.run(...values);
    return true;
  }

  async listAttempts(taskId: string): Promise<AttemptRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number ASC');
    const rows = stmt.all(taskId) as Record<string, unknown>[];
    return rows.map(mapRowToAttemptRecord);
  }

  async listAttemptsByStage(stageId: string): Promise<AttemptRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM task_attempts WHERE stage_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(stageId) as Record<string, unknown>[];
    return rows.map(mapRowToAttemptRecord);
  }

  async getLatestAttempt(taskId: string): Promise<AttemptRecord | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1'
    );
    const row = stmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToAttemptRecord(row);
  }

  async recordAttemptProvenance(input: CreateAttemptProvenanceInput): Promise<AttemptProvenanceRecord> {
    const comparable = {
      attemptId: input.attemptId, runId: input.runId, stageId: input.stageId, taskId: input.taskId,
      baseCommit: input.baseCommit, expectedBranch: input.expectedBranch, expectedWorktree: input.expectedWorktree,
      taskPacketHash: input.taskPacketHash, implementationPromptHash: input.implementationPromptHash,
      workerId: input.workerId, sessionId: input.sessionId,
    };
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO attempt_provenance
      (attempt_id, run_id, stage_id, task_id, base_commit, expected_branch, expected_worktree,
       task_packet_hash, implementation_prompt_hash, worker_id, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.attemptId, input.runId, input.stageId, input.taskId, input.baseCommit,
        input.expectedBranch, input.expectedWorktree, input.taskPacketHash, input.implementationPromptHash,
        input.workerId, input.sessionId, now);
    const existing = await this.getAttemptProvenance(input.attemptId);
    if (!existing) throw new Error(`attempt provenance insert failed for ${input.attemptId}`);
    const { createdAt: _createdAt, ...persisted } = existing;
    if (JSON.stringify(persisted) !== JSON.stringify(comparable)) {
      throw new Error(`attempt provenance mismatch for immutable attempt ${input.attemptId}`);
    }
    return existing;
  }

  async getAttemptProvenance(attemptId: string): Promise<AttemptProvenanceRecord | null> {
    const row = this.db.prepare('SELECT * FROM attempt_provenance WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      attemptId: String(row.attempt_id), runId: String(row.run_id), stageId: String(row.stage_id), taskId: String(row.task_id),
      baseCommit: String(row.base_commit), expectedBranch: String(row.expected_branch), expectedWorktree: String(row.expected_worktree),
      taskPacketHash: String(row.task_packet_hash), implementationPromptHash: String(row.implementation_prompt_hash),
      workerId: String(row.worker_id), sessionId: String(row.session_id), createdAt: String(row.created_at),
    };
  }

  // ══════════════════════════════════════════════════════════════
  // Path lock operations
  // ══════════════════════════════════════════════════════════════

  async createPathLock(input: CreatePathLockInput): Promise<PathLockRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO path_locks (id, run_id, task_id, file_path, lock_type, status, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(input.id, input.runId, input.taskId, input.filePath, input.lockType || 'exclusive', 'locked', now);
    return {
      id: input.id, runId: input.runId, taskId: input.taskId,
      filePath: input.filePath, lockType: (input.lockType || 'exclusive') as any,
      status: 'locked' as any, acquiredAt: now, releasedAt: null,
    };
  }

  async acquirePathLocksAtomic(input: AcquirePathLocksInput): Promise<AcquirePathLocksResult> {
    const violations: string[] = [];
    const normalized = this.normalizeLockPaths(input.filePaths, violations);
    if (violations.length > 0) {
      return { acquired: false, locks: [], conflicts: [], violations };
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const activeRows = this.db.prepare(
        "SELECT * FROM path_locks WHERE run_id = ? AND status = 'locked'"
      ).all(input.runId) as Record<string, unknown>[];
      const activeLocks = activeRows.map(mapRowToPathLockRecord);
      const conflicts = activeLocks.filter((lock) => lock.taskId !== input.taskId
        && normalized.some((filePath) => this.lockPathsOverlap(filePath, this.normalizePersistedLockPath(lock.filePath))));

      if (conflicts.length > 0) {
        this.db.exec('ROLLBACK');
        return { acquired: false, locks: [], conflicts, violations: [] };
      }

      const now = new Date().toISOString();
      const insert = this.db.prepare(
        'INSERT INTO path_locks (id, run_id, task_id, file_path, lock_type, status, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const selectById = this.db.prepare('SELECT * FROM path_locks WHERE id = ?');
      const relock = this.db.prepare('UPDATE path_locks SET status = ?, acquired_at = ?, released_at = NULL, lock_type = ?, file_path = ? WHERE id = ?');
      const existingByPath = new Map(
        activeLocks
          .filter((lock) => lock.taskId === input.taskId)
          .map((lock) => [this.normalizePersistedLockPath(lock.filePath), lock]),
      );
      const locks: PathLockRecord[] = [];

      for (const filePath of normalized) {
        const existing = existingByPath.get(filePath);
        if (existing) {
          locks.push(existing);
          continue;
        }
        const id = this.createDeterministicLockId(input.runId, input.taskId, filePath);
        const oldRow = selectById.get(id) as Record<string, unknown> | undefined;
        if (oldRow) {
          const old = mapRowToPathLockRecord(oldRow);
          if (old.runId !== input.runId || old.taskId !== input.taskId) {
            this.db.exec('ROLLBACK');
            return { acquired: false, locks: [], conflicts: [old], violations: [] };
          }
          relock.run('locked', now, input.lockType || 'exclusive', filePath, id);
          locks.push({
            ...old,
            filePath,
            lockType: (input.lockType || 'exclusive') as any,
            status: 'locked' as any,
            acquiredAt: now,
            releasedAt: null,
          });
          continue;
        }
        insert.run(id, input.runId, input.taskId, filePath, input.lockType || 'exclusive', 'locked', now);
        locks.push({
          id,
          runId: input.runId,
          taskId: input.taskId,
          filePath,
          lockType: (input.lockType || 'exclusive') as any,
          status: 'locked' as any,
          acquiredAt: now,
          releasedAt: null,
        });
      }

      this.db.exec('COMMIT');
      return { acquired: true, locks, conflicts: [], violations: [] };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  async claimActualPathsAtomic(input: ClaimActualPathsInput): Promise<ClaimActualPathsResult> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = claimActualPathsInOpenTransaction(this.db, input);
      if (!result.claimed) {
        this.db.exec('ROLLBACK');
        return result;
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async listActualPathClaims(stageId: string): Promise<ActualPathClaimRecord[]> {
    const rows = this.db.prepare('SELECT * FROM actual_path_claims WHERE stage_id = ? ORDER BY created_at, normalized_path')
      .all(stageId) as Record<string, unknown>[];
    return rows.map(mapActualPathClaimRow);
  }

  async releaseActualPathClaimsForStage(stageId: string, releasedAt: string): Promise<number> {
    const result = this.db.prepare('UPDATE actual_path_claims SET released_at = ? WHERE stage_id = ? AND released_at IS NULL')
      .run(releasedAt, stageId);
    return Number(result.changes);
  }

  async getPathLock(lockId: string): Promise<PathLockRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM path_locks WHERE id = ?');
    const row = stmt.get(lockId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToPathLockRecord(row);
  }

  async releasePathLock(lockId: string, releasedAt: string): Promise<boolean> {
    const stmt = this.db.prepare('UPDATE path_locks SET status = ?, released_at = ? WHERE id = ?');
    stmt.run('released', releasedAt, lockId);
    return true;
  }

  async getActiveLocksForRun(runId: string): Promise<PathLockRecord[]> {
    const stmt = this.db.prepare(
      "SELECT * FROM path_locks WHERE run_id = ? AND status = 'locked' ORDER BY acquired_at ASC"
    );
    const rows = stmt.all(runId) as Record<string, unknown>[];
    return rows.map(mapRowToPathLockRecord);
  }

  async getConflictingLocks(taskId: string, filePaths: string[], runId: string): Promise<PathLockRecord[]> {
    if (filePaths.length === 0) return [];
    const violations: string[] = [];
    const normalized = this.normalizeLockPaths(filePaths, violations);
    const rows = this.db.prepare(
      "SELECT * FROM path_locks WHERE run_id = ? AND status = 'locked' AND task_id != ?"
    ).all(runId, taskId) as Record<string, unknown>[];
    const locks = rows.map(mapRowToPathLockRecord);
    if (violations.length > 0) return locks;
    return locks.filter((lock) => normalized.some((filePath) => this.lockPathsOverlap(filePath, this.normalizePersistedLockPath(lock.filePath))));
  }

  private normalizeLockPaths(filePaths: string[], violations: string[]): string[] {
    const normalized = new Set<string>();
    for (const filePath of filePaths) {
      const result = this.normalizeLockPath(filePath);
      if (result.ok) normalized.add(result.path);
      else violations.push(`Unsafe lock path '${filePath}': ${result.reason}`);
    }
    return Array.from(normalized).sort();
  }

  private normalizeLockPath(filePath: string): { ok: true; path: string } | { ok: false; reason: string } {
    const raw = String(filePath || '').replace(/\\/g, '/').trim();
    if (!raw) return { ok: false, reason: 'empty path' };
    if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('//')) {
      return { ok: false, reason: 'absolute path is forbidden' };
    }
    const parts = raw.split('/').filter((part) => part.length > 0 && part !== '.');
    if (parts.includes('..')) return { ok: false, reason: '.. escape is forbidden' };
    if (parts.length === 0) return { ok: false, reason: 'empty path' };
    return { ok: true, path: parts.join('/').toLowerCase() };
  }

  private normalizePersistedLockPath(filePath: string): string {
    const result = this.normalizeLockPath(filePath);
    return result.ok ? result.path : String(filePath).replace(/\\/g, '/').toLowerCase();
  }

  private lockPathsOverlap(left: string, right: string): boolean {
    if (left === right) return true;
    const leftPrefix = left.endsWith('/') ? left : left + '/';
    const rightPrefix = right.endsWith('/') ? right : right + '/';
    return left.startsWith(rightPrefix) || right.startsWith(leftPrefix);
  }

  private createDeterministicLockId(runId: string, taskId: string, filePath: string): string {
    // SHA-256 of the normalized path. The old lossy replacement of every
    // non-alphanumeric char (`/`, `.`, `-` → `_`) let distinct paths such as
    // `src/api-v2/x` and `src/api_v2/x` collide onto the same lock row id,
    // silently dropping the first-layer lock for one of them. filePath is
    // already normalized (lowercase, slash-joined) by normalizeLockPaths.
    // MUST stay byte-identical with StageScheduler.expectedLockId and
    // recover.ts lockId, or verifyResumeLocks misjudges every lock.
    return runId + '-lk-' + taskId + '-' + sha256Hex(filePath);
  }

  // ══════════════════════════════════════════════════════════════
  // Review operations
  // ══════════════════════════════════════════════════════════════

  async createReview(input: CreateReviewInput): Promise<ReviewRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO reviews (id, attempt_id, task_id, reviewer_type, status, rework_count, merge_allowed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run(input.id, input.attemptId, input.taskId, input.reviewerType, input.status || 'pending', 0, 0, now);
    return {
      id: input.id, attemptId: input.attemptId, taskId: input.taskId,
      reviewerType: input.reviewerType, status: (input.status || 'pending') as any,
      reviewJson: null, findingsJson: null, requiredReworkJson: null,
      reworkCount: 0, mergeAllowed: false, startedAt: null, finishedAt: null,
      reviewedThroughCommit: null, finalCommit: null, coverageStatus: 'partial',
      reviewerUnavailable: false, errorCategory: null, exitCode: null,
      durationMs: null, stderrHash: null, createdAt: now,
    };
  }

  async getReview(reviewId: string): Promise<ReviewRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM reviews WHERE id = ?');
    const row = stmt.get(reviewId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToReviewRecord(row);
  }

  async updateReviewResult(reviewId: string, u: Partial<Pick<ReviewRecord, 'status' | 'reviewJson' | 'findingsJson' | 'requiredReworkJson' | 'reworkCount' | 'mergeAllowed' | 'startedAt' | 'finishedAt' | 'reviewedThroughCommit' | 'finalCommit' | 'coverageStatus' | 'reviewerUnavailable' | 'errorCategory' | 'exitCode' | 'durationMs' | 'stderrHash'>>): Promise<boolean> {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(u)) {
      if (value !== undefined) {
        const dbKey = key === 'mergeAllowed' ? 'merge_allowed' : key.replace(/([A-Z])/g, '_$1').toLowerCase();
        sets.push(dbKey + ' = ?');
        values.push(value === true ? 1 : value === false ? 0 : value);
      }
    }
    if (sets.length === 0) return false;
    values.push(reviewId);
    const stmt = this.db.prepare('UPDATE reviews SET ' + sets.join(', ') + ' WHERE id = ?');
    stmt.run(...values);
    return true;
  }

  async listReviewsByAttempt(attemptId: string): Promise<ReviewRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM reviews WHERE attempt_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(attemptId) as Record<string, unknown>[];
    return rows.map(mapRowToReviewRecord);
  }

  async listReviewsByTask(taskId: string): Promise<ReviewRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM reviews WHERE task_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(taskId) as Record<string, unknown>[];
    return rows.map(mapRowToReviewRecord);
  }

  // ══════════════════════════════════════════════════════════════
  // Integration batch operations
  // ══════════════════════════════════════════════════════════════

  async createIntegrationBatch(input: CreateIntegrationBatchInput): Promise<IntegrationBatchRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO integration_batches (id, stage_id, run_id, status, integration_branch, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    stmt.run(input.id, input.stageId, input.runId, 'pending', input.integrationBranch, now);
    return {
      id: input.id, stageId: input.stageId, runId: input.runId,
      status: 'pending' as any, integrationBranch: input.integrationBranch,
      baseCommit: null, mergeCommitHash: null, targetMergeCommit: null, conflictsJson: null,
      createdAt: now, finishedAt: null, reviewedThroughCommit: null, finalCommit: null,
      reviewCoverageStatus: 'partial', reviewerUnavailable: false, reviewMetadataJson: null,
    };
  }

  async getIntegrationBatch(batchId: string): Promise<IntegrationBatchRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM integration_batches WHERE id = ?');
    const row = stmt.get(batchId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToIntegrationBatchRecord(row);
  }

  async updateIntegrationBatch(batchId: string, u: Partial<Pick<IntegrationBatchRecord, 'status' | 'baseCommit' | 'mergeCommitHash' | 'targetMergeCommit' | 'conflictsJson' | 'finishedAt' | 'reviewedThroughCommit' | 'finalCommit' | 'reviewCoverageStatus' | 'reviewerUnavailable' | 'reviewMetadataJson'>>): Promise<boolean> {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(u)) {
      if (value !== undefined) {
        const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        sets.push(dbKey + ' = ?');
        values.push(value === true ? 1 : value === false ? 0 : value);
      }
    }
    if (sets.length === 0) return false;
    values.push(batchId);
    const stmt = this.db.prepare('UPDATE integration_batches SET ' + sets.join(', ') + ' WHERE id = ?');
    stmt.run(...values);
    return true;
  }

  async listIntegrationBatches(stageId: string): Promise<IntegrationBatchRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM integration_batches WHERE stage_id = ? ORDER BY created_at ASC');
    const rows = stmt.all(stageId) as Record<string, unknown>[];
    return rows.map(mapRowToIntegrationBatchRecord);
  }

  // ══════════════════════════════════════════════════════════════
  // Event operations
  // ══════════════════════════════════════════════════════════════

  async createEvent(input: CreateEventInput): Promise<EventRecord> {
    const now = new Date().toISOString();
    // ── Privacy: sanitize event data and set privacy_profile ──
    let eventDataJson: string | null = null;
    let privacyProfile: string | null = null;
    if (input.eventData) {
      if (this.privacyService) {
        const sanitized = this.privacyService.summarizeEvent(input.eventData);
        eventDataJson = JSON.stringify(sanitized);
        privacyProfile = this.privacyService.profile.profile;
      } else {
        eventDataJson = JSON.stringify(input.eventData);
      }
    }
    // Check if privacy_profile column exists
    const eventColumns = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    const hasPrivacyProfileCol = eventColumns.some((column) => column.name === 'privacy_profile');
    if (hasPrivacyProfileCol) {
      const stmt = this.db.prepare(
        'INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, privacy_profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      stmt.run(
        input.id, input.runId, input.stageId || null, input.taskId || null,
        input.attemptId || null, input.eventType,
        eventDataJson, privacyProfile, now,
      );
    } else {
      const stmt = this.db.prepare(
        'INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      stmt.run(
        input.id, input.runId, input.stageId || null, input.taskId || null,
        input.attemptId || null, input.eventType,
        eventDataJson, now,
      );
    }
    return {
      id: input.id, runId: input.runId, stageId: input.stageId || null,
      taskId: input.taskId || null, attemptId: input.attemptId || null,
      eventType: input.eventType, eventDataJson,
      createdAt: now,
    };
  }

  async listEvents(runId: string, eventType?: string): Promise<EventRecord[]> {
    let rows: Record<string, unknown>[];
    if (eventType) {
      const stmt = this.db.prepare('SELECT * FROM events WHERE run_id = ? AND event_type = ? ORDER BY created_at ASC');
      rows = stmt.all(runId, eventType) as Record<string, unknown>[];
    } else {
      const stmt = this.db.prepare('SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC');
      rows = stmt.all(runId) as Record<string, unknown>[];
    }
    return rows.map(mapRowToEventRecord);
  }

  // ══════════════════════════════════════════════════════════════
  // M3 Resource Sample operations
  // ══════════════════════════════════════════════════════════════

  async insertResourceSample(input: CreateResourceSampleInput): Promise<ResourceSampleRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO resource_samples
       (id, run_id, timestamp, cpu_pct, mem_total_mb, mem_used_mb, mem_pct,
        pi_active, budget, dispatch_paused, pause_reason,
        degraded, degrade_reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      input.id,
      input.runId || null,
      input.timestamp,
      input.cpuPct,
      input.memTotalMb ?? null,
      input.memUsedMb ?? null,
      input.memPct ?? null,
      input.piActive,
      input.budget,
      input.dispatchPaused ?? 0,
      input.pauseReason || null,
      input.degraded ?? 0,
      input.degradeReason || null,
      input.source,
      now,
    );
    return {
      id: input.id,
      runId: input.runId || null,
      timestamp: input.timestamp,
      cpuPct: input.cpuPct,
      memTotalMb: input.memTotalMb ?? null,
      memUsedMb: input.memUsedMb ?? null,
      memPct: input.memPct ?? null,
      piActive: input.piActive,
      budget: input.budget,
      dispatchPaused: input.dispatchPaused ?? 0,
      pauseReason: input.pauseReason || null,
      degraded: input.degraded ?? 0,
      degradeReason: input.degradeReason || null,
      source: input.source,
      createdAt: now,
    };
  }

  async getRecentResourceSamples(limit = 20): Promise<ResourceSampleRecord[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM resource_samples ORDER BY created_at DESC LIMIT ?'
    );
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map(mapRowToResourceSampleRecord);
  }

  async cleanupResourceSamples(retentionDays = 7): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString();
    const stmt = this.db.prepare(
      'DELETE FROM resource_samples WHERE created_at < ?'
    );
    const result = stmt.run(cutoffStr);
    return typeof result.changes === 'number' ? result.changes : 0;
  }

  // ══════════════════════════════════════════════════════════════
  // M3 Dispatch Decision operations
  // ══════════════════════════════════════════════════════════════

  async insertDispatchDecision(input: CreateDispatchDecisionInput): Promise<DispatchDecisionRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO dispatch_decisions
       (id, run_id, timestamp, decision_type, reason, previous_budget, new_budget, sample_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      input.id,
      input.runId || null,
      input.timestamp,
      input.decisionType,
      input.reason,
      input.previousBudget,
      input.newBudget,
      input.sampleJson || null,
      now,
    );
    return {
      id: input.id,
      runId: input.runId || null,
      timestamp: input.timestamp,
      decisionType: input.decisionType,
      reason: input.reason,
      previousBudget: input.previousBudget,
      newBudget: input.newBudget,
      sampleJson: input.sampleJson || null,
      createdAt: now,
    };
  }

  async getRecentDispatchDecisions(limit = 20): Promise<DispatchDecisionRecord[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM dispatch_decisions ORDER BY created_at DESC LIMIT ?'
    );
    const rows = stmt.all(limit) as Record<string, unknown>[];
    return rows.map(mapRowToDispatchDecisionRecord);
  }

  // ══════════════════════════════════════════════════════════════
  // M4 Approval Decision operations
  // ══════════════════════════════════════════════════════════════

  async createApprovalDecision(input: CreateApprovalDecisionInput): Promise<ApprovalDecision> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO approval_decisions
       (id, run_id, gate, decision_type, scope, status, approved_by, expires_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      input.id, input.runId, input.gate, input.decisionType, input.scope,
      input.status || 'pending', input.approvedBy || 'user',
      input.expiresAt || null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now, now,
    );
    return {
      id: input.id, runId: input.runId, gate: input.gate as ApprovalDecision['gate'],
      decisionType: input.decisionType as ApprovalDecision['decisionType'],
      scope: input.scope as ApprovalDecision['scope'],
      status: (input.status || 'pending') as ApprovalDecision['status'],
      approvedBy: (input.approvedBy || 'user') as ApprovalDecision['approvedBy'],
      approvedAt: null, expiresAt: input.expiresAt || null,
      revokedAt: null, revokeReason: null,
      metadata: input.metadata || {},
      createdAt: now, updatedAt: now,
    };
  }

  async getApprovalDecision(id: string): Promise<ApprovalDecision | null> {
    const stmt = this.db.prepare('SELECT * FROM approval_decisions WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToApprovalDecision(row);
  }

  async updateApprovalDecisionStatus(id: string, status: string, updatedAt: string): Promise<boolean> {
    const existing = await this.getApprovalDecision(id);
    if (!existing) return false;
    const stmt = this.db.prepare(
      'UPDATE approval_decisions SET status = ?, updated_at = ? WHERE id = ?'
    );
    stmt.run(status, updatedAt, id);
    return true;
  }

  async listApprovalDecisions(runId: string, status?: string): Promise<ApprovalDecision[]> {
    let rows: Record<string, unknown>[];
    if (status) {
      const stmt = this.db.prepare(
        'SELECT * FROM approval_decisions WHERE run_id = ? AND status = ? ORDER BY created_at ASC'
      );
      rows = stmt.all(runId, status) as Record<string, unknown>[];
    } else {
      const stmt = this.db.prepare(
        'SELECT * FROM approval_decisions WHERE run_id = ? ORDER BY created_at ASC'
      );
      rows = stmt.all(runId) as Record<string, unknown>[];
    }
    return rows.map(mapRowToApprovalDecision);
  }

  async getPendingApprovals(runId: string): Promise<ApprovalDecision[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM approval_decisions WHERE run_id = ? AND status = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(runId, 'pending') as Record<string, unknown>[];
    return rows.map(mapRowToApprovalDecision);
  }

  // ══════════════════════════════════════════════════════════════
  // M4 Token Ledger operations
  // ══════════════════════════════════════════════════════════════

  async insertTokenLedgerEntry(input: CreateTokenLedgerEntryInput): Promise<TokenLedgerEntry> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO token_ledger
       (id, run_id, stage_id, task_id, attempt_id, call_type, call_id,
        estimated_total, estimated_input, estimated_output,
        actual_total, actual_input, actual_output, actual_cache_hit,
        prompt_hash, model, duration_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      input.id, input.runId, input.stageId || null, input.taskId || null,
      input.attemptId || null, input.callType, input.callId,
      input.estimatedTotal ?? null, input.estimatedInput ?? null, input.estimatedOutput ?? null,
      input.actualTotal ?? null, input.actualInput ?? null, input.actualOutput ?? null,
      input.actualCacheHit ?? null,
      input.promptHash || null, input.model || null, input.durationMs ?? null,
      input.status || 'estimated', now,
    );
    return {
      id: input.id, runId: input.runId,
      stageId: input.stageId || null, taskId: input.taskId || null, attemptId: input.attemptId || null,
      callType: input.callType as TokenLedgerEntry['callType'], callId: input.callId,
      estimatedTotal: input.estimatedTotal ?? null,
      estimatedInput: input.estimatedInput ?? null,
      estimatedOutput: input.estimatedOutput ?? null,
      actualTotal: input.actualTotal ?? null,
      actualInput: input.actualInput ?? null,
      actualOutput: input.actualOutput ?? null,
      actualCacheHit: input.actualCacheHit ?? null,
      promptHash: input.promptHash || null,
      model: input.model || null,
      durationMs: input.durationMs ?? null,
      isSynthetic: false,
      status: (input.status || 'estimated') as TokenLedgerEntry['status'],
      createdAt: now,
    };
  }

  async updateTokenLedgerEntry(id: string, updates: Partial<Pick<TokenLedgerEntry, 'status' | 'actualTotal' | 'actualInput' | 'actualOutput' | 'actualCacheHit' | 'model' | 'durationMs'>>): Promise<boolean> {
    const existing = await this.getTokenLedgerEntry(id);
    if (!existing) return false;
    const sets: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        sets.push(col + ' = ?');
        values.push(value);
      }
    }
    if (sets.length === 0) return false;
    values.push(id);
    const stmt = this.db.prepare('UPDATE token_ledger SET ' + sets.join(', ') + ' WHERE id = ?');
    stmt.run(...values);
    return true;
  }

  async getTokenLedgerEntry(id: string): Promise<TokenLedgerEntry | null> {
    const stmt = this.db.prepare('SELECT * FROM token_ledger WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToTokenLedgerEntry(row);
  }

  async listTokenLedgerEntries(runId: string, callType?: string): Promise<TokenLedgerEntry[]> {
    let rows: Record<string, unknown>[];
    if (callType) {
      const stmt = this.db.prepare(
        'SELECT * FROM token_ledger WHERE run_id = ? AND call_type = ? ORDER BY created_at ASC'
      );
      rows = stmt.all(runId, callType) as Record<string, unknown>[];
    } else {
      const stmt = this.db.prepare(
        'SELECT * FROM token_ledger WHERE run_id = ? ORDER BY created_at ASC'
      );
      rows = stmt.all(runId) as Record<string, unknown>[];
    }
    return rows.map(mapRowToTokenLedgerEntry);
  }

  async getTokenUsageSummary(runId: string): Promise<TokenUsageSummary> {
    const entries = await this.listTokenLedgerEntries(runId);
    const summary: TokenUsageSummary = {
      codexPlan: { estimated: 0, actual: 0 },
      codexReview: { estimated: 0, actual: 0 },
      piWorker: { estimated: 0, actual: 0 },
      totalEstimated: 0,
      totalActual: 0,
    };

    // Per-entry effective usage — each entry contributes exactly once.
    // Confirmed → actualTotal (confirmed value).
    // Estimated/unavailable → estimatedTotal (conservative estimate).
    for (const e of entries) {
      const isConfirmed = e.status === 'confirmed' && e.actualTotal != null;
      const effective = isConfirmed ? (e.actualTotal ?? 0) : (e.estimatedTotal ?? 0);

      const target = e.callType === 'codex_plan' ? summary.codexPlan
        : e.callType === 'codex_review' ? summary.codexReview
        : summary.piWorker;

      if (isConfirmed) {
        target.actual += effective;
        summary.totalActual += effective;
      } else {
        target.estimated += effective;
        summary.totalEstimated += effective;
      }
    }

    return summary;
  }

  async reserveCost(input: import('./state-store.js').CreateCostReservationInput): Promise<import('./state-store.js').CostReservationResult> {
    if (!(input.budgetLimit > 0) || !(input.reservedCost > 0)) {
      throw new Error('cost budget and reservation must be positive');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT COALESCE(SUM(CASE
          WHEN status = 'confirmed' AND actual_cost IS NOT NULL THEN actual_cost
          WHEN status IN ('reserved', 'unavailable') THEN reserved_cost
          ELSE 0 END), 0) AS committed
        FROM cost_reservations WHERE run_id = ?
      `).get(input.runId) as Record<string, unknown>;
      const committedCost = Number(row.committed ?? 0);
      const remaining = Math.max(0, input.budgetLimit - committedCost);
      if (input.reservedCost > remaining + 1e-9) {
        this.db.exec('ROLLBACK');
        return { allowed: false, reservation: null, committedCost, remaining,
          reason: `cost_budget_exceeded: ${input.reservedCost} requested, ${remaining} remaining` };
      }
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO cost_reservations
          (id, run_id, stage_id, task_id, attempt_id, call_type, call_id, currency,
           budget_limit, reserved_cost, status, pricing_version, usage_status,
           phase, owner_id, lease_expires_at, heartbeat_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, 'pending',
                'reserved', ?, ?, ?, ?, ?)
      `).run(input.id, input.runId, input.stageId ?? null, input.taskId ?? null,
        input.attemptId ?? null, input.callType, input.callId, input.currency,
        input.budgetLimit, input.reservedCost, input.pricingVersion,
        input.ownerId ?? null, input.leaseExpiresAt ?? null, input.heartbeatAt ?? now, now, now);
      this.db.exec('COMMIT');
      const inserted = this.db.prepare('SELECT * FROM cost_reservations WHERE id = ?').get(input.id) as Record<string, unknown>;
      return { allowed: true, reservation: mapRowToCostReservation(inserted),
        committedCost: committedCost + input.reservedCost,
        remaining: Math.max(0, remaining - input.reservedCost) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async settleCostReservation(id: string, actualCost: number | null): Promise<boolean> {
    return this.finalizeCostReservation({
      id,
      outcome: actualCost == null ? 'unavailable' : 'confirmed',
      actualCost,
      terminationEvidence: actualCost == null ? 'provider_cost_unavailable' : 'trusted_actual_cost',
    });
  }

  async markCostReservationSpawned(id: string, ownerId: string, spawnedAt: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE cost_reservations
      SET phase = 'spawned', spawned_at = ?, heartbeat_at = ?, updated_at = ?
      WHERE id = ? AND status = 'reserved' AND phase = 'reserved'
        AND (owner_id IS NULL OR owner_id = ?)
    `).run(spawnedAt, spawnedAt, spawnedAt, id, ownerId);
    return Number(result.changes) === 1;
  }

  async heartbeatCostReservation(
    id: string,
    ownerId: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE cost_reservations SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'reserved' AND (owner_id IS NULL OR owner_id = ?)
    `).run(heartbeatAt, leaseExpiresAt, heartbeatAt, id, ownerId);
    return Number(result.changes) === 1;
  }

  async finalizeCostReservation(
    input: import('./state-store.js').FinalizeCostReservationInput,
  ): Promise<boolean> {
    if (!input.terminationEvidence.trim()) {
      throw new Error('termination evidence is required');
    }
    if (input.outcome === 'confirmed'
      && (input.actualCost == null || !Number.isFinite(input.actualCost) || input.actualCost < 0)) {
      throw new Error('actual cost must be a finite non-negative number');
    }
    if (input.actualCost != null && (!Number.isFinite(input.actualCost) || input.actualCost < 0)) {
      throw new Error('actual cost must be a finite non-negative number');
    }

    const settledAt = input.settledAt ?? new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const reservation = this.db.prepare(
        'SELECT * FROM cost_reservations WHERE id = ? AND status = ?'
      ).get(input.id, 'reserved') as Record<string, unknown> | undefined;
      if (!reservation) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (reservation.owner_id && input.ownerId && String(reservation.owner_id) !== input.ownerId) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (input.outcome === 'released' && reservation.spawned_at != null) {
        this.db.exec('ROLLBACK');
        return false;
      }

      const usageStatus = input.outcome === 'confirmed'
        ? 'confirmed'
        : input.outcome === 'unavailable' ? 'unavailable' : 'pending';
      const result = this.db.prepare(`
        UPDATE cost_reservations
        SET status = ?, usage_status = ?, actual_cost = ?, phase = 'settled',
            termination_evidence = ?, settled_at = ?, updated_at = ?
        WHERE id = ? AND status = 'reserved'
      `).run(
        input.outcome,
        usageStatus,
        input.outcome === 'confirmed' ? input.actualCost : null,
        input.terminationEvidence,
        settledAt,
        settledAt,
        input.id,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }

      const eventData = JSON.stringify({
        reservationId: input.id,
        outcome: input.outcome,
        terminationEvidence: input.terminationEvidence,
      });
      const hasPrivacyProfile = (this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
        .some((column) => column.name === 'privacy_profile');
      const eventId = `${input.id}-settled-${Date.now()}`;
      if (hasPrivacyProfile) {
        this.db.prepare(`
          INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, privacy_profile, created_at)
          VALUES (?, ?, ?, ?, ?, 'cost_reservation_settled', ?, NULL, ?)
        `).run(eventId, reservation.run_id, reservation.stage_id ?? null, reservation.task_id ?? null,
          reservation.attempt_id ?? null, eventData, settledAt);
      } else {
        this.db.prepare(`
          INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
          VALUES (?, ?, ?, ?, ?, 'cost_reservation_settled', ?, ?)
        `).run(eventId, reservation.run_id, reservation.stage_id ?? null, reservation.task_id ?? null,
          reservation.attempt_id ?? null, eventData, settledAt);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  /**
   * R2: manual, explicit, auditable write-off of an `unavailable` reservation.
   *
   * Semantics: "money may have been spent, but the user decided it no longer
   * occupies the budget". This is DISTINCT from `released` (which proves no
   * money was spent). Only `status='unavailable'` may be written off;
   * `reserved`/`spawned` are refused so a live call can never be written off.
   * A non-blank decision note is mandatory (fail closed), and the amount,
   * note, time and reservation id are persisted as an auditable event.
   */
  async writeOffCostReservation(input: import('./state-store.js').WriteOffCostReservationInput): Promise<boolean> {
    const note = typeof input.decisionNote === 'string' ? input.decisionNote.trim() : '';
    if (!note) {
      throw new Error('write-off requires --decision-note (explicit auditable decision)');
    }
    const settledAt = input.writtenOffAt ?? new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const reservation = this.db.prepare(
        'SELECT * FROM cost_reservations WHERE id = ?'
      ).get(input.id) as Record<string, unknown> | undefined;
      if (!reservation) {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (String(reservation.status) !== 'unavailable') {
        this.db.exec('ROLLBACK');
        return false;
      }
      if (reservation.owner_id && input.ownerId && String(reservation.owner_id) !== input.ownerId) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const result = this.db.prepare(`
        UPDATE cost_reservations
        SET status = 'written_off', usage_status = 'unavailable', phase = 'settled',
            termination_evidence = 'manual_write_off', settled_at = ?, updated_at = ?
        WHERE id = ? AND status = 'unavailable'
      `).run(settledAt, settledAt, input.id);
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return false;
      }

      const eventData = JSON.stringify({
        reservationId: input.id,
        outcome: 'written_off',
        decisionNote: note,
        writtenOffAmount: Number(reservation.reserved_cost ?? 0),
        settledAt,
      });
      const hasPrivacyProfile = (this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
        .some((column) => column.name === 'privacy_profile');
      const eventId = `${input.id}-written-off-${Date.now()}`;
      if (hasPrivacyProfile) {
        this.db.prepare(`
          INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, privacy_profile, created_at)
          VALUES (?, ?, ?, ?, ?, 'cost_reservation_written_off', ?, NULL, ?)
        `).run(eventId, reservation.run_id, reservation.stage_id ?? null, reservation.task_id ?? null,
          reservation.attempt_id ?? null, eventData, settledAt);
      } else {
        this.db.prepare(`
          INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
          VALUES (?, ?, ?, ?, ?, 'cost_reservation_written_off', ?, ?)
        `).run(eventId, reservation.run_id, reservation.stage_id ?? null, reservation.task_id ?? null,
          reservation.attempt_id ?? null, eventData, settledAt);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  async reconcileStaleCostReservations(runId: string, now: string): Promise<number> {
    const stale = this.db.prepare(`
      SELECT * FROM cost_reservations
      WHERE run_id = ? AND status = 'reserved' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      ORDER BY created_at ASC
    `).all(runId, now) as Record<string, unknown>[];
    let settled = 0;
    for (const reservation of stale) {
      let ownerInactive = false;
      if (reservation.attempt_id) {
        const attempt = this.db.prepare('SELECT status FROM task_attempts WHERE id = ?')
          .get(reservation.attempt_id) as { status: string } | undefined;
        ownerInactive = !attempt || ['approved', 'failed', 'interrupted', 'canceled'].includes(attempt.status);
      } else {
        const run = this.db.prepare('SELECT status FROM runs WHERE id = ?')
          .get(runId) as { status: string } | undefined;
        ownerInactive = !run || ['completed', 'failed', 'canceled'].includes(run.status);
      }
      const provablyNeverSpawned = reservation.spawned_at == null && String(reservation.phase) === 'reserved';
      const outcome = provablyNeverSpawned && ownerInactive ? 'released' : 'unavailable';
      const changed = await this.finalizeCostReservation({
        id: String(reservation.id),
        outcome,
        ownerId: reservation.owner_id ? String(reservation.owner_id) : null,
        terminationEvidence: outcome === 'released'
          ? 'expired_lease_owner_inactive_no_spawn_evidence'
          : 'expired_lease_spawn_or_owner_state_unknown',
        settledAt: now,
      });
      if (changed) settled++;
    }
    return settled;
  }

  async listCostReservations(runId: string): Promise<import('../types/m4-types.js').CostReservation[]> {
    try {
      const rows = this.db.prepare('SELECT * FROM cost_reservations WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Record<string, unknown>[];
      return rows.map(mapRowToCostReservation);
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) return [];
      throw error;
    }
  }

  // ── B: persistent guard block-probe cache (keyed by full Pi CLI version) ──
  async getGuardProbeCache(piVersion: string): Promise<{ outcome: string; failureCategory: string | null; checkedAt: string } | null> {
    try {
      const row = this.db.prepare(
        'SELECT outcome, failure_category, checked_at FROM pi_guard_probe_cache WHERE pi_version = ?'
      ).get(piVersion) as { outcome: string; failure_category: string | null; checked_at: string } | undefined;
      if (!row) return null;
      return { outcome: row.outcome, failureCategory: row.failure_category, checkedAt: row.checked_at };
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) return null;
      throw error;
    }
  }

  async setGuardProbeCache(piVersion: string, outcome: string, failureCategory: string | null, checkedAt: string): Promise<void> {
    try {
      this.db.prepare(`
        INSERT INTO pi_guard_probe_cache (pi_version, outcome, failure_category, checked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(pi_version) DO UPDATE SET outcome = excluded.outcome, failure_category = excluded.failure_category, checked_at = excluded.checked_at
      `).run(piVersion, outcome, failureCategory, checkedAt);
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) return;
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════
  // M4 Budget Policy operations
  // ══════════════════════════════════════════════════════════════

  async createBudgetPolicy(input: CreateBudgetPolicyInput): Promise<BudgetPolicy> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO budget_policies
       (id, run_id, scope, policy_type, token_limit, action_on_exceed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      input.id, input.runId || null, input.scope, input.policyType,
      input.tokenLimit, input.actionOnExceed || 'pause', now, now,
    );
    return {
      id: input.id, runId: input.runId || null,
      scope: input.scope as BudgetPolicy['scope'],
      policyType: input.policyType as BudgetPolicy['policyType'],
      tokenLimit: input.tokenLimit,
      actionOnExceed: (input.actionOnExceed || 'pause') as BudgetPolicy['actionOnExceed'],
      createdAt: now, updatedAt: now,
    };
  }

  async getBudgetPolicy(id: string): Promise<BudgetPolicy | null> {
    const stmt = this.db.prepare('SELECT * FROM budget_policies WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToBudgetPolicy(row);
  }

  async updateBudgetPolicy(id: string, tokenLimit: number, action: string): Promise<boolean> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE budget_policies SET token_limit = ?, action_on_exceed = ?, updated_at = ? WHERE id = ?'
    );
    stmt.run(tokenLimit, action, now, id);
    return true;
  }

  async listBudgetPolicies(runId?: string | null): Promise<BudgetPolicy[]> {
    let rows: Record<string, unknown>[];
    if (runId === undefined) {
      // List all
      const stmt = this.db.prepare('SELECT * FROM budget_policies ORDER BY created_at ASC');
      rows = stmt.all() as Record<string, unknown>[];
    } else if (runId === null) {
      // Global only
      const stmt = this.db.prepare('SELECT * FROM budget_policies WHERE run_id IS NULL ORDER BY created_at ASC');
      rows = stmt.all() as Record<string, unknown>[];
    } else {
      // Specific run + global
      const stmt = this.db.prepare(
        'SELECT * FROM budget_policies WHERE run_id = ? OR run_id IS NULL ORDER BY run_id NULLS LAST, created_at ASC'
      );
      rows = stmt.all(runId) as Record<string, unknown>[];
    }
    return rows.map(mapRowToBudgetPolicy);
  }

  async getEffectiveBudgetPolicy(policyType: string, runId?: string | null): Promise<BudgetPolicy | null> {
    // Priority: most recent per-run (run_id = specified run) > global (run_id IS NULL)
    if (runId) {
      const stmt = this.db.prepare(
        `SELECT * FROM budget_policies
         WHERE policy_type = ? AND (run_id = ? OR run_id IS NULL)
         ORDER BY CASE WHEN run_id IS NULL THEN 1 ELSE 0 END, created_at DESC, id DESC
         LIMIT 1`
      );
      const row = stmt.get(policyType, runId) as Record<string, unknown> | undefined;
      if (row) return mapRowToBudgetPolicy(row);
    }
    // Fallback: global only
    const stmt = this.db.prepare(
      'SELECT * FROM budget_policies WHERE policy_type = ? AND run_id IS NULL LIMIT 1'
    );
    const row = stmt.get(policyType) as Record<string, unknown> | undefined;
    return row ? mapRowToBudgetPolicy(row) : null;
  }

  // ══════════════════════════════════════════════════════════════
  // M4 Risk Assessment operations
  // ══════════════════════════════════════════════════════════════

  async createRiskAssessment(input: CreateRiskAssessmentInput): Promise<RiskAssessment> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO risk_assessments
       (id, run_id, stage_id, assessment_type, risk_level, findings_json, trigger, resolved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    );
    stmt.run(
      input.id, input.runId, input.stageId || null,
      input.assessmentType, input.riskLevel,
      input.findingsJson || null,
      input.trigger || 'auto',
      now,
    );
    return {
      id: input.id, runId: input.runId, stageId: input.stageId || null,
      assessmentType: input.assessmentType as RiskAssessment['assessmentType'],
      riskLevel: input.riskLevel as RiskAssessment['riskLevel'],
      findingsJson: input.findingsJson || null,
      trigger: (input.trigger || 'auto') as RiskAssessment['trigger'],
      resolved: false, resolvedAt: null,
      createdAt: now,
    };
  }

  async getRiskAssessment(id: string): Promise<RiskAssessment | null> {
    const stmt = this.db.prepare('SELECT * FROM risk_assessments WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToRiskAssessment(row);
  }

  async resolveRiskAssessment(id: string, resolvedAt: string): Promise<boolean> {
    const stmt = this.db.prepare(
      'UPDATE risk_assessments SET resolved = 1, resolved_at = ? WHERE id = ?'
    );
    stmt.run(resolvedAt, id);
    return true;
  }

  async listRiskAssessments(runId: string): Promise<RiskAssessment[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM risk_assessments WHERE run_id = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(runId) as Record<string, unknown>[];
    return rows.map(mapRowToRiskAssessment);
  }

  // ══════════════════════════════════════════════════════════════
  // M5 Reconciliation operations
  // ══════════════════════════════════════════════════════════════

  async insertReconciliationReport(input: CreateReconciliationReportInput): Promise<ReconciliationReportRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO reconciliation_reports
       (id, run_id, phase, initiated_by, total_findings, blocking_count,
        applied_count, skipped_count, summary_json, started_at, finished_at, created_at)
       VALUES (?, ?, 'applied', 'user_direct', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      input.id, input.runId,
      input.totalFindings, input.blockingCount, input.appliedCount, input.skippedCount,
      input.summaryJson, input.startedAt, input.finishedAt || null, now,
    );
    return {
      id: input.id,
      runId: input.runId,
      phase: 'applied',
      initiatedBy: 'user_direct',
      totalFindings: input.totalFindings,
      blockingCount: input.blockingCount,
      appliedCount: input.appliedCount,
      skippedCount: input.skippedCount,
      summaryJson: input.summaryJson,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt || null,
      createdAt: now,
    };
  }

  async getLatestReconciliationReport(runId: string): Promise<ReconciliationReportRecord | null> {
    const stmt = this.db.prepare(
      'SELECT * FROM reconciliation_reports WHERE run_id = ? ORDER BY created_at DESC LIMIT 1'
    );
    const row = stmt.get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRowToReconciliationReportRecord(row);
  }

  async insertReconciliationFinding(input: CreateReconciliationFindingInput): Promise<ReconciliationFindingRecord> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO reconciliation_findings
       (id, report_id, run_id, entity_type, entity_id, kind, severity, status,
        proposal, applied_action, evidence_hash, created_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      input.id, input.reportId, input.runId,
      input.entityType, input.entityId, input.kind, input.severity, input.status,
      input.proposal, input.appliedAction || null, input.evidenceHash,
      now, input.appliedAt || null,
    );
    return {
      id: input.id,
      reportId: input.reportId,
      runId: input.runId,
      entityType: input.entityType,
      entityId: input.entityId,
      kind: input.kind,
      severity: input.severity,
      status: input.status,
      proposal: input.proposal,
      appliedAction: input.appliedAction || null,
      evidenceHash: input.evidenceHash,
      createdAt: now,
      appliedAt: input.appliedAt || null,
    };
  }

  async listReconciliationFindings(reportId: string): Promise<ReconciliationFindingRecord[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM reconciliation_findings WHERE report_id = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(reportId) as Record<string, unknown>[];
    return rows.map(mapRowToReconciliationFindingRecord);
  }

  async listReconciliationReports(runId: string): Promise<ReconciliationReportRecord[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM reconciliation_reports WHERE run_id = ? ORDER BY created_at DESC'
    );
    const rows = stmt.all(runId) as Record<string, unknown>[];
    return rows.map(mapRowToReconciliationReportRecord);
  }

  async listNonTerminalRuns(): Promise<RunRecord[]> {
    const stmt = this.db.prepare(
      "SELECT * FROM runs WHERE status NOT IN ('completed', 'failed', 'canceled') ORDER BY created_at ASC"
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(mapRowToRunRecord);
  }

  // ══════════════════════════════════════════════════════════════
  // M5 Atomic Apply (single SQLite transaction)
  // ══════════════════════════════════════════════════════════════

  async applyReconciliationAtomically(input: AtomicApplyInput): Promise<AtomicApplyResult> {
    const now = new Date().toISOString();
    let appliedCount = 0;
    let skippedCount = 0;
    const appliedActions: AtomicApplyResult['appliedActions'] = [];

    // ── BEGIN IMMEDIATE transaction ──
    this.db.exec('BEGIN IMMEDIATE');

    try {
      // 1. Execute each safe action
      for (const action of input.actions) {
        const result = this.executeAtomicAction(action, now);
        appliedActions.push(result);
        if (result.success) appliedCount++;
        else skippedCount++;
      }

      // 2. Persist reconciliation report
      const reportStmt = this.db.prepare(
        `INSERT INTO reconciliation_reports
         (id, run_id, phase, initiated_by, total_findings, blocking_count,
          applied_count, skipped_count, summary_json, started_at, finished_at, created_at)
         VALUES (?, ?, 'applied', 'user_direct', ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      reportStmt.run(
        input.reportInput.id, input.reportInput.runId,
        input.reportInput.totalFindings, input.reportInput.blockingCount,
        input.reportInput.appliedCount, input.reportInput.skippedCount,
        input.reportInput.summaryJson, input.reportInput.startedAt,
        input.reportInput.finishedAt || null, now,
      );

      // 3. Persist findings
      for (const fi of input.findingInputs) {
        const findingStmt = this.db.prepare(
          `INSERT INTO reconciliation_findings
           (id, report_id, run_id, entity_type, entity_id, kind, severity, status,
            proposal, applied_action, evidence_hash, created_at, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        findingStmt.run(
          fi.id, fi.reportId, fi.runId,
          fi.entityType, fi.entityId, fi.kind, fi.severity, fi.status,
          fi.proposal, fi.appliedAction || null, fi.evidenceHash,
          now, fi.appliedAt || null,
        );
      }

      // 4. Persist events
      for (const ev of input.eventInputs) {
        const evStmt = this.db.prepare(
          `INSERT INTO events (id, run_id, stage_id, task_id, attempt_id, event_type, event_data_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        evStmt.run(
          ev.id, ev.runId, ev.stageId || null, ev.taskId || null,
          ev.attemptId || null, ev.eventType,
          ev.eventData ? JSON.stringify(ev.eventData) : null, now,
        );
      }

      // 5. COMMIT
      this.db.exec('COMMIT');

      // Re-read persisted records
      const reportRecordStmt = this.db.prepare(
        'SELECT * FROM reconciliation_reports WHERE id = ?'
      );
      const reportRow = reportRecordStmt.get(input.reportInput.id) as Record<string, unknown> | undefined;
      const reportRecord = reportRow ? mapRowToReconciliationReportRecord(reportRow) : {
        id: input.reportInput.id, runId: input.reportInput.runId,
        phase: 'applied' as const, initiatedBy: 'user_direct' as const,
        totalFindings: input.reportInput.totalFindings,
        blockingCount: input.reportInput.blockingCount,
        appliedCount: input.reportInput.appliedCount,
        skippedCount: input.reportInput.skippedCount,
        summaryJson: input.reportInput.summaryJson,
        startedAt: input.reportInput.startedAt,
        finishedAt: input.reportInput.finishedAt || null,
        createdAt: now,
      };

      const findingRowsStmt = this.db.prepare(
        'SELECT * FROM reconciliation_findings WHERE report_id = ? ORDER BY created_at ASC'
      );
      const findingRows = findingRowsStmt.all(input.reportInput.id) as Record<string, unknown>[];
      const findingRecords = findingRows.map(mapRowToReconciliationFindingRecord);

      const eventRows = input.eventInputs.map((ev, i) => ({
        id: ev.id, runId: ev.runId, stageId: ev.stageId || null,
        taskId: ev.taskId || null, attemptId: ev.attemptId || null,
        eventType: ev.eventType,
        eventDataJson: ev.eventData ? JSON.stringify(ev.eventData) : null,
        createdAt: now,
      }));

      return {
        reportRecord, findingRecords, eventRecords: eventRows,
        appliedActions, appliedCount, skippedCount,
      };
    } catch (err) {
      // ── ROLLBACK on any failure ──
      try { this.db.exec('ROLLBACK'); } catch { /* best effort */ }
      throw err;
    }
  }

  /**
   * Execute a single atomic action within the transaction.
   * Returns success/failure. Never throws.
   */
  private executeAtomicAction(
    action: AtomicApplyInput['actions'][0],
    now: string,
  ): { actionType: string; targetEntityId: string; success: boolean; error?: string } {
    try {
      switch (action.actionType) {
        case 'mark_attempt_interrupted': {
          const existing = this.db.prepare('SELECT status FROM task_attempts WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!existing) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Attempt not found' };
          const current = String(existing.status);
          if (current === 'interrupted') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
          if (['approved', 'failed', 'canceled'].includes(current)) {
            return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Attempt is terminal: ${current}` };
          }
          const changed = this.db.prepare(
            'UPDATE task_attempts SET status = ?, exit_reason = ?, stopped_at = ?, updated_at = ? WHERE id = ? AND status = ?'
          ).run('interrupted', `reconciled: ${action.metadata.reason || 'unknown'}`, now, now, action.targetEntityId, current);
          return Number(changed.changes) === 1
            ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
            : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Attempt status changed concurrently' };
        }

        case 'release_lock': {
          const lock = this.db.prepare('SELECT status FROM path_locks WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!lock) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Lock not found' };
          if (lock.status === 'released') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
          if (lock.status !== 'locked') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Unexpected lock status: ${String(lock.status)}` };
          const changed = this.db.prepare("UPDATE path_locks SET status = 'released', released_at = ? WHERE id = ? AND status = 'locked'")
            .run(now, action.targetEntityId);
          return Number(changed.changes) === 1
            ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
            : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Lock status changed concurrently' };
        }

        case 'mark_stage_paused': {
          const existing = this.db.prepare('SELECT status FROM stages WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!existing) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Stage not found' };
          const current = String(existing.status) as StageStatus;
          if (current === 'paused') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
          if (TERMINAL_STAGE_STATUSES.includes(current)) {
            return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Stage is terminal: ${current}` };
          }
          assertTransitionStage(current, 'paused');
          const changed = this.db.prepare("UPDATE stages SET status = 'paused', updated_at = ? WHERE id = ? AND status = ?")
            .run(now, action.targetEntityId, current);
          return Number(changed.changes) === 1
            ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
            : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Stage status changed concurrently' };
        }

        case 'mark_attempt_canceled': {
          const existing = this.db.prepare('SELECT status FROM task_attempts WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!existing) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Attempt not found' };
          const current = String(existing.status);
          if (current === 'canceled') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
          if (['approved', 'failed', 'interrupted'].includes(current)) {
            return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Attempt is terminal: ${current}` };
          }
          const changed = this.db.prepare(
            "UPDATE task_attempts SET status = 'canceled', exit_reason = ?, stopped_at = ?, updated_at = ? WHERE id = ? AND status = ?"
          ).run(`reconciled: ${action.metadata.reason || 'canceled_run_recovery'}`, now, now, action.targetEntityId, current);
          return Number(changed.changes) === 1
            ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
            : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Attempt status changed concurrently' };
        }

        case 'mark_stage_canceled': {
          const existing = this.db.prepare('SELECT status FROM stages WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!existing) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Stage not found' };
          const current = String(existing.status) as StageStatus;
          if (current === 'canceled') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
          if (TERMINAL_STAGE_STATUSES.includes(current)) {
            return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Stage is terminal: ${current}` };
          }
          assertTransitionStage(current, 'canceled');
          const changed = this.db.prepare("UPDATE stages SET status = 'canceled', updated_at = ? WHERE id = ? AND status = ?")
            .run(now, action.targetEntityId, current);
          return Number(changed.changes) === 1
            ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
            : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Stage status changed concurrently' };
        }

        case 'update_integration_batch_completed': {
          const batch = this.db.prepare('SELECT status FROM integration_batches WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!batch) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Integration batch not found' };
          const current = String(batch.status);
          if (current === 'completed') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
          if (current === 'failed') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Integration batch is failed' };
          const changed = this.db.prepare("UPDATE integration_batches SET status = 'completed', finished_at = ? WHERE id = ? AND status = ?")
            .run(now, action.targetEntityId, current);
          return Number(changed.changes) === 1
            ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
            : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Integration batch status changed concurrently' };
        }

        case 'update_approval_expired': {
          const approval = this.db.prepare('SELECT status FROM approval_decisions WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!approval) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Approval not found' };
          if (approval.status === 'expired') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
          if (approval.status !== 'pending') return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Approval is not pending: ${String(approval.status)}` };
          const changed = this.db.prepare("UPDATE approval_decisions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'")
            .run(now, action.targetEntityId);
          return Number(changed.changes) === 1
            ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
            : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Approval status changed concurrently' };
        }

        case 'update_attempt_status_by_review': {
          const attempt = this.db.prepare('SELECT task_id, status FROM task_attempts WHERE id = ?')
            .get(action.targetEntityId) as Record<string, unknown> | undefined;
          if (!attempt) {
            return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Attempt not found' };
          }
          const reviews = this.db.prepare('SELECT status FROM reviews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
            .all(attempt.task_id) as Record<string, unknown>[];
          const latestReview = reviews[0];
          if (!latestReview) {
            return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'No review found' };
          }
          const newStatus = String(latestReview.status);
          if (newStatus === 'approved' || newStatus === 'rework_required') {
            const current = String(attempt.status) as AttemptStatus;
            if (current === newStatus) return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true };
            assertTransitionAttempt(current, newStatus);
            const changed = this.db.prepare('UPDATE task_attempts SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
              .run(newStatus, now, action.targetEntityId, current);
            return Number(changed.changes) === 1
              ? { actionType: action.actionType, targetEntityId: action.targetEntityId, success: true }
              : { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: 'Attempt status changed concurrently' };
          }
          return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Unexpected review status: ${newStatus}` };
        }

        default:
          return { actionType: action.actionType, targetEntityId: action.targetEntityId, success: false, error: `Unknown action: ${action.actionType}` };
      }
    } catch (err) {
      return {
        actionType: action.actionType, targetEntityId: action.targetEntityId, success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

}

/**
 * Map a database row to a ResourceSampleRecord.
 */
function mapRowToResourceSampleRecord(row: Record<string, unknown>): ResourceSampleRecord {
  return {
    id: String(row.id),
    runId: row.run_id ? String(row.run_id) : null,
    timestamp: String(row.timestamp),
    cpuPct: Number(row.cpu_pct),
    memTotalMb: row.mem_total_mb != null ? Number(row.mem_total_mb) : null,
    memUsedMb: row.mem_used_mb != null ? Number(row.mem_used_mb) : null,
    memPct: row.mem_pct != null ? Number(row.mem_pct) : null,
    piActive: Number(row.pi_active),
    budget: Number(row.budget),
    dispatchPaused: Number(row.dispatch_paused ?? 0),
    pauseReason: row.pause_reason ? String(row.pause_reason) : null,
    degraded: Number(row.degraded ?? 0),
    degradeReason: row.degrade_reason ? String(row.degrade_reason) : null,
    source: String(row.source),
    createdAt: String(row.created_at),
  };
}

/**
 * Map a database row to a DispatchDecisionRecord.
 */
function mapRowToDispatchDecisionRecord(row: Record<string, unknown>): DispatchDecisionRecord {
  return {
    id: String(row.id),
    runId: row.run_id ? String(row.run_id) : null,
    timestamp: String(row.timestamp),
    decisionType: String(row.decision_type),
    reason: String(row.reason),
    previousBudget: Number(row.previous_budget),
    newBudget: Number(row.new_budget),
    sampleJson: row.sample_json ? String(row.sample_json) : null,
    createdAt: String(row.created_at),
  };
}

/**
 * Map a database row to a RunRecord.
 */
function mapRowToRunRecord(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectRoot: String(row.project_root),
    requestText: String(row.request_text),
    status: String(row.status) as RunStatus,
    codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
    executionConfigSnapshot: row.execution_config_snapshot ? String(row.execution_config_snapshot) : null,
    encryptedRequestText: row.encrypted_request_text ? String(row.encrypted_request_text) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Map a database row to a TaskRecord.
 */

function mapRowToStageRecord(row: Record<string, unknown>): StageRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageNumber: Number(row.stage_number),
    title: String(row.title),
    status: String(row.status) as any,
    baseCommit: row.base_commit ? String(row.base_commit) : null,
    integrationBranch: row.integration_branch ? String(row.integration_branch) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

function mapRowToAttemptRecord(row: Record<string, unknown>): AttemptRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    stageId: String(row.stage_id),
    attemptNumber: Number(row.attempt_number),
    status: String(row.status) as any,
    piPid: row.pi_pid != null ? Number(row.pi_pid) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    stoppedAt: row.stopped_at ? String(row.stopped_at) : null,
    worktreePath: row.worktree_path ? String(row.worktree_path) : null,
    branchName: row.branch_name ? String(row.branch_name) : null,
    promptHash: row.prompt_hash ? String(row.prompt_hash) : null,
    workerResultJson: row.worker_result_json ? String(row.worker_result_json) : null,
    encryptedWorkerResultJson: row.encrypted_worker_result_json ? String(row.encrypted_worker_result_json) : null,
    exitReason: row.exit_reason ? String(row.exit_reason) : null,
    logPath: row.log_path ? String(row.log_path) : null,
    rawLogPath: row.raw_log_path ? String(row.raw_log_path) : null,
    resultSource: String(row.result_source ?? 'pi') as AttemptRecord['resultSource'],
    adoptedCommit: row.adopted_commit ? String(row.adopted_commit) : null,
    adoptionMetadataJson: row.adoption_metadata_json ? String(row.adoption_metadata_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRowToPathLockRecord(row: Record<string, unknown>): PathLockRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    filePath: String(row.file_path),
    lockType: String(row.lock_type) as any,
    status: String(row.status) as any,
    acquiredAt: String(row.acquired_at),
    releasedAt: row.released_at ? String(row.released_at) : null,
  };
}

function mapRowToReviewRecord(row: Record<string, unknown>): ReviewRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attempt_id),
    taskId: String(row.task_id),
    reviewerType: String(row.reviewer_type),
    status: String(row.status) as any,
    reviewJson: row.review_json ? String(row.review_json) : null,
    findingsJson: row.findings_json ? String(row.findings_json) : null,
    requiredReworkJson: row.required_rework_json ? String(row.required_rework_json) : null,
    reworkCount: Number(row.rework_count ?? 0),
    mergeAllowed: row.merge_allowed === 1 || row.merge_allowed === true,
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    reviewedThroughCommit: row.reviewed_through_commit ? String(row.reviewed_through_commit) : null,
    finalCommit: row.final_commit ? String(row.final_commit) : null,
    coverageStatus: String(row.coverage_status ?? 'partial') as ReviewRecord['coverageStatus'],
    reviewerUnavailable: row.reviewer_unavailable === 1 || row.reviewer_unavailable === true,
    errorCategory: row.error_category ? String(row.error_category) : null,
    exitCode: row.exit_code != null ? Number(row.exit_code) : null,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    stderrHash: row.stderr_hash ? String(row.stderr_hash) : null,
    createdAt: String(row.created_at),
  };
}

function mapRowToIntegrationBatchRecord(row: Record<string, unknown>): IntegrationBatchRecord {
  return {
    id: String(row.id),
    stageId: String(row.stage_id),
    runId: String(row.run_id),
    status: String(row.status) as any,
    integrationBranch: String(row.integration_branch),
    baseCommit: row.base_commit ? String(row.base_commit) : null,
    mergeCommitHash: row.merge_commit_hash ? String(row.merge_commit_hash) : null,
    targetMergeCommit: row.target_merge_commit ? String(row.target_merge_commit) : null,
    conflictsJson: row.conflicts_json ? String(row.conflicts_json) : null,
    createdAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    reviewedThroughCommit: row.reviewed_through_commit ? String(row.reviewed_through_commit) : null,
    finalCommit: row.final_commit ? String(row.final_commit) : null,
    reviewCoverageStatus: String(row.review_coverage_status ?? 'partial') as IntegrationBatchRecord['reviewCoverageStatus'],
    reviewerUnavailable: row.reviewer_unavailable === 1 || row.reviewer_unavailable === true,
    reviewMetadataJson: row.review_metadata_json ? String(row.review_metadata_json) : null,
  };
}

function mapRowToEventRecord(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: row.stage_id ? String(row.stage_id) : null,
    taskId: row.task_id ? String(row.task_id) : null,
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    eventType: String(row.event_type),
    eventDataJson: row.event_data_json ? String(row.event_data_json) : null,
    createdAt: String(row.created_at),
  };
}

function mapRowToTaskRecord(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    title: String(row.title),
    status: String(row.status) as TaskStatus,
    specJson: row.spec_json ? parseSpecJsonStrict(String(row.spec_json)) : null,
    branchName: row.branch_name ? String(row.branch_name) : null,
    worktreePath: row.worktree_path ? String(row.worktree_path) : null,
    workerId: row.worker_id ? String(row.worker_id) : null,
    commitHash: row.commit_hash ? String(row.commit_hash) : null,
    retryCount: Number(row.retry_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Safely parse a JSON field, returning null on failure.
 */
function parseJsonField(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Strict parse for task spec_json. A corrupt spec must fail closed (loudly)
 * instead of silently degrading to null — downstream `?? []` fallbacks would
 * otherwise disable the allowedPaths scope guard for the task.
 */
function parseSpecJsonStrict(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error('Corrupt task spec_json in state store: not valid JSON; refusing to continue (scope guard would silently fail open)');
  }
}

// ══════════════════════════════════════════════════════════════
// M4 Row Mapping Functions
// ══════════════════════════════════════════════════════════════

function mapRowToApprovalDecision(row: Record<string, unknown>): ApprovalDecision {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    gate: String(row.gate) as ApprovalDecision['gate'],
    decisionType: String(row.decision_type) as ApprovalDecision['decisionType'],
    scope: String(row.scope) as ApprovalDecision['scope'],
    status: String(row.status) as ApprovalDecision['status'],
    approvedBy: String(row.approved_by) as ApprovalDecision['approvedBy'],
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    revokeReason: row.revoke_reason ? String(row.revoke_reason) : null,
    metadata: row.metadata_json ? (parseJsonField(String(row.metadata_json)) || {}) : {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRowToTokenLedgerEntry(row: Record<string, unknown>): TokenLedgerEntry {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: row.stage_id ? String(row.stage_id) : null,
    taskId: row.task_id ? String(row.task_id) : null,
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    callType: String(row.call_type) as TokenLedgerEntry['callType'],
    callId: String(row.call_id),
    estimatedTotal: row.estimated_total != null ? Number(row.estimated_total) : null,
    estimatedInput: row.estimated_input != null ? Number(row.estimated_input) : null,
    estimatedOutput: row.estimated_output != null ? Number(row.estimated_output) : null,
    actualTotal: row.actual_total != null ? Number(row.actual_total) : null,
    actualInput: row.actual_input != null ? Number(row.actual_input) : null,
    actualOutput: row.actual_output != null ? Number(row.actual_output) : null,
    actualCacheHit: row.actual_cache_hit != null ? Number(row.actual_cache_hit) : null,
    promptHash: row.prompt_hash ? String(row.prompt_hash) : null,
    model: row.model ? String(row.model) : null,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    status: String(row.status) as TokenLedgerEntry['status'],
    createdAt: String(row.created_at),
  };
}

function mapRowToPauseRecord(row: Record<string, unknown>): PauseRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: String(row.stage_id),
    reasonCode: String(row.reason_code),
    category: String(row.category) as PauseRecord['category'],
    recoverable: row.recoverable === 1 || row.recoverable === true,
    requiredApprovalType: row.required_approval_type ? String(row.required_approval_type) : null,
    decisionId: row.decision_id ? String(row.decision_id) : null,
    evidenceSummary: String(row.evidence_summary),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    resolutionNote: row.resolution_note ? String(row.resolution_note) : null,
  };
}

function mapRowToCostReservation(row: Record<string, unknown>): import('../types/m4-types.js').CostReservation {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: row.stage_id ? String(row.stage_id) : null,
    taskId: row.task_id ? String(row.task_id) : null,
    attemptId: row.attempt_id ? String(row.attempt_id) : null,
    callType: String(row.call_type) as import('../types/m4-types.js').CallType,
    callId: String(row.call_id),
    currency: String(row.currency) as 'CNY' | 'USD',
    budgetLimit: Number(row.budget_limit),
    reservedCost: Number(row.reserved_cost),
    actualCost: row.actual_cost != null ? Number(row.actual_cost) : null,
    status: String(row.status) as import('../types/m4-types.js').CostReservation['status'],
    pricingVersion: String(row.pricing_version),
    usageStatus: String(row.usage_status) as import('../types/m4-types.js').CostReservation['usageStatus'],
    phase: String(row.phase ?? 'reserved') as import('../types/m4-types.js').CostReservation['phase'],
    spawnedAt: row.spawned_at ? String(row.spawned_at) : null,
    ownerId: row.owner_id ? String(row.owner_id) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    heartbeatAt: row.heartbeat_at ? String(row.heartbeat_at) : null,
    terminationEvidence: row.termination_evidence ? String(row.termination_evidence) : null,
    settledAt: row.settled_at ? String(row.settled_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRowToBudgetPolicy(row: Record<string, unknown>): BudgetPolicy {
  return {
    id: String(row.id),
    runId: row.run_id ? String(row.run_id) : null,
    scope: String(row.scope) as BudgetPolicy['scope'],
    policyType: String(row.policy_type) as BudgetPolicy['policyType'],
    tokenLimit: Number(row.token_limit),
    actionOnExceed: String(row.action_on_exceed) as BudgetPolicy['actionOnExceed'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRowToRiskAssessment(row: Record<string, unknown>): RiskAssessment {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageId: row.stage_id ? String(row.stage_id) : null,
    assessmentType: String(row.assessment_type) as RiskAssessment['assessmentType'],
    riskLevel: String(row.risk_level) as RiskAssessment['riskLevel'],
    findingsJson: row.findings_json ? String(row.findings_json) : null,
    trigger: String(row.trigger) as RiskAssessment['trigger'],
    resolved: row.resolved === 1 || row.resolved === true,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    createdAt: String(row.created_at),
  };
}

// ══════════════════════════════════════════════════════════════
// M5 Row Mapping Functions
// ══════════════════════════════════════════════════════════════

function mapRowToReconciliationReportRecord(row: Record<string, unknown>): ReconciliationReportRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    phase: 'applied',
    initiatedBy: 'user_direct',
    totalFindings: Number(row.total_findings),
    blockingCount: Number(row.blocking_count),
    appliedCount: Number(row.applied_count),
    skippedCount: Number(row.skipped_count),
    summaryJson: String(row.summary_json),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    createdAt: String(row.created_at),
  };
}

function mapRowToReconciliationFindingRecord(row: Record<string, unknown>): ReconciliationFindingRecord {
  return {
    id: String(row.id),
    reportId: String(row.report_id),
    runId: String(row.run_id),
    entityType: String(row.entity_type) as ReconciliationFindingRecord['entityType'],
    entityId: String(row.entity_id),
    kind: String(row.kind) as ReconciliationFindingRecord['kind'],
    severity: String(row.severity) as ReconciliationFindingRecord['severity'],
    status: String(row.status) as ReconciliationFindingRecord['status'],
    proposal: String(row.proposal),
    appliedAction: row.applied_action ? String(row.applied_action) : null,
    evidenceHash: String(row.evidence_hash),
    createdAt: String(row.created_at),
    appliedAt: row.applied_at ? String(row.applied_at) : null,
  };
}
