import { describe, expect, it } from 'vitest';
import { Binary, Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import { AppErrorException } from '@mongo-gui/core';
import { discoverColumns, renderCell, renderScalar } from './export';
import { splitJsonArray, splitLines } from './source';

async function* chunksOf(text: string, size: number): AsyncGenerator<string> {
  for (let index = 0; index < text.length; index += size) {
    yield text.slice(index, index + size);
  }
}

async function elements(
  text: string,
  size = text.length || 1,
  truncated = false,
): Promise<string[]> {
  const out: string[] = [];
  for await (const element of splitJsonArray(chunksOf(text, size), truncated)) {
    out.push(element);
  }
  return out;
}

async function rejection(promise: Promise<unknown>): Promise<AppErrorException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('splitJsonArray', () => {
  it('yields the source text of each element', async () => {
    expect(await elements('[{"a":1}, {"b":[1,2]} ,3,"x"]')).toEqual([
      '{"a":1}',
      '{"b":[1,2]}',
      '3',
      '"x"',
    ]);
  });

  it('gives an empty result for an empty array', async () => {
    expect(await elements('[ ]\n')).toEqual([]);
  });

  it('does not split on brackets, commas or quotes inside strings', async () => {
    const text = '[{"s":"a,b]}\\"c[","t":"\\\\"},{"u":1}]';
    expect(await elements(text)).toEqual(['{"s":"a,b]}\\"c[","t":"\\\\"}', '{"u":1}']);
  });

  it.each([1, 2, 3, 7, 16])(
    'gives the same elements when split into %i-character chunks',
    async (size) => {
      const text = '[\n  {"a": "x,]}", "n": [1, {"deep": "[\\"q\\"]"}]},\n  {"a": "y"}\n]\n';
      expect(await elements(text, size)).toEqual([
        '{"a": "x,]}", "n": [1, {"deep": "[\\"q\\"]"}]}',
        '{"a": "y"}',
      ]);
    },
  );

  it('refuses input that does not start with an array', async () => {
    const error = await rejection(elements('{"a":1}'));
    expect(error.error.code).toBe('VALIDATION');
  });

  it('refuses a trailing comma and a missing comma', async () => {
    expect((await rejection(elements('[1,]'))).error.message).toMatch(/trailing comma/);
    expect((await rejection(elements('[1 2]'))).error.message).toMatch(/missing comma/);
    expect((await rejection(elements('[,1]'))).error.message).toMatch(/missing before a comma/);
  });

  it('refuses a file that ends before the array closes', async () => {
    expect((await rejection(elements('[{"a":1},{"b":2}'))).error.message).toMatch(
      /before the JSON array is closed/,
    );
    expect((await rejection(elements('[{"a":'))).error.message).toMatch(/middle of a JSON element/);
  });

  it('refuses content after the closing bracket', async () => {
    expect((await rejection(elements('[1] [2]'))).error.message).toMatch(/after the end/);
  });

  it('drops an unfinished element when the input is a truncated head', async () => {
    expect(await elements('[{"a":1},{"b":', 4, true)).toEqual(['{"a":1}']);
    expect(await elements('[{"a":1},{"b":2}', 4, true)).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('splitLines', () => {
  it('splits on LF and removes a CR before it, across chunk boundaries', async () => {
    const lines: string[] = [];
    for await (const line of splitLines(chunksOf('{"a":1}\r\n{"b":2}\n\n{"c":3}', 3))) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '', '{"c":3}']);
  });
});

describe('renderScalar and renderCell', () => {
  it('keeps the BSON type visible in the text', () => {
    expect(renderScalar(new Int32(7))).toBe('7');
    expect(renderScalar(new Double(2))).toBe('2.0');
    expect(renderScalar(new Double(2.5))).toBe('2.5');
    expect(renderScalar(new Double(Number.POSITIVE_INFINITY))).toBe('Infinity');
    expect(renderScalar(Long.fromString('9007199254740993'))).toBe('9007199254740993');
    expect(renderScalar(Decimal128.fromString('1.50'))).toBe('1.50');
  });

  it('renders ObjectId as hex, dates as ISO text, and binary as base64', () => {
    expect(renderScalar(new ObjectId('64b000000000000000000001'))).toBe('64b000000000000000000001');
    expect(renderScalar(new Date(Date.UTC(2026, 0, 2)))).toBe('2026-01-02T00:00:00.000Z');
    expect(renderScalar(new Date(Number.NaN))).toBe('');
    expect(renderScalar(new Binary(Buffer.from('hi')))).toBe(Buffer.from('hi').toString('base64'));
  });

  it('renders null and undefined as empty text', () => {
    expect(renderScalar(null)).toBe('');
    expect(renderScalar(undefined)).toBe('');
  });

  it('renders arrays as EJSON text in json mode and joins them in join mode', () => {
    const values = [new Int32(1), 'b'];
    expect(renderCell(values, 'json')).toBe('[{"$numberInt":"1"},"b"]');
    expect(renderCell([new Int32(1), 'b'], 'join')).toBe('1;b');
    expect(renderCell([], 'join')).toBe('');
  });
});

describe('discoverColumns', () => {
  it('lists dotted leaf paths in first-seen order', () => {
    const columns = discoverColumns([
      { _id: 1, address: { city: 'Ljubljana', geo: { lat: 1 } } },
      { _id: 2, tags: ['a'], address: { zip: '1000' } },
      { _id: 3, empty: {} },
    ]);
    expect(columns).toEqual([
      '_id',
      'address.city',
      'address.geo.lat',
      'tags',
      'address.zip',
      'empty',
    ]);
  });
});
