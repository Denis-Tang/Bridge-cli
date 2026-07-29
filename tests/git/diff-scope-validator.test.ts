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

    it('rejects absolute paths even when they point at allowed content', () => {
      const files = ['C:/fake-project/docs/README.md'];  // fake absolute path, 已脱敏
      const result = validator.validate(files, ['docs/'], []);
      expect(result.valid).toBe(false);
      expect(result.invalidPathFiles).toContain(files[0]);
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
