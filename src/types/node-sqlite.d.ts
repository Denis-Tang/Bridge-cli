/**
 * Minimal type declarations for Node.js built-in `node:sqlite` (Bridge supports Node 24.x).
 * API reference: https://nodejs.org/api/sqlite.html
 */
declare module 'node:sqlite' {
  class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
    open(): void;
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }

  interface DatabaseSyncOptions {
    /** Open database in read-only mode (default: false) */
    readOnly?: boolean;
    /** Enable WAL mode (default: false) */
    enableWAL?: boolean;
  }

  class StatementSync {
    run(...params: unknown[]): void;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
    readonly sql: string;
    readonly reader: boolean;
  }

  const constants: {
    readonly SQLITE_OK: number;
    readonly SQLITE_ERROR: number;
    readonly SQLITE_BUSY: number;
    readonly SQLITE_LOCKED: number;
    readonly SQLITE_MISUSE: number;
  };

  class Session {
    /* Not needed for basic usage */
  }

  function backup(
    destination: DatabaseSync,
    source: DatabaseSync,
    options?: BackupOptions,
  ): void;

  interface BackupOptions {
    pages?: number;
    progress?: (remaining: number, pageCount: number) => void;
  }
}
