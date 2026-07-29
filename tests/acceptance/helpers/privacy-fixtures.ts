import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Aes256GcmService } from '../../../src/privacy/crypto.js';
import { PrivacyService } from '../../../src/privacy/privacy-service.js';
import { SqliteMigrationRunner } from '../../../src/state/sqlite-migration-runner.js';
import { SqliteStateStore } from '../../../src/state/sqlite-store.js';

export interface PrivacyFixture {
  root: string;
  sqlitePath: string;
  artifactsDir: string;
}

export interface PrivacyCanaries {
  request: string;
  workerResult: string;
  event: string;
  prompt: string;
  logSecret: string;
  testKey: string;
}

export function createPrivacyCanaries(): PrivacyCanaries {
  const suffix = randomBytes(12).toString('hex');
  return {
    request: `REQ-CANARY-${suffix}`,
    workerResult: `WR-CANARY-${suffix}`,
    event: `EVENT-CANARY-${suffix}`,
    prompt: `PROMPT-CANARY-${suffix}`,
    logSecret: `sk-${randomBytes(24).toString('hex')}`,
    testKey: randomBytes(32).toString('hex'),
  };
}

export function createPrivacyFixture(): PrivacyFixture {
  const root = mkdtempSync(join(tmpdir(), 'brainctl-privacy-accept-'));
  const artifactsDir = join(root, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });
  return { root, sqlitePath: join(root, 'privacy.sqlite'), artifactsDir };
}

export function cleanupPrivacyFixture(fixture: PrivacyFixture): boolean {
  const resolvedRoot = resolve(fixture.root);
  const tempPrefix = resolve(tmpdir()) + sep;
  if (!resolvedRoot.startsWith(tempPrefix) || !basename(resolvedRoot).startsWith('brainctl-privacy-accept-')) {
    return false;
  }
  rmSync(resolvedRoot, { recursive: true, force: true });
  return true;
}

export function createMinimalPrivacyService(testKey?: string, projectRoot?: string): PrivacyService {
  return new PrivacyService({
    profile: { profile: 'minimal', debugExpiresAt: null, debugWarningAcknowledged: false },
    crypto: testKey ? new Aes256GcmService(testKey) : null,
    projectRoot: projectRoot ?? null,
  });
}

export function createDebugPrivacyService(testKey: string, expiresAt: string): PrivacyService {
  return new PrivacyService({
    profile: { profile: 'debug', debugExpiresAt: expiresAt, debugWarningAcknowledged: true },
    crypto: new Aes256GcmService(testKey),
    projectRoot: null,
  });
}

export function createPrivacyStore(
  fixture: PrivacyFixture,
  privacyService: PrivacyService | null,
): SqliteStateStore {
  const store = SqliteStateStore.create(fixture.sqlitePath, privacyService);
  new SqliteMigrationRunner(
    { path: fixture.sqlitePath, maskedPath: '[privacy-acceptance-db]' },
    store.getDatabase(),
  ).applyPending();
  return store;
}

export function scanFixtureForCanary(root: string, canary: string): string[] {
  const needle = Buffer.from(canary, 'utf8');
  const matches: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (readFileSync(absolutePath).includes(needle)) {
        matches.push(absolutePath.slice(resolve(root).length + 1));
      }
    }
  }

  if (existsSync(root)) walk(root);
  return matches;
}
