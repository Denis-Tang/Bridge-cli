import { describe, it, expect } from 'vitest';
import { redactLogContent, wouldRedact } from '../../src/adapters/pi-worker-log-redactor.js';

describe('redactLogContent', () => {
  it('redacts DEEPSEEK_API_KEY values', () => {
    const input = 'export DEEPSEEK_API_KEY=sk-my-secret-key-12345';
    const result = redactLogContent(input);
    expect(result).not.toContain('sk-my-secret-key-12345');
    // New unified sanitizer uses [REDACTED] instead of ***
    expect(result).toContain('[REDACTED]');
  });

  it('redacts DEEPSEEK_API_KEY with quotes', () => {
    const input = 'set DEEPSEEK_API_KEY="sk-secret-value"';
    const result = redactLogContent(input);
    expect(result).not.toContain('sk-secret-value');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Authorization Bearer tokens', () => {
    const input = 'Authorization: Bearer sk-my-api-token-abcdef';
    const result = redactLogContent(input);
    expect(result).not.toContain('sk-my-api-token-abcdef');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts standalone sk- tokens', () => {
    const input = 'Using API key sk-abc123def456ghi789jkl';
    const result = redactLogContent(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-abc123def456ghi789jkl');
  });

  it('redacts ghp_ GitHub tokens', () => {
    const input = 'token=ghp_abcdef123456789012345678901234567890';
    const result = redactLogContent(input);
    expect(result).not.toContain('ghp_abcdef123456789012345678901234567890');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts MySQL connection passwords', () => {
    const input = 'mysql://brainctl_user:super-secret-password@127.0.0.1:3306/brainctl';
    const result = redactLogContent(input);
    expect(result).not.toContain('super-secret-password');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts generic URL passwords', () => {
    const input = 'postgres://admin:pass123@localhost:5432/db';
    const result = redactLogContent(input);
    expect(result).not.toContain('pass123');
    expect(result).toContain('[REDACTED]');
  });

  it('does not modify safe content', () => {
    const input = 'This is a safe log message with no secrets.';
    const result = redactLogContent(input);
    expect(result).toBe(input);
  });

  it('handles empty input', () => {
    expect(redactLogContent('')).toBe('');
  });
});

describe('wouldRedact', () => {
  it('returns true for content with API keys', () => {
    expect(wouldRedact('sk-abc123def45678901234')).toBe(true);
  });

  it('returns false for safe content', () => {
    expect(wouldRedact('hello world')).toBe(false);
  });
});
