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
  planning: ['running', 'failed'],
  running: ['waiting_decision', 'reviewing', 'failed', 'canceled'],
  waiting_decision: ['running', 'canceled'],
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
  pending: ['ready'],
  ready: ['running', 'canceled'],
  running: ['integration', 'failed', 'paused', 'canceled'],
  integration: ['completed', 'failed', 'paused'],
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
  running: ['worker_completed', 'failed', 'interrupted', 'canceled'],
  worker_completed: ['validating', 'failed'],
  validating: ['reviewing', 'review_skipped', 'failed', 'rework_required'],
  reviewing: ['approved', 'rework_required', 'failed'],
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
  pending: ['ready'],
  ready: ['running', 'canceled'],
  running: ['worker_completed', 'waiting_decision', 'failed', 'canceled', 'rework_required'],
  worker_completed: ['validating', 'failed'],
  validating: ['reviewing', 'review_skipped', 'failed', 'rework_required', 'canceled'],
  reviewing: ['approved', 'rework_required', 'failed', 'rejected', 'canceled'],
  review_skipped: ['approved', 'rework_required'],
  approved: ['merged', 'merge_blocked'],
  merged: [],
  failed: [],
  canceled: [],
  rejected: [],
  rework_required: ['ready'],
  waiting_decision: ['running', 'failed', 'canceled'],
  merge_blocked: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransitionTask(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new StateTransitionError(from, to);
  }
}

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['merged', 'failed', 'canceled', 'rejected', 'merge_blocked'];
