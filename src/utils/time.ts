/**
 * Return current UTC time as ISO 8601 string.
 */
export function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Parse an ISO 8601 string to Date. Returns null for invalid input.
 */
export function parseISO(iso: string): Date | null {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a Date to a human-readable local time string.
 */
export function formatLocal(date: Date): string {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
