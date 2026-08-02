import { afterEach, describe, it, expect } from 'vitest';
import { parseMigrationFilename, computeChecksum, splitSqlStatements } from '../../src/state/sqlite-migration-runner.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cleanup: string[] = [];
const openDatabases: any[] = [];
afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try { db.close(); } catch {}
  }
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

function fixture(sql: string): { db: any; runner: SqliteMigrationRunner; dir: string } {
  const dir = path.join(tmpdir(), `bridge-migration-atomic-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  writeFileSync(path.join(dir, '001_test.sql'), sql, 'utf8');
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  openDatabases.push(db);
  const runner = new SqliteMigrationRunner({ path: dbPath, maskedPath: dbPath }, db);
  (runner as any).migrationsDir = dir;
  return { db, runner, dir };
}

describe('parseMigrationFilename', () => {
  it('parses "001_initial.sql"', () => {
    const result = parseMigrationFilename('001_initial.sql');
    expect(result).toEqual({ version: '001', name: 'initial' });
  });

  it('parses "002_add_users.sql"', () => {
    const result = parseMigrationFilename('002_add_users.sql');
    expect(result).toEqual({ version: '002', name: 'add_users' });
  });

  it('throws for invalid filename', () => {
    expect(() => parseMigrationFilename('random.sql')).toThrow('Invalid migration filename');
  });

  it('throws for filename without version prefix', () => {
    expect(() => parseMigrationFilename('migration.sql')).toThrow('Invalid migration filename');
  });
});

describe('computeChecksum', () => {
  it('returns a consistent SHA-256 hex string', () => {
    const hash1 = computeChecksum('CREATE TABLE foo;');
    const hash2 = computeChecksum('CREATE TABLE foo;');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 hex
  });

  it('produces different hashes for different content', () => {
    const hash1 = computeChecksum('SELECT 1;');
    const hash2 = computeChecksum('SELECT 2;');
    expect(hash1).not.toBe(hash2);
  });
});

describe('splitSqlStatements', () => {
  it('splits simple statements', () => {
    const result = splitSqlStatements('CREATE TABLE a; INSERT INTO b;');
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('CREATE TABLE a;');
    expect(result[1]).toBe('INSERT INTO b;');
  });

  it('removes comment lines', () => {
    const sql = `-- This is a comment\nCREATE TABLE a;\n-- Another comment\nINSERT INTO b;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('CREATE TABLE a;');
    expect(result[1]).toBe('INSERT INTO b;');
  });

  it('removes block comments', () => {
    const sql = `/* block comment */ CREATE TABLE a;`;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('CREATE TABLE a;');
  });

  it('handles empty input', () => {
    const result = splitSqlStatements('');
    expect(result).toHaveLength(0);
  });

  it('handles whitespace-only input', () => {
    const result = splitSqlStatements('   \n  ');
    expect(result).toHaveLength(0);
  });

  it('keeps a trigger body as one statement', () => {
    const sql = `CREATE TRIGGER guard BEFORE INSERT ON target BEGIN\nSELECT RAISE(ABORT, 'blocked');\nEND;`;
    expect(splitSqlStatements(sql)).toEqual([sql]);
  });
});

describe('per-file migration atomicity', () => {
  it('rolls back all SQL and leaves the version unregistered when a middle statement fails', () => {
    const { db, runner } = fixture(`CREATE TABLE partial(id INTEGER);\nINSERT INTO partial VALUES (1);\nTHIS IS INVALID;`);
    expect(() => runner.applyPending()).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partial'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='001'").get()).toMatchObject({ count: 0 });
    db.close();
  });

  it('rolls back migration SQL when schema_migrations registration fails', () => {
    const { db, runner } = fixture(`CREATE TABLE registration_rollback(id INTEGER);`);
    runner.ensureSchemaTable();
    db.exec(`CREATE TRIGGER reject_registration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT, 'registration blocked'); END;`);
    expect(() => runner.applyPending()).toThrow(/registration blocked/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registration_rollback'").get()).toBeUndefined();
    db.close();
  });

  it('accepts duplicate ADD COLUMN only when PRAGMA schema exactly matches and still runs later statements', () => {
    const { db, runner } = fixture(`ALTER TABLE legacy ADD COLUMN marker TEXT NOT NULL DEFAULT 'same';\nCREATE TABLE after_duplicate(id INTEGER);`);
    db.exec(`CREATE TABLE legacy(id INTEGER, marker TEXT NOT NULL DEFAULT 'same');`);
    expect(runner.applyPending()).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='after_duplicate'").get()).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='001'").get()).toMatchObject({ count: 1 });
    db.close();
  });

  it('rejects duplicate ADD COLUMN when type/null/default schema differs', () => {
    const { db, runner } = fixture(`ALTER TABLE legacy ADD COLUMN marker TEXT NOT NULL DEFAULT 'expected';`);
    db.exec(`CREATE TABLE legacy(id INTEGER, marker INTEGER DEFAULT 0);`);
    expect(() => runner.applyPending()).toThrow(/duplicate column schema mismatch/);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version='001'").get()).toMatchObject({ count: 0 });
    db.close();
  });
});
