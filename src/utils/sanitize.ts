// ── M4 Token & Event Sanitization Utilities ─────────────────────────────
// Delegates to unified sanitizer in src/privacy/sanitizer.ts.
// Kept for backward-compatible exports.

import {
  sanitizeEventData as unifiedSanitizeEventData,
  sanitizeLogContent,
  computeHash,
} from '../privacy/sanitizer.js';

/** @deprecated Use computeHash from src/privacy/sanitizer.ts */
export function promptHash(text: string): string {
  return computeHash(text);
}

/** @deprecated Use sanitizeEventData from src/privacy/sanitizer.ts */
export function sanitizeEventData(data: Record<string, unknown>): Record<string, unknown> {
  return unifiedSanitizeEventData(data);
}
