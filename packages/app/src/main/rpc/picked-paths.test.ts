import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickedFile, resolveRequestPath } from './picked-paths';

describe('resolveRequestPath', () => {
  it('refuses a parent segment written with a backslash', () => {
    expect(() => resolveRequestPath('..\\x')).toThrow('".." segments');
  });

  it('refuses a Windows drive path that climbs out with a parent segment', () => {
    expect(() => resolveRequestPath('C:\\a\\..\\b')).toThrow('".." segments');
  });

  it('keeps a UNC path and does not read it as traversal', () => {
    const unc = '\\\\host\\share\\file';
    expect(resolveRequestPath(unc)).toBe(resolve(unc));
  });

  it('resolves a forward-slash path', () => {
    expect(resolveRequestPath('/data/out/a.json')).toBe(resolve('/data/out/a.json'));
    expect(resolveRequestPath('C:/data/a.json')).toBe(resolve('C:/data/a.json'));
  });

  it('refuses a forward-slash parent segment', () => {
    expect(() => resolveRequestPath('C:/a/../b')).toThrow('".." segments');
  });

  it('resolves mixed separators and refuses a mixed parent segment', () => {
    expect(resolveRequestPath('C:\\a/b\\c.json')).toBe(resolve('C:\\a/b\\c.json'));
    expect(() => resolveRequestPath('C:\\a/..\\b')).toThrow('".." segments');
  });
});

describe('pickedFile', () => {
  it('reports traversal before it checks the dialog', () => {
    expect(() => pickedFile('..\\x', new Set())).toThrow('".." segments');
  });

  it('returns the resolved path of a file picked this session', () => {
    const picked = 'C:\\a\\b.csv';
    expect(pickedFile(picked, new Set([resolve(picked)]))).toBe(resolve(picked));
  });

  it('refuses a UNC file that was not picked in a dialog', () => {
    expect(() => pickedFile('\\\\host\\share\\file', new Set())).toThrow(
      'Choose the file in a dialog first.',
    );
  });

  it('accepts a picked forward-slash path', () => {
    const picked = '/data/a.csv';
    expect(pickedFile(picked, new Set([resolve(picked)]))).toBe(resolve(picked));
  });

  it('accepts a picked path with mixed separators', () => {
    const picked = 'C:\\a/b.csv';
    expect(pickedFile(picked, new Set([resolve(picked)]))).toBe(resolve(picked));
  });
});
