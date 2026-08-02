import { StateTransitionError } from './errors.js';

// ── Run Status ──────────────────────────────────────────────────────────
export type RunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_decision'
  | 'reviewing'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'canceled';

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['planning'],
  planning: ['running', 'failed', 'canceled'],
  running: ['waiting_decision', 'reviewing', 'completed', 'failed', 'canceled'],
  waiting_decision: ['running', 'failed', 'canceled'],
  reviewing: ['merging', 'failed', 'canceled'],
  merging: ['completed', 'failed'],
  completed: [],
  failed: [],
  canceled: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionRun(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

export const TERMINAL_RUN_STATUSES: RunStatus[] = ['completed', 'failed', 'canceled'];

// ── Stage Status ────────────────────────────────────────────────
export type StageStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'integration'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'canceled';

const STAGE_TRANSITIONS: Record<StageStatus, StageStatus[]> = {
  pending: ['ready', 'paused', 'canceled'],
  ready: ['running', 'paused', 'canceled'],
  running: ['integration', 'failed', 'paused', 'canceled'],
  integration: ['completed', 'failed', 'paused', 'canceled'],
  completed: [],
  failed: [],
  paused: ['ready', 'canceled'],
  canceled: [],
};

export function canTransitionStage(from: StageStatus, to: StageStatus): boolean {
  return STAGE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionStage(from: StageStatus, to: StageStatus): void {
  if (!canTransitionStage(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

export const TERMINAL_STAGE_STATUSES: StageStatus[] = ['completed', 'failed', 'canceled'];

// ── Attempt Status ─────────────────────────────────────────
export type AttemptStatus =
  | 'pending'
  | 'running'
  | 'worker_completed'
  | 'validating'
  | 'reviewing'
  | 'review_skipped'
  | 'approved'
  | 'rework_required'
  | 'failed'
  | 'interrupted'
  | 'canceled';

const ATTEMPT_TRANSITIONS: Record<AttemptStatus, AttemptStatus[]> = {
  pending: ['running', 'canceled'],
  running: ['worker_completed', 'rework_required', 'failed', 'interrupted', 'canceled'],
  worker_completed: ['validating', 'rework_required', 'failed', 'canceled'],
  validating: ['reviewing', 'review_skipped', 'failed', 'rework_required'],
  reviewing: ['approved', 'rework_required', 'failed', 'canceled'],
  review_skipped: ['approved', 'rework_required'],
  approved: [],
  rework_required: ['running'],
  failed: [],
  interrupted: [],
  canceled: [],
};

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionAttempt(from: AttemptStatus, to: AttemptStatus): void {
  if (!canTransitionAttempt(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

export const TERMINAL_ATTEMPT_STATUSES: AttemptStatus[] = ['approved', 'failed', 'interrupted', 'canceled'];

// ── Task Status ─────────────────────────────────────────────────────────
export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'worker_completed'
  | 'validating'
  | 'reviewing'
  | 'review_skipped'
  | 'approved'
  | 'merged'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'rework_required'
  | 'waiting_decision'
  | 'merge_blocked';

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['ready', 'waiting_decision', 'canceled'],
  ready: ['running', 'waiting_decision', 'rework_required', 'canceled'],
  running: ['worker_completed', 'waiting_decision', 'failed', 'canceled', 'rework_required'],
  worker_completed: ['validating', 'waiting_decision', 'failed', 'rework_required', 'canceled'],
  validating: ['reviewing', 'review_skipped', 'waiting_decision', 'failed', 'rework_required', 'canceled'],
  reviewing: ['approved', 'waiting_decision', 'rework_required', 'failed', 'rejected', 'canceled'],
  review_skipped: ['approved', 'rework_required', 'failed', 'canceled'],
  approved: ['merged', 'merge_blocked', 'canceled'],
  merged: [],
  failed: [],
  canceled: [],
  rejected: [],
  rework_required: ['ready', 'waiting_decision', 'canceled'],
  waiting_decision: ['running', 'rework_required', 'failed', 'canceled'],
  merge_blocked: ['approved', 'rework_required', 'canceled'],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionTask(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['merged', 'failed', 'canceled', 'rejected'];
