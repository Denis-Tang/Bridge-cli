import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFileCb);
import path from 'node:path';
import { buildMinimalSubprocessEnv } from '../privacy/env-allowlist.js';

/**
 * Result of a single quality gate check.
 */
export interface QualityGateResult {
  name: string;
  command: string;
  commandVector: string[];
  cwd: string;
  cwdDisplay: string;
  status: 'passed' | 'failed' | 'skipped' | 'timeout';
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

/**
 * Overall result of running all quality gates.
 */
export interface QualityGateRunResult {
  passed: boolean;
  results: QualityGateResult[];
  summary: string;
}

/**
 * Configuration for a quality gate command.
 */
export interface QualityGateConfig {
  name: string;
  command: string;
  args: string[];
  /** Working directory relative to project root, default '' */
  cwd?: string;
  /** Timeout in milliseconds, default 120000 (2 min) */
  timeoutMs?: number;
  /** Max lines to keep from stdout/stdr tail, default 20 */
  maxTailLines?: number;
  /** Max chars to keep from stdout/stdr tail, default 2000 */
  maxTailChars?: number;
  /**
   * @deprecated Shell-mode escape hatch.
   * Production quality gates SHALL only use command + args[] vector execution.
   * This field is ignored; shell execution is never allowed in quality gates.
   */
  shell?: boolean;
  /** Whether a failure stops the remaining gates. Defaults to true. */
  stopOnFail?: boolean;
}

/**
 * Quality Gate Runner - executes configured quality checks (test, build, lint).
 * Captures exit code, stdout tail, stderr tail with timeout support.
 */
export class QualityGateRunner {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Run a single quality gate check.
   */
  async runGate(config: QualityGateConfig): Promise<QualityGateResult> {
    const startTime = Date.now();
    const timeoutMs = config.timeoutMs ?? 120000;
    const maxTailLines = config.maxTailLines ?? 20;
    const maxTailChars = config.maxTailChars ?? 2000;
    const cwd = config.cwd
      ? this.resolvePath(config.cwd)
      : this.projectRoot;
    let commandVector = [config.command, ...config.args];
    let fullCommand = this.formatCommand(commandVector);
    const cwdDisplay = this.formatCwd(cwd);

    // Check if working directory exists
    if (!existsSync(cwd)) {
      return {
        name: config.name,
        command: fullCommand,
        commandVector,
        cwd,
        cwdDisplay,
        status: 'skipped',
        exitCode: null,
        stdoutTail: '',
        stderrTail: `Working directory does not exist: ${cwd}`,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const options = {
        cwd,
        encoding: 'utf-8' as const,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: 'pipe' as const,
      };

      // Quality gates always use argument vector (argv) execution.
      // Shell mode is strictly prohibited — no shell:true escape hatch.
      // Windows .cmd shims are resolved to trusted JS entry points
      // in resolveExecutable() and executed via node without shell.
      const resolved = this.resolveExecutable(config.command);
      const allArgs = [...resolved.args, ...config.args];
      commandVector = [resolved.command, ...allArgs];
      fullCommand = this.formatCommand(commandVector);
      const subprocessEnv = buildMinimalSubprocessEnv();
      const { stdout } = await execFileAsync(resolved.command, allArgs, {
        ...options,
        env: subprocessEnv,
        // Never shell:true — args[], only vector execution.
        shell: false,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const durationMs = Date.now() - startTime;

      return {
        name: config.name,
        command: fullCommand,
        commandVector,
        cwd,
        cwdDisplay,
        status: 'passed',
        exitCode: 0,
        stdoutTail: this.truncateTail(String(stdout), maxTailLines, maxTailChars),
        stderrTail: '',
        durationMs,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const error = err as Error & { stderr?: unknown; stdout?: unknown; status?: number; code?: string };

      // Detect timeout (AbortError from AbortSignal, or legacy ETIMEDOUT)
      const errMsg = error.message ?? '';
      const isTimeout = error.name === 'AbortError' ||
        errMsg.includes('timed out') ||
        errMsg.includes('ETIMEDOUT') ||
        error.code === 'ETIMEDOUT' ||
        errMsg.includes('TIMEOUT') ||
        errMsg.includes('aborted');

      if (isTimeout) {
        const stdOut = typeof error.stdout === 'string' ? error.stdout : '';
        const stdErr = typeof error.stderr === 'string' ? error.stderr : `Command timed out after ${timeoutMs}ms`;
        return {
          name: config.name,
          command: fullCommand,
          commandVector,
          cwd,
          cwdDisplay,
          status: 'timeout',
          exitCode: null,
          stdoutTail: this.truncateTail(stdOut, maxTailLines, maxTailChars),
          stderrTail: this.truncateTail(stdErr, maxTailLines, maxTailChars),
          durationMs,
        };
      }

      const failStdOut = typeof error.stdout === 'string' ? error.stdout : '';
      const failStdErr = typeof error.stderr === 'string' ? error.stderr : (error.message ?? 'Unknown error');
      return {
        name: config.name,
        command: fullCommand,
        commandVector,
        cwd,
        cwdDisplay,
        status: 'failed',
        exitCode: error.status ?? 1,
        stdoutTail: this.truncateTail(failStdOut, maxTailLines, maxTailChars),
        stderrTail: this.truncateTail(failStdErr, maxTailLines, maxTailChars),
        durationMs,
      };
    }
  }

  /**
   * Run multiple quality gates and return the aggregated result.
   * Stops on first failure if stopOnFail is true.
   */
  async runGates(gates: QualityGateConfig[], stopOnFail: boolean = true): Promise<QualityGateRunResult> {
    const results: QualityGateResult[] = [];
    let allPassed = true;

    for (const gate of gates) {
      const result = await this.runGate(gate);
      results.push(result);

      if (result.status !== 'passed') {
        allPassed = false;
        if (gate.stopOnFail ?? stopOnFail) {
          break;
        }
      }
    }

    const passedCount = results.filter((r) => r.status === 'passed').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;
    const timeoutCount = results.filter((r) => r.status === 'timeout').length;

    const summaryParts: string[] = [];
    if (passedCount > 0) summaryParts.push(`${passedCount} passed`);
    if (failedCount > 0) summaryParts.push(`${failedCount} failed`);
    if (skippedCount > 0) summaryParts.push(`${skippedCount} skipped`);
    if (timeoutCount > 0) summaryParts.push(`${timeoutCount} timed out`);

    return {
      passed: allPassed,
      results,
      summary: summaryParts.length > 0
        ? `Quality gates: ${summaryParts.join(', ')}`
        : 'No quality gates configured',
    };
  }

  /**
   * Truncate output to the last N lines and last M chars.
   */
  private truncateTail(output: string, maxLines: number, maxChars: number): string {
    if (!output) return '';

    const lines = output.split('\n');
    const tailLines = lines.slice(-maxLines);
    let result = tailLines.join('\n');

    if (result.length > maxChars) {
      result = '...(truncated)' + result.slice(-maxChars + 13);
    }

    return result;
  }

  /**
   * Resolve a path relative to the project root.
   */
  private resolvePath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }
    return path.join(this.projectRoot, relativePath);
  }

  private resolveExecutable(command: string): { command: string; args: string[] } {
    const ext = path.extname(command);
    // If the command already has a known non-shim extension (.exe, .js, etc.), use as-is
    if (ext && ext !== '.cmd' && ext !== '.bat') {
      return { command, args: [] };
    }

    // On non-Windows, no shim resolution needed
    if (process.platform !== 'win32') {
      return { command, args: [] };
    }

    // If the command does not look like a Windows shim (no extension or not .cmd/.bat),
    // and it's not one of the known shim names, return as-is.
    const lower = command.toLowerCase();
    const SHIM_NAMES = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsx', 'tsc']);
    if (!SHIM_NAMES.has(lower)) {
      // Not a known shim — pass through as-is (e.g., node, python, cargo, git)
      return { command, args: [] };
    }

    // Windows .cmd shim resolution: resolve to trusted JS entry points
    // instead of using shell:true. If resolution fails, fail closed.
    const nodeDir = path.dirname(process.execPath);

    const jsEntryCandidates: Record<string, string[]> = {
      npm: [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')],
      npx: [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')],
      pnpm: [
        path.join(nodeDir, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
        path.join(nodeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      ],
      yarn: [
        path.join(nodeDir, 'node_modules', 'corepack', 'dist', 'yarn.js'),
        path.join(nodeDir, 'node_modules', 'yarn', 'bin', 'yarn.js'),
      ],
    };

    if (jsEntryCandidates[lower]) {
      for (const entry of jsEntryCandidates[lower]) {
        if (existsSync(entry)) {
          return { command: process.execPath, args: [entry] };
        }
      }
      throw new Error(
        `Cannot safely resolve Windows shim '${command}' to a trusted JavaScript entry point.`,
      );
    }

    // tsx and tsc: resolve via node_modules/.bin in the project root.
    // These are project-local tools. Fail closed — recommend npx.
    if (lower === 'tsx' || lower === 'tsc') {
      throw new Error(
        `Cannot safely execute '${command}.cmd' without shell. ` +
        `Use 'npx ${command}' instead, or configure the full path to node_modules/.bin/${command}.`
      );
    }

    // Should not reach here (all SHIM_NAMES are handled above).
    return { command, args: [] };
  }

  private formatCommand(commandVector: string[]): string {
    return JSON.stringify(commandVector);
  }

  private formatCwd(cwd: string): string {
    const rel = path.relative(this.projectRoot, cwd);
    if (!rel) return '.';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '<outside-project>';
    return rel.replace(/\\/g, '/');
  }
}
