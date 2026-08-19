import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerResult } from '../types/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Result of parsing a WorkerResult from raw output.
 */
export interface ParseResult {
  success: boolean;
  workerResult: WorkerResult | null;
  errors: string[];
}

// Lazy-load schema validator
let _validate: ((data: unknown) => boolean) | null = null;
let _ajvErrors: string[] = [];

function getValidator(): (data: unknown) => boolean {
  if (!_validate) {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    try {
      const schemaPath = resolve(__dirname, '../../src/schemas/worker-result.schema.json');
      const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
      _validate = ajv.compile(schema);
    } catch (err) {
      throw new Error(
        `Failed to load worker-result schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return _validate;
}

/**
 * Extract a WorkerResult JSON from raw Pi output.
 * Priority: marked block > last JSON object fallback.
 */
export function parseWorkerResult(rawOutput: string): ParseResult {
  const errors: string[] = [];

  // Strategy 1: Find marked block
  const markedResult = extractFromMarkedBlock(rawOutput);
  if (markedResult) {
    return validateAndReturn(markedResult, errors);
  }

  errors.push('No BEGIN_WORKER_RESULT_JSON/END_WORKER_RESULT_JSON markers found');

  // Strategy 2: Try to parse the last JSON object
  const jsonFallback = extractLastJsonObject(rawOutput);
  if (jsonFallback) {
    return validateAndReturn(jsonFallback, errors);
  }

  errors.push('No valid JSON found in output');
  return { success: false, workerResult: null, errors };
}

/**
 * Lenient extraction: return the raw WorkerResult-shaped object WITHOUT schema
 * validation. Used by callers that need to inspect status/commitHash before
 * deciding whether evidence (e.g. worktree HEAD) can complete the result.
 */
export function extractWorkerResultObject(rawOutput: string): unknown | null {
  const marked = extractFromMarkedBlock(rawOutput);
  if (marked) return marked;
  return extractLastJsonObject(rawOutput);
}

/**
 * Extract JSON from between BEGIN_WORKER_RESULT_JSON and END_WORKER_RESULT_JSON markers.
 * Tolerates the model literally quoting the prompt's marker instruction with
 * backticks (`` `BEGIN_WORKER_RESULT_JSON` `` … `` `END_WORKER_RESULT_JSON` ``).
 */
function extractFromMarkedBlock(output: string): unknown | null {
  const beginMarker = 'BEGIN_WORKER_RESULT_JSON';
  const endMarker = 'END_WORKER_RESULT_JSON';

  const startIdx = output.lastIndexOf(beginMarker);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + beginMarker.length;
  const endIdx = output.indexOf(endMarker, jsonStart);
  if (endIdx === -1) return null;

  // Strip markdown backticks the model may have wrapped around the markers.
  let jsonStr = output.slice(jsonStart, endIdx).trim();
  jsonStr = jsonStr.replace(/^`+/, '').replace(/`+$/, '').trim();
  if (!jsonStr) return null;

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Fallback: try to find the last valid JSON object in the output.
 */
function extractLastJsonObject(output: string): unknown | null {
  // Find all { ... } blocks and try to parse the last valid one
  const lines = output.split('\n');
  let lastValid: unknown | null = null;

  // Try progressively larger slices from the end
  for (let i = lines.length - 1; i >= 0; i--) {
    const slice = lines.slice(i).join('\n');
    // Find opening brace
    const openIdx = slice.indexOf('{');
    if (openIdx === -1) continue;

    const jsonCandidate = slice.slice(openIdx);
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === 'object') {
        lastValid = parsed;
        break;
      }
    } catch {
      continue;
    }
  }

  return lastValid;
}

/**
 * Normalize model-realistic shape deviations before schema validation.
 *
 * The Pi model is instructed to output a WorkerResult, but with the terse
 * token-efficient packet contract it commonly emits shapes the strict schema
 * rejects. Observed with the real DeepSeek V4-Flash worker:
 *   - `checks` as an array of plain strings (schema wants {name,status,summary})
 *   - `tokenUsage` as the string "minimal" or another non-object (schema wants
 *     {inputTokens,outputTokens,cacheHitTokens})
 *   - `status` as "success"/"succeeded"/"done" (schema enum is
 *     completed|failed|blocked|needs_decision|scope_violation)
 *   - `scopeViolations` / `risks` / `unresolvedQuestions` entries as objects
 *     (e.g. {path, note}) instead of plain strings
 *
 * These are FORMAT deviations, not evidence. The harness never gates on the
 * model's self-reported checks (the quality gate and Codex review run
 * independently), it never trusts the model's self-reported tokenUsage for
 * the ledger (authoritative usage comes from the Pi JSONL provider-usage
 * accumulator), and it verifies scope/commitHash against Git rather than the
 * self-report. Normalizing the shape therefore does not fake any evidence:
 * string checks become informational objects, status synonyms map to the
 * closest canonical value, non-numeric tokenUsage becomes zeros (honest: "the
 * result carries no usage numbers"), and structured violation entries are
 * flattened to strings.
 *
 * Structural contract violations (missing taskId/status/summary, unknown
 * status values, completed without commitHash, non-array fields, …) are left
 * untouched and still rejected by the schema.
 */
const STATUS_SYNONYMS: Record<string, string> = {
  success: 'completed',
  succeeded: 'completed',
  done: 'completed',
  ok: 'completed',
  complete: 'completed',
  failure: 'failed',
  error: 'failed',
  errored: 'failed',
  'needs user decision': 'needs_decision',
  'needs input': 'needs_decision',
  'need user': 'needs_decision',
  'scope violation': 'scope_violation',
  scope_violation: 'scope_violation',
};

function normalizeWorkerResultShapes(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.status === 'string') {
    const synonym = STATUS_SYNONYMS[data.status.trim().toLowerCase()];
    if (synonym) data.status = synonym;
  }

  // The model may emit `commitHash: null` for a no-change completion. Coerce
  // null to the empty string: the schema then only enforces a non-empty hash
  // when filesChanged is non-empty (a changed completion still cannot claim an
  // empty/placeholder commit), and the scheduler proves the worktree is clean
  // before accepting a no-change completion.
  if (data.commitHash === null) data.commitHash = '';

  if (typeof data.summary !== 'string') data.summary = data.summary == null ? '' : String(data.summary);

  // filesChanged must be a string array (used for scope claims). Coerce a
  // single path string into an array; drop anything else that is not an array.
  if (typeof data.filesChanged === 'string') data.filesChanged = [data.filesChanged];
  if (!Array.isArray(data.filesChanged)) data.filesChanged = [];

  if (!Array.isArray(data.checks)) data.checks = [];

  // productDecisionRequired must be a boolean; the model may emit strings.
  if (typeof data.productDecisionRequired === 'string') {
    const lowered = data.productDecisionRequired.trim().toLowerCase();
    data.productDecisionRequired = lowered === 'true' || lowered === 'yes' || lowered === '1';
  } else if (typeof data.productDecisionRequired !== 'boolean') {
    data.productDecisionRequired = false;
  }

  if (Array.isArray(data.checks)) {
    data.checks = data.checks
      .map((item) => {
        if (typeof item === 'string') {
          return { name: item, status: 'info', summary: item };
        }
        return item;
      })
      .filter((item): item is { name: string; status: string; summary: string } => {
        return Boolean(item) && typeof item === 'object';
      });
  }

  for (const key of ['scopeViolations', 'risks', 'unresolvedQuestions', 'filesChanged'] as const) {
    if (Array.isArray(data[key])) {
      data[key] = coerceStringArray(data[key]);
    }
  }

  if (!isValidTokenUsageShape(data.tokenUsage)) {
    data.tokenUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
  }

  return data;
}

function coerceStringArray(items: unknown[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      result.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const path = typeof record.path === 'string' ? record.path : '';
      const note = typeof record.note === 'string' ? record.note : '';
      if (path && note) result.push(`${path}: ${note}`);
      else if (path) result.push(path);
      else result.push(JSON.stringify(record));
      continue;
    }
    result.push(String(item));
  }
  return result;
}

function isValidTokenUsageShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const usage = value as Record<string, unknown>;
  return ['inputTokens', 'outputTokens', 'cacheHitTokens'].every((key) => {
    const n = usage[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0;
  });
}

/**
 * Validate the parsed data against the WorkerResult schema.
 */
function validateAndReturn(data: unknown, existingErrors: string[]): ParseResult {
  try {
    const validate = getValidator();
    const normalized = normalizeWorkerResultShapes(data as Record<string, unknown>);
    if (validate(normalized)) {
      return { success: true, workerResult: normalized as unknown as WorkerResult, errors: existingErrors };
    }

    // Validation failed - collect errors
    const schemaErrors: string[] = [];
    if ((validate as any).errors) {
      for (const err of (validate as any).errors as Array<{ instancePath: string; message: string }>) {
        schemaErrors.push(`${err.instancePath || '(root)'}: ${err.message}`);
      }
    }
    return {
      success: false,
      workerResult: null,
      errors: [...existingErrors, ...schemaErrors],
    };
  } catch (err) {
    return {
      success: false,
      workerResult: null,
      errors: [...existingErrors, `Schema validation error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
