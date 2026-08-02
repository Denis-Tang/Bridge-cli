import { describe, it, expect } from 'vitest';
import { DiffScopeValidator } from '../../src/git/diff-scope-validator.js';

const validator = new DiffScopeValidator();

describe('DiffScopeValidator', () => {
  describe('validate', () => {
    it('passes when all files are in allowed paths', () => {
      const files = ['docs/README.md', 'docs/guide.md'];
      const result = validator.validate(files, ['docs/'], []);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.allowedFiles).toEqual(files);
    });

    it('detects files outside allowed paths', () => {
      const files = ['docs/README.md', 'src/index.ts'];
      const result = validator.validate(files, ['docs/'], []);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain('src/index.ts');
    });

    it('detects files in forbidden paths', () => {
      const files = ['docs/README.md', '.env'];
      const result = validator.validate(files, ['docs/'], ['.env']);
      expect(result.valid).toBe(false);
      expect(result.forbiddenFiles).toContain('.env');
      expect(result.violations).toHaveLength(1);
    });

    it('handles nested forbidden paths', () => {
      const files = ['config/secrets.json'];
      const result = validator.validate(files, ['config/'], ['**/*secret*']);
      expect(result.valid).toBe(false);
      expect(result.forbiddenFiles).toContain('config/secrets.json');
    });

    it('passes with empty changed files', () => {
      const result = validator.validate([], ['docs/'], []);
      expect(result.valid).toBe(true);
    });

    it('fail-closes when allowedPaths is empty (no write path is authorized)', () => {
      const files = ['docs/README.md'];
      const result = validator.validate(files, [], []);
      expect(result.valid).toBe(false);
      expect(result.allowedFiles).toEqual([]);
      expect(result.violations.some((v) => v.includes('allowedPaths is empty'))).toBe(true);
      // Root cause must be visible, not just a per-file "not in any allowed path"
      expect(result.violations[0]).toContain('allowedPaths is empty');
    });

    it('still flags forbidden files when allowedPaths is empty', () => {
      const result = validator.validate(['.env'], [], ['.env']);
      expect(result.valid).toBe(false);
      expect(result.forbiddenFiles).toContain('.env');
      expect(result.violations.some((v) => v.includes('allowedPaths is empty'))).toBe(true);
    });

    it('rejects absolute paths even when they point at allowed content', () => {
      const files = ['C:/fake-project/docs/README.md'];  // fake absolute path, 已脱敏
      const result = validator.validate(files, ['docs/'], []);
      expect(result.valid).toBe(false);
      expect(result.invalidPathFiles).toContain(files[0]);
    });

    it('ignores an absolute external forbidden directory for repository-relative Git evidence', () => {
      const result = validator.validate(
        ['src/index.ts'],
        ['src/'],
        ['D:/external-private-evidence/'],
        'C:/fake-project',
      );
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('maps an absolute in-repository forbidden directory back to a relative policy', () => {
      const result = validator.validate(
        ['src/private/key.txt'],
        ['src/'],
        ['C:/fake-project/src/private/'],
        'C:/fake-project',
      );
      expect(result.valid).toBe(false);
      expect(result.forbiddenFiles).toEqual(['src/private/key.txt']);
    });

    it('still rejects absolute allowed paths even when repositoryRoot is provided', () => {
      const result = validator.validate(
        ['src/index.ts'],
        ['C:/fake-project/src/'],
        [],
        'C:/fake-project',
      );
      expect(result.valid).toBe(false);
      expect(result.violations.join('\n')).toContain('absolute path is forbidden');
    });

    it('handles Windows backslash paths', () => {
      const files = ['src\\index.ts'];
      const result = validator.validate(files, ['src/'], []);
      expect(result.valid).toBe(true);
    });

    it('rejects parent-directory escapes in changed files and policy paths', () => {
      const result = validator.validate(['src/../secrets.txt'], ['../src/'], []);
      expect(result.valid).toBe(false);
      expect(result.violations.join('\n')).toContain('.. escape');
    });

    it('normalizes case and slash variants before matching', () => {
      const result = validator.validate(['SRC\\Feature\\Index.ts'], ['src/feature/'], []);
      expect(result.valid).toBe(true);
    });
  });
});
