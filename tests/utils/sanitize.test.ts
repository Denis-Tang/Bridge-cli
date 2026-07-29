// ── M4 Sanitize Utilities Tests ────────────────────────────────────────
// Tests promptHash and sanitizeEventData for correctness and safety.
// NO raw prompts, secrets, or tokens appear as verified plaintext — only
// as test input that gets hashed or redacted immediately.

import { describe, it, expect } from 'vitest';
import { promptHash, sanitizeEventData } from '../../src/utils/sanitize.js';

describe('promptHash', () => {
  it('produces consistent SHA256 hash', () => {
    const h1 = promptHash('hello');
    const h2 = promptHash('hello');
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different inputs', () => {
    const h1 = promptHash('alpha');
    const h2 = promptHash('beta');
    expect(h1).not.toBe(h2);
  });

  it('output is 64-char hex string', () => {
    const h = promptHash('test-input');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is irreversible — hash does not contain input', () => {
    const input = 'top-secret-project-plan-v2';
    const h = promptHash(input);
    expect(h).not.toContain('top-secret');
    expect(h).not.toContain('project-plan');
    expect(h.length).toBe(64);
  });

  it('handles empty string', () => {
    const h = promptHash('');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    // SHA256 of empty string is known
    expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('same input always produces same hash (deterministic)', () => {
    const input = 'prompt-for-task-42';
    const results = Array.from({ length: 10 }, () => promptHash(input));
    for (const r of results) {
      expect(r).toBe(results[0]);
    }
  });
});

describe('sanitizeEventData — secret redaction', () => {
  it('removes sensitive key names entirely', () => {
    const input = {
      prompt: 'do-not-store-me',
      apiKey: 'sk-12345678901234567890',
      password: 's3cret',
      secret: 'do-not-leak',
      token: 'Bearer eyJ...',
      normal: 'safe-value',
    };
    const output = sanitizeEventData(input);
    expect(output).not.toHaveProperty('prompt');
    expect(output).not.toHaveProperty('apiKey');
    expect(output).not.toHaveProperty('password');
    expect(output).not.toHaveProperty('secret');
    expect(output).not.toHaveProperty('token');
    expect(output.normal).toBe('safe-value');
  });

  it('redacts Bearer tokens in string values', () => {
    const input = {
      description: 'Auth header: Bearer abcdef123456',
      safe: 'just text',
    };
    const output = sanitizeEventData(input);
    expect(output.safe).toBe('just text');
    expect(output.description).toContain('[REDACTED]');
    expect(output.description).not.toContain('abcdef123456');
  });

  it('redacts API key patterns (sk-, pk-, rk-)', () => {
    const input = {
      msg: 'Using key sk-abcdefghijklmnopqrstuvwxy',
      ok: 'sk-short', // too short to match
    };
    const output = sanitizeEventData(input);
    expect(output.msg).toContain('[REDACTED]');
    expect(output.msg).not.toContain('sk-abcdefg');
    expect(output.ok).toBe('sk-short');
  });

  it('redacts JWT tokens', () => {
    const input = {
      header: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    };
    const output = sanitizeEventData(input);
    // Bearer redacts the token; JWT pattern also applies
    expect(output.header).toContain('[REDACTED]');
    expect(output.header).not.toMatch(/eyJ/);
  });

  it('redacts AWS-style key IDs', () => {
    const input = {
      config: 'access key: AKIAIOSFODNN7EXAMPLE',
    };
    const output = sanitizeEventData(input);
    expect(output.config).toContain('[REDACTED]');
    expect(output.config).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts password in assignment patterns', () => {
    const input = {
      line: 'DATABASE_URL=postgres://user:password123@host/db',
    };
    const output = sanitizeEventData(input);
    expect(output.line).toContain('[REDACTED]');
    // The password= pattern catches this
    expect(output.line).not.toContain('password123');
  });

  it('redacts connection strings with embedded credentials', () => {
    const input = {
      conn: 'mysql://admin:secret123@localhost:3306/mydb',
    };
    const output = sanitizeEventData(input);
    expect(output.conn).toContain('[REDACTED]');
    expect(output.conn).not.toContain('admin');
    expect(output.conn).not.toContain('secret123');
  });

  it('redacts private key PEM blocks', () => {
    const input = {
      key: `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==
-----END RSA PRIVATE KEY-----`,
      normal: 'unrelated',
    };
    const output = sanitizeEventData(input);
    expect(output.key).toContain('[REDACTED]');
    expect(output.key).not.toContain('MIIBOgIB');
    expect(output.normal).toBe('unrelated');
  });

  it('leaves safe fields untouched', () => {
    const input = {
      id: 'evt-001',
      status: 'completed',
      count: 42,
      items: ['a', 'b', 'c'],
      nested: { key: 'value' },
    };
    const output = sanitizeEventData(input);
    expect(output).toEqual(input);
  });

  it('recursively sanitizes nested objects', () => {
    const input = {
      outer: {
        inner: {
          password: 's3cret',
          prompt: 'dangerous',
          safe: 'ok',
        },
        normal: 'fine',
      },
    };
    const output = sanitizeEventData(input);
    const outer = output.outer as Record<string, unknown>;
    expect(outer).not.toHaveProperty('password');
    expect(outer).not.toHaveProperty('prompt');
    expect(outer.normal).toBe('fine');
    const inner = outer.inner as Record<string, unknown>;
    expect(inner).not.toHaveProperty('password');
    expect(inner).not.toHaveProperty('prompt');
    expect(inner.safe).toBe('ok');
  });

  it('handles arrays with string sanitization', () => {
    const input = {
      lines: [
        'normal line',
        'password=secret123',
        'Bearer abcdefgh123',
        'clean',
      ],
    };
    const output = sanitizeEventData(input);
    const lines = output.lines as string[];
    expect(lines[0]).toBe('normal line');
    expect(lines[1]).toContain('[REDACTED]');
    expect(lines[2]).toContain('[REDACTED]');
    expect(lines[3]).toBe('clean');
  });
});

describe('sanitizeEventData — prompt field hashing', () => {
  it('replaces prompt fields with SHA256 hash, not raw text', () => {
    const input = {
      taskId: 'task-1',
      promptText: 'build a REST API endpoint',
      result: 'success',
    };
    const output = sanitizeEventData(input);
    // promptText should be replaced with its hash
    expect(output.promptText).toMatch(/^[a-f0-9]{64}$/);
    expect(output.promptText).not.toContain('build');
    expect(output.promptText).not.toContain('REST');
    expect(output.taskId).toBe('task-1');
    expect(output.result).toBe('success');
  });

  it('prompt fields — content, instruction, message are hashed', () => {
    const input = {
      instruction: 'do X then Y',
      message: 'hello world',
      content: 'some data',
    };
    const output = sanitizeEventData(input);
    expect(output.instruction).toMatch(/^[a-f0-9]{64}$/);
    expect(output.message).toMatch(/^[a-f0-9]{64}$/);
    expect(output.content).toMatch(/^[a-f0-9]{64}$/);
  });

  it('empty prompt fields are removed entirely by unified sanitizer', () => {
    // New unified sanitizer drops the entire key if it's in the DROP_KEYS set
    const input = {
      promptText: '',
      safe: 'ok',
    };
    const output = sanitizeEventData(input);
    // promptText is dropped entirely (in DROP_KEYS), undefined is fine
    expect(output.promptText).toBeUndefined();
    expect(output.safe).toBe('ok');
  });
});
