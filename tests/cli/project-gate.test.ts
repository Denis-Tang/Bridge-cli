import { describe, it, expect } from 'vitest';
import { approveCommand } from '../../src/cli/commands/approve.js';
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { submitCommand } from '../../src/cli/commands/submit.js';
import { validateRealProjectExecution } from '../../src/core/real-project-gate.js';

/**
 * Tests for the --allow-real-project safety gate.
 * These validate the logic used in submit.ts without invoking the full CLI.
 */

describe('Real project gate', () => {
  it('allows paths under .brainctl-dev/', () => {
    const result = validateRealProjectExecution('/some/project/.brainctl-dev/fixtures/demo-repo', false);
    expect(result.allowed).toBe(true);
  });

  it('allows paths ending with .brainctl-dev', () => {
    const result = validateRealProjectExecution('/some/project/.brainctl-dev', false);
    expect(result.allowed).toBe(true);
  });

  it('denies real project paths without --allow-real-project', () => {
    const result = validateRealProjectExecution('D:/真实项目/my-project', false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('--allow-real-project');
  });

  it('allows real project paths with --allow-real-project', () => {
    const result = validateRealProjectExecution('D:/真实项目/my-project', true);
    expect(result.allowed).toBe(true);
  });

  it('denies empty project path', () => {
    const result = validateRealProjectExecution('', false);
    expect(result.allowed).toBe(false);
  });

  it('handles Windows backslashes in disposable path detection', () => {
    const result1 = validateRealProjectExecution('D:\\projects\\.brainctl-dev\\fixtures\\demo', false);
    expect(result1.allowed).toBe(true);

    const result2 = validateRealProjectExecution('D:\\real-project\\src', false);
    expect(result2.allowed).toBe(false);
  });

  it('exposes the real project gate on all real execution entrypoints', () => {
    for (const command of [submitCommand, approveCommand, resumeCommand]) {
      expect(command.options.some((option) => option.long === '--allow-real-project')).toBe(true);
    }
  });

  it('exposes explicit target branch selection on scheduler entrypoints', () => {
    for (const command of [approveCommand, resumeCommand]) {
      expect(command.options.some((option) => option.long === '--target-branch')).toBe(true);
    }
  });
});
