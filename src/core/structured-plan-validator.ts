import type { StructuredPlan, StructuredTaskSpec } from '../types/m2-types.js';
import { addDeterministicWriteConflictDependencies, type AddedWriteDependency } from './path-ownership.js';

export function normalizeStructuredPlanWriteConflicts(plan: StructuredPlan): AddedWriteDependency[] {
  return addDeterministicWriteConflictDependencies(plan);
}

/**
 * Validate graph invariants that JSON Schema cannot express.
 * Stages are strict barriers, so explicit dependencies may only target tasks
 * in the same stage; earlier stages are already inherited through stage base.
 */
export function validateStructuredPlan(plan: StructuredPlan): string[] {
  const errors: string[] = [];
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (stages.length === 0) errors.push('missing stages');
  if (tasks.length === 0) errors.push('missing tasks');

  const stageByNumber = new Map<number, (typeof stages)[number]>();
  for (const stage of stages) {
    if (!Number.isInteger(stage.stageNumber) || stage.stageNumber < 1) {
      errors.push(`invalid stageNumber: ${String(stage.stageNumber)}`);
      continue;
    }
    if (stageByNumber.has(stage.stageNumber)) {
      errors.push(`duplicate stageNumber: ${stage.stageNumber}`);
      continue;
    }
    stageByNumber.set(stage.stageNumber, stage);
    if (!stage.title?.trim()) errors.push(`stage ${stage.stageNumber}: missing title`);
    if (!Array.isArray(stage.tasks) || stage.tasks.length === 0) errors.push(`stage ${stage.stageNumber}: no tasks`);
  }
  const orderedStageNumbers = [...stageByNumber.keys()].sort((a, b) => a - b);
  orderedStageNumbers.forEach((stageNumber, index) => {
    if (stageNumber !== index + 1) errors.push('stage numbers must be contiguous starting at 1');
  });

  const taskById = new Map<string, StructuredTaskSpec>();
  for (const task of tasks) {
    if (!task.taskId?.trim()) {
      errors.push('task missing taskId');
      continue;
    }
    if (taskById.has(task.taskId)) {
      errors.push(`duplicate taskId: ${task.taskId}`);
      continue;
    }
    taskById.set(task.taskId, task);
    if (!Number.isInteger(task.stageNumber) || !stageByNumber.has(task.stageNumber)) {
      errors.push(`${task.taskId}: unknown stageNumber ${String(task.stageNumber)}`);
    }
    if (!task.title?.trim()) errors.push(`${task.taskId}: missing title`);
    if (!task.goal?.trim()) errors.push(`${task.taskId}: missing goal`);
    if (!Array.isArray(task.estimatedWritePaths) || task.estimatedWritePaths.length === 0) {
      errors.push(`${task.taskId}: missing estimatedWritePaths`);
    }
  }

  const membership = new Map<string, number[]>();
  for (const stage of stages) {
    const seenInStage = new Set<string>();
    for (const taskId of stage.tasks || []) {
      if (seenInStage.has(taskId)) errors.push(`stage ${stage.stageNumber}: duplicate task ref ${taskId}`);
      seenInStage.add(taskId);
      const task = taskById.get(taskId);
      if (!task) {
        errors.push(`stage ${stage.stageNumber} refs unknown task: ${taskId}`);
        continue;
      }
      const memberships = membership.get(taskId) ?? [];
      memberships.push(stage.stageNumber);
      membership.set(taskId, memberships);
      if (task.stageNumber !== stage.stageNumber) {
        errors.push(`stage ${stage.stageNumber} refs task ${taskId} assigned to stage ${task.stageNumber}`);
      }
    }
  }
  for (const taskId of taskById.keys()) {
    const memberships = membership.get(taskId) ?? [];
    if (memberships.length === 0) errors.push(`${taskId}: missing from stage task membership`);
    if (memberships.length > 1) errors.push(`${taskId}: appears in multiple stage memberships`);
  }

  for (const task of taskById.values()) {
    for (const dependencyId of task.dependencies || []) {
      if (dependencyId === task.taskId) {
        errors.push(`${task.taskId}: self dependency`);
        continue;
      }
      const dependency = taskById.get(dependencyId);
      if (!dependency) {
        errors.push(`${task.taskId}: unknown dependency ${dependencyId}`);
        continue;
      }
      if (dependency.stageNumber !== task.stageNumber) {
        errors.push(`${task.taskId}: cross-stage dependency ${dependencyId} is invalid; stage barriers are implicit`);
      }
    }
  }

  const visitState = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycleReported = false;
  const visit = (taskId: string): void => {
    if (cycleReported || visitState.get(taskId) === 2) return;
    if (visitState.get(taskId) === 1) {
      const start = stack.indexOf(taskId);
      const cycle = [...stack.slice(Math.max(0, start)), taskId];
      errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
      cycleReported = true;
      return;
    }
    visitState.set(taskId, 1);
    stack.push(taskId);
    const task = taskById.get(taskId);
    for (const dependencyId of task?.dependencies || []) {
      const dependency = taskById.get(dependencyId);
      if (dependency && dependency.stageNumber === task?.stageNumber) visit(dependencyId);
    }
    stack.pop();
    visitState.set(taskId, 2);
  };
  for (const taskId of taskById.keys()) visit(taskId);

  return [...new Set(errors)];
}
