import { describe, expect, it } from 'vitest';
import { needsAllowedPathsNotice } from '../../src/cli/commands/init.js';
import { defaults } from '../../src/adapters/project-adapter.js';

describe('init allowedPaths notice', () => {
  it('fires for the default suggested config, which ships an empty allowedPaths', () => {
    // defaults() deliberately authorizes no write path; the schema rejects it,
    // so init must say so instead of leaving the user with a bare schema error.
    expect(needsAllowedPathsNotice(defaults('.') as unknown as Record<string, unknown>)).toBe(true);
  });

  it('fires for an empty or malformed allowedPaths', () => {
    expect(needsAllowedPathsNotice({ allowedPaths: [] })).toBe(true);
    expect(needsAllowedPathsNotice({})).toBe(true);
    expect(needsAllowedPathsNotice({ allowedPaths: 'src/' })).toBe(true);
  });

  it('stays silent once a real write scope is present', () => {
    expect(needsAllowedPathsNotice({ allowedPaths: ['src/'] })).toBe(false);
  });
});
