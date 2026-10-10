import { BSON } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { readArchivePrelude } from './prelude';

const MAGIC = Uint8Array.from([0x6d, 0xe2, 0x99, 0x81]);
const TERMINATOR = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

function archive(documents: BSON.Document[], terminated = true): Uint8Array {
  const parts = [MAGIC, ...documents.map((doc) => BSON.serialize(doc))];
  if (terminated) {
    parts.push(TERMINATOR);
  }
  return Buffer.concat(parts);
}

const HEADER = {
  concurrent_collections: 4,
  version: '0.1',
  server_version: '8.0.17',
  tool_version: '100.10.0',
};

describe('readArchivePrelude', () => {
  it('reads the versions and the namespaces', () => {
    const bytes = archive([
      HEADER,
      { db: 'shop', collection: 'orders', metadata: '{}', size: 0, type: 'collection' },
      { db: 'shop', collection: 'recent', metadata: '{}', size: 0, type: 'view' },
      { db: 'metrics', collection: 'cpu', metadata: '{}', size: 0, type: 'timeseries' },
    ]);
    expect(readArchivePrelude(bytes)).toEqual({
      serverVersion: '8.0.17',
      toolsVersion: '100.10.0',
      oplog: false,
      truncated: false,
      namespaces: [
        { database: 'shop', collection: 'orders', type: 'collection' },
        { database: 'shop', collection: 'recent', type: 'view' },
        { database: 'metrics', collection: 'cpu', type: 'timeseries' },
      ],
    });
  });

  it('treats a missing type as a collection', () => {
    const bytes = archive([HEADER, { db: 'shop', collection: 'orders' }]);
    expect(readArchivePrelude(bytes).namespaces).toEqual([
      { database: 'shop', collection: 'orders', type: 'collection' },
    ]);
  });

  it('reads a header without versions', () => {
    const prelude = readArchivePrelude(archive([{ version: '0.1' }]));
    expect(prelude).toEqual({ namespaces: [], oplog: false, truncated: false });
  });

  it('reports the oplog entry of mongodump --oplog instead of listing it', () => {
    const bytes = archive([
      HEADER,
      { db: 'shop', collection: 'orders', metadata: '{}', size: 0, type: 'collection' },
      { db: '', collection: 'oplog', metadata: '', size: 0 },
    ]);
    const prelude = readArchivePrelude(bytes);
    expect(prelude.oplog).toBe(true);
    expect(prelude.namespaces).toEqual([
      { database: 'shop', collection: 'orders', type: 'collection' },
    ]);
  });

  it('skips any other entry without a database', () => {
    const prelude = readArchivePrelude(archive([HEADER, { db: '', collection: 'other' }]));
    expect(prelude).toMatchObject({ oplog: false, namespaces: [] });
  });

  it('rejects bad magic', () => {
    expect(() => readArchivePrelude(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/magic/);
    expect(() => readArchivePrelude(new Uint8Array())).toThrow(/magic/);
  });

  it('flags a prefix that ends before the terminator', () => {
    const full = archive([HEADER, { db: 'shop', collection: 'orders', type: 'collection' }], false);
    const cut = full.subarray(0, full.byteLength - 3);
    const prelude = readArchivePrelude(cut);
    expect(prelude.truncated).toBe(true);
    expect(prelude.namespaces).toEqual([]);
    expect(prelude.serverVersion).toBe('8.0.17');
  });

  it('flags a missing terminator after complete namespaces', () => {
    const bytes = archive([HEADER, { db: 'shop', collection: 'orders' }], false);
    const prelude = readArchivePrelude(bytes);
    expect(prelude.truncated).toBe(true);
    expect(prelude.namespaces).toHaveLength(1);
  });

  it('throws when the header is cut off', () => {
    const bytes = archive([HEADER]).subarray(0, 10);
    expect(() => readArchivePrelude(bytes)).toThrow(/header/);
  });
});
