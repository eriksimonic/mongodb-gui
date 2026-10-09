import { describe, expect, it } from 'vitest';
import { formatMongoshSyntax, formatRelaxedJson } from './format';
import { toCanonicalValue } from './canonical';

const ONE_LINE = { indent: 0 };
const TWO = { indent: 2 };

function shell(value: unknown, options = ONE_LINE): string {
  return formatMongoshSyntax(JSON.stringify(value), options);
}

describe('formatMongoshSyntax, scalar wrappers', () => {
  it('writes an ObjectId', () => {
    expect(shell({ $oid: '64b7f0c2a1b2c3d4e5f60718' })).toBe(
      'ObjectId("64b7f0c2a1b2c3d4e5f60718")',
    );
  });

  it('writes a date from canonical milliseconds as ISODate', () => {
    expect(shell({ $date: { $numberLong: '0' } })).toBe('ISODate("1970-01-01T00:00:00.000Z")');
  });

  it('writes a date from a relaxed ISO string as ISODate', () => {
    expect(shell({ $date: '2026-10-09T10:00:00.000Z' })).toBe(
      'ISODate("2026-10-09T10:00:00.000Z")',
    );
  });

  it('writes a 32-bit int as a plain number', () => {
    expect(shell({ $numberInt: '20' })).toBe('20');
    expect(shell({ $numberInt: '-7' })).toBe('-7');
  });

  it('writes a 64-bit int as NumberLong', () => {
    expect(shell({ $numberLong: '4821930112' })).toBe('NumberLong("4821930112")');
  });

  it('writes a double as a plain number', () => {
    expect(shell({ $numberDouble: '1.5' })).toBe('1.5');
    expect(shell({ $numberDouble: 'NaN' })).toBe('NaN');
    expect(shell({ $numberDouble: 'Infinity' })).toBe('Infinity');
    expect(shell({ $numberDouble: '-Infinity' })).toBe('-Infinity');
  });

  it('writes a decimal as NumberDecimal', () => {
    expect(shell({ $numberDecimal: '19.99' })).toBe('NumberDecimal("19.99")');
  });

  it('writes a timestamp as Timestamp(t, i)', () => {
    expect(shell({ $timestamp: { t: 1791575698, i: 2 } })).toBe('Timestamp(1791575698, 2)');
  });

  it('writes a binary with its subtype and base64 text', () => {
    expect(shell({ $binary: { base64: 'AQID', subType: '00' } })).toBe('BinData(0, "AQID")');
    expect(shell({ $binary: { base64: 'AQID', subType: '80' } })).toBe('BinData(128, "AQID")');
  });

  it('writes a subtype 04 binary of 16 bytes as a dashed UUID', () => {
    // 16 bytes 0x00 .. 0x0f in base64.
    const base64 = 'AAECAwQFBgcICQoLDA0ODw==';
    expect(shell({ $binary: { base64, subType: '04' } })).toBe(
      'UUID("00010203-0405-0607-0809-0a0b0c0d0e0f")',
    );
  });

  it('keeps a subtype 04 binary that is not 16 bytes as BinData', () => {
    expect(shell({ $binary: { base64: 'AQID', subType: '04' } })).toBe('BinData(4, "AQID")');
  });

  it('writes a regular expression as a literal and escapes slashes in the pattern', () => {
    expect(shell({ $regularExpression: { pattern: '^ab', options: 'i' } })).toBe('/^ab/i');
    expect(shell({ $regularExpression: { pattern: 'a/b', options: '' } })).toBe('/a\\/b/');
  });

  it('writes min and max keys', () => {
    expect(shell({ $minKey: 1 })).toBe('MinKey');
    expect(shell({ $maxKey: 1 })).toBe('MaxKey');
  });

  it('writes code and undefined', () => {
    expect(shell({ $code: 'return 1' })).toBe('Code("return 1")');
    expect(shell({ $undefined: true })).toBe('undefined');
  });
});

describe('formatMongoshSyntax, plain values', () => {
  it('writes strings with JSON escaping', () => {
    expect(shell('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
  });

  it('writes booleans and null', () => {
    expect(shell(true)).toBe('true');
    expect(shell(false)).toBe('false');
    expect(shell(null)).toBe('null');
  });

  it('writes empty objects and arrays compactly at any indent', () => {
    expect(shell({}, TWO)).toBe('{}');
    expect(shell([], TWO)).toBe('[]');
  });

  it('quotes keys that are not plain identifiers', () => {
    expect(shell({ $set: { a: 1 }, 'a.b': 2, plain_key: 3 })).toBe(
      '{$set: {a: 1}, "a.b": 2, plain_key: 3}',
    );
  });

  it('writes a document on one line with spaces when indent is zero', () => {
    expect(shell({ find: 'orders', filter: { status: 'paid' } })).toBe(
      '{find: "orders", filter: {status: "paid"}}',
    );
  });

  it('indents nested objects and arrays', () => {
    const value = {
      find: 'orders',
      filter: { status: { $in: ['paid', 'shipped'] } },
      limit: { $numberInt: '20' },
    };
    expect(formatMongoshSyntax(JSON.stringify(value), TWO)).toBe(
      [
        '{',
        '  find: "orders",',
        '  filter: {',
        '    status: {',
        '      $in: [',
        '        "paid",',
        '        "shipped"',
        '      ]',
        '    }',
        '  },',
        '  limit: 20',
        '}',
      ].join('\n'),
    );
  });

  it('formats a pipeline of wrapped values with the wrappers in place', () => {
    const value = {
      aggregate: 'orders',
      pipeline: [
        { $match: { createdAt: { $date: { $numberLong: '0' } } } },
        { $limit: { $numberInt: '5' } },
      ],
    };
    expect(shell(value)).toBe(
      '{aggregate: "orders", pipeline: [{$match: {createdAt: ISODate("1970-01-01T00:00:00.000Z")}}, {$limit: 5}]}',
    );
  });

  it('returns input that is not JSON unchanged', () => {
    expect(formatMongoshSyntax('not json {', TWO)).toBe('not json {');
    expect(formatRelaxedJson('not json {')).toBe('not json {');
  });

  it('does not treat a wrapper key next to other keys as a wrapper', () => {
    expect(shell({ $oid: '64b7', extra: 1 })).toBe('{$oid: "64b7", extra: 1}');
  });

  it('keeps a wrapper with a non-string payload as an ordinary document', () => {
    expect(shell({ $oid: 5 })).toBe('{$oid: 5}');
  });
});

describe('formatMongoshSyntax, round trip of plain values through toCanonicalValue', () => {
  it('writes the mongosh form of an ordinary command', () => {
    const command = { find: 'orders', filter: { status: 'paid' }, limit: 20 };
    expect(shell(toCanonicalValue(command))).toBe(
      '{find: "orders", filter: {status: "paid"}, limit: 20}',
    );
  });

  it('writes integers, longs, doubles and dates from plain JavaScript values', () => {
    const value = {
      small: 7,
      large: 5_000_000_000,
      ratio: 0.5,
      at: new Date(0),
    };
    expect(shell(toCanonicalValue(value))).toBe(
      '{small: 7, large: NumberLong("5000000000"), ratio: 0.5, at: ISODate("1970-01-01T00:00:00.000Z")}',
    );
  });
});

describe('formatRelaxedJson', () => {
  it('turns numbers into JSON numbers and dates into ISO strings', () => {
    const value = {
      limit: { $numberInt: '20' },
      big: { $numberLong: '4821930112' },
      ratio: { $numberDouble: '0.25' },
      at: { $date: { $numberLong: '0' } },
    };
    expect(JSON.parse(formatRelaxedJson(JSON.stringify(value)))).toEqual({
      limit: 20,
      big: 4821930112,
      ratio: 0.25,
      at: '1970-01-01T00:00:00.000Z',
    });
  });

  it('keeps ObjectId, binary and regex wrappers because JSON has no form for them', () => {
    const value = { _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' } };
    expect(JSON.parse(formatRelaxedJson(JSON.stringify(value)))).toEqual(value);
  });

  it('indents with two spaces', () => {
    expect(formatRelaxedJson('{"a":{"$numberInt":"1"}}')).toBe('{\n  "a": 1\n}');
  });
});
