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
 * Extract JSON from between BEGIN_WORKER_RESULT_JSON and END_WORKER_RESULT_JSON markers.
 */
function extractFromMarkedBlock(output: string): unknown | null {
  const beginMarker = 'BEGIN_WORKER_RESULT_JSON';
  const endMarker = 'END_WORKER_RESULT_JSON';

  const startIdx = output.lastIndexOf(beginMarker);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + beginMarker.length;
  const endIdx = output.indexOf(endMarker, jsonStart);
  if (endIdx === -1) return null;

  const jsonStr = output.slice(jsonStart, endIdx).trim();
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
 * Validate the parsed data against the WorkerResult schema.
 */
function validateAndReturn(data: unknown, existingErrors: string[]): ParseResult {
  try {
    const validate = getValidator();
    if (validate(data)) {
      return { success: true, workerResult: data as WorkerResult, errors: existingErrors };
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
