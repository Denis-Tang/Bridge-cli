import { describe, it, expect } from 'vitest';
import {
  canTransitionRun,
  canTransitionTask,
  assertTransitionRun,
  assertTransitionTask,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
} from '../../src/core/state-machine.js';
import { StateTransitionError } from '../../src/core/errors.js';

describe('Run Status Transitions', () => {
  const validTransitions: Array<[string, string, boolean]> = [
    ['queued', 'planning', true],
    ['planning', 'running', true],
    ['running', 'waiting_decision', true],
    ['running', 'reviewing', true],
    ['running', 'failed', true],
    ['running', 'canceled', true],
    ['waiting_decision', 'running', true],
    ['waiting_decision', 'canceled', true],
    ['reviewing', 'merging', true],
    ['reviewing', 'failed', true],
    ['merging', 'completed', true],
    ['merging', 'failed', true],
    // Invalid transitions
    ['completed', 'running', false],
    ['canceled', 'merging', false],
    ['failed', 'running', false],
    ['queued', 'completed', false],
  ];

  it.each(validTransitions)('from %s to %s should be %s', (from, to, expected) => {
    expect(canTransitionRun(from as any, to as any)).toBe(expected);
  });

  it('assertTransitionRun throws for invalid transitions', () => {
    expect(() => assertTransitionRun('completed' as any, 'running' as any)).toThrow(StateTransitionError);
  });

  it('assertTransitionRun passes for valid transitions', () => {
    expect(() => assertTransitionRun('queued', 'planning')).not.toThrow();
  });
});

describe('Task Status Transitions', () => {
  const validTransitions: Array<[string, string, boolean]> = [
    ['pending', 'ready', true],
    ['ready', 'running', true],
    ['ready', 'canceled', true],
    ['running', 'worker_completed', true],
    ['running', 'failed', true],
    ['running', 'canceled', true],
    ['worker_completed', 'validating', true],
    ['validating', 'reviewing', true],
    ['validating', 'failed', true],
    ['reviewing', 'approved', true],
    ['reviewing', 'rework_required', true],
    ['reviewing', 'rejected', true],
    ['reviewing', 'failed', true],
    ['approved', 'merged', true],
    ['rework_required', 'ready', true],
    // Invalid: from completed to running
    ['completed', 'running', false],
    // Invalid: from canceled to merged
    ['canceled', 'merged', false],
    ['merged', 'running', false],
    ['rejected', 'approved', false],
  ];

  it.each(validTransitions)('from %s to %s should be %s', (from, to, expected) => {
    expect(canTransitionTask(from as any, to as any)).toBe(expected);
  });

  it('assertTransitionTask throws for invalid transitions', () => {
    expect(() => assertTransitionTask('completed' as any, 'running' as any)).toThrow(StateTransitionError);
    expect(() => assertTransitionTask('canceled' as any, 'merged' as any)).toThrow(StateTransitionError);
  });

  it('assertTransitionTask passes for valid transitions', () => {
    expect(() => assertTransitionTask('pending', 'ready')).not.toThrow();
  });

  it('terminal statuses are defined correctly', () => {
    expect(TERMINAL_RUN_STATUSES).toContain('completed');
    expect(TERMINAL_RUN_STATUSES).toContain('failed');
    expect(TERMINAL_RUN_STATUSES).toContain('canceled');
    expect(TERMINAL_TASK_STATUSES).toContain('merged');
    expect(TERMINAL_TASK_STATUSES).toContain('failed');
    expect(TERMINAL_TASK_STATUSES).toContain('canceled');
    expect(TERMINAL_TASK_STATUSES).toContain('rejected');
  });
});
