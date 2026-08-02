import { describe, it, expect } from 'vitest';
import {
  canTransitionStage,
  canTransitionAttempt,
  assertTransitionStage,
  assertTransitionAttempt,
  TERMINAL_STAGE_STATUSES,
  TERMINAL_ATTEMPT_STATUSES,
} from '../../src/core/state-machine.js';
import { StateTransitionError } from '../../src/core/errors.js';

describe('Stage Status Transitions', () => {
  const validTransitions: Array<[string, string, boolean]> = [
    ['pending', 'ready', true],
    ['ready', 'running', true],
    ['ready', 'canceled', true],
    ['running', 'integration', true],
    ['running', 'failed', true],
    ['running', 'paused', true],
    ['running', 'canceled', true],
    ['integration', 'completed', true],
    ['integration', 'failed', true],
    ['integration', 'paused', true],
    ['paused', 'ready', true],
    ['paused', 'canceled', true],
    ['completed', 'running', false],
    ['failed', 'ready', false],
    ['canceled', 'ready', false],
    ['pending', 'completed', false],
  ];

  it.each(validTransitions)('from %s to %s should be %s', (from, to, expected) => {
    expect(canTransitionStage(from as any, to as any)).toBe(expected);
  });

  it('assertTransitionStage throws for invalid', () => {
    expect(() => assertTransitionStage('completed' as any, 'running' as any)).toThrow(StateTransitionError);
  });

  it('assertTransitionStage passes for valid', () => {
    expect(() => assertTransitionStage('paused', 'ready')).not.toThrow();
  });

  it('terminal stage statuses', () => {
    expect(TERMINAL_STAGE_STATUSES).toContain('completed');
    expect(TERMINAL_STAGE_STATUSES).toContain('failed');
    expect(TERMINAL_STAGE_STATUSES).toContain('canceled');
    expect(TERMINAL_STAGE_STATUSES).not.toContain('paused');
  });
});

describe('Attempt Status Transitions', () => {
  const validTransitions: Array<[string, string, boolean]> = [
    ['pending', 'running', true],
    ['pending', 'canceled', true],
    ['running', 'worker_completed', true],
    ['running', 'failed', true],
    ['running', 'interrupted', true],
    ['running', 'canceled', true],
    ['worker_completed', 'validating', true],
    ['worker_completed', 'failed', true],
    ['validating', 'reviewing', true],
    ['validating', 'failed', true],
    ['validating', 'rework_required', true],
    ['reviewing', 'approved', true],
    ['reviewing', 'rework_required', true],
    ['reviewing', 'failed', true],
    ['reviewing', 'canceled', true],
    ['rework_required', 'running', true],
    ['approved', 'running', false],
    ['failed', 'running', false],
    ['interrupted', 'running', false],
    ['canceled', 'running', false],
    ['pending', 'approved', false],
  ];

  it.each(validTransitions)('attempt %s to %s = %s', (from, to, expected) => {
    expect(canTransitionAttempt(from as any, to as any)).toBe(expected);
  });

  it('assertTransitionAttempt throws for invalid', () => {
    expect(() => assertTransitionAttempt('approved' as any, 'running' as any)).toThrow(StateTransitionError);
  });

  it('terminal attempt statuses', () => {
    expect(TERMINAL_ATTEMPT_STATUSES).toContain('approved');
    expect(TERMINAL_ATTEMPT_STATUSES).toContain('failed');
    expect(TERMINAL_ATTEMPT_STATUSES).toContain('interrupted');
    expect(TERMINAL_ATTEMPT_STATUSES).toContain('canceled');
    expect(TERMINAL_ATTEMPT_STATUSES).not.toContain('running');
  });
});
