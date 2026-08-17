import type { ReviewResult } from '../types/protocol.js';

const BEGIN_MARKER = 'BEGIN_REVIEW_RESULT_JSON';
const END_MARKER = 'END_REVIEW_RESULT_JSON';

const VALID_STATUSES = ['approved', 'rework_required', 'rejected', 'needs_user_decision'] as const;
const VALID_QUALITY_GATE_STATUSES = ['passed', 'failed', 'skipped'] as const;
const VALID_ERROR_CATEGORIES = ['timeout', 'nonzero_exit', 'spawn_failure', 'unexpected'] as const;

type ReviewStatus = (typeof VALID_STATUSES)[number];
type QualityGateStatus = (typeof VALID_QUALITY_GATE_STATUSES)[number];
type ErrorCategory = (typeof VALID_ERROR_CATEGORIES)[number];

const REQUIRED_FIELDS = [
  'taskId',
  'status',
  'reviewSummary',
  'findings',
  'requiredRework',
  'qualityGateStatus',
  'mergeAllowed',
] as const;

/**
 * Parse a ReviewResult from a review response.
 *
 * Strict rules:
 * - Exactly one BEGIN_REVIEW_RESULT_JSON line and exactly one END_REVIEW_RESULT_JSON
 *   line must exist, and the begin line must precede the end line.
 * - Only the raw text enclosed between those two marker lines is ever passed to
 *   JSON.parse. Headings, prose, global keywords, stdout, stderr, diff, or prompt
 *   text outside the block are never scanned.
 * - The parsed object must satisfy the ReviewResult schema and semantic rules.
 *
 * @param output Raw reviewer response text.
 * @param expectedTaskId When provided, the parsed taskId must exactly match it.
 */
export function parseReviewResult(
  output: string,
  expectedTaskId?: string,
): { success: boolean; result?: ReviewResult; error?: string } {
  if (!output || output.trim().length === 0) {
    return { success: false, error: 'Empty review output' };
  }

  const lines = output.split('\n');
  const beginIndexes: number[] = [];
  const endIndexes: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === BEGIN_MARKER) {
      beginIndexes.push(i);
    }
    if (line === END_MARKER) {
      endIndexes.push(i);
    }
  }

  if (beginIndexes.length === 0) {
    return { success: false, error: `No '${BEGIN_MARKER}' marker found` };
  }
  if (endIndexes.length === 0) {
    return { success: false, error: `No '${END_MARKER}' marker found` };
  }
  if (beginIndexes.length !== 1) {
    return {
      success: false,
      error: `Expected exactly one '${BEGIN_MARKER}' marker, found ${beginIndexes.length}`,
    };
  }
  if (endIndexes.length !== 1) {
    return {
      success: false,
      error: `Expected exactly one '${END_MARKER}' marker, found ${endIndexes.length}`,
    };
  }

  const beginIndex = beginIndexes[0];
  const endIndex = endIndexes[0];
  if (beginIndex >= endIndex) {
    return { success: false, error: `'${BEGIN_MARKER}' must appear before '${END_MARKER}'` };
  }

  const jsonStr = lines.slice(beginIndex + 1, endIndex).join('\n').trim();
  if (!jsonStr) {
    return { success: false, error: 'Empty JSON block between markers' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { success: false, error: 'Invalid JSON in review result block' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { success: false, error: 'Review result is not an object' };
  }

  const obj = parsed as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      return { success: false, error: `Missing required field: '${field}'` };
    }
  }

  if (typeof obj.taskId !== 'string') {
    return { success: false, error: "'taskId' must be a string" };
  }
  if (expectedTaskId !== undefined && obj.taskId !== expectedTaskId) {
    return { success: false, error: "'taskId' must equal the expected taskId" };
  }
  if (typeof obj.reviewSummary !== 'string' || obj.reviewSummary.trim().length === 0) {
    return { success: false, error: "'reviewSummary' must be a non-empty string" };
  }
  if (typeof obj.status !== 'string' || !VALID_STATUSES.includes(obj.status as ReviewStatus)) {
    return {
      success: false,
      error: `Invalid status '${String(obj.status)}'. Must be one of: ${VALID_STATUSES.join(', ')}`,
    };
  }
  if (
    typeof obj.qualityGateStatus !== 'string' ||
    !VALID_QUALITY_GATE_STATUSES.includes(obj.qualityGateStatus as QualityGateStatus)
  ) {
    return {
      success: false,
      error: `Invalid qualityGateStatus '${String(obj.qualityGateStatus)}'. Must be one of: ${VALID_QUALITY_GATE_STATUSES.join(', ')}`,
    };
  }
  if (typeof obj.mergeAllowed !== 'boolean') {
    return { success: false, error: "'mergeAllowed' must be a boolean" };
  }

  const findingsError = validateNonEmptyStringArray(obj.findings, 'findings');
  if (findingsError) {
    return { success: false, error: findingsError };
  }
  const requiredReworkError = validateNonEmptyStringArray(obj.requiredRework, 'requiredRework');
  if (requiredReworkError) {
    return { success: false, error: requiredReworkError };
  }

  if (obj.reviewer !== undefined && typeof obj.reviewer !== 'string') {
    return { success: false, error: "'reviewer' must be a string" };
  }
  if (obj.reviewerUnavailable !== undefined && typeof obj.reviewerUnavailable !== 'boolean') {
    return { success: false, error: "'reviewerUnavailable' must be a boolean" };
  }

  if (obj.executionMetadata !== undefined) {
    const executionMetadataError = validateExecutionMetadata(obj.executionMetadata);
    if (executionMetadataError) {
      return { success: false, error: executionMetadataError };
    }
  }

  const status = obj.status as ReviewStatus;
  const qualityGateStatus = obj.qualityGateStatus as QualityGateStatus;
  const mergeAllowed = obj.mergeAllowed as boolean;
  const requiredRework = obj.requiredRework as string[];
  const reviewerUnavailable = obj.reviewerUnavailable === true;

  // Semantic contradiction: an approved/rework_required verdict is a real
  // review outcome; it can never come from an unavailable reviewer or a
  // failed subprocess. Fail closed so such output is never treated as passed.
  if (reviewerUnavailable && (status === 'approved' || status === 'rework_required')) {
    return { success: false, error: `Semantic violation: ${status} cannot carry reviewerUnavailable=true` };
  }
  if (status === 'approved' && obj.executionMetadata !== undefined) {
    const meta = obj.executionMetadata as { errorCategory?: string };
    if (meta.errorCategory !== undefined) {
      return { success: false, error: `Semantic violation: approved cannot carry errorCategory '${String(meta.errorCategory)}'` };
    }
  }

  // Enforce semantic rules for each review status.
  switch (status) {
    case 'approved':
      if (mergeAllowed !== true) {
        return { success: false, error: "Semantic violation: approved requires mergeAllowed to be true" };
      }
      if (qualityGateStatus !== 'passed') {
        return { success: false, error: "Semantic violation: approved requires qualityGateStatus to be 'passed'" };
      }
      if (requiredRework.length !== 0) {
        return { success: false, error: 'Semantic violation: approved requires an empty requiredRework array' };
      }
      break;
    case 'rework_required':
      if (mergeAllowed !== false) {
        return { success: false, error: "Semantic violation: rework_required requires mergeAllowed to be false" };
      }
      if (qualityGateStatus !== 'failed') {
        return { success: false, error: "Semantic violation: rework_required requires qualityGateStatus to be 'failed'" };
      }
      if (requiredRework.length === 0) {
        return { success: false, error: 'Semantic violation: rework_required requires a non-empty requiredRework array' };
      }
      break;
    case 'rejected':
    case 'needs_user_decision':
      if (mergeAllowed !== false) {
        return { success: false, error: `Semantic violation: ${status} requires mergeAllowed to be false` };
      }
      break;
  }

  // Build a fresh allowlisted object instead of returning `parsed as ReviewResult`:
  // unknown top-level keys (e.g. a raw `stdout`/`diff` field) must never be
  // persisted via reviewJson. Only the ReviewResult contract fields survive.
  const result: ReviewResult = {
    taskId: obj.taskId as string,
    status,
    reviewSummary: obj.reviewSummary as string,
    findings: obj.findings as string[],
    requiredRework,
    qualityGateStatus,
    mergeAllowed,
  };
  if (obj.reviewer !== undefined) {
    result.reviewer = obj.reviewer as string;
  }
  if (obj.reviewerUnavailable !== undefined) {
    result.reviewerUnavailable = obj.reviewerUnavailable as boolean;
  }
  if (obj.executionMetadata !== undefined) {
    result.executionMetadata = obj.executionMetadata as ReviewResult['executionMetadata'];
  }
  return { success: true, result };
}

function validateNonEmptyStringArray(value: unknown, name: string): string | null {
  if (!Array.isArray(value)) {
    return `'${name}' must be an array`;
  }
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      return `'${name}' must contain only non-empty strings (invalid item at index ${i})`;
    }
  }
  return null;
}

function validateExecutionMetadata(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return "'executionMetadata' must be an object";
  }

  const meta = value as Record<string, unknown>;
  const allowedKeys = new Set(['errorCategory', 'exitCode', 'durationMs', 'stderrHash']);
  for (const key of Object.keys(meta)) {
    if (!allowedKeys.has(key)) {
      return `'executionMetadata' contains unsupported field '${key}'`;
    }
  }

  if (
    meta.errorCategory !== undefined &&
    !VALID_ERROR_CATEGORIES.includes(meta.errorCategory as ErrorCategory)
  ) {
    return `Invalid executionMetadata.errorCategory '${String(meta.errorCategory)}'. Must be one of: ${VALID_ERROR_CATEGORIES.join(', ')}`;
  }
  if (meta.exitCode !== undefined && meta.exitCode !== null && typeof meta.exitCode !== 'number') {
    return "'executionMetadata.exitCode' must be a number or null";
  }
  if (meta.durationMs !== undefined && typeof meta.durationMs !== 'number') {
    return "'executionMetadata.durationMs' must be a number";
  }
  if (meta.stderrHash !== undefined && meta.stderrHash !== null && typeof meta.stderrHash !== 'string') {
    return "'executionMetadata.stderrHash' must be a string or null";
  }

  return null;
}
