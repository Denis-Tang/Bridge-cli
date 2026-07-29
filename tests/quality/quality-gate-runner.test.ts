import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QualityGateRunner, QualityGateConfig } from '../../src/quality/quality-gate-runner.js';

let tmpDir: string;
let projectDir: string;
let runner: QualityGateRunner;

describe('QualityGateRunner', () => {
  beforeAll(() => {
    tmpDir = path.join(tmpdir(), `brainctl-qg-test-${Date.now()}`);
    projectDir = path.join(tmpDir, 'test-project');
    mkdirSync(projectDir, { recursive: true });

    // Create a minimal Node.js project for testing
    writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      packageManager: 'pnpm@11.9.0',
      scripts: {
        test: 'echo "Tests passed"',
        build: 'echo "Build ok" && exit 0',
        fail: 'echo "Tests failed" && exit 1',
        lint: 'exit 0',
      },
    }));

    runner = new QualityGateRunner(projectDir);
  });

  afterAll(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('runGate', () => {
    it('passes a successful command', async () => {
      const config: QualityGateConfig = {
        name: 'test',
        command: 'node',
        args: ['-e', 'console.log("ok")'],
        timeoutMs: 5000,
      };

      const result = await runner.runGate(config);
      expect(result.status).toBe('passed');
      expect(result.exitCode).toBe(0);
      expect(result.stdoutTail).toContain('ok');
      expect(result.commandVector).toEqual(['node', '-e', 'console.log("ok")']);
      expect(result.cwdDisplay).toBe('.');
    });

    it('runs relative cwd against the runner root worktree', async () => {
      mkdirSync(path.join(projectDir, 'attempt-wt'), { recursive: true });
      writeFileSync(path.join(projectDir, 'attempt-wt', 'attempt-only.txt'), 'ok');
      const mainRunner = new QualityGateRunner(projectDir);
      const result = await mainRunner.runGate({
        name: 'QG-WT-01',
        command: 'node',
        args: ['-e', 'process.exit(require("node:fs").existsSync("attempt-only.txt") ? 0 : 1)'],
        cwd: 'attempt-wt',
        timeoutMs: 5000,
      });
      expect(result.status).toBe('passed');
      expect(result.cwdDisplay).toBe('attempt-wt');
    });

    it('passes metacharacters as plain argv in vector mode', async () => {
      const payload = 'quoted & | > < ( )\n--not-a-flag';
      const result = await runner.runGate({
        name: 'PROC-01',
        command: 'node',
        args: ['-e', 'console.log(process.argv[1])', payload],
        timeoutMs: 5000,
      });
      expect(result.status).toBe('passed');
      expect(result.stdoutTail).toContain(payload);
    });

    it('shell flag is ignored — all gates use vector execution only', async () => {
      // The shell field is deprecated; even when set to true, the runner
      // uses execFile (argv) mode. The command should run normally.
      const result = await runner.runGate({
        name: 'shell-ignored',
        command: 'node',
        args: ['-e', 'console.log("ok")'],
        shell: true,
        timeoutMs: 5000,
      });
      expect(result.status).toBe('passed');
      expect(result.exitCode).toBe(0);
    });

    it('quality gate subprocess runs without provider keys', async () => {
      const result = await runner.runGate({
        name: 'no-provider-env',
        command: 'node',
        args: ['-e', 'const k = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY; process.exit(k ? 1 : 0)'],
        timeoutMs: 5000,
      });
      // Should pass because no Provider keys are in the minimal env
      expect(result.status).toBe('passed');
      expect(result.exitCode).toBe(0);
    });

    it('fails a failing command', async () => {
      const config: QualityGateConfig = {
        name: 'fail',
        command: 'node',
        args: ['-e', 'process.exit(1)'],
        timeoutMs: 5000,
      };

      const result = await runner.runGate(config);
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    });

    it('times out a slow command', async () => {
      const config: QualityGateConfig = {
        name: 'timeout',
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        timeoutMs: 500,
      };

      const result = await runner.runGate(config);
      expect(result.status).toBe('timeout');
    });

    it('skips when working directory does not exist', async () => {
      const config: QualityGateConfig = {
        name: 'nonexistent',
        command: 'echo',
        args: ['hello'],
        cwd: '/nonexistent/path/that/does/not/exist',
      };

      const result = await runner.runGate(config);
      expect(result.status).toBe('skipped');
      expect(result.stderrTail).toContain('does not exist');
    });

    it('passes all shell metacharacters as literal argv without side effects', async () => {
      // Each payload is a distinct injection vector that must remain
      // literal — no command chaining, piping, or substitution.
      const attackVectors = [
        { name: 'amp-amp', payload: 'safe && echo pwned' },
        { name: 'pipe-pipe', payload: 'safe || echo pwned' },
        { name: 'semicolon', payload: 'safe; echo pwned' },
        { name: 'pipe', payload: 'safe | echo pwned' },
        { name: 'redirect-out', payload: 'safe > /tmp/pwned' },
        { name: 'redirect-in', payload: 'safe < /etc/passwd' },
        { name: 'dollar-sub', payload: 'safe $(whoami)' },
        { name: 'backtick', payload: 'safe `whoami`' },
        { name: 'background', payload: 'safe & echo pwned' },
        { name: 'ps-subexpr', payload: 'safe $(Get-Content secret.txt)' },
        { name: 'percent-var', payload: 'safe %USERPROFILE%' },
        { name: 'brace-sub', payload: 'safe ${HOME}' },
        { name: 'at-subexpr', payload: 'safe @(1,2)' },
      ];

      for (const vec of attackVectors) {
        const result = await runner.runGate({
          name: `attack-${vec.name}`,
          command: 'node',
          args: ['-e', 'console.log(process.argv[1])', vec.payload],
          timeoutMs: 5000,
        });
        // Must pass — the payload is a literal arg, not a command
        expect(result.status, vec.name).toBe('passed');
        // The output must contain the exact payload as-is (no shell interpretation)
        expect(result.stdoutTail, vec.name).toContain(vec.payload);
      }
    });

    it('never uses shell mode — no cmd.exe /c wrapper', async () => {
      // Exec with args containing '<' and '>' which in shell mode
      // would be redirection. Must pass as literal strings.
      const payload = '<redirect> & pipe|test';
      const result = await runner.runGate({
        name: 'no-shell-mode',
        command: 'node',
        args: ['-e', 'console.log(process.argv[1])', payload],
        timeoutMs: 5000,
      });
      expect(result.status).toBe('passed');
      expect(result.stdoutTail.trim()).toContain('<redirect> & pipe|test');
    });

    it('Windows CMD variable expansion %VAR% is literal in argv mode', async () => {
      const result = await runner.runGate({
        name: 'win-cmd-var',
        command: 'node',
        args: ['-e', 'console.log(process.argv[1])', '%USERPROFILE%\\evil'],
        timeoutMs: 5000,
      });
      expect(result.status).toBe('passed');
      expect(result.stdoutTail).toContain('%USERPROFILE%\\evil');
    });

    it.runIf(process.platform === 'win32')('resolves Corepack pnpm without shell', async () => {
      const result = await runner.runGate({
        name: 'windows-corepack-pnpm',
        command: 'pnpm',
        args: ['--version'],
        timeoutMs: 10000,
      });

      expect(result.status).toBe('passed');
      expect(result.commandVector[0]).toBe(process.execPath);
      expect(result.commandVector[1].replace(/\\/g, '/')).toContain('/corepack/dist/pnpm.js');
    });

    it('captures stdout tail', async () => {
      const config: QualityGateConfig = {
        name: 'long-output',
        command: 'node',
        args: ['-e', 'for(let i=0;i<100;i++) console.log("line "+i)'],
        timeoutMs: 5000,
        maxTailLines: 5,
      };

      const result = await runner.runGate(config);
      expect(result.status).toBe('passed');
      const lines = result.stdoutTail.split('\n');
      expect(lines.length).toBeLessThanOrEqual(6); // 5 tail lines
      expect(result.stdoutTail).toContain('line 99'); // should have the last lines
    });
  });

  describe('runGates', () => {
    it('runs multiple gates and aggregates results', async () => {
      const gates: QualityGateConfig[] = [
        { name: 'gate1', command: 'node', args: ['-e', 'console.log("ok")'], timeoutMs: 5000 },
        { name: 'gate2', command: 'node', args: ['-e', 'console.log("ok2")'], timeoutMs: 5000 },
      ];

      const result = await runner.runGates(gates, false);
      expect(result.passed).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].status).toBe('passed');
      expect(result.results[1].status).toBe('passed');
    });

    it('stops on first failure when stopOnFail is true', async () => {
      const gates: QualityGateConfig[] = [
        { name: 'ok', command: 'node', args: ['-e', 'console.log("ok")'], timeoutMs: 5000 },
        { name: 'fail', command: 'node', args: ['-e', 'process.exit(1)'], timeoutMs: 5000 },
        { name: 'should-not-run', command: 'node', args: ['-e', 'console.log("should not run")'], timeoutMs: 5000 },
      ];

      const result = await runner.runGates(gates, true);
      expect(result.passed).toBe(false);
      expect(result.results).toHaveLength(2); // stopped after first failure
    });

    it('continues after failure when stopOnFail is false', async () => {
      const gates: QualityGateConfig[] = [
        { name: 'ok', command: 'node', args: ['-e', 'console.log("ok")'], timeoutMs: 5000 },
        { name: 'fail', command: 'node', args: ['-e', 'process.exit(1)'], timeoutMs: 5000 },
        { name: 'also-ok', command: 'node', args: ['-e', 'console.log("ok2")'], timeoutMs: 5000 },
      ];

      const result = await runner.runGates(gates, false);
      expect(result.passed).toBe(false);
      expect(result.results).toHaveLength(3);
    });

    it('returns passed for empty gates list', async () => {
      const result = await runner.runGates([], false);
      expect(result.passed).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  describe('truncateTail (via std output)', () => {
    it('truncates very long stdout', async () => {
      const config: QualityGateConfig = {
        name: 'long',
        command: 'node',
        args: ['-e', 'console.log("x".repeat(5000))'],
        timeoutMs: 5000,
        maxTailChars: 100,
      };

      const result = await runner.runGate(config);
      expect(result.stdoutTail.length).toBeLessThanOrEqual(113); // 100 chars + "(truncated)" prefix
      expect(result.stdoutTail).toContain('(truncated)');
    });
  });
});
