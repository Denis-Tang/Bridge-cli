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
  /** R3: guard self-check hooks (zero-inference probe before real clarification). */
  guardSelfCheck?: {
    enabled?: boolean;
    markerDir?: string;
    timeoutMs?: number;
    verifiedPiVersion?: string;
    /** Injectable runner for tests; omitted → real Pi spawn (zero-inference probe). */
    runner?: import('./pi-worker-types.js').ProcessRunner;
    /** Reports the self-check outcome (audit sink; e.g. scheduler writes SQLite event). */
    onResult?: (result: import('./pi-guard-selfcheck.js').GuardSelfCheckResult) => void | Promise<void>;
    /** B (authorized): block-semantics probe — ONE minimal inference, cost-gated. */
    inferenceProbe?: {
      enabled?: boolean;
      model?: string;
      timeoutMs?: number;
      runner?: import('./pi-worker-types.js').ProcessRunner;
      reserveCost?: () => Promise<{ allowed: boolean; reason?: string }>;
      settleCost?: (outcome: 'released' | 'unavailable', terminationEvidence: string) => Promise<boolean>;
      cacheGet?: (piVersion: string) => Promise<{ outcome: string; failureCategory: string | null; checkedAt: string } | null>;
      cacheSet?: (piVersion: string, outcome: string, failureCategory: string | null) => Promise<void>;
      onResult?: (result: import('./pi-guard-block-probe.js').GuardBlockProbeResult) => void | Promise<void>;
    };
  };
}

/**
 * Input for a Pi worker task execution.
 */
export interface PiWorkerTaskInput {
  taskSpec: TaskSpec;
  /** Optional bounded implementation prompt. Clarification still uses the full immutable TaskSpec. */
  implementationPrompt?: string;
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
  reason: 'worker_result_found' | 'worker_result_invalid' | 'user_abort';
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
  /** Keep only the newest N stdout characters in ProcessRunResult. */
  maxCapturedStdoutChars?: number;
  /** Keep only the newest N stderr characters in ProcessRunResult. */
  maxCapturedStderrChars?: number;
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
  /** Total characters observed before bounded capture was applied. */
  stdoutLength?: number;
  /** Total characters observed before bounded capture was applied. */
  stderrLength?: number;
  timedOut: boolean;
  aborted: boolean;
  terminatedAfterWorkerResult: boolean;
  durationMs: number;
}
