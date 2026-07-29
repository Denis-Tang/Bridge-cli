import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SqliteConfig } from './sqlite-config.js';

/**
 * A single migration record.
 */
export interface MigrationRecord {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  sql: string;
  appliedAt?: string;
}

/**
 * Migration plan: what's applied vs pending.
 */
export interface MigrationPlan {
  applied: MigrationRecord[];
  pending: MigrationRecord[];
}

/**
 * Result of applying migrations.
 */
export interface ApplyResult {
  applied: MigrationRecord[];
  skipped: number;
}

/**
 * SQLite migration runner.
 * Reads migration files from src/state/migrations/sqlite/ and applies them in order.
 */
export class SqliteMigrationRunner {
  private migrationsDir: string;
  private db: DatabaseSync;

  /**
   * Create a SqliteMigrationRunner from a config and database instance.
   */
  constructor(config: SqliteConfig, db: DatabaseSync) {
    this.db = db;
    this.migrationsDir = resolve(import.meta.dirname, 'migrations/sqlite');
  }

  /**
   * Ensure the schema_migrations table exists.
   */
  ensureSchemaTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        filename TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * Load all migration files from the migrations directory.
   */
  loadMigrations(): MigrationRecord[] {
    if (!existsSync(this.migrationsDir)) {
      return [];
    }

    const files = readdirSync(this.migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    return files.map((filename) => {
      const parsed = parseMigrationFilename(filename);
      const sql = readFileSync(resolve(this.migrationsDir, filename), 'utf-8');
      return {
        version: parsed.version,
        name: parsed.name,
        filename,
        checksum: computeChecksum(sql),
        sql,
      };
    });
  }

  /**
   * Get the migration plan: which migrations are applied and which are pending.
   */
  getPlan(): MigrationPlan {
    this.ensureSchemaTable();
    const localMigrations = this.loadMigrations();
    const appliedMigrations = this.getAppliedMigrations();

    const applied: MigrationRecord[] = [];
    const pending: MigrationRecord[] = [];

    for (const local of localMigrations) {
      const appliedRecord = appliedMigrations.find((a) => a.version === local.version);
      if (appliedRecord) {
        // Check checksum consistency
        if (appliedRecord.checksum !== local.checksum) {
          throw new Error(
            `Migration ${local.filename} checksum mismatch: ` +
            `expected ${appliedRecord.checksum}, got ${local.checksum}. ` +
            `The migration file has been modified after application.`,
          );
        }
        applied.push(local);
      } else {
        pending.push(local);
      }
    }

    return { applied, pending };
  }

  /**
   * Apply all pending migrations.
   */
  applyPending(): MigrationRecord[] {
    const plan = this.getPlan();
    const applied: MigrationRecord[] = [];

    for (const migration of plan.pending) {
      // Execute the migration SQL
      const statements = splitSqlStatements(migration.sql);
      for (const stmt of statements) {
        try {
          this.db.exec(stmt);
        } catch (err: unknown) {
          // ALTER TABLE ADD COLUMN is not idempotent in SQLite.
          // If the column already exists, skip the error.
          const msg = err instanceof Error ? err.message : String(err);
          if (stmt.trim().toUpperCase().startsWith('ALTER TABLE') &&
              msg.includes('duplicate column name')) {
            // Column already exists — safe to skip
            continue;
          }
          throw err;
        }
      }

      // Record the migration
      const recordStmt = this.db.prepare(`
        INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      recordStmt.run(
        migration.version,
        migration.name,
        migration.filename,
        migration.checksum,
        new Date().toISOString(),
      );

      applied.push(migration);
    }

    return applied;
  }

  /**
   * Get already applied migrations from the database.
   */
  private getAppliedMigrations(): MigrationRecord[] {
    this.ensureSchemaTable();
    try {
      const stmt = this.db.prepare('SELECT * FROM schema_migrations ORDER BY version ASC');
      const rows = stmt.all() as Record<string, unknown>[];
      return rows.map((row) => ({
        version: String(row.version),
        name: String(row.name),
        filename: String(row.filename),
        checksum: String(row.checksum),
        appliedAt: String(row.applied_at),
        sql: '',
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Parse a migration filename like "001_initial.sql" into version and name.
 */
export function parseMigrationFilename(filename: string): { version: string; name: string } {
  const match = filename.match(/^(\d+)_(.+)\.sql$/);
  if (!match) {
    throw new Error(`Invalid migration filename: ${filename}. Expected format: NNN_name.sql`);
  }
  return { version: match[1], name: match[2] };
}

/**
 * Compute SHA-256 checksum of SQL content.
 */
export function computeChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Split SQL text into individual statements.
 * Removes comment lines and inline block comments, splits by semicolons.
 */
export function splitSqlStatements(sql: string): string[] {
  // Remove block comments (/* ... */) including inline ones
  let cleaned = sql.replace(/\/\*[\s\S]*?\*\//g, '');

  // Remove single-line comments
  cleaned = cleaned
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return cleaned
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ';');
}
