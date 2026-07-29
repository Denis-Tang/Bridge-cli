import { isDisposableProject } from './decision-gate.js';

export interface RealProjectExecutionGate {
  allowed: boolean;
  isDisposable: boolean;
  reason?: string;
}

export function validateRealProjectExecution(
  projectRoot: string,
  allowRealProject: boolean,
): RealProjectExecutionGate {
  if (!projectRoot || projectRoot.trim().length === 0) {
    return {
      allowed: false,
      isDisposable: false,
      reason: '目标项目路径为空。',
    };
  }

  const isDisposable = isDisposableProject(projectRoot);
  if (isDisposable || allowRealProject) {
    return { allowed: true, isDisposable };
  }

  return {
    allowed: false,
    isDisposable,
    reason: '目标项目不是 disposable 项目路径。如需对真实项目执行，请添加 --allow-real-project 参数。',
  };
}
