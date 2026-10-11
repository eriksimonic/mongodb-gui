import { describe, expect, it } from 'vitest';
import {
  BATCH_PREVIEW_CHARS,
  ROOT_KEY_LIMIT,
  TRUNCATED_KEY,
  containsTruncatedMarker,
  docBudget,
  isUnkeptPreview,
  nestedMarker,
  previewDocument,
  previewInfo,
  withPreviewInfo,
} from './preview';

type Tree = Record<string, unknown>;

const OID = { $oid: '507f1f77bcf86cd799439011' };
const SLACK = 64 * 1024;

function doubles(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({ $numberDouble: `${i}.5` }));
}

function keyed(count: number, value: (i: number) => unknown): Tree {
  const out: Tree = {};
  for (let i = 0; i < count; i += 1) {
    out[`k${i}`] = value(i);
  }
  return out;
}

function deep(depth: number): unknown {
  let value: unknown = { leaf: 'x'.repeat(100) };
  for (let i = 0; i < depth; i += 1) {
    value = { child: value, pad: 'y'.repeat(40) };
  }
  return value;
}

const FIXTURES: Record<string, () => Tree> = {
  'array of 200k doubles': () => ({ _id: OID, values: doubles(200_000), tail: 'end' }),
  'object of 5000 keys with 1 KB strings': () => ({
    _id: OID,
    map: keyed(5000, () => 'v'.repeat(1024)),
  }),
  'a 5 MB string': () => ({ _id: OID, text: 'a'.repeat(5 * 1024 * 1024), tail: 1 }),
  'deep nest of depth 20': () => ({ _id: OID, tree: deep(20) }),
  wrappers: () => ({
    _id: OID,
    at: { $date: { $numberLong: '1700000000000' } },
    big: { $numberLong: '9007199254740993' },
    blob: { $binary: { base64: 'QUJD'.repeat(3000), subType: '00' } },
    more: doubles(5000),
  }),
  'a huge _id string': () => ({ _id: 'i'.repeat(100_000), a: 1 }),
  'a root with 3000 keys': () => keyed(3000, (i) => i),
};

function fixture(name: string): Tree {
  const make = FIXTURES[name];
  if (make === undefined) {
    throw new Error(`no fixture ${name}`);
  }
  return make();
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function size(value: unknown): number {
  return JSON.stringify(value).length;
}

describe('previewDocument size', () => {
  for (const [name, make] of Object.entries(FIXTURES)) {
    for (const budget of [16_384, 1024]) {
      it(`bounds ${name} at budget ${String(budget)}`, () => {
        const { value, cut } = previewDocument(make(), budget);
        expect(size(value)).toBeLessThanOrEqual(2 * budget + SLACK);
        expect(cut).toBe(true);
      });
    }
  }
});

describe('previewDocument content', () => {
  it('reports no cut for a small document and returns it equal', () => {
    const doc = { _id: OID, name: 'a', n: { $numberInt: '3' }, list: [1, 2, 3], sub: { a: 1 } };
    const { value, cut } = previewDocument(doc, 16_384);
    expect(cut).toBe(false);
    expect(value).toEqual(doc);
  });

  it('keeps a small _id verbatim and marks a huge one', () => {
    expect(previewDocument(fixture('array of 200k doubles'), 1024).value['_id']).toEqual(OID);
    const marked = previewDocument(fixture('a huge _id string'), 16_384).value['_id'];
    expect(nestedMarker(marked)).toMatchObject({ t: 'string', n: 100_000 });
  });

  it('keeps every root key up to the limit and sets cut beyond it', () => {
    const { value, cut } = previewDocument(fixture('a root with 3000 keys'), 100_000);
    expect(Object.keys(value)).toHaveLength(ROOT_KEY_LIMIT);
    expect(Object.keys(value)[0]).toBe('k0');
    expect(cut).toBe(true);
    const few = previewDocument(
      keyed(ROOT_KEY_LIMIT, () => 1),
      100_000,
    );
    expect(few.cut).toBe(false);
  });

  it('keeps the root keys whose values are cut and leaves out exact ones past the budget', () => {
    const tree = {
      _id: OID,
      a: 'x'.repeat(5000),
      b: doubles(10_000),
      c: keyed(500, () => 'z'.repeat(100)),
      d: 7,
    };
    const { value } = previewDocument(tree, 1024);
    // c is cut to a marker, so its key stays. d is an exact scalar with no room left.
    expect(Object.keys(value)).toEqual(['_id', 'a', 'b', 'c']);
    expect(value['d']).toBeUndefined();
  });

  it('leaves wrappers intact', () => {
    const { value } = previewDocument(fixture('wrappers'), 1024);
    expect(value['_id']).toEqual(OID);
    expect(value['at']).toEqual({ $date: { $numberLong: '1700000000000' } });
    expect(value['big']).toEqual({ $numberLong: '9007199254740993' });
  });

  it('replaces a large binary by a marker with the decoded length', () => {
    const { value } = previewDocument(fixture('wrappers'), 16_384);
    expect(nestedMarker(value['blob'])).toEqual({ t: 'binary', n: 9000 });
    const base64 = `${'A'.repeat(1998)}==`;
    const padded = { _id: 1, b: { $binary: { base64, subType: '00' } } };
    expect(nestedMarker(previewDocument(padded, 16_384).value['b'])).toEqual({
      t: 'binary',
      n: Buffer.from(base64, 'base64').length,
    });
  });

  it('keeps a document of root scalars and wrappers to the budget', () => {
    const wide = keyed(400, (i) => (i % 2 === 0 ? i : { $numberLong: `${i}0000000000` }));
    const doc = { _id: OID, ...wide };
    const { value, cut } = previewDocument(doc, 4_000);
    expect(cut).toBe(true);
    expect(value['_id']).toEqual(OID);
    expect(Object.keys(value).length).toBeLessThan(400);
    expect(JSON.stringify(value).length).toBeLessThan(4_000 + SLACK / 8);
    // What is kept is exact, and the leading keys are the ones kept.
    expect(value['k0']).toBe(0);
    expect(value['k1']).toEqual({ $numberLong: '10000000000' });
    expect(previewDocument(doc, 40_000).cut).toBe(false);
  });

  it('keeps a late _id when the budget is already spent', () => {
    const { value } = previewDocument({ ...keyed(400, () => 1), _id: 5 }, 1_024);
    expect(value['_id']).toBe(5);
  });

  it('cuts a wrapper that is large without being a binary or a string', () => {
    const regex = { $regularExpression: { pattern: 'a'.repeat(1_000_000), options: 'i' } };
    const { value, cut } = previewDocument(
      { _id: 1, re: regex, small: { $oid: OID.$oid } },
      16_384,
    );
    expect(cut).toBe(true);
    expect(nestedMarker(value['re'])).toEqual({ t: 'object', n: 1 });
    expect(JSON.stringify(value).length).toBeLessThan(1024);
    expect(value['small']).toEqual({ $oid: OID.$oid });
    const little = { $regularExpression: { pattern: '^a', options: 'i' } };
    expect(previewDocument({ _id: 1, re: little }, 16_384).value['re']).toEqual(little);
  });

  it('records the true length and a prefix head for a cut string', () => {
    const text = 'abcdefghij'.repeat(500_000);
    const { value } = previewDocument({ _id: 1, text }, 16_384);
    const found = nestedMarker(value['text']);
    expect(found?.t).toBe('string');
    expect(found?.n).toBe(text.length);
    expect(typeof found?.head).toBe('string');
    expect(text.startsWith(found?.head as string)).toBe(true);
  });

  it('records the true length and a prefix head for a cut array', () => {
    const items = doubles(200_000);
    const { value } = previewDocument({ _id: 1, values: items }, 16_384);
    const found = nestedMarker(value['values']);
    expect(found?.t).toBe('array');
    expect(found?.n).toBe(200_000);
    const head = found?.head as unknown[];
    expect(head.length).toBeGreaterThan(0);
    expect(head).toEqual(items.slice(0, head.length));
  });

  it('records the true key count and a prefix head for a cut object', () => {
    const map = keyed(5000, () => 'v'.repeat(1024));
    const { value } = previewDocument({ _id: 1, map }, 16_384);
    const found = nestedMarker(value['map']);
    expect(found?.t).toBe('object');
    expect(found?.n).toBe(5000);
    const head = found?.head as Tree;
    const keys = Object.keys(head);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toEqual(Object.keys(map).slice(0, keys.length));
  });

  it('turns a nest deeper than the limit into a marker', () => {
    const { value } = previewDocument({ _id: 1, tree: deep(20) }, 16_384);
    expect(JSON.stringify(value)).toContain(TRUNCATED_KEY);
  });

  it('does not mutate the input and is deterministic', () => {
    const tree = fixture('object of 5000 keys with 1 KB strings');
    const before = JSON.stringify(tree);
    const first = previewDocument(tree, 4096);
    const second = previewDocument(tree, 4096);
    expect(JSON.stringify(tree)).toBe(before);
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });

  it('never splits a surrogate pair', () => {
    const text = '\u{1F600}'.repeat(10_000);
    for (const budget of [1024, 16_384]) {
      const { value } = previewDocument({ _id: 1, text }, budget);
      const head = nestedMarker(value['text'])?.head as string;
      expect(head.length).toBeGreaterThan(0);
      expect(LONE_SURROGATE.test(head)).toBe(false);
    }
    // An odd cap lands between the two halves of a pair.
    const odd = `a${'\u{1F600}'.repeat(400)}`;
    const head = nestedMarker(previewDocument({ _id: 1, odd }, 1024).value['odd'])?.head as string;
    expect(LONE_SURROGATE.test(head)).toBe(false);
  });

  it('leaves budget for the siblings after a huge array', () => {
    const tree = { _id: 1, first: doubles(200_000), second: 'later', third: { a: 1 } };
    const { value } = previewDocument(tree, 16_384);
    expect(value['second']).toBe('later');
    expect(value['third']).toEqual({ a: 1 });
    expect(size(value['first'])).toBeLessThan(16_384);
  });

  it('keeps a key named __proto__ as an own key', () => {
    const tree = JSON.parse('{"_id":1,"__proto__":{"a":"' + 'x'.repeat(40_000) + '"}}') as Tree;
    const { value } = previewDocument(tree, 1024);
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe('docBudget', () => {
  it('gives a lone document the full share', () => {
    expect(docBudget(0, 1)).toBe(16_384);
  });

  it('shrinks the share over a large batch', () => {
    expect(docBudget(0, 1000)).toBe(2097);
  });

  it('never goes below the minimum', () => {
    expect(docBudget(BATCH_PREVIEW_CHARS, 10)).toBe(1024);
    expect(docBudget(BATCH_PREVIEW_CHARS * 2, 10)).toBe(1024);
  });

  it('treats zero documents left as one', () => {
    expect(docBudget(0, 0)).toBe(16_384);
  });
});

describe('markers', () => {
  it('reads and writes the root marker', () => {
    const doc = withPreviewInfo({ _id: 1, a: 2 }, { ref: 'r', chars: 99 });
    expect(Object.keys(doc).at(-1)).toBe(TRUNCATED_KEY);
    expect(previewInfo(doc)).toEqual({ ref: 'r', chars: 99 });
    expect(previewInfo(withPreviewInfo({}, { ref: undefined, chars: 5 }))).toEqual({
      ref: undefined,
      chars: 5,
    });
    expect(withPreviewInfo({}, { ref: undefined, chars: 5 })[TRUNCATED_KEY]).toEqual({ chars: 5 });
  });

  it('carries the saved edits of a previewed document', () => {
    const edits = [
      { path: 'a.b', value: 3 },
      { path: 'c', unset: true as const },
    ];
    const doc = withPreviewInfo({ _id: 1 }, { ref: 'r', chars: 9, edits });
    expect(previewInfo(doc)).toEqual({ ref: 'r', chars: 9, edits });
    // Entries without a path are ignored.
    expect(previewInfo({ [TRUNCATED_KEY]: { chars: 1, edits: [{ x: 1 }, 'y'] } })).toEqual({
      ref: undefined,
      chars: 1,
    });
  });

  it('tells a preview without a stored copy from one with it and from a whole document', () => {
    expect(isUnkeptPreview(withPreviewInfo({}, { ref: undefined, chars: 5 }))).toBe(true);
    expect(isUnkeptPreview(withPreviewInfo({}, { ref: 'r', chars: 5 }))).toBe(false);
    expect(isUnkeptPreview({ _id: 1 })).toBe(false);
  });

  it('does not read a root marker from other values', () => {
    expect(previewInfo({ _id: 1 })).toBeUndefined();
    expect(previewInfo({ [TRUNCATED_KEY]: 'x' })).toBeUndefined();
    expect(previewInfo({ [TRUNCATED_KEY]: { ref: 'r' } })).toBeUndefined();
    expect(previewInfo(null)).toBeUndefined();
    expect(previewInfo([1])).toBeUndefined();
    expect(previewInfo('text')).toBeUndefined();
  });

  it('reads a nested marker', () => {
    expect(nestedMarker({ [TRUNCATED_KEY]: { t: 'array', n: 3 } })).toEqual({ t: 'array', n: 3 });
    expect(nestedMarker({ [TRUNCATED_KEY]: { t: 'string', n: 9, head: 'ab' } })).toEqual({
      t: 'string',
      n: 9,
      head: 'ab',
    });
  });

  it('rejects look-alikes of a nested marker', () => {
    expect(nestedMarker({ [TRUNCATED_KEY]: { t: 'array', n: 3 }, other: 1 })).toBeUndefined();
    expect(nestedMarker({ [TRUNCATED_KEY]: { t: 'number', n: 3 } })).toBeUndefined();
    expect(nestedMarker({ [TRUNCATED_KEY]: { t: 'array', n: '3' } })).toBeUndefined();
    expect(nestedMarker({ [TRUNCATED_KEY]: { chars: 3 } })).toBeUndefined();
    expect(nestedMarker({ [TRUNCATED_KEY]: 1 })).toBeUndefined();
    expect(nestedMarker({ a: 1 })).toBeUndefined();
    expect(nestedMarker([{ t: 'array', n: 3 }])).toBeUndefined();
    expect(nestedMarker(null)).toBeUndefined();
  });

  it('finds the marker text', () => {
    expect(containsTruncatedMarker('{"a":{"$mgTruncated":{}}}')).toBe(true);
    expect(containsTruncatedMarker('{"a":{"$oid":"1"}}')).toBe(false);
  });
});
