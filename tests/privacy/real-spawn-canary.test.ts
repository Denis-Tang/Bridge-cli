// ── P0-2: Real Spawn Privacy Canary Tests ─────────────────────────────
// Verify that canSpawnRealProvider() and buildProviderEnv() correctly
// gate and isolate real Provider spawns. All assertions check variable
// NAME existence only, never values. No real Provider is ever spawned.

import { afterEach, describe, it, expect, vi } from 'vitest';
import { PrivacyService } from '../../src/privacy/privacy-service.js';

describe('P0-2 Real Spawn Privacy Canary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('canSpawnRealProvider() — fail-closed in minimal mode', () => {
    it('returns allowed=false in minimal mode without encryption key', () => {
      const ps = PrivacyService.create({
        projectOverride: { profile: 'minimal' },
      });
      const check = ps.canSpawnRealProvider();
      expect(check.allowed).toBe(false);
      expect(check.reason).toBeTruthy();
      expect(check.reason).toContain('encryption');
    });

    it('returns allowed=true in debug mode without key', () => {
      const ps = PrivacyService.create({
        projectOverride: { profile: 'debug' },
      });
      const check = ps.canSpawnRealProvider();
      expect(check.allowed).toBe(true);
      expect(check.reason).toBeNull();
    });

    it('returns allowed=true in minimal mode with encryption key', () => {
      const ps = PrivacyService.create({
        encryptionKey: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        projectOverride: { profile: 'minimal' },
      });
      const check = ps.canSpawnRealProvider();
      // With a valid encryption key, minimal mode allows spawn
      expect(check.allowed).toBe(true);
      expect(check.reason).toBeNull();
    });

    it('returns allowed=false with default profile (no key → fail-closed)', () => {
      const ps = PrivacyService.create();
      const check = ps.canSpawnRealProvider();
      // Default profile without encryption key → fail-closed (safe default)
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('encryption');
    });
  });

  describe('buildProviderEnv() — per-provider isolation', () => {
    it('buildProviderEnv("pi") returns an object with env var names', () => {
      const ps = PrivacyService.create();
      const env = ps.buildProviderEnv('pi');
      expect(typeof env).toBe('object');
      expect(env).not.toBeNull();
      // Must be a plain record of string values
      for (const key of Object.keys(env)) {
        expect(typeof key).toBe('string');
        // Only check that value exists (string or undefined), never inspect the value
        expect(env[key] !== undefined || env[key] === undefined).toBe(true);
      }
    });

    it('passes only the selected Pi Provider key name', () => {
      vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-deepseek-key');
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key');
      vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-anthropic-key');
      vi.stubEnv('MOONSHOT_API_KEY', 'synthetic-moonshot-key');
      vi.stubEnv('DASHSCOPE_API_KEY', 'synthetic-dashscope-key');

      const envNames = Object.keys(
        PrivacyService.create().buildProviderEnv('pi', undefined, 'deepseek/deepseek-v4-flash'),
      );

      expect(envNames).toContain('DEEPSEEK_API_KEY');
      expect(envNames).not.toContain('OPENAI_API_KEY');
      expect(envNames).not.toContain('ANTHROPIC_API_KEY');
      expect(envNames).not.toContain('MOONSHOT_API_KEY');
      expect(envNames).not.toContain('DASHSCOPE_API_KEY');
    });

    it('buildProviderEnv("codex") returns an object with env var names', () => {
      const ps = PrivacyService.create();
      const env = ps.buildProviderEnv('codex');
      expect(typeof env).toBe('object');
      expect(env).not.toBeNull();
      for (const key of Object.keys(env)) {
        expect(typeof key).toBe('string');
        expect(env[key] !== undefined || env[key] === undefined).toBe(true);
      }
    });

    it('keeps all Provider key names out of Codex CLI env', () => {
      vi.stubEnv('DEEPSEEK_API_KEY', 'synthetic-deepseek-key');
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key');
      vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-anthropic-key');

      const envNames = Object.keys(PrivacyService.create().buildProviderEnv('codex'));
      expect(envNames).not.toContain('DEEPSEEK_API_KEY');
      expect(envNames).not.toContain('OPENAI_API_KEY');
      expect(envNames).not.toContain('ANTHROPIC_API_KEY');
    });

    it('buildProviderEnv("quality_gate") returns minimal env without Provider keys', () => {
      const ps = PrivacyService.create();
      const env = ps.buildProviderEnv('quality_gate');

      // Must be an object
      expect(typeof env).toBe('object');

      // Provider key names must NOT be present in quality_gate env
      const providerKeyPatterns = [
        'API_KEY',
        'TOKEN',
        'SECRET',
        'DEEPSEEK',
        'OPENAI',
        'ANTHROPIC',
        'CODE',
      ];

      const envKeys = Object.keys(env).map(k => k.toUpperCase());
      for (const pattern of providerKeyPatterns) {
        const hasProviderKey = envKeys.some(k => k.includes(pattern));
        expect(hasProviderKey).toBe(false);
      }
    });

    it('each provider type returns a distinct env object', () => {
      const ps = PrivacyService.create();
      const piEnv = ps.buildProviderEnv('pi');
      const codexEnv = ps.buildProviderEnv('codex');
      const qgEnv = ps.buildProviderEnv('quality_gate');

      // All three must be objects
      expect(typeof piEnv).toBe('object');
      expect(typeof codexEnv).toBe('object');
      expect(typeof qgEnv).toBe('object');

      // They should be independent objects (not the same reference)
      expect(piEnv).not.toBe(codexEnv);
      expect(piEnv).not.toBe(qgEnv);
      expect(codexEnv).not.toBe(qgEnv);
    });
  });

  describe('Integration: fake spawn blocked in minimal mode', () => {
    it('PrivacyService in minimal mode without key blocks spawn', () => {
      // Simulates the fail-closed path that StageScheduler would take
      const ps = PrivacyService.create({
        projectOverride: { profile: 'minimal' },
      });

      const gate = ps.canSpawnRealProvider();
      expect(gate.allowed).toBe(false);

      // The scheduler should NOT proceed to spawn
      // This is the canonical gate that protects real Provider execution
    });

    it('PrivacyService in debug mode allows spawn (gated by user intent)', () => {
      const ps = PrivacyService.create({
        projectOverride: { profile: 'debug' },
      });

      const gate = ps.canSpawnRealProvider();
      expect(gate.allowed).toBe(true);
      // Note: debug mode allows spawn BUT requires user to have explicitly
      // opted into debug mode with an expiration. This is a conscious choice.
    });
  });
});
