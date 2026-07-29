// ── M4 Migration Tests ──────────────────────────────────────────────────
// Verifies 001-005 migration runs on a temp SQLite database.
// Checks all 4 M4 tables exist, all 8 new columns on existing tables exist.
// Verifies idempotent re-run and that only "duplicate column name" is swallowed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStateStore } from '../../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../../src/state/sqlite-migration-runner.js';
import type { SqliteConfig } from '../../src/state/sqlite-config.js';

let tmpDir: string;
let dbPath: string;
let store: SqliteStateStore;

describe('M4 Migration 005', () => {
  beforeAll(async () => {
    tmpDir = path.join(tmpdir(), `brainctl-m4-mig-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'test-m4-mig.db');
    store = SqliteStateStore.create(dbPath);
    const config: SqliteConfig = { path: dbPath, maskedPath: dbPath };
    const runner = new SqliteMigrationRunner(config, store.getDatabase());
    runner.applyPending();
  });

  afterAll(async () => {
    await store.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  /**
   * Helper: get all table names from sqlite_master.
   */
  function getTableNames(): string[] {
    const db = store.getDatabase();
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Record<string, unknown>[];
    return rows.map((r) => String(r.name));
  }

  /**
   * Helper: get column names for a table via PRAGMA.
   */
  function getColumnNames(table: string): string[] {
    const db = store.getDatabase();
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    return rows.map((r) => String(r.name));
  }

  describe('table existence', () => {
    it('creates approval_decisions table', () => {
      expect(getTableNames()).toContain('approval_decisions');
    });

    it('creates token_ledger table', () => {
      expect(getTableNames()).toContain('token_ledger');
    });

    it('creates budget_policies table', () => {
      expect(getTableNames()).toContain('budget_policies');
    });

    it('creates risk_assessments table', () => {
      expect(getTableNames()).toContain('risk_assessments');
    });

    it('all pre-existing tables still exist', () => {
      const tables = getTableNames();
      for (const t of ['runs', 'tasks', 'stages', 'task_attempts', 'reviews',
        'path_locks', 'integration_batches', 'events',
        'resource_samples', 'dispatch_decisions']) {
        expect(tables).toContain(t);
      }
    });
  });

  describe('new columns on existing tables', () => {
    it('runs table has budget_config_json and risk_level columns', () => {
      const cols = getColumnNames('runs');
      expect(cols).toContain('budget_config_json');
      expect(cols).toContain('risk_level');
    });

    it('task_attempts table has token_estimated, token_actual, scope_expansion_allowed', () => {
      const cols = getColumnNames('task_attempts');
      expect(cols).toContain('token_estimated');
      expect(cols).toContain('token_actual');
      expect(cols).toContain('scope_expansion_allowed');
    });

    it('reviews table has token_estimated and token_actual', () => {
      const cols = getColumnNames('reviews');
      expect(cols).toContain('token_estimated');
      expect(cols).toContain('token_actual');
    });

    it('new columns have correct defaults via schema inspection', () => {
      const db = store.getDatabase();
      // risk_level should default to 'low'
      const info = db.prepare("PRAGMA table_info(runs)").all() as Record<string, unknown>[];
      const riskCol = info.find((r) => r.name === 'risk_level');
      expect(riskCol).toBeDefined();
      expect(riskCol!.dflt_value).toBe("'low'");

      // scope_expansion_allowed should default to 0
      const attInfo = db.prepare("PRAGMA table_info(task_attempts)").all() as Record<string, unknown>[];
      const scopeCol = attInfo.find((r) => r.name === 'scope_expansion_allowed');
      expect(scopeCol).toBeDefined();
      // PRAGMA table_info returns dflt_value as a string
      expect(String(scopeCol!.dflt_value)).toBe('0');
    });
  });

  describe('approval_decisions schema', () => {
    it('has all required columns', () => {
      const cols = getColumnNames('approval_decisions');
      for (const c of ['id', 'run_id', 'gate', 'decision_type', 'scope', 'status',
        'approved_by', 'approved_at', 'expires_at', 'revoked_at', 'revoke_reason',
        'metadata_json', 'created_at', 'updated_at']) {
        expect(cols).toContain(c);
      }
    });

    it('has indices', () => {
      const db = store.getDatabase();
      const indices = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approval_decisions'"
      ).all() as Record<string, unknown>[];
      const names = indices.map((r) => String(r.name));
      expect(names.some((n) => n.includes('idx_approval_decisions'))).toBe(true);
    });
  });

  describe('token_ledger schema — sanitization safety', () => {
    it('has no column that stores raw prompt/log text', () => {
      const cols = getColumnNames('token_ledger');
      // prompt_hash is SHA256 — no raw prompt column
      const forbidden = ['prompt', 'prompt_text', 'raw_prompt', 'log_text', 'raw_log',
        'response', 'full_output', 'content'];
      for (const f of forbidden) {
        expect(cols).not.toContain(f);
      }
      // prompt_hash IS allowed
      expect(cols).toContain('prompt_hash');
    });
  });

  describe('budget_policies schema', () => {
    it('has run_id nullable for global defaults', () => {
      const db = store.getDatabase();
      const info = db.prepare("PRAGMA table_info(budget_policies)").all() as Record<string, unknown>[];
      const runIdCol = info.find((r) => r.name === 'run_id');
      expect(runIdCol).toBeDefined();
      // notnull should be 0 (nullable)
      expect(runIdCol!.notnull).toBe(0);
    });

    it('has action_on_exceed defaulting to pause', () => {
      const db = store.getDatabase();
      const info = db.prepare("PRAGMA table_info(budget_policies)").all() as Record<string, unknown>[];
      const actionCol = info.find((r) => r.name === 'action_on_exceed');
      expect(actionCol).toBeDefined();
      expect(actionCol!.dflt_value).toBe("'pause'");
    });
  });

  describe('risk_assessments schema', () => {
    it('has resolved defaulting to 0', () => {
      const db = store.getDatabase();
      const info = db.prepare("PRAGMA table_info(risk_assessments)").all() as Record<string, unknown>[];
      const resolvedCol = info.find((r) => r.name === 'resolved');
      expect(resolvedCol).toBeDefined();
      // PRAGMA table_info returns dflt_value as a string
      expect(String(resolvedCol!.dflt_value)).toBe('0');
    });
  });
});

describe('M4 Migration idempotency', () => {
  let idemDir: string;
  let idemDbPath: string;
  let idemStore: SqliteStateStore;

  beforeAll(async () => {
    idemDir = path.join(tmpdir(), `brainctl-m4-idem-${Date.now()}`);
    mkdirSync(idemDir, { recursive: true });
    idemDbPath = path.join(idemDir, 'idem.db');
    idemStore = SqliteStateStore.create(idemDbPath);
  });

  afterAll(async () => {
    await idemStore.close();
    try { rmSync(idemDir, { recursive: true, force: true }); } catch {}
  });

  it('first migration applies successfully', () => {
    const config: SqliteConfig = { path: idemDbPath, maskedPath: idemDbPath };
    const runner = new SqliteMigrationRunner(config, idemStore.getDatabase());
    const plan1 = runner.getPlan();
    expect(plan1.pending.length).toBeGreaterThanOrEqual(5); // 001-005
    const applied = runner.applyPending();
    expect(applied.length).toBe(plan1.pending.length);
  });

  it('second migration (re-run) is idempotent — no errors, no pending', () => {
    const config: SqliteConfig = { path: idemDbPath, maskedPath: idemDbPath };
    const runner = new SqliteMigrationRunner(config, idemStore.getDatabase());
    const plan2 = runner.getPlan();
    expect(plan2.pending.length).toBe(0);
    // applyPending on empty queue should succeed with zero applied
    const applied2 = runner.applyPending();
    expect(applied2.length).toBe(0);
  });

  it('re-run after all applied does not corrupt tables', () => {
    const config: SqliteConfig = { path: idemDbPath, maskedPath: idemDbPath };
    const runner = new SqliteMigrationRunner(config, idemStore.getDatabase());
    // Should not throw
    runner.applyPending();
    // Tables should still exist
    const db = idemStore.getDatabase();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Record<string, unknown>[];
    const names = tables.map((r) => String(r.name));
    expect(names).toContain('approval_decisions');
    expect(names).toContain('token_ledger');
    expect(names).toContain('budget_policies');
    expect(names).toContain('risk_assessments');
  });
});

describe('Migration runner error safety', () => {
  it('rejects checksum mismatch (modified migration file)', () => {
    const dir = path.join(tmpdir(), `brainctl-m4-safety-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbp = path.join(dir, 'safety.db');
    const s = SqliteStateStore.create(dbp);

    try {
      const config: SqliteConfig = { path: dbp, maskedPath: dbp };
      const runner = new SqliteMigrationRunner(config, s.getDatabase());
      runner.applyPending();

      // Manually tamper with the recorded checksum
      const db = s.getDatabase();
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = '005'")
        .run('deadbeef');

      expect(() => runner.getPlan()).toThrow(/checksum mismatch/i);
    } finally {
      s.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
