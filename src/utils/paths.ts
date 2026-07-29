import path from 'node:path';

/**
 * Normalize a Windows path to use forward slashes and resolve relative components.
 */
export function normalizeProjectPath(input: string): string {
  // Replace backslashes with forward slashes
  let normalized = input.replace(/\\/g, '/');
  // Resolve . and ..
  const resolved = path.posix.normalize(normalized);
  // Ensure drive letter is uppercase
  return resolved.replace(/^([a-zA-Z]):/, (_: string, letter: string) => `${letter.toUpperCase()}:`);
}

/**
 * Check if `child` path is inside `parent` directory.
 * Resolves both paths and prevents path traversal.
 */
export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(normalizeProjectPath(parent));
  const resolvedChild = path.resolve(normalizeProjectPath(child));
  const relative = path.relative(resolvedParent, resolvedChild);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}
