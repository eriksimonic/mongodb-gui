import {
  mkdirSync,
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
import { ExportWriter, exportTargetProblem, replaceFile } from './export-file';

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

describe('ExportWriter', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-writer-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the parts in order and leaves only the target', () => {
    const path = join(dir, 'out.json');
    const writer = new ExportWriter(path);
    writer.append('[\n');
    writer.append('{"a":"\u00e9\ud83d\ude00"}');
    writer.append('\n]');
    writer.commit();
    expect(readFileSync(path, 'utf8')).toBe('[\n{"a":"\u00e9\ud83d\ude00"}\n]');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('keeps the old file readable until commit', () => {
    const path = join(dir, 'out.csv');
    writeFileSync(path, 'old');
    const writer = new ExportWriter(path);
    writer.append('new');
    expect(readFileSync(path, 'utf8')).toBe('old');
    writer.commit();
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['out.csv']);
  });

  it('leaves no temporary file and no target after abort', () => {
    const path = join(dir, 'out.json');
    const writer = new ExportWriter(path);
    writer.append('partial');
    writer.abort();
    writer.abort();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps the old file after abort', () => {
    const path = join(dir, 'out.json');
    writeFileSync(path, 'old');
    const writer = new ExportWriter(path);
    writer.append('partial');
    writer.abort();
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['out.json']);
  });

  it('removes the temporary file when the rename fails', () => {
    // The target is a non-empty folder, so the rename cannot replace it.
    const path = join(dir, 'taken');
    mkdirSync(path);
    writeFileSync(join(path, 'inner'), 'x');
    const writer = new ExportWriter(path);
    writer.append('text');
    expect(() => {
      writer.commit();
    }).toThrow();
    expect(readdirSync(dir)).toEqual(['taken']);
  });
});
