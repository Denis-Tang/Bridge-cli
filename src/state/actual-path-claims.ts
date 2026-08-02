import { createHash } from 'node:crypto';
import { normalizeRepositoryPath, repositoryPathsOverlap, tasksHaveSerialOwnership } from '../core/path-ownership.js';
import type { StructuredTaskSpec, ActualPathClaimRecord } from '../types/m2-types.js';
import type { ClaimActualPathsInput, ClaimActualPathsResult, ActualPathConflict } from './state-store.js';

type SqliteDatabase = {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): { changes?: number | bigint } };
};

function mapClaim(row: Record<string, unknown>): ActualPathClaimRecord {
  return {
    id: String(row.id), runId: String(row.run_id), stageId: String(row.stage_id), taskId: String(row.task_id),
    attemptId: String(row.attempt_id), filePath: String(row.file_path), normalizedPath: String(row.normalized_path),
    createdAt: String(row.created_at), releasedAt: row.released_at ? String(row.released_at) : null,
  };
}

function conflictKey(conflict: ActualPathConflict): string {
  return [conflict.conflictingTaskId, conflict.conflictingAttemptId ?? '', conflict.candidatePath,
    conflict.conflictingPath, conflict.conflictLayer].join('\0');
}

/** Execute claim validation/insertion while the caller holds BEGIN IMMEDIATE. */
export function claimActualPathsInOpenTransaction(
  db: SqliteDatabase,
  input: ClaimActualPathsInput,
  now = new Date().toISOString(),
): ClaimActualPathsResult {
  const violations: string[] = [];
  const normalized: string[] = [];
  for (const path of input.filePaths) {
    try { normalized.push(normalizeRepositoryPath(path)); }
    catch (error) { violations.push(error instanceof Error ? error.message : String(error)); }
  }
  const candidatePaths = [...new Set(normalized)].sort();
  if (violations.length > 0 || candidatePaths.length === 0) {
    return { claimed: false, claims: [], conflicts: [], violations: violations.length > 0 ? violations : ['actual path claim is empty'] };
  }

  const stage = db.prepare('SELECT run_id, stage_number FROM stages WHERE id = ?').get(input.stageId) as Record<string, unknown> | undefined;
  const attempt = db.prepare('SELECT task_id, stage_id FROM task_attempts WHERE id = ?').get(input.attemptId) as Record<string, unknown> | undefined;
  if (!stage || String(stage.run_id) !== input.runId) violations.push('actual path claim stage/run identity mismatch');
  if (!attempt || String(attempt.task_id) !== input.taskId || String(attempt.stage_id) !== input.stageId) {
    violations.push('actual path claim attempt/task/stage identity mismatch');
  }
  if (violations.length > 0) return { claimed: false, claims: [], conflicts: [], violations };

  const taskRows = db.prepare('SELECT id, spec_json FROM tasks WHERE run_id = ?').all(input.runId) as Record<string, unknown>[];
  const specs = new Map<string, StructuredTaskSpec>();
  for (const row of taskRows) {
    try {
      const spec = JSON.parse(String(row.spec_json || '{}')) as StructuredTaskSpec;
      if (spec.stageNumber === Number(stage!.stage_number)) specs.set(String(row.id), { ...spec, taskId: String(row.id) });
    } catch {
      violations.push(`task ${String(row.id)} has invalid spec_json`);
    }
  }
  if (!specs.has(input.taskId)) violations.push('actual path claim task is not a member of the stage');
  if (violations.length > 0) return { claimed: false, claims: [], conflicts: [], violations };

  const conflicts: ActualPathConflict[] = [];
  for (const [otherTaskId, otherSpec] of specs) {
    if (otherTaskId === input.taskId || tasksHaveSerialOwnership(input.taskId, otherTaskId, specs)) continue;
    for (const candidatePath of candidatePaths) {
      for (const estimatedPath of otherSpec.estimatedWritePaths ?? []) {
        let normalizedEstimated: string;
        try { normalizedEstimated = normalizeRepositoryPath(estimatedPath); } catch { continue; }
        if (repositoryPathsOverlap(candidatePath, normalizedEstimated)) {
          conflicts.push({ conflictingTaskId: otherTaskId, conflictingAttemptId: null, candidatePath,
            conflictingPath: normalizedEstimated, conflictLayer: 'estimated' });
        }
      }
    }
  }

  const activeClaims = db.prepare(
    'SELECT * FROM actual_path_claims WHERE stage_id = ? AND released_at IS NULL AND task_id != ?'
  ).all(input.stageId, input.taskId) as Record<string, unknown>[];
  for (const row of activeClaims) {
    const otherTaskId = String(row.task_id);
    if (tasksHaveSerialOwnership(input.taskId, otherTaskId, specs)) continue;
    for (const candidatePath of candidatePaths) {
      const claimedPath = String(row.normalized_path);
      if (repositoryPathsOverlap(candidatePath, claimedPath)) {
        conflicts.push({ conflictingTaskId: otherTaskId, conflictingAttemptId: String(row.attempt_id), candidatePath,
          conflictingPath: claimedPath, conflictLayer: 'actual' });
      }
    }
  }

  const uniqueConflicts = [...new Map(conflicts.map((conflict) => [conflictKey(conflict), conflict])).values()];
  if (uniqueConflicts.length > 0) return { claimed: false, claims: [], conflicts: uniqueConflicts, violations: [] };

  const insert = db.prepare(`INSERT INTO actual_path_claims
    (id, run_id, stage_id, task_id, attempt_id, file_path, normalized_path, created_at, released_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(stage_id, attempt_id, normalized_path) DO NOTHING`);
  for (const normalizedPath of candidatePaths) {
    const id = `claim-${createHash('sha256').update(`${input.stageId}\0${input.attemptId}\0${normalizedPath}`).digest('hex')}`;
    insert.run(id, input.runId, input.stageId, input.taskId, input.attemptId, normalizedPath, normalizedPath, now);
  }
  const rows = db.prepare('SELECT * FROM actual_path_claims WHERE stage_id = ? AND attempt_id = ? ORDER BY normalized_path')
    .all(input.stageId, input.attemptId) as Record<string, unknown>[];
  return { claimed: true, claims: rows.map(mapClaim), conflicts: [], violations: [] };
}

export function mapActualPathClaimRow(row: Record<string, unknown>): ActualPathClaimRecord {
  return mapClaim(row);
}
