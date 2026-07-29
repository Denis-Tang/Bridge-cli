import type { QualityGateItem } from '../adapters/project-adapter.js';
import type { QualityGateConfig } from './quality-gate-runner.js';

export interface ParsedQualityGates {
  task: QualityGateConfig[];
  stage: QualityGateConfig[];
}

export interface QualityGateValidationError {
  path: string;
  message: string;
}

function hasPathEscape(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split('/').some((part) => part === '..');
}

function validateGate(gate: QualityGateItem, pathPrefix: string): QualityGateValidationError[] {
  const errors: QualityGateValidationError[] = [];

  if (!gate.command || gate.command.trim().length === 0) {
    errors.push({ path: `${pathPrefix}.${gate.name || '?'}.command`, message: 'command is required' });
  }

  if (gate.timeoutMs !== undefined && gate.timeoutMs <= 0) {
    errors.push({ path: `${pathPrefix}.${gate.name || '?'}.timeoutMs`, message: 'timeoutMs must be > 0' });
  }

  if (gate.cwd && hasPathEscape(gate.cwd)) {
    errors.push({ path: `${pathPrefix}.${gate.name || '?'}.cwd`, message: 'cwd must be relative to project root' });
  }

  if (!gate.args || !Array.isArray(gate.args)) {
    errors.push({ path: `${pathPrefix}.${gate.name || '?'}.args`, message: 'args must be an array' });
  }

  return errors;
}

export function parseQualityGates(qualityGates: { task?: QualityGateItem[]; stage?: QualityGateItem[] } | undefined): {
  gates: ParsedQualityGates;
  errors: QualityGateValidationError[];
} {
  const gates: ParsedQualityGates = { task: [], stage: [] };
  const errors: QualityGateValidationError[] = [];

  const input = qualityGates || {};

  for (const gate of input.task ?? []) {
    errors.push(...validateGate(gate, 'qualityGates.task'));
    gates.task.push({
      name: gate.name,
      command: gate.command,
      args: gate.args ?? [],
      cwd: gate.cwd,
      timeoutMs: gate.timeoutMs,
      stopOnFail: gate.stopOnFail,
    });
  }

  for (const gate of input.stage ?? []) {
    errors.push(...validateGate(gate, 'qualityGates.stage'));
    gates.stage.push({
      name: gate.name,
      command: gate.command,
      args: gate.args ?? [],
      cwd: gate.cwd,
      timeoutMs: gate.timeoutMs,
      stopOnFail: gate.stopOnFail,
    });
  }

  return { gates, errors };
}

export function qualityGatesToRunnerConfig(gates: QualityGateItem[]): QualityGateConfig[] {
  return gates.map((gate) => ({
    name: gate.name,
    command: gate.command,
    args: gate.args ?? [],
    cwd: gate.cwd,
    timeoutMs: gate.timeoutMs ?? 120000,
    stopOnFail: gate.stopOnFail,
  }));
}

export function assertValidQualityGates(qualityGates: { task?: QualityGateItem[]; stage?: QualityGateItem[] } | undefined): ParsedQualityGates {
  const { gates, errors } = parseQualityGates(qualityGates);
  if (errors.length > 0) {
    const summary = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`Quality gate validation failed: ${summary}`);
  }
  return gates;
}
