import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeNewFile } from './export-file';

describe('writeNewFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the content to a file that does not exist', () => {
    const path = join(dir, 'results.json');
    expect(writeNewFile(path, '[1,2]\n')).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('[1,2]\n');
  });

  it('leaves an existing file alone and reports that it was not written', () => {
    const path = join(dir, 'results.csv');
    writeFileSync(path, 'old');
    expect(writeNewFile(path, 'new')).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('old');
  });

  it('leaves no temporary file behind', () => {
    writeNewFile(join(dir, 'a.json'), '[]');
    writeNewFile(join(dir, 'a.json'), '[]');
    expect(readdirSync(dir)).toEqual(['a.json']);
  });
});
