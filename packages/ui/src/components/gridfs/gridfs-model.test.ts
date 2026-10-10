import type { GridFsFile } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  filenameProblem,
  formatBytes,
  downloadFileName,
  joinFolderPath,
  metadataFieldCount,
  parseMetadataDraft,
  selectedFiles,
  toggleSelected,
} from './gridfs-model';

function file(filename: string, metadataEjson?: string): GridFsFile {
  return {
    idEjson: `{"$oid":"${filename}"}`,
    filename,
    length: 10,
    chunkSize: 255 * 1024,
    uploadDate: '2026-09-01T09:00:00.000Z',
    ...(metadataEjson === undefined ? {} : { metadataEjson }),
  };
}

describe('formatBytes', () => {
  it('uses bytes below one KiB and binary prefixes above it', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(84_512)).toBe('82.5 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GiB');
  });
});

describe('parseMetadataDraft', () => {
  it('reads one JSON object and clears the metadata for an empty text', () => {
    expect(parseMetadataDraft('  ')).toEqual({ ok: true, metadataEjson: '{}' });
    expect(parseMetadataDraft('{ "customer": "Ana" }')).toEqual({
      ok: true,
      metadataEjson: '{"customer":"Ana"}',
    });
  });

  it('refuses text that is not one object', () => {
    expect(parseMetadataDraft('[1, 2]')).toMatchObject({ ok: false });
    expect(parseMetadataDraft('{ "a": ')).toMatchObject({ ok: false });
    expect(parseMetadataDraft('"text"')).toMatchObject({ ok: false });
  });
});

describe('metadataFieldCount', () => {
  it('counts the top-level fields, and none for a file without metadata', () => {
    expect(metadataFieldCount(file('a.pdf'))).toBe(0);
    expect(metadataFieldCount(file('a.pdf', '{"order":"ord-1","paid":true}'))).toBe(2);
  });
});

describe('filenameProblem', () => {
  it('uses the core schema to refuse empty names and null bytes', () => {
    expect(filenameProblem('')).toBeDefined();
    expect(filenameProblem('bad\u0000name')).toBeDefined();
    expect(filenameProblem('receipt-1001.pdf')).toBeUndefined();
  });
});

describe('joinFolderPath', () => {
  it('joins with the separator the folder uses', () => {
    expect(joinFolderPath('/mock/downloads', 'a.pdf')).toBe('/mock/downloads/a.pdf');
    expect(joinFolderPath('/mock/downloads/', 'a.pdf')).toBe('/mock/downloads/a.pdf');
    expect(joinFolderPath('C:\\files', 'a.pdf')).toBe('C:\\files\\a.pdf');
  });
});

describe('downloadFileName', () => {
  const ID = '{"$oid":"5f2c9a1e"}';

  it.each([
    ['../../x', 'x'],
    ['..\\x', 'x'],
    ['/etc/x', 'x'],
    ['a/b\\c.pdf', 'c.pdf'],
    ['receipt-1001.pdf', 'receipt-1001.pdf'],
  ])('reduces %j to its last segment: %s', (filename, expected) => {
    expect(downloadFileName(filename, ID)).toBe(expected);
  });

  it.each(['', '.', '..', '...', 'CON', 'con.txt', 'NUL', 'LPT1.log', 'COM9', 'a\u0000b.pdf'])(
    'falls back to the file id for %j',
    (filename) => {
      expect(downloadFileName(filename, ID)).toBe('5f2c9a1e');
    },
  );

  it('keeps a folder download inside the folder', () => {
    const name = downloadFileName('../../escape.txt', ID);
    expect(joinFolderPath('/mock/downloads', name)).toBe('/mock/downloads/escape.txt');
    expect(joinFolderPath('C:\\files', downloadFileName('..\\..\\escape.txt', ID))).toBe(
      'C:\\files\\escape.txt',
    );
  });

  it('replaces unsafe characters in a non-ObjectId id', () => {
    expect(downloadFileName('', '{"uuid":"a:b"}')).toBe('__uuid___a_b__');
  });
});

describe('selection', () => {
  it('toggles one id without touching the others', () => {
    const first = toggleSelected(new Set(), 'a');
    const second = toggleSelected(first, 'b');
    expect([...second].sort()).toEqual(['a', 'b']);
    expect([...toggleSelected(second, 'a')]).toEqual(['b']);
  });

  it('returns the selected files in list order', () => {
    const files = [file('a.pdf'), file('b.pdf'), file('c.pdf')];
    const chosen = selectedFiles(
      files,
      new Set([files[2]?.idEjson ?? '', files[0]?.idEjson ?? '']),
    );
    expect(chosen.map((item) => item.filename)).toEqual(['a.pdf', 'c.pdf']);
  });
});
