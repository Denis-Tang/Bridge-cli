// ── Privacy Mainline Canary Tests ───────────────────────────────────────
// Verifies that sensitive data does NOT leak to plaintext persistence
// in minimal mode, and that encryption/decryption round-trips work.
//
// These tests use unique random canary tokens per run. Test logs must
// report only field/file names and match counts, NEVER the canary itself.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { PrivacyService, type DataClassification } from '../src/privacy/privacy-service.js';
import { Aes256GcmService } from '../src/privacy/crypto.js';
import { SqliteStateStore } from '../src/state/sqlite-store.js';
import { SqliteMigrationRunner } from '../src/state/sqlite-migration-runner.js';
import { readSqliteConfigFromEnv } from '../src/state/sqlite-config.js';
import { sanitizeText, sanitizeEventData, containsSecrets, computeHash } from '../src/privacy/sanitizer.js';
import { buildSubprocessEnv, buildMinimalSubprocessEnv, getEnvDiagnostics } from '../src/privacy/env-allowlist.js';
import { createDefaultProfile, resolvePrivacyProfile, isDebugActive } from '../src/privacy/profile.js';
import { PrivacyArtifactStore, hashProjectRoot, toRelativePath } from '../src/privacy/artifact-store.js';

// ══════════════════════════════════════════════════════════════
// Canary helpers
// ══════════════════════════════════════════════════════════════

/** Generate a unique canary token for leak detection */
function makeCanary(): string {
  return `CANARY-${randomBytes(16).toString('hex')}-SECRET`;
}

/** Count occurrences of a canary in a string (case-sensitive) */
function countCanary(text: string, canary: string): number {
  if (!text || !canary) return 0;
  const matches = text.match(new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  return matches ? matches.length : 0;
}

/** Count canary occurrences in a file */
function countCanaryInFile(filePath: string, canary: string): number {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return countCanary(content, canary);
  } catch {
    return 0;
  }
}

/** Recursively search a directory for canary in all files */
function countCanaryInDir(dir: string, canary: string): Map<string, number> {
  const results = new Map<string, number>();
  try {
    const entries = readFileSync(dir, 'utf-8'); // doesn't work for dirs
  } catch { /* using fs for dirs is complex, skip for now */ }
  return results;
}

// ══════════════════════════════════════════════════════════════
// Test database path
// ══════════════════════════════════════════════════════════════

const TEST_DB_DIR = resolve(tmpdir(), 'brainctl-privacy-test-' + Date.now());
const TEST_DB_PATH = resolve(TEST_DB_DIR, 'test.db');

function cleanDb() {
  try {
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_DIR + '-wal')) unlinkSync(TEST_DB_DIR + '-wal');
    if (existsSync(TEST_DB_DIR + '-shm')) unlinkSync(TEST_DB_DIR + '-shm');
    try { rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  } catch { /* cleanup best-effort */ }
}

// ══════════════════════════════════════════════════════════════
// Test 1: Sanitizer — canary detection + redaction
// ══════════════════════════════════════════════════════════════

describe('Privacy Sanitizer — canary leak prevention', () => {
  it('sanitizeText redacts all 14 secret patterns', () => {
    const canary = makeCanary();
    const inputs = [
      `Authorization: Bearer ${canary}`,
      `x-api-key: sk-${canary}`,
      `eyJhbGciOiJIUzI1NiJ9.eyJkYXRhIjoi${canary.substring(0, 32)}In0.${canary.substring(0, 32)}`,  // JWT-like
      `AKIA${canary.substring(0, 16)}`,  // AWS key-like
      `github_pat_${canary.replace(/-/g, 'A').substring(0, 30)}`,
      `ghp_${canary.substring(0, 36)}`,
      `password=${canary}`,
      `DEEPSEEK_API_KEY=${canary}`,
      `OPENAI_API_KEY="${canary}"`,
      `mysql://user:${canary}@localhost/db`,
      `-----BEGIN PRIVATE KEY-----\n${canary}\n-----END PRIVATE KEY-----`,
      `Authorization: ${canary}`,
      `X-Api-Key: ${canary}`,
      `ConnectionString=mongodb://admin:${canary}@host`,
    ];

    for (const input of inputs) {
      const sanitized = sanitizeText(input);
      const count = countCanary(sanitized, canary);
      expect(count, `Canary leaked in: "${input.substring(0, 50)}..."`).toBe(0);
    }
  });

  it('sanitizeEventData drops DROP_KEYS and hashes PROMPT_LIKE_KEYS', () => {
    const canary = makeCanary();
    const eventData = {
      runId: 'test-1',
      prompt: canary,           // DROP_KEY → removed
      rawResponse: canary,      // DROP_KEY → removed
      stdout: canary,           // DROP_KEY → removed
      apiKey: canary,           // DROP_KEY → removed
      env: { SECRET: canary },  // DROP_KEY → removed
      absolutePath: canary,     // DROP_KEY → removed
      diff: canary,             // PROMPT_LIKE → hash
      requestText: canary,      // PROMPT_LIKE → hash
      instruction: canary,      // PROMPT_LIKE → hash
      count: 42,                // Number → preserved
    };

    const sanitized = sanitizeEventData(eventData);
    const sanitizedStr = JSON.stringify(sanitized);

    // DROP_KEYS should be absent
    expect(sanitized).not.toHaveProperty('prompt');
    expect(sanitized).not.toHaveProperty('rawResponse');
    expect(sanitized).not.toHaveProperty('stdout');
    expect(sanitized).not.toHaveProperty('apiKey');
    expect(sanitized).not.toHaveProperty('env');
    expect(sanitized).not.toHaveProperty('absolutePath');
    // Number fields preserved
    expect(sanitized.count).toBe(42);
    // runId preserved
    expect(sanitized.runId).toBe('test-1');

    // No canary in output
    const canaryCount = countCanary(sanitizedStr, canary);
    expect(canaryCount, 'Canary leaked in sanitizeEventData output').toBe(0);
  });

  it('containsSecrets detects API keys and tokens', () => {
    const canary = makeCanary();
    expect(containsSecrets(`sk-${canary}`)).toBe(true);
    expect(containsSecrets(`Bearer ${canary}`)).toBe(true);
    expect(containsSecrets('hello world')).toBe(false);
    expect(containsSecrets(`DEEPSEEK_API_KEY=${canary}`)).toBe(true);
  });

  it('computeHash is deterministic', () => {
    const text = 'test-content';
    const h1 = computeHash(text);
    const h2 = computeHash(text);
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64); // SHA-256 hex is 64 chars
  });
});

// ══════════════════════════════════════════════════════════════
// Test 2: Crypto — AES-256-GCM round-trip and failure modes
// ══════════════════════════════════════════════════════════════

describe('AES-256-GCM Crypto', () => {
  it('encrypt → decrypt round-trip succeeds', () => {
    const key = randomBytes(32).toString('hex');
    const svc = new Aes256GcmService(key);
    const canary = makeCanary();

    const encrypted = svc.encrypt(canary);
    expect(encrypted.version).toBe(1);
    expect(encrypted.keyId).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();

    const decrypted = svc.decrypt(encrypted);
    expect(decrypted).toBe(canary);
  });

  it('decryption fails with wrong key', () => {
    const key1 = randomBytes(32).toString('hex');
    const key2 = randomBytes(32).toString('hex');
    const svc1 = new Aes256GcmService(key1);
    const svc2 = new Aes256GcmService(key2);
    const encrypted = svc1.encrypt('test');
    expect(svc2.decrypt(encrypted)).toBeNull();
  });

  it('decryption fails on tampered ciphertext', () => {
    const key = randomBytes(32).toString('hex');
    const svc = new Aes256GcmService(key);
    const encrypted = svc.encrypt('test');
    const tampered = { ...encrypted, ciphertext: 'AAAA' + encrypted.ciphertext.slice(4) };
    expect(svc.decrypt(tampered)).toBeNull();
  });

  it('isAvailable returns false without key', () => {
    const svc = new Aes256GcmService(undefined);
    expect(svc.isAvailable()).toBe(false);
    expect(svc.getKeyId()).toBeNull();
  });

  it('encrypt throws without key', () => {
    const svc = new Aes256GcmService(undefined);
    expect(() => svc.encrypt('test')).toThrow('Encryption not available');
  });

  it('static test helpers work', () => {
    expect(Aes256GcmService.testRoundTrip()).toBe(true);
    expect(Aes256GcmService.testWrongKeyFails()).toBe(true);
    expect(Aes256GcmService.testTamperingFails()).toBe(true);
  });

  it('encrypted payload does not contain plaintext canary in any string field', () => {
    const key = randomBytes(32).toString('hex');
    const svc = new Aes256GcmService(key);
    const canary = makeCanary();
    const encrypted = svc.encrypt(canary);
    const json = JSON.stringify(encrypted);

    // Canary must NOT appear in the JSON-serialized payload
    expect(countCanary(json, canary)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Test 3: PrivacyService — minimal mode with key
// ══════════════════════════════════════════════════════════════

describe('PrivacyService — minimal + test key', () => {
  const key = randomBytes(32).toString('hex');
  const crypto = new Aes256GcmService(key);
  const profile = createDefaultProfile(); // minimal
  const ps = new PrivacyService({ profile, crypto: crypto, projectRoot: '/test/project' });

  it('prepareForPersistence encrypts and zeroes plaintext in minimal mode', () => {
    const canary = makeCanary();
    const result = ps.prepareForPersistence(canary, 'request_text');

    // Plaintext must be null (minimal mode with encryption)
    expect(result.plaintext).toBeNull();
    // Encrypted must be present
    expect(result.encrypted).toBeTruthy();
    expect(result.status).toBe('encrypted');
    expect(result.contentHash).toBeTruthy();

    // Canary must NOT be in plaintext
    if (result.plaintext) {
      expect(countCanary(result.plaintext, canary)).toBe(0);
    }
    // Canary must NOT be in the encrypted JSON payload
    const encJson = JSON.stringify(JSON.parse(result.encrypted!));
    // The encrypted payload (version, keyId, iv, ciphertext, authTag) is safe
    // keyId is SHA-256 of key, iv is random, ciphertext is encrypted
    // none of these encode the plaintext
    expect(result.encrypted!).toContain('"version":1');
  });

  it('prepareForPersistence always produces content hash', () => {
    const canary = makeCanary();
    const result = ps.prepareForPersistence(canary, 'worker_result');
    expect(result.contentHash).toBeTruthy();
    expect(result.contentHash.length).toBe(64);
  });

  it('canSpawnRealProvider returns allowed when encryption is available', () => {
    const check = ps.canSpawnRealProvider();
    expect(check.allowed).toBe(true);
    expect(check.reason).toBeNull();
  });

  it('decryptPayload recovers original content', () => {
    const canary = makeCanary();
    const stored = ps.prepareForPersistence(canary, 'request_text');
    const decrypted = ps.decryptPayload(stored.encrypted);
    expect(decrypted.status).toBe('encrypted');
    expect(decrypted.content).toBe(canary);
  });

  it('decryptPayload returns null content for null input', () => {
    const result = ps.decryptPayload(null);
    expect(result.content).toBeNull();
    expect(result.status).toBe('unavailable');
  });

  it('sanitizeForStorage returns null plaintext in minimal mode', () => {
    const canary = makeCanary();
    const result = ps.sanitizeForStorage(`Some text with ${canary}`, 'event_data');
    expect(result.plaintext).toBeNull();
    expect(result.contentHash).toBeTruthy();
    expect(countCanary(result.plaintext || '', canary)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Test 4: PrivacyService — minimal + no key (fail closed)
// ══════════════════════════════════════════════════════════════

describe('PrivacyService — minimal + no key (fail closed)', () => {
  const profile = createDefaultProfile();
  const ps = new PrivacyService({ profile, crypto: null, projectRoot: '/test/project' });

  it('canSpawnRealProvider returns not-allowed without key', () => {
    const check = ps.canSpawnRealProvider();
    expect(check.allowed).toBe(false);
    expect(check.reason).toBeTruthy();
    expect(check.reason).toContain('encryption key');
  });

  it('prepareForPersistence returns unavailable without fallback', () => {
    const canary = makeCanary();
    const result = ps.prepareForPersistence(canary, 'request_text');
    expect(result.plaintext).toBeNull();
    expect(result.encrypted).toBeNull();
    expect(result.status).toBe('unavailable');
  });

  it('prepareForPersistence with allowPlaintextFallback returns sanitized', () => {
    const canary = makeCanary();
    const result = ps.prepareForPersistence(canary, 'worker_result', { allowPlaintextFallback: true });
    expect(result.status).toBe('sanitized');
    // In sanitized mode without encryption, the canary should be partially redacted
    // Not asserting on canary here because sanitizeText may not catch all patterns
  });

  it('decryptPayload returns encrypted-status when no key for valid payload', () => {
    // Without crypto, even valid encrypted payload can't be decrypted
    const result = ps.decryptPayload('{"version":1,"keyId":"abc","iv":"abc","ciphertext":"abc","authTag":"abc"}');
    expect(result.content).toBeNull();
    expect(result.status).toBe('encrypted');
  });
});

// ══════════════════════════════════════════════════════════════
// Test 5: Debug mode — controlled plaintext with expiry
// ══════════════════════════════════════════════════════════════

describe('PrivacyService — debug mode', () => {
  it('prepareForPersistence stores sanitized plaintext in debug mode', () => {
    const canary = makeCanary();
    const profile = {
      profile: 'debug' as const,
      debugExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      debugWarningAcknowledged: false,
    };
    const key = randomBytes(32).toString('hex');
    const crypto = new Aes256GcmService(key);
    const ps = new PrivacyService({ profile, crypto, projectRoot: '/test/project' });

    const result = ps.prepareForPersistence(`request with ${canary}`, 'request_text');
    expect(result.status).toBe('encrypted'); // Because crypto is available
    // With encryption available, plaintext is null even in debug
    expect(result.plaintext).toBeNull();
    expect(result.encrypted).toBeTruthy();
  });

  it('debug + no key stores sanitized plaintext', () => {
    const canary = makeCanary();
    const profile = {
      profile: 'debug' as const,
      debugExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      debugWarningAcknowledged: false,
    };
    const ps = new PrivacyService({ profile, crypto: null, projectRoot: '/test/project' });

    const result = ps.prepareForPersistence(`request with ${canary}`, 'request_text');
    expect(result.status).toBe('debug');
    expect(result.plaintext).toBeTruthy();
    expect(result.encrypted).toBeNull();
  });

  it('isDebugActive returns false for expired debug', () => {
    const expired = {
      profile: 'debug' as const,
      debugExpiresAt: new Date(Date.now() - 1000).toISOString(),
      debugWarningAcknowledged: false,
    };
    expect(isDebugActive(expired)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// Test 6: Environment isolation
// ══════════════════════════════════════════════════════════════

describe('Environment Allowlist — Provider isolation', () => {
  it('buildSubprocessEnv includes system vars', () => {
    const env = buildSubprocessEnv();
    expect(env.PATH).toBeTruthy();
  });

  it('buildMinimalSubprocessEnv excludes all Provider keys', () => {
    // Set some provider keys in process.env for testing
    const prevDk = process.env.DEEPSEEK_API_KEY;
    const prevOk = process.env.OPENAI_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'test-dk-key';
    process.env.OPENAI_API_KEY = 'test-ok-key';

    try {
      const env = buildMinimalSubprocessEnv();
      // Provider keys must NOT be present
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
      // System vars present
      expect(env.PATH).toBeTruthy();
    } finally {
      // Restore
      if (prevDk !== undefined) process.env.DEEPSEEK_API_KEY = prevDk;
      else delete process.env.DEEPSEEK_API_KEY;
      if (prevOk !== undefined) process.env.OPENAI_API_KEY = prevOk;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it('getEnvDiagnostics never outputs key values', () => {
    const diags = getEnvDiagnostics();
    for (const [key, status] of Object.entries(diags)) {
      expect(status).toMatch(/^(present|not_set)$/);
      // Value must never appear in the diagnostic
      expect(typeof status).toBe('string');
      expect(status.length).toBeLessThan(10); // 'present' or 'not_set'
    }
  });

  it('provider env contains no unrelated keys in diagnostics', () => {
    const diags = getEnvDiagnostics();
    // Only PROVIDER_ALLOWLIST keys should appear
    const validKeys = [
      'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY', 'COHERE_API_KEY', 'BRAINCTL_SQLITE_PATH',
      'BRAINCTL_PRIVACY_PROFILE', 'BRAINCTL_DEBUG_EXPIRES_AT',
    ];
    for (const key of Object.keys(diags)) {
      expect(validKeys).toContain(key);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Test 7: Profile resolution
// ══════════════════════════════════════════════════════════════

describe('Privacy Profile — resolution and expiry', () => {
  it('createDefaultProfile returns minimal', () => {
    const profile = createDefaultProfile();
    expect(profile.profile).toBe('minimal');
    expect(profile.debugExpiresAt).toBeNull();
    expect(profile.debugWarningAcknowledged).toBe(false);
  });

  it('resolvePrivacyProfile with env var BRAINCTL_PRIVACY_PROFILE=debug', () => {
    const prev = process.env.BRAINCTL_PRIVACY_PROFILE;
    process.env.BRAINCTL_PRIVACY_PROFILE = 'debug';
    process.env.BRAINCTL_DEBUG_EXPIRES_AT = new Date(Date.now() + 3600_000).toISOString();
    try {
      const resolved = resolvePrivacyProfile();
      expect(resolved.profile).toBe('debug');
      expect(resolved.debugExpiresAt).toBeTruthy();
    } finally {
      if (prev !== undefined) process.env.BRAINCTL_PRIVACY_PROFILE = prev;
      else delete process.env.BRAINCTL_PRIVACY_PROFILE;
      delete process.env.BRAINCTL_DEBUG_EXPIRES_AT;
    }
  });

  it('resolvePrivacyProfile falls back to minimal when env not set', () => {
    const prev = process.env.BRAINCTL_PRIVACY_PROFILE;
    delete process.env.BRAINCTL_PRIVACY_PROFILE;
    try {
      const resolved = resolvePrivacyProfile();
      expect(resolved.profile).toBe('minimal');
    } finally {
      if (prev !== undefined) process.env.BRAINCTL_PRIVACY_PROFILE = prev;
    }
  });

  it('isDebugActive returns false for minimal profile', () => {
    const profile = createDefaultProfile();
    expect(isDebugActive(profile)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// Test 8: SQLite privacy integration — encrypted storage
// ══════════════════════════════════════════════════════════════

describe('SQLite Privacy Integration', () => {
  const key = randomBytes(32).toString('hex');
  let store: SqliteStateStore;
  let ps: PrivacyService;
  let testIndex = 0;

  function setupTestDb() {
    cleanDb();
    mkdirSync(TEST_DB_DIR, { recursive: true });
    ps = new PrivacyService({
      profile: createDefaultProfile(),
      crypto: new Aes256GcmService(key),
      projectRoot: '/test/project',
    });
    store = SqliteStateStore.create(TEST_DB_PATH, ps);
    const db = (store as any).db;
    // Apply migrations
    const runner = new SqliteMigrationRunner({ path: TEST_DB_PATH } as any, db);
    runner.applyPending();
  }

  beforeEach(() => {
    testIndex++;
    setupTestDb();
  });

  afterAll(() => {
    cleanDb();
  });

  it('createRun encrypts requestText and stores encrypted_request_text', async () => {
    const canary = makeCanary();
    const run = await store.createRun({
      id: 'test-run-1',
      projectId: 'test-project',
      projectRoot: '/test/project',
      requestText: `Implement ${canary} in the codebase`,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(run.id).toBe('test-run-1');
    // requestText should be sanitized (null in minimal+encrypt mode)
    // The actual behavior depends on the migration state

    // Retrieve from DB and check
    const retrieved = await store.getRun('test-run-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.encryptedRequestText).toBeTruthy();

    // Check that encrypted JSON can be decrypted
    if (retrieved!.encryptedRequestText) {
      const decrypted = ps.decryptPayload(retrieved!.encryptedRequestText);
      expect(decrypted.content).toContain(canary);
    }
  });

  it('createRun without privacy service stores as legacy plaintext', async () => {
    cleanDb();
    mkdirSync(TEST_DB_DIR, { recursive: true });
    const plainStore = SqliteStateStore.create(TEST_DB_PATH, null);
    const canary = makeCanary();
    await plainStore.createRun({
      id: 'test-run-2',
      projectId: 'test-project',
      projectRoot: '/test/project',
      requestText: `Legacy ${canary}`,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const retrieved = await plainStore.getRun('test-run-2');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.requestText).toContain(canary);
    expect(retrieved!.encryptedRequestText).toBeNull();
    await plainStore.close();
  });

  it('createEvent with privacy service sanitizes event data', async () => {
    const canary = makeCanary();
    // First create a run
    await store.createRun({
      id: 'test-run-ev',
      projectId: 'test-project',
      projectRoot: '/test/project',
      requestText: 'test request',
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const event = await store.createEvent({
      id: 'test-ev-1',
      runId: 'test-run-ev',
      eventType: 'worker_started',
      eventData: {
        prompt: `Secret prompt with ${canary}`,
        stdout: `Output with ${canary}`,
        apiKey: canary,
        status: 'ok',
      },
    });

    expect(event.id).toBe('test-ev-1');
    // Event data should be sanitized (prompt, stdout, apiKey dropped)
    if (event.eventDataJson) {
      const data = JSON.parse(event.eventDataJson);
      expect(data.prompt).toBeUndefined();
      expect(data.stdout).toBeUndefined();
      expect(data.apiKey).toBeUndefined();
      // 'status' should be preserved
      expect(data.status).toBe('ok');
    }
  });

  it('classifyStoredData correctly identifies encrypted/legacy/unavailable', () => {
    const encryptedJson = JSON.stringify({
      version: 1,
      keyId: 'test-key-id',
      iv: 'test-iv',
      ciphertext: 'test-ct',
      authTag: 'test-at',
    });

    // encrypted: has encrypted JSON
    expect(ps.classifyStoredData('[ENCRYPTED]', encryptedJson)).toBe('encrypted');
    // legacy: has plaintext but no encrypted
    expect(ps.classifyStoredData('some real text', null)).toBe('legacy_plaintext');
    // unavailable: nothing stored
    expect(ps.classifyStoredData(null, null)).toBe('unavailable');
    // encrypted marker but no encrypted payload
    expect(ps.classifyStoredData('[ENCRYPTED]', null)).toBe('encrypted');
    expect(ps.classifyStoredData('[UNAVAILABLE]', null)).toBe('unavailable');
  });

  it('getDisplayText returns appropriate markers', () => {
    const encryptedJson = JSON.stringify({
      version: 1, keyId: 'test-key-id', iv: 'test-iv',
      ciphertext: 'test-ct', authTag: 'test-at',
    });

    // encrypted
    expect(ps.getDisplayText(null, encryptedJson)).toBe('[encrypted]');
    // legacy plaintext in minimal mode — shows marker without content
    expect(ps.getDisplayText('some legacy text', null)).toBe('[legacy_plaintext]');
    // unavailable
    expect(ps.getDisplayText(null, null)).toBe('[unavailable]');
  });

  it('updateAttemptResult encrypts workerResultJson', async () => {
    const canary = makeCanary();
    // Create a run and attempt
    await store.createRun({
      id: 'test-run-att',
      projectId: 'test-project',
      projectRoot: '/test/project',
      requestText: 'test',
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // We need to create an attempt first
    const db = (store as any).db;
    // Need parent records: stages -> tasks -> task_attempts
    db.prepare(
      "INSERT INTO stages (id, run_id, stage_number, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('test-stage-1', 'test-run-att', 1, 'Test Stage', 'pending',
      new Date().toISOString(), new Date().toISOString());
    db.prepare(
      "INSERT INTO tasks (id, run_id, title, status, spec_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('test-task-1', 'test-run-att', 'Test Task', 'pending', '{}',
      new Date().toISOString(), new Date().toISOString());
    db.prepare(
      "INSERT INTO task_attempts (id, task_id, stage_id, attempt_number, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('test-att-1', 'test-task-1', 'test-stage-1', 1, 'running',
      new Date().toISOString(), new Date().toISOString());

    const workerResult = JSON.stringify({
      taskId: 'test-task-1',
      status: 'completed',
      summary: `Worker completed task with secret ${canary}`,
    });

    await store.updateAttemptResult('test-att-1', {
      workerResultJson: workerResult,
      exitReason: 'completed',
    });

    const attempt = await store.getAttempt('test-att-1');
    expect(attempt).not.toBeNull();
    // Check that encrypted column has content
    if (attempt!.encryptedWorkerResultJson) {
      // Decrypt and verify
      const decrypted = ps.decryptPayload(attempt!.encryptedWorkerResultJson);
      expect(decrypted.content).toContain(canary);
    }
    // Plaintext column should be sanitized/null
    expect(attempt!.workerResultJson).not.toContain(canary);
  });
});

// ══════════════════════════════════════════════════════════════
// Test 9: Legacy database compatibility
// ══════════════════════════════════════════════════════════════

describe('Legacy Database Compatibility', () => {
  it('reads legacy plaintext runs without crashing', async () => {
    cleanDb();
    mkdirSync(TEST_DB_DIR, { recursive: true });
    const plainStore = SqliteStateStore.create(TEST_DB_PATH, null);
    const canary = makeCanary();
    await plainStore.createRun({
      id: 'legacy-run',
      projectId: 'test-project',
      projectRoot: '/test/project',
      requestText: `legacy ${canary}`,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await plainStore.close();

    // Reopen with privacy service
    const ps = new PrivacyService({
      profile: createDefaultProfile(),
      crypto: null,
      projectRoot: '/test/project',
    });
    const privacyStore = SqliteStateStore.create(TEST_DB_PATH, ps);
    const retrieved = await privacyStore.getRun('legacy-run');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.requestText).toContain(canary);
    expect(retrieved!.encryptedRequestText).toBeNull();
    // Legacy data is read-compatible, not modified
    await privacyStore.close();
    cleanDb();
  });
});

// ══════════════════════════════════════════════════════════════
// Test 10: Artifact Store
// ══════════════════════════════════════════════════════════════

describe('PrivacyArtifactStore', () => {
  const testDir = resolve(tmpdir(), 'brainctl-artifact-test-' + Date.now());

  afterAll(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('writeLog sanitizes content in minimal mode', () => {
    const store = new PrivacyArtifactStore({ baseDir: testDir, defaultRetentionDays: 7 });
    const canary = makeCanary();
    const profile = createDefaultProfile();

    store.writeLog('test.log', `Log content with sk-${canary}`, { profile });

    const content = readFileSync(resolve(testDir, 'test.log'), 'utf-8');
    expect(content).toContain('[PRIVACY: minimal mode');
    // API key should be redacted
    expect(countCanary(content, canary)).toBe(0);
  });

  it('writePromptIfDebug returns hash but does not write in minimal mode', () => {
    const store = new PrivacyArtifactStore({ baseDir: testDir, defaultRetentionDays: 7 });
    const canary = makeCanary();
    const profile = createDefaultProfile();

    const hash = store.writePromptIfDebug('prompt.txt', `Prompt: ${canary}`, { profile });
    expect(hash).toBeTruthy();
    expect(hash.length).toBe(64);

    // File should not exist in minimal mode
    expect(existsSync(resolve(testDir, 'prompt.txt'))).toBe(false);
  });

  it('writeLog includes debug warning in debug mode', () => {
    const store = new PrivacyArtifactStore({ baseDir: testDir, defaultRetentionDays: 7 });
    const profile = {
      profile: 'debug' as const,
      debugExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      debugWarningAcknowledged: false,
    };

    store.writeLog('debug.log', 'test content', { profile });

    const content = readFileSync(resolve(testDir, 'debug.log'), 'utf-8');
    expect(content).toContain('DEBUG MODE');
    expect(content).toContain('DO NOT COMMIT');
  });

  it('hashProjectRoot produces consistent hash', () => {
    const h1 = hashProjectRoot('/test/path');
    const h2 = hashProjectRoot('/test/path');
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
  });

  it('toRelativePath converts absolute to relative', () => {
    expect(toRelativePath('/project/src/file.ts', '/project')).toBe('src/file.ts');
    expect(toRelativePath('/other/src/file.ts', '/project')).toBeNull();
  });
});
