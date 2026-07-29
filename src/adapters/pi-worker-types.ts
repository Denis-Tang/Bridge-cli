import type { TaskSpec, WorkerResult } from '../types/protocol.js';
import type { TechnicalClarificationResponder } from './pi-clarification.js';

/**
 * Configuration for a Pi RPC Worker.
 */
export interface PiWorkerConfig {
  workerId: string;
  /** Pi CLI command, default "pi" */
  command: string;
  /** CLI args, default ["--mode", "rpc", "--no-session"] */
  args: string[];
  /** Optional configured model identifier. If not set, Pi uses its own default. */
  model?: string;
  /** Working directory for the Pi process */
  workingDirectory: string;
  /** Directory to store session logs */
  sessionDirectory: string;
  /** Path to write the raw log file */
  rawLogPath: string;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Additional environment variables */
  env?: Record<string, string | undefined>;
  /** Allow real Pi process execution (default: false for safety) */
  allowRealPiExecution: boolean;
  /** Called immediately after the controlled Pi process has a PID. */
  onProcessSpawn?: (pid: number) => void | Promise<void>;
  /** Enforce the read-only 95% understanding gate before implementation. */
  requireClarification?: boolean;
  /** Codex responder for technical-only questions. Required when clarification is enabled. */
  clarificationResponder?: TechnicalClarificationResponder;
}

/**
 * Input for a Pi worker task execution.
 */
export interface PiWorkerTaskInput {
  taskSpec: TaskSpec;
  worktreePath: string;
  runId: string;
}

/**
 * Result of a Pi worker execution attempt.
 */
export interface PiWorkerExecutionResult {
  workerResult: WorkerResult | null;
  /** Usage reported by Pi's provider-backed JSONL events, never agent self-report. */
  providerUsage: PiProviderUsage | null;
  rawLogPath: string;
  pid: number | null;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  errorMessage?: string;
}

/** Numeric-only provider telemetry safe to persist in logs and reports. */
export interface PiProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costTotal: number;
}

/**
 * Abstract process runner interface.
 * Allows mocking Pi subprocess in tests.
 */
export interface ProcessRunner {
  run(input: ProcessRunInput): Promise<ProcessRunResult>;
}

/**
 * Signal for early completion: the runner should terminate the process and return the result.
 */
export interface ProcessEarlyCompletion {
  /** Why the process should be terminated early */
  reason: 'worker_result_found' | 'user_abort';
  /** Whether to kill the child process */
  terminateProcess: boolean;
}

export interface ProcessRunInput {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  stdin?: string;
  /**
   * Optional callback invoked on each stdout/stderr chunk.
   * Return a ProcessEarlyCompletion to terminate the process early.
   */
  onStdoutChunk?: (chunk: string, accumulatedStdout: string) => ProcessEarlyCompletion | void;
  onStderrChunk?: (chunk: string, accumulatedStderr: string) => ProcessEarlyCompletion | void;
  onSpawn?: (pid: number) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ProcessRunResult {
  pid: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  terminatedAfterWorkerResult: boolean;
  durationMs: number;
}
