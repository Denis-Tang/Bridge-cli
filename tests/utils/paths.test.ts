import { describe, it, expect } from 'vitest';
import { normalizeProjectPath, isPathInside } from '../../src/utils/paths.js';

describe('normalizeProjectPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeProjectPath('C:\\Users\\test\\project')).toBe('C:/Users/test/project');
  });

  it('uppercases drive letter', () => {
    expect(normalizeProjectPath('d:/users/test')).toBe('D:/users/test');
  });

  it('handles Chinese paths', () => {
    expect(normalizeProjectPath('D:\\示例\\项目')).toBe('D:/示例/项目');
  });

  it('handles paths with spaces', () => {
    expect(normalizeProjectPath('C:\\My Projects\\test project')).toBe('C:/My Projects/test project');
  });

  it('resolves double dots', () => {
    expect(normalizeProjectPath('C:/a/b/../c')).toBe('C:/a/c');
  });
});

describe('isPathInside', () => {
  it('returns true for direct child', () => {
    expect(isPathInside('C:/project', 'C:/project/src')).toBe(true);
  });

  it('returns true for nested child', () => {
    expect(isPathInside('C:/project', 'C:/project/src/deep/file.ts')).toBe(true);
  });

  it('returns false for parent', () => {
    expect(isPathInside('C:/project/src', 'C:/project')).toBe(false);
  });

  it('returns false for path traversal with ..', () => {
    expect(isPathInside('C:/project', 'C:/project/../outside')).toBe(false);
  });

  it('returns false for completely different path', () => {
    expect(isPathInside('C:/project', 'D:/other')).toBe(false);
  });

  it('handles Chinese paths', () => {
    expect(isPathInside('D:/示例/项目', 'D:/示例/项目/子目录')).toBe(true);
  });

  it('handles case-insensitive drive letters', () => {
    expect(isPathInside('c:/project', 'C:/project/src')).toBe(true);
  });
});
