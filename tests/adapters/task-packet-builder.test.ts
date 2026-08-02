import { describe, expect, it } from 'vitest';
import { buildMinimalTaskPacket, buildRetryPacket } from '../../src/adapters/task-packet-builder.js';
import { buildPiWorkerMinimalPrompt, buildPiWorkerRetryPrompt } from '../../src/adapters/pi-worker-prompt.js';
import type { AttemptRecord, StructuredTaskSpec } from '../../src/types/m2-types.js';

const spec: StructuredTaskSpec = {
  taskId: 'T1', stageNumber: 1, title: 'bounded task', goal: 'change one file', dependencies: [],
  estimatedWritePaths: ['src/a.ts'], allowedPaths: ['src/'], forbiddenPaths: ['.env'],
  contextFiles: ['src/context.ts'], acceptanceChecks: ['npm test'], allowedCommands: ['npm test'],
  riskLevel: 'low', productDecisionsLocked: true, expectedOutputs: ['src/a.ts'],
  heavyCommandSlotsRequired: 0, timeoutSeconds: 60,
};

describe('task packet prompts', () => {
  it('bounds context while retaining immutable scope and commands', () => {
    const context = 'export const value = 1;\n' + 'do-not-copy-entire-file'.repeat(100);
    const { packet } = buildMinimalTaskPacket(spec, new Map([['src/context.ts', context]]), {
      maxContextFiles: 1, maxContextFileChars: 40, allowContextExpansion: false,
    });
    const prompt = buildPiWorkerMinimalPrompt(packet);
    expect(packet.contextFilesSummary[0].summary.length).toBeLessThanOrEqual(41);
    expect(prompt).toContain('`src/`');
    expect(prompt).toContain('`npm test`');
    expect(prompt).toContain('产品决策已锁定: 是');
    expect(prompt).not.toContain(context);
  });

  it('builds a retry-only prompt with findings, diff, and unchanged scope', () => {
    const previous = { taskId: 'T1', attemptNumber: 1, exitReason: 'qg_failed' } as AttemptRecord;
    const packet = buildRetryPacket(previous, 'quality gate failed', ['fix assertion'], '+corrected line', 'repair tests', spec);
    const prompt = buildPiWorkerRetryPrompt(packet);
    expect(prompt).toContain('quality gate failed');
    expect(prompt).toContain('fix assertion');
    expect(prompt).toContain('+corrected line');
    expect(prompt).toContain('`src/`');
    expect(prompt).toContain('`npm test`');
  });
});
