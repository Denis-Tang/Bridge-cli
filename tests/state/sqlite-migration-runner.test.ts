import { describe, it, expect } from 'vitest';
import { parseMigrationFilename, computeChecksum, splitSqlStatements } from '../../src/state/sqlite-migration-runner.js';

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
});
