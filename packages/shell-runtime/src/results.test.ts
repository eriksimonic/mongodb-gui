import { runInNewContext } from 'node:vm';
import { ObjectId } from 'bson';
import { describe, expect, it } from 'vitest';
import { formatPrintText, hasMoreResults, serializePrintable } from './results';

describe('serializePrintable', () => {
  it('encodes BSON values in canonical EJSON', () => {
    const id = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
    expect(serializePrintable({ _id: id })).toContain('{"$oid":"64b7f0c2a1b2c3d4e5f60718"}');
  });

  it('encodes undefined as null', () => {
    expect(serializePrintable(undefined)).toBe('null');
  });

  it('falls back to inspect for a cyclic object instead of failing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const text = JSON.parse(serializePrintable(cyclic)) as string;
    expect(text).toContain('loop');
    expect(text).toContain('<ref *1>');
  });

  it('renders a Map with its entries rather than as an empty object', () => {
    const text = JSON.parse(serializePrintable(new Map([['a', 1]]))) as string;
    expect(text).toContain("'a'");
    expect(text).toContain('Map');
  });

  it('renders an error from another realm with its message', () => {
    const foreign: unknown = runInNewContext('new Error("boom")');
    expect(JSON.parse(serializePrintable(foreign))).toContain('boom');
  });
});

describe('formatPrintText', () => {
  it('prints strings bare and other values as inspected text', () => {
    expect(formatPrintText(['hi', 2])).toBe('hi 2');
    expect(formatPrintText([{ a: 1 }])).toBe('{ a: 1 }');
  });
});

describe('hasMoreResults', () => {
  it('is true for an open cursor with documents in the batch', () => {
    expect(hasMoreResults({ cursorHasMore: true, documents: [{}] })).toBe(true);
  });

  it('is false for an open cursor whose batch is empty', () => {
    expect(hasMoreResults({ cursorHasMore: true, documents: [] })).toBe(false);
  });

  it('is false for values that are not cursor results', () => {
    expect(hasMoreResults(2)).toBe(false);
    expect(hasMoreResults(null)).toBe(false);
    expect(hasMoreResults({ documents: [{}] })).toBe(false);
  });
});
