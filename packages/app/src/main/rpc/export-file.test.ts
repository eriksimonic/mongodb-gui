import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportTargetProblem, replaceFile } from './export-file';

describe('replaceFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the content to a file that does not exist yet', () => {
    const path = join(dir, 'results.json');
    replaceFile(path, '[1,2]\n');
    expect(readFileSync(path, 'utf8')).toBe('[1,2]\n');
  });

  it('replaces an existing file that the user picked', () => {
    const path = join(dir, 'results.csv');
    writeFileSync(path, 'old');
    replaceFile(path, 'new');
    expect(readFileSync(path, 'utf8')).toBe('new');
  });

  it('leaves no temporary file behind', () => {
    replaceFile(join(dir, 'a.json'), '[]');
    replaceFile(join(dir, 'a.json'), '[]');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});

describe('exportTargetProblem', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-target-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a new path and a regular file', () => {
    const existing = join(dir, 'a.json');
    writeFileSync(existing, '[]');
    expect(exportTargetProblem(join(dir, 'new.csv'))).toBeUndefined();
    expect(exportTargetProblem(existing)).toBeUndefined();
  });

  it('refuses a path with a parent segment', () => {
    expect(exportTargetProblem(`${dir}/../escape.json`)).toBeDefined();
    expect(exportTargetProblem(`${dir}/x/../y.json`)).toBeDefined();
  });

  it('refuses a symbolic link at the target', () => {
    const target = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(target, '[]');
    symlinkSync(target, link);
    expect(exportTargetProblem(link)).toBeDefined();
  });
});
