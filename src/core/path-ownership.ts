import type { StructuredPlan, StructuredTaskSpec } from '../types/m2-types.js';

export function normalizeRepositoryPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
    throw new Error(`repository path must be relative: ${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`repository path contains unsafe segments: ${value}`);
  }
  return parts.join('/');
}

export function repositoryPathsOverlap(left: string, right: string): boolean {
  const a = normalizeRepositoryPath(left);
  const b = normalizeRepositoryPath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function taskTransitivelyDependsOn(
  taskId: string,
  dependencyId: string,
  specs: ReadonlyMap<string, Pick<StructuredTaskSpec, 'dependencies'>>,
  seen = new Set<string>(),
): boolean {
  if (taskId === dependencyId) return true;
  if (seen.has(taskId)) return false;
  seen.add(taskId);
  const spec = specs.get(taskId);
  return Boolean(spec?.dependencies?.some((dependency) =>
    dependency === dependencyId || taskTransitivelyDependsOn(dependency, dependencyId, specs, seen)));
}

export function tasksHaveSerialOwnership(
  firstTaskId: string,
  secondTaskId: string,
  specs: ReadonlyMap<string, Pick<StructuredTaskSpec, 'dependencies'>>,
): boolean {
  return taskTransitivelyDependsOn(firstTaskId, secondTaskId, specs)
    || taskTransitivelyDependsOn(secondTaskId, firstTaskId, specs);
}

export interface AddedWriteDependency {
  stageNumber: number;
  predecessorTaskId: string;
  successorTaskId: string;
  overlappingPaths: string[];
}

/**
 * Serialize declared same-stage write overlap using a stable topological order.
 * Added edges always point forward in that order, so an already-valid DAG
 * remains acyclic. The input plan is mutated intentionally before persistence.
 */
export function addDeterministicWriteConflictDependencies(plan: StructuredPlan): AddedWriteDependency[] {
  const additions: AddedWriteDependency[] = [];
  for (const stage of [...plan.stages].sort((a, b) => a.stageNumber - b.stageNumber)) {
    const tasks = plan.tasks.filter((task) => task.stageNumber === stage.stageNumber);
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const indegree = new Map(tasks.map((task) => [task.taskId, 0]));
    const dependents = new Map(tasks.map((task) => [task.taskId, [] as string[]]));
    for (const task of tasks) {
      for (const dependency of task.dependencies) {
        if (!byId.has(dependency)) continue;
        indegree.set(task.taskId, (indegree.get(task.taskId) ?? 0) + 1);
        dependents.get(dependency)!.push(task.taskId);
      }
    }
    const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
    const order: string[] = [];
    while (ready.length > 0) {
      const current = ready.shift()!;
      order.push(current);
      for (const dependent of [...dependents.get(current)!].sort()) {
        const remaining = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) {
          ready.push(dependent);
          ready.sort();
        }
      }
    }
    if (order.length !== tasks.length) continue; // validation reports the existing cycle

    const specs = new Map(tasks.map((task) => [task.taskId, task]));
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const predecessor = byId.get(order[i])!;
        const successor = byId.get(order[j])!;
        if (tasksHaveSerialOwnership(predecessor.taskId, successor.taskId, specs)) continue;
        const overlappingPaths = predecessor.estimatedWritePaths
          .filter((left) => successor.estimatedWritePaths.some((right) => repositoryPathsOverlap(left, right)));
        if (overlappingPaths.length === 0) continue;
        successor.dependencies = [...new Set([...successor.dependencies, predecessor.taskId])].sort();
        additions.push({
          stageNumber: stage.stageNumber,
          predecessorTaskId: predecessor.taskId,
          successorTaskId: successor.taskId,
          overlappingPaths: [...new Set(overlappingPaths.map(normalizeRepositoryPath))].sort(),
        });
      }
    }
  }
  return additions;
}
