import { describe, it, expect, afterEach } from 'vitest';
import { sep } from 'node:path';

describe('SqliteConfig', () => {
  const OLD_ENV = process.env.BRAINCTL_SQLITE_PATH;

  afterEach(() => {
    if (OLD_ENV) {
      process.env.BRAINCTL_SQLITE_PATH = OLD_ENV;
    } else {
      delete process.env.BRAINCTL_SQLITE_PATH;
    }
  });

  it('returns default path when no env var set', async () => {
    delete process.env.BRAINCTL_SQLITE_PATH;
    const { readSqliteConfigFromEnv } = await import('../../src/state/sqlite-config.js');
    const config = readSqliteConfigFromEnv();
    expect(config.path).toContain('.brainctl');
    expect(config.path).toContain('state');
    expect(config.path).toContain('brainctl.sqlite');
  });

  it('respects BRAINCTL_SQLITE_PATH env var', async () => {
    process.env.BRAINCTL_SQLITE_PATH = '/custom/path/test.db';
    const { readSqliteConfigFromEnv } = await import('../../src/state/sqlite-config.js');
    const config = readSqliteConfigFromEnv('/project');
    expect(config.path).toContain('custom');
    expect(config.path).toContain('path');
    expect(config.path).toContain('test.db');
  });

  it('resolves relative path against project root', async () => {
    delete process.env.BRAINCTL_SQLITE_PATH;
    const { readSqliteConfigFromEnv } = await import('../../src/state/sqlite-config.js');
    const config = readSqliteConfigFromEnv('/my/project');
    const expected = `.brainctl${sep}state${sep}brainctl.sqlite`;
    expect(config.path).toContain(expected);
  });

  it('provides maskedPath equal to path (no secrets in path)', async () => {
    delete process.env.BRAINCTL_SQLITE_PATH;
    const { readSqliteConfigFromEnv } = await import('../../src/state/sqlite-config.js');
    const config = readSqliteConfigFromEnv();
    expect(config.maskedPath).toBe(config.path);
  });
});
