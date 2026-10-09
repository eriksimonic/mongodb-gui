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

  it('writes a date with no ISO form as new Date with plain milliseconds', () => {
    // Year 50000 is inside the Date range but past the ISO years, so it takes the number form.
    const year50000 = Date.UTC(50000, 0, 1);
    expect(shell({ $date: { $numberLong: String(year50000) } })).toBe(`new Date(${year50000})`);
    // Year -1 is also outside the ISO years.
    const yearMinus1 = Date.UTC(-1, 0, 1);
    expect(shell({ $date: { $numberLong: String(yearMinus1) } })).toBe(`new Date(${yearMinus1})`);
  });

  it('writes a null with a comment for a date beyond the Date range, never Invalid Date', () => {
    expect(shell({ $date: { $numberLong: '9007199254740993' } })).toBe(
      '/* date out of range: 9007199254740993 */ null',
    );
    expect(shell({ $date: { $numberLong: '-9000000000000000' } })).toBe(
      '/* date out of range: -9000000000000000 */ null',
    );
    expect(shell({ $date: { $numberLong: 'not a number' } })).toBe(
      '/* date out of range: not a number */ null',
    );
  });

  it('keeps the largest in-range date as a plain number', () => {
    expect(shell({ $date: { $numberLong: '8640000000000000' } })).toBe(
      'new Date(8640000000000000)',
    );
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

  it('writes min and max keys as constructor calls', () => {
    expect(shell({ $minKey: 1 })).toBe('MinKey()');
    expect(shell({ $maxKey: 1 })).toBe('MaxKey()');
  });

  it('writes whole doubles as Double so they stay doubles', () => {
    expect(shell({ $numberDouble: '1' })).toBe('Double(1)');
    expect(shell({ $numberDouble: '-0' })).toBe('Double(-0)');
    expect(shell({ $numberDouble: '0' })).toBe('Double(0)');
  });

  it('writes an exact literal regex for the flags a literal can carry', () => {
    expect(shell({ $regularExpression: { pattern: 'a.c', options: 'ims' } })).toBe('/a.c/ims');
    expect(shell({ $regularExpression: { pattern: 'x', options: 'u' } })).toBe('/x/u');
  });

  it('writes BSONRegExp when the flags are not literal flags', () => {
    expect(shell({ $regularExpression: { pattern: '^ab', options: 'x' } })).toBe(
      'BSONRegExp("^ab", "x")',
    );
    expect(shell({ $regularExpression: { pattern: 'a', options: 'g' } })).toBe(
      'BSONRegExp("a", "g")',
    );
  });

  it('writes BSONRegExp when the pattern has a line terminator', () => {
    expect(shell({ $regularExpression: { pattern: 'a\nb', options: '' } })).toBe(
      'BSONRegExp("a\\nb", "")',
    );
    expect(shell({ $regularExpression: { pattern: 'a b', options: 'i' } })).toBe(
      'BSONRegExp("a b", "i")',
    );
  });

  it('leaves an already escaped slash alone and escapes only the bare ones', () => {
    expect(shell({ $regularExpression: { pattern: 'a\\/b', options: '' } })).toBe('/a\\/b/');
    expect(shell({ $regularExpression: { pattern: 'a/b/c', options: '' } })).toBe('/a\\/b\\/c/');
    // Two backslashes are an escaped backslash, so the slash after them is bare.
    expect(shell({ $regularExpression: { pattern: 'a\\\\/b', options: '' } })).toBe('/a\\\\\\/b/');
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

  it('always quotes a __proto__ key, in mongosh and in the JSON view', () => {
    const value = JSON.parse('{"__proto__": {"$numberInt": "1"}, "a": 2}') as unknown;
    // A computed key, so mongosh adds a field named __proto__ rather than setting the prototype.
    expect(formatMongoshSyntax(JSON.stringify(value), ONE_LINE)).toBe('{["__proto__"]: 1, a: 2}');
    const relaxed = JSON.parse(formatRelaxedJson(JSON.stringify(value))) as Record<string, unknown>;
    expect(Object.keys(relaxed)).toEqual(['__proto__', 'a']);
    expect(Object.getOwnPropertyDescriptor(relaxed, '__proto__')?.value).toBe(1);
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

/** Reads a mongosh regex literal back into a RegExp, the way mongosh would. */
function regexFromLiteral(text: string): RegExp {
  const end = text.lastIndexOf('/');
  return new RegExp(text.slice(1, end), text.slice(end + 1));
}

describe('regex round trip through mongosh text', () => {
  it('escapes every bare slash, including runs of slashes and the slashes of a URL', () => {
    expect(shell({ $regularExpression: { pattern: 'a//b', options: '' } })).toBe('/a\\/\\/b/');
    expect(shell({ $regularExpression: { pattern: '^//', options: '' } })).toBe('/^\\/\\//');
    expect(shell({ $regularExpression: { pattern: 'https://x', options: '' } })).toBe(
      '/https:\\/\\/x/',
    );
  });

  it('reads back a pattern with a double slash to the same matches', () => {
    const doubled = regexFromLiteral(
      shell({ $regularExpression: { pattern: 'a//b', options: '' } }),
    );
    expect(doubled.test('a//b')).toBe(true);
    expect(doubled.test('a/b')).toBe(false);

    const anchored = regexFromLiteral(
      shell({ $regularExpression: { pattern: '^//', options: '' } }),
    );
    expect(anchored.test('//x')).toBe(true);
    expect(anchored.test('x//')).toBe(false);

    const url = regexFromLiteral(
      shell({ $regularExpression: { pattern: 'https://x', options: 'i' } }),
    );
    expect(url.test('HTTPS://X')).toBe(true);
  });

  it('keeps an escaped backslash before a slash as one escape', () => {
    // The pattern is a literal backslash followed by a slash: the slash still needs its escape.
    expect(shell({ $regularExpression: { pattern: 'a\\\\/b', options: '' } })).toBe('/a\\\\\\/b/');
  });

  it('reads a literal with an escaped slash back to the same pattern', () => {
    const literal = shell({ $regularExpression: { pattern: 'a\\/b', options: '' } });
    expect(regexFromLiteral(literal).test('a/b')).toBe(true);
    expect(regexFromLiteral(literal).test('a\\b')).toBe(false);
  });

  it('reads a literal with a bare slash back to the same pattern', () => {
    const literal = shell({ $regularExpression: { pattern: 'a/b', options: 'i' } });
    expect(regexFromLiteral(literal).test('A/B')).toBe(true);
    expect(regexFromLiteral(literal).source).toBe(new RegExp('a/b', 'i').source);
  });

  it('keeps the x option in BSONRegExp, where a literal would drop it', () => {
    expect(shell({ $regularExpression: { pattern: 'a b', options: 'x' } })).toBe(
      'BSONRegExp("a b", "x")',
    );
  });

  it('keeps a newline in the pattern through the BSONRegExp escape', () => {
    const text = shell({ $regularExpression: { pattern: 'a\nb', options: '' } });
    // The escape is the two characters backslash and n, so the text parses back to a newline.
    const pattern = JSON.parse(text.slice('BSONRegExp('.length, text.lastIndexOf(',')));
    expect(pattern).toBe('a\nb');
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
