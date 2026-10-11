import { runInNewContext } from 'node:vm';
import { EJSON, ObjectId } from 'bson';
import { describe, expect, it } from 'vitest';
import { BATCH_PREVIEW_CHARS, previewInfo, TRUNCATED_KEY } from '@mongo-gui/core';
import {
  formatPrintText,
  hasMoreResults,
  serializeCursorBatch,
  serializeResult,
  serializePrintable,
  type SpillSink,
} from './results';

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

function recordingSink(ref: string | undefined): SpillSink & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    write: (text) => {
      texts.push(text);
      return ref;
    },
  };
}

function parsed(text: string): { documents: Record<string, unknown>[]; cursorHasMore: boolean } {
  return JSON.parse(text) as { documents: Record<string, unknown>[]; cursorHasMore: boolean };
}

describe('serializeCursorBatch', () => {
  it('writes small documents as plain canonical EJSON and never calls the sink', () => {
    const documents = [{ _id: new ObjectId('64b7f0c2a1b2c3d4e5f60718'), n: 1 }, { n: 2 }];
    const sink = recordingSink('a/b');
    const text = serializeCursorBatch({ documents, cursorHasMore: true }, sink);
    expect(text).toBe(
      `{"documents":[${documents.map((doc) => EJSON.stringify(doc, { relaxed: false })).join(',')}],"cursorHasMore":true}`,
    );
    expect(sink.texts).toHaveLength(0);
  });

  it('previews oversized documents, spills their full text and keeps order and cursorHasMore', () => {
    const documents = [
      { _id: 1, name: 'small' },
      { _id: 2, text: 'x'.repeat(1_000_000) },
      { _id: 3, values: Array.from({ length: 200_000 }, (_, i) => i + 0.5) },
      { _id: 4, name: 'last' },
    ];
    const sink = recordingSink('run/file');
    const text = serializeCursorBatch({ documents, cursorHasMore: false }, sink);
    const page = parsed(text);
    expect(page.cursorHasMore).toBe(false);
    expect(page.documents.map((doc) => (doc['_id'] as { $numberInt: string }).$numberInt)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(previewInfo(page.documents[0])).toBeUndefined();
    expect(previewInfo(page.documents[3])).toBeUndefined();
    expect(previewInfo(page.documents[1])).toMatchObject({ ref: 'run/file' });
    expect(previewInfo(page.documents[2])).toMatchObject({ ref: 'run/file' });
    expect(sink.texts).toEqual(
      [documents[1], documents[2]].map((doc) => EJSON.stringify(doc, { relaxed: false })),
    );
    expect(previewInfo(page.documents[1])?.chars).toBe(sink.texts[0]?.length);
    expect(text.length).toBeLessThan(BATCH_PREVIEW_CHARS + 100_000);
  });

  it('keeps 1000 documents of 100 KB under the batch preview budget', () => {
    const body = 'y'.repeat(100_000);
    const documents = Array.from({ length: 1000 }, (_, i) => ({ _id: i, body }));
    let writes = 0;
    const text = serializeCursorBatch(
      { documents, cursorHasMore: true },
      {
        write: () => {
          writes += 1;
          return 'a/b';
        },
      },
    );
    expect(writes).toBe(1000);
    expect(text.length).toBeLessThan(2.5 * 1024 * 1024);
    expect(parsed(text).documents).toHaveLength(1000);
  });

  it('keeps 500 wide documents of root scalars under the batch preview budget', () => {
    const fields = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field_${i}`, i]));
    const documents = Array.from({ length: 500 }, (_, i) => ({ _id: i, ...fields }));
    const sink = recordingSink('a/b');
    const text = serializeCursorBatch({ documents, cursorHasMore: true }, sink);
    // Each document is about 14 KB, so the whole batch would be 7 MB without a cut.
    expect(sink.texts[0]?.length).toBeGreaterThan(10_000);
    expect(text.length).toBeLessThan(2.5 * 1024 * 1024);
    const page = parsed(text);
    expect(page.documents).toHaveLength(500);
    expect(previewInfo(page.documents[499])).toMatchObject({ ref: 'a/b' });
  });

  it('marks a preview without a reference when the sink refuses the text', () => {
    const documents = [{ _id: 1, text: 'x'.repeat(100_000) }];
    const text = serializeCursorBatch(
      { documents, cursorHasMore: false },
      recordingSink(undefined),
    );
    const marker = parsed(text).documents[0]?.[TRUNCATED_KEY] as Record<string, unknown>;
    expect(marker['chars']).toBeGreaterThan(100_000);
    expect(Object.hasOwn(marker, 'ref')).toBe(false);
  });

  it('does not change the documents of the printable', () => {
    const documents = [{ _id: 1, text: 'x'.repeat(100_000) }];
    serializeCursorBatch({ documents, cursorHasMore: false }, recordingSink('a/b'));
    expect(documents[0]?.text).toHaveLength(100_000);
    expect(Object.keys(documents[0] ?? {})).toEqual(['_id', 'text']);
  });

  it('falls back to inspect for a document EJSON cannot encode', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const sink = recordingSink('a/b');
    const page = parsed(
      serializeCursorBatch(
        { documents: [cyclic, new Map([['a', 1]])], cursorHasMore: false },
        sink,
      ),
    );
    expect(page.documents[0]).toContain('<ref *1>');
    expect(String(page.documents[1])).toContain('Map');
    expect(sink.texts).toHaveLength(0);
  });
});

describe('serializeResult', () => {
  it('previews a list of documents the way a cursor batch is, whatever its length', () => {
    const body = 'y'.repeat(100_000);
    const documents = Array.from({ length: 500 }, (_, i) => ({ _id: i, body }));
    const sink = recordingSink('a/b');
    const text = serializeResult(documents, sink);
    expect(sink.texts).toHaveLength(500);
    expect(text.length).toBeLessThan(2.5 * 1024 * 1024);
    const list = JSON.parse(text) as Record<string, unknown>[];
    expect(list).toHaveLength(500);
    expect(previewInfo(list[499])).toMatchObject({ ref: 'a/b' });
  });

  it('previews one large document and keeps a small one whole', () => {
    const sink = recordingSink('a/b');
    const small = { _id: 1, n: 2 };
    expect(serializeResult(small, sink)).toBe(EJSON.stringify(small, { relaxed: false }));
    expect(sink.texts).toHaveLength(0);
    const text = serializeResult({ _id: 2, text: 'x'.repeat(1_000_000) }, sink);
    expect(text.length).toBeLessThan(20_000);
    expect(previewInfo(JSON.parse(text))).toMatchObject({ ref: 'a/b' });
    expect(sink.texts).toHaveLength(1);
  });

  it('sends values that are not documents the way serializePrintable does', () => {
    const sink = recordingSink('a/b');
    for (const value of [undefined, 'text', 5, [1, 2, 3], [], [{ a: 1 }, 'x'], new Map([[1, 2]])]) {
      expect(serializeResult(value, sink)).toBe(serializePrintable(value));
    }
    expect(sink.texts).toHaveLength(0);
  });
});
