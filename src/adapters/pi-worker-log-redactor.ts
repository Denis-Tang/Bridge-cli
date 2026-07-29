/**
 * Pi Worker Log Redactor - delegates to unified sanitizer.
 * @deprecated Use sanitizeLogContent from src/privacy/sanitizer.ts
 */

import { sanitizeLogContent, containsSecrets } from '../privacy/sanitizer.js';

export function redactLogContent(content: string): string {
  return sanitizeLogContent(content);
}

export function wouldRedact(input: string): boolean {
  return containsSecrets(input);
}
