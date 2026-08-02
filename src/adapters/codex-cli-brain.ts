import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StructuredPlan, StructuredTaskSpec } from '../types/m2-types.js';
import type { LedgerSink, InvocationContext } from '../core/token-telemetry.js';
import { estimateForCallType } from '../core/token-telemetry.js';
import type { CodexProcessRunner } from './codex-process-runner.js';
import { RealCodexProcessRunner } from './codex-process-runner.js';

/**
 * Configuration for Codex CLI Brain provider.
 */
export interface CodexCliBrainConfig {
  /** Timeout in ms for Codex CLI calls (default: 180s) */
  timeoutMs: number;
  /** Working directory for Codex CLI planning */
  workDir: string;
  /** Session/log directory for planning artifacts */
  sessionDir: string;
  /** Whether to actually call Codex CLI (default: false for safety) */
  allowRealPlanning: boolean;
}

/**
 * Result from the brain planning process.
 */
export interface BrainPlanResult {
  success: boolean;
  plan: StructuredPlan | null;
  rawOutput: string;
  errors: string[];
}

const DEFAULT_CONFIG: CodexCliBrainConfig = {
  timeoutMs: 180_000,
  workDir: process.cwd(),
  sessionDir: '.brainctl-dev/plan-logs',
  allowRealPlanning: false,
};

/**
 * CodexCliBrain — generates structured stage plans using Codex CLI.
 * Uses a prompt template to request JSON-structured plan output.
 *
 * M4: Accepts optional LedgerSink + InvocationContext for token telemetry.
 * Governance OFF → no Sink → no ledger writes.
 */
export class CodexCliBrain {
  private config: CodexCliBrainConfig;
  private processRunner: CodexProcessRunner;
  private ledgerSink: LedgerSink | null;
  private invocationContext: InvocationContext | null;

  constructor(
    config?: Partial<CodexCliBrainConfig>,
    options?: {
      processRunner?: CodexProcessRunner;
      ledgerSink?: LedgerSink | null;
      invocationContext?: InvocationContext | null;
    },
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.processRunner = options?.processRunner ?? new RealCodexProcessRunner();
    this.ledgerSink = options?.ledgerSink ?? null;
    this.invocationContext = options?.invocationContext ?? null;
  }

  /**
   * Set a ledger sink for token telemetry (M4 governance).
   * Returns this for chaining.
   */
  withLedger(sink: LedgerSink | null, ctx: InvocationContext | null): this {
    this.ledgerSink = sink;
    this.invocationContext = ctx;
    return this;
  }

  /**
   * Generate a structured plan from a natural language request.
   */
  async generatePlan(request: string, runId: string): Promise<BrainPlanResult> {
    mkdirSync(this.config.sessionDir, { recursive: true });

    const planPrompt = this.buildPlanPrompt(request, runId);
    const promptPath = resolve(this.config.sessionDir, `${runId}_plan-prompt.txt`);
    writeFileSync(promptPath, planPrompt, 'utf-8');

    if (!this.config.allowRealPlanning) {
      return {
        success: false,
        plan: null,
        rawOutput: '',
        errors: ['Real Codex CLI planning not enabled (allowRealPlanning=false). Cannot generate plan.'],
      };
    }

    // ── M4: Write estimate BEFORE calling external process ──
    let entryId: string | null = null;
    const ctx = this.invocationContext;
    const sink = this.ledgerSink;
    if (sink && ctx) {
      const est = estimateForCallType('codex_plan', { requestText: request });
      try {
        entryId = await sink.writeEstimate(ctx, est.total, est.input, est.output, planPrompt);
      } catch {
        // Sink failure must not change business semantics
      }
    }

    const startTime = Date.now();
    try {
      const result = await this.processRunner.run('codex', [
        'exec',
        '--ephemeral',
        '--sandbox',
        'read-only',
        '--ignore-user-config',
        '--ignore-rules',
        '-',
      ], {
        cwd: this.config.workDir,
        timeoutMs: this.config.timeoutMs,
        input: planPrompt,
        maxBuffer: 10 * 1024 * 1024,
      });

      const planPath = resolve(this.config.sessionDir, `${runId}_plan-output.txt`);
      writeFileSync(planPath, result.stdout, 'utf-8');

      const parsed = this.tryParsePlan(result.stdout, request, runId);

      // ── M4: Update ledger entry after call ──
      if (sink && entryId) {
        const durationMs = Date.now() - startTime;
        if (result.tokenUsage) {
          // Trusted structured provider metadata → confirmed actual
          try {
            await sink.confirmActual(
              entryId,
              result.tokenUsage.inputTokens + result.tokenUsage.outputTokens + (result.tokenUsage.cacheHitTokens || 0),
              result.tokenUsage.inputTokens,
              result.tokenUsage.outputTokens,
              result.tokenUsage.cacheHitTokens || 0,
              durationMs,
            );
          } catch { /* sink failure must not change semantics */ }
        } else {
          // No reliable usage metadata → unavailable (preserves estimate)
          try {
            await sink.markUnavailable(entryId, durationMs);
          } catch { /* sink failure must not change semantics */ }
        }
      }

      return parsed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // ── M4: Mark unavailable on call failure ──
      if (sink && entryId) {
        try {
          await sink.markUnavailable(entryId, Date.now() - startTime);
        } catch { /* sink failure must not change semantics */ }
      }

      return {
        success: false,
        plan: null,
        rawOutput: '',
        errors: ['Codex CLI call failed: ' + errMsg],
      };
    }
  }

  /**
   * Build a plan prompt asking Codex CLI for a structured JSON plan.
   */
  private buildPlanPrompt(request: string, runId: string): string {
    return `You are a software planning assistant. Given a request, create a structured implementation plan.

Request: "${request}"

Output a JSON plan with stages, tasks, and dependencies using EXACTLY this format:

\`\`\`json
{
  "jobId": "${runId}",
  "summary": "Brief summary of what needs to be done",
  "stages": [
    {
      "stageNumber": 1,
      "title": "Stage title",
      "tasks": ["task-1", "task-2"]
    }
  ],
  "tasks": [
    {
      "taskId": "task-1",
      "stageNumber": 1,
      "title": "Task title",
      "goal": "What this task accomplishes",
      "dependencies": [],
      "estimatedWritePaths": ["src/file.ts"],
      "allowedPaths": ["src/"],
      "forbiddenPaths": [".env"],
      "contextFiles": [],
      "acceptanceChecks": ["Task completes the goal"],
      "allowedCommands": ["git diff", "git add", "git commit", "node", "npm"],
      "riskLevel": "low",
      "productDecisionsLocked": true,
      "expectedOutputs": [],
      "heavyCommandSlotsRequired": 0,
      "timeoutSeconds": 120
    }
  ],
  "riskAssessment": {
    "level": "low",
    "notes": ["No significant risks identified"]
  }
}
\`\`\`

Rules:
- Each stage groups tasks that can run in parallel.
- Stage barriers already make every later stage wait for all earlier stages; do not encode that order in task dependencies.
- A task's dependencies array MUST contain only task IDs from the same stage. Use [] when it has no same-stage dependency. NEVER list a task from an earlier or later stage.
- Within a stage, tasks with same-stage explicit dependencies must wait.
- estimatedWritePaths must list ALL files the task will likely modify.
- Multiple tasks must NOT write to the same file in the same stage.
- allowedPaths limits which directories the worker can modify.
- Output ONLY the JSON block, no other text.`;
  }

  /**
   * Try to parse structured plan from Codex CLI output.
   */
  private tryParsePlan(output: string, request: string, runId: string): BrainPlanResult {
    // Try to extract JSON from code block
    const jsonMatch = output.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : output;

    try {
      const plan = JSON.parse(jsonStr) as StructuredPlan;
      // Validate basic structure
      if (!plan.stages || !plan.tasks || plan.stages.length === 0) {
        return {
          success: false,
          plan: null,
          rawOutput: output,
          errors: ['Codex output missing stages/tasks fields'],
        };
      }
      return { success: true, plan, rawOutput: output, errors: [] };
    } catch {
      return {
        success: false,
        plan: null,
        rawOutput: output,
        errors: ['Failed to parse Codex output as valid JSON'],
      };
    }
  }

  /**
   * Build a fallback single-stage plan when Codex is unavailable.
   */
  private buildFallbackPlan(request: string, runId: string): StructuredPlan {
    return {
      jobId: runId,
      summary: `Implement: ${request.substring(0, 100)}`,
      stages: [
        {
          stageNumber: 1,
          title: 'Primary Implementation',
          tasks: ['task-main'],
        },
      ],
      tasks: [
        {
          taskId: 'task-main',
          stageNumber: 1,
          title: 'Main task',
          goal: request,
          dependencies: [],
          estimatedWritePaths: ['src/'],
          allowedPaths: ['src/'],
          forbiddenPaths: ['.env', '.env.*', 'node_modules/'],
          contextFiles: [],
          acceptanceChecks: ['Task completes the request'],
          allowedCommands: ['git diff', 'git add', 'git commit', 'node', 'npm'],
          riskLevel: 'low',
          productDecisionsLocked: true,
          expectedOutputs: [],
          heavyCommandSlotsRequired: 0,
          timeoutSeconds: 120,
        },
      ],
      riskAssessment: {
        level: 'low',
        notes: ['Single-stage fallback plan (Codex CLI planning not available)'],
      },
    };
  }
}
