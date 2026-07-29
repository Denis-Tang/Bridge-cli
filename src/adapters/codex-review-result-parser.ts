import type { ReviewResult } from '../types/protocol.js';

const BEGIN_MARKER = 'BEGIN_REVIEW_RESULT_JSON';
const END_MARKER = 'END_REVIEW_RESULT_JSON';

/**
 * Parse a ReviewResult from a review response.
 * Looks for BEGIN_REVIEW_RESULT_JSON / END_REVIEW_RESULT_JSON markers.
 */
export function parseReviewResult(output: string): { success: boolean; result?: ReviewResult; error?: string } {
  if (!output || output.trim().length === 0) {
    return { success: false, error: 'Empty review output' };
  }

  // Find the marked block
  const startIdx = output.lastIndexOf(BEGIN_MARKER);
  if (startIdx === -1) {
    return { success: false, error: `No '${BEGIN_MARKER}' marker found` };
  }

  const jsonStart = startIdx + BEGIN_MARKER.length;
  const endIdx = output.indexOf(END_MARKER, jsonStart);
  if (endIdx === -1) {
    return { success: false, error: `No '${END_MARKER}' marker found` };
  }

  const jsonStr = output.slice(jsonStart, endIdx).trim();
  if (!jsonStr) {
    return { success: false, error: 'Empty JSON block between markers' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { success: false, error: 'Invalid JSON in review result block' };
  }

  // Basic field validation
  if (!parsed || typeof parsed !== 'object') {
    return { success: false, error: 'Review result is not an object' };
  }

  const obj = parsed as Record<string, unknown>;

  // Check required fields
  const requiredFields = ['taskId', 'status', 'reviewSummary', 'findings', 'requiredRework', 'qualityGateStatus', 'mergeAllowed'];
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      return { success: false, error: `Missing required field: '${field}'` };
    }
  }

  // Validate status enum
  const validStatuses = ['approved', 'rework_required', 'rejected', 'needs_user_decision'];
  if (!validStatuses.includes(String(obj.status))) {
    return {
      success: false,
      error: `Invalid status '${obj.status}'. Must be one of: ${validStatuses.join(', ')}`,
    };
  }

  // Validate mergeAllowed is boolean
  if (typeof obj.mergeAllowed !== 'boolean') {
    return { success: false, error: "'mergeAllowed' must be a boolean" };
  }

  return {
    success: true,
    result: parsed as ReviewResult,
  };
}
