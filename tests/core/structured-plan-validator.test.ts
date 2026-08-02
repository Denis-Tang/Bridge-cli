import { describe, expect, it } from 'vitest';
import { normalizeStructuredPlanWriteConflicts, validateStructuredPlan } from '../../src/core/structured-plan-validator.js';
import type { StructuredPlan, StructuredTaskSpec } from '../../src/types/m2-types.js';

function task(taskId: string, stageNumber: number, dependencies: string[] = []): StructuredTaskSpec {
  return {
    taskId, stageNumber, dependencies, title: taskId, goal: `implement ${taskId}`,
    estimatedWritePaths: [`src/${taskId}.ts`], allowedPaths: ['src/'], forbiddenPaths: [],
    contextFiles: [], acceptanceChecks: ['npm test'], allowedCommands: ['npm test'],
    riskLevel: 'low', productDecisionsLocked: true, expectedOutputs: [`src/${taskId}.ts`],
    heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
  };
}

function plan(tasks: StructuredTaskSpec[], stages: StructuredPlan['stages']): StructuredPlan {
  return { jobId: 'job-1', summary: 'test', tasks, stages, riskAssessment: { level: 'low', notes: [] } };
}

describe('validateStructuredPlan graph invariants', () => {
  it('accepts a valid staged DAG with implicit stage barriers', () => {
    expect(validateStructuredPlan(plan(
      [task('T1', 1), task('T2', 1, ['T1']), task('T3', 2)],
      [{ stageNumber: 1, title: 'one', tasks: ['T1', 'T2'] }, { stageNumber: 2, title: 'two', tasks: ['T3'] }],
    ))).toEqual([]);
  });

  it('rejects unknown, self, cyclic, and cross-stage dependencies', () => {
    const errors = validateStructuredPlan(plan(
      [task('T1', 1, ['T2']), task('T2', 1, ['T1']), task('T3', 2, ['T1', 'T3', 'missing'])],
      [{ stageNumber: 1, title: 'one', tasks: ['T1', 'T2'] }, { stageNumber: 2, title: 'two', tasks: ['T3'] }],
    ));
    expect(errors.some((error) => error.includes('dependency cycle'))).toBe(true);
    expect(errors).toContain('T3: cross-stage dependency T1 is invalid; stage barriers are implicit');
    expect(errors).toContain('T3: self dependency');
    expect(errors).toContain('T3: unknown dependency missing');
  });

  it('rejects stage gaps and inconsistent membership', () => {
    const errors = validateStructuredPlan(plan(
      [task('T1', 1), task('T2', 3)],
      [{ stageNumber: 1, title: 'one', tasks: ['T2'] }, { stageNumber: 3, title: 'three', tasks: ['T2'] }],
    ));
    expect(errors).toContain('stage numbers must be contiguous starting at 1');
    expect(errors).toContain('T1: missing from stage task membership');
    expect(errors).toContain('T2: appears in multiple stage memberships');
    expect(errors).toContain('stage 1 refs task T2 assigned to stage 3');
  });

  it('deterministically serializes declared same-stage path overlap and keeps the DAG valid', () => {
    const t1 = task('T1', 1);
    const t2 = task('T2', 1);
    const t3 = task('T3', 1, ['T2']);
    t1.estimatedWritePaths = ['src/shared/'];
    t2.estimatedWritePaths = ['SRC\\shared\\file.ts'];
    t3.estimatedWritePaths = ['docs/other.ts'];
    const input = plan([t3, t2, t1], [{ stageNumber: 1, title: 'one', tasks: ['T3', 'T2', 'T1'] }]);

    const additions = normalizeStructuredPlanWriteConflicts(input);

    expect(additions).toEqual([{
      stageNumber: 1, predecessorTaskId: 'T1', successorTaskId: 'T2', overlappingPaths: ['src/shared'],
    }]);
    expect(t2.dependencies).toEqual(['T1']);
    expect(t3.dependencies).toEqual(['T2']);
    expect(validateStructuredPlan(input)).toEqual([]);
    expect(normalizeStructuredPlanWriteConflicts(input)).toEqual([]);
  });
});
