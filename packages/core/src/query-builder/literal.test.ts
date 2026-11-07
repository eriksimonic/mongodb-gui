import { parseExpressionAt } from 'acorn';
import { describe, expect, it } from 'vitest';
import { formatMongoshSyntax } from '../ejson/format';
import { parseLiteral } from './literal';

function read(text: string) {
  return parseLiteral(parseExpressionAt(text, 0, { ecmaVersion: 'latest' }));
}

// Years 0 to 9999 read as an ISO string with milliseconds, as the UI writes them.
const JAN_1_2026 = { $date: '2026-01-01T00:00:00.000Z' };
// Years outside 0 to 9999 keep the milliseconds.
const YEAR_10000_MILLIS = Date.UTC(10000, 0, 1);
const YEAR_MINUS_1_MILLIS = Date.UTC(-1, 0, 1);
const OBJECT_ID_HEX = '64b7f0c2a1b2c3d4e5f60718';

describe('parseLiteral, accepted literals', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['true', true],
    ['false', false],
    ['"text"', 'text'],
    ["'text'", 'text'],
    ['`text`', 'text'],
    ['12', 12],
    ['-3.5', -3.5],
    ['-2147483648', -2147483648],
    ['[]', []],
    ['[1, "a", [null]]', [1, 'a', [null]]],
    ['{}', {}],
    ['{ a: 1, "b c": { $gt: 2 } }', { a: 1, 'b c': { $gt: 2 } }],
    ['{ 1: "x" }', { '1': 'x' }],
    ['/^a.*$/im', { $regularExpression: { pattern: '^a.*$', options: 'im' } }],
    ['/a\\/b/s', { $regularExpression: { pattern: 'a\\/b', options: 's' } }],
    ['ObjectId("64b7f0c2a1b2c3d4e5f60718")', { $oid: OBJECT_ID_HEX }],
    ['ISODate("2026-01-01T00:00:00Z")', JAN_1_2026],
    ['ISODate("2026-01-01T00:00:00")', JAN_1_2026],
    ['ISODate("2026-01-01")', JAN_1_2026],
    ['ISODate("2026-01-01T01:00:00+01:00")', JAN_1_2026],
    ['new Date("2026-01-01T00:00:00Z")', JAN_1_2026],
    ['ISODate("0000-01-01")', { $date: '0000-01-01T00:00:00.000Z' }],
    ['ISODate("9999-12-31T23:59:59.999Z")', { $date: '9999-12-31T23:59:59.999Z' }],
    ['new Date("+010000-01-01T00:00:00Z")', { $date: { $numberLong: String(YEAR_10000_MILLIS) } }],
    [`new Date(${YEAR_10000_MILLIS})`, { $date: { $numberLong: String(YEAR_10000_MILLIS) } }],
    [`new Date(${YEAR_MINUS_1_MILLIS})`, { $date: { $numberLong: String(YEAR_MINUS_1_MILLIS) } }],
    ['NumberInt(5)', { $numberInt: '5' }],
    ['NumberInt("-7")', { $numberInt: '-7' }],
    ['NumberInt(-2147483648)', { $numberInt: '-2147483648' }],
    ['NumberLong("9007199254740993")', { $numberLong: '9007199254740993' }],
    ['NumberLong(-3)', { $numberLong: '-3' }],
    ['Decimal128("1.50")', { $numberDecimal: '1.50' }],
    ['Decimal128(0.5)', { $numberDecimal: '0.5' }],
    ['NumberDecimal("1.50")', { $numberDecimal: '1.50' }],
    [
      '{ tags: { $in: ["a", ObjectId("64b7f0c2a1b2c3d4e5f60718")] } }',
      { tags: { $in: ['a', { $oid: OBJECT_ID_HEX }] } },
    ],
  ])('reads %s', (text, expected) => {
    expect(read(text)).toEqual({ value: expected });
  });
});

describe('parseLiteral, refused literals', () => {
  it.each<[string, string]>([
    ['foo', 'identifier'],
    ['undefined', 'identifier'],
    ['[1, { a: foo }]', 'identifier'],
    ['{ a }', 'identifier'],
    ['{ ...{ a: 1 } }', 'spread'],
    ['[...[1]]', 'spread'],
    ['{ [k]: 1 }', 'computed key'],
    ['{ a() {} }', 'method or accessor'],
    ['{ get a() { return 1 } }', 'method or accessor'],
    ['{ "__proto__": 1 }', '__proto__ key'],
    ['[1, , 2]', 'array hole'],
    ['`a${1}`', 'template string with an expression'],
    ['a.b', 'not a literal (MemberExpression)'],
    ['1 + 2', 'not a literal (BinaryExpression)'],
    ['x = 1', 'not a literal (AssignmentExpression)'],
    ['() => 1', 'not a literal (ArrowFunctionExpression)'],
    ['function () {}', 'not a literal (FunctionExpression)'],
    ['this', 'not a literal (ThisExpression)'],
    ['fn()', 'call to fn'],
    ['obj.fn()', 'call'],
    ['Date("2026-01-01")', 'call to Date'],
    ['ObjectId()', 'ObjectId needs one 24 hex character string'],
    ['ObjectId("xyz")', 'ObjectId needs one 24 hex character string'],
    ['ObjectId(5)', 'ObjectId needs one 24 hex character string'],
    ['new ObjectId("64b7f0c2a1b2c3d4e5f60718")', 'constructor call'],
    ['ISODate("not a date")', 'ISODate needs one ISO 8601 string'],
    ['ISODate(1)', 'ISODate needs one ISO 8601 string'],
    ['ISODate("2026-13-45")', 'invalid date'],
    ['new Date()', 'new Date needs one string'],
    ['new Date("nope")', 'invalid date'],
    ['new Date(1.5)', 'invalid date'],
    ['new Date(9e15)', 'invalid date'],
    ['NumberInt(1.5)', 'NumberInt needs an integer'],
    ['NumberInt(x)', 'NumberInt needs an integer'],
    ['NumberInt(3000000000)', 'NumberInt out of range'],
    ['NumberLong("abc")', 'NumberLong needs an integer'],
    ['NumberLong()', 'NumberLong needs an integer'],
    ['NumberLong(1e20)', 'NumberLong out of range'],
    ['Decimal128("abc")', 'Decimal128 needs a decimal'],
    ['Decimal128(true)', 'Decimal128 needs a decimal'],
    ['/a/g', 'regex flag other than i, m, s, u'],
    ['1n', 'BigInt literal'],
    ['1e400', 'number out of range'],
    ['-1e400', 'unary operator'],
    ['-"a"', 'unary operator'],
    ['!true', 'unary operator'],
  ])('refuses %s', (text, reason) => {
    expect(read(text)).toEqual({ unsupported: reason });
  });
});

describe('parseLiteral, round trip through formatMongoshSyntax', () => {
  it.each<[string, string]>([
    ['ObjectId("64b7f0c2a1b2c3d4e5f60718")', 'ObjectId("64b7f0c2a1b2c3d4e5f60718")'],
    ['ISODate("2026-01-01T00:00:00Z")', 'ISODate("2026-01-01T00:00:00.000Z")'],
    ['NumberLong("9007199254740993")', 'NumberLong("9007199254740993")'],
    ['NumberDecimal("1.50")', 'NumberDecimal("1.50")'],
    ['/^a.*$/im', '/^a.*$/im'],
    ['ISODate("0000-01-01")', 'ISODate("0000-01-01T00:00:00.000Z")'],
    ['new Date("+010000-01-01T00:00:00Z")', `new Date(${YEAR_10000_MILLIS})`],
    [`new Date(${YEAR_MINUS_1_MILLIS})`, `new Date(${YEAR_MINUS_1_MILLIS})`],
  ])('prints %s as %s and reads it back', (text, printed) => {
    const first = read(text);
    if (!('value' in first)) {
      throw new Error(`refused: ${first.unsupported}`);
    }
    const mongosh = formatMongoshSyntax(JSON.stringify(first.value), { indent: 0 });
    expect(mongosh).toBe(printed);
    expect(read(mongosh)).toEqual(first);
  });

  it('reads back a date value the UI writes as an ISO string with milliseconds', () => {
    const value = { $date: '2026-01-01T10:00:30.500Z' };
    const mongosh = formatMongoshSyntax(JSON.stringify(value), { indent: 0 });
    expect(mongosh).toBe('ISODate("2026-01-01T10:00:30.500Z")');
    expect(read(mongosh)).toEqual({ value });
  });
});
