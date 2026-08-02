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
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const statements = splitSqlStatements(migration.sql);
        for (const stmt of statements) {
          try {
            this.db.exec(stmt);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (isAlterTableAddColumn(stmt) && msg.toLowerCase().includes('duplicate column name')) {
              assertDuplicateColumnCompatible(this.db, stmt);
              continue;
            }
            throw err;
          }
        }

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
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
        throw error;
      }

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
  const cleaned = stripSqlComments(sql);
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let index = 0; index < cleaned.length; index++) {
    const char = cleaned[index];
    current += char;
    if (quote) {
      if (quote === ']' && char === ']') quote = null;
      else if (quote !== ']' && char === quote) {
        if (cleaned[index + 1] === quote) current += cleaned[++index];
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '[') { quote = ']'; continue; }
    if (char !== ';') continue;
    const trimmed = current.trim();
    const trigger = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(trimmed);
    if (trigger && !/\bEND\s*;$/i.test(trimmed)) continue;
    if (trimmed) statements.push(trimmed);
    current = '';
  }
  const tail = current.trim();
  if (tail) statements.push(tail.endsWith(';') ? tail : `${tail};`);
  return statements;
}

function stripSqlComments(sql: string): string {
  let output = '';
  let quote: "'" | '"' | '`' | ']' | null = null;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (quote) {
      output += char;
      if (quote === ']' && char === ']') quote = null;
      else if (quote !== ']' && char === quote) {
        if (next === quote) output += sql[++index];
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; output += char; continue; }
    if (char === '[') { quote = ']'; output += char; continue; }
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index++;
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++;
      index++;
      continue;
    }
    output += char;
  }
  return output;
}

function isAlterTableAddColumn(statement: string): boolean {
  return /^ALTER\s+TABLE\s+[^\s]+\s+ADD\s+(?:COLUMN\s+)?/i.test(statement.trim());
}

function normalizeDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim();
  while (normalized.startsWith('(') && normalized.endsWith(')')) normalized = normalized.slice(1, -1).trim();
  return normalized.replace(/\s+/g, ' ');
}

function assertDuplicateColumnCompatible(db: DatabaseSync, statement: string): void {
  const match = statement.trim().replace(/;$/, '').match(
    /^ALTER\s+TABLE\s+["`\[]?([^\s"`\]]+)["`\]]?\s+ADD\s+(?:COLUMN\s+)?["`\[]?([^\s"`\]]+)["`\]]?\s+([\s\S]+)$/i,
  );
  if (!match) throw new Error('duplicate column schema mismatch: cannot parse ALTER TABLE ADD COLUMN');
  const [, tableName, columnName, definition] = match;
  const row = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all()
    .find((candidate: any) => String(candidate.name).toLowerCase() === columnName.toLowerCase()) as any;
  if (!row) throw new Error(`duplicate column schema mismatch: ${tableName}.${columnName} is not present`);

  const typeMatch = definition.trim().match(/^([^\s]+)/);
  const expectedType = String(typeMatch?.[1] ?? '').toUpperCase();
  const expectedNotNull = /\bNOT\s+NULL\b/i.test(definition) ? 1 : 0;
  const expectedPrimaryKey = /\bPRIMARY\s+KEY\b/i.test(definition) ? 1 : 0;
  const defaultMatch = definition.match(/\bDEFAULT\s+((?:'[^']*(?:''[^']*)*'|"[^"]*"|\([^)]*\)|[^\s,]+))/i);
  const expectedDefault = normalizeDefault(defaultMatch?.[1]);
  const actual = {
    type: String(row.type ?? '').toUpperCase(),
    notNull: Number(row.notnull ?? 0),
    primaryKey: Number(row.pk ?? 0),
    defaultValue: normalizeDefault(row.dflt_value),
  };
  if (actual.type !== expectedType || actual.notNull !== expectedNotNull
    || actual.primaryKey !== expectedPrimaryKey || actual.defaultValue !== expectedDefault) {
    throw new Error(`duplicate column schema mismatch: ${tableName}.${columnName}`);
  }
}
