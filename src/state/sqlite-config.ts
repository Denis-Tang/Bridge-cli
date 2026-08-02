import { resolve } from 'node:path';

/**
 * Configuration for the SQLite state store.
 */
export interface SqliteConfig {
  /** Path to the SQLite database file */
  path: string;
  /** Masked path for display (no sensitive info, just the path) */
  maskedPath?: string;
}

/**
 * Default SQLite database file path relative to project root.
 */
export const DEFAULT_SQLITE_PATH = '.brainctl/state/brainctl.sqlite';

/**
 * Read SQLite config from environment variable or return default.
 * Priority: BRAINCTL_SQLITE_PATH env var > default path.
 */
export function readSqliteConfigFromEnv(projectRoot?: string, explicitPath?: string): SqliteConfig {
  const envPath = process.env.BRAINCTL_SQLITE_PATH;
  const dbPath = explicitPath || envPath || DEFAULT_SQLITE_PATH;
  const fullPath = projectRoot ? resolve(projectRoot, dbPath) : (explicitPath ? resolve(explicitPath) : dbPath);
  return {
    path: fullPath,
    maskedPath: fullPath,
  };
}
