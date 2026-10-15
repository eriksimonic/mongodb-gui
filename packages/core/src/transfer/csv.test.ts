import { describe, expect, it } from 'vitest';
import { createCsvParser, CsvSyntaxError, formatCsvField, formatCsvRow } from './csv';

// Parses the whole text in one chunk, then flushes.
function parseAll(text: string, delimiter = ','): string[][] {
  const parser = createCsvParser({ delimiter });
  return [...parser.write(text), ...parser.flush()];
}

// Parses the text split into chunks of the given size, to exercise boundaries.
function parseChunked(text: string, size: number, delimiter = ','): string[][] {
  const parser = createCsvParser({ delimiter });
  const rows: string[][] = [];
  for (let index = 0; index < text.length; index += size) {
    rows.push(...parser.write(text.slice(index, index + size)));
  }
  rows.push(...parser.flush());
  return rows;
}

describe('createCsvParser', () => {
  it('splits simple records on LF and CRLF', () => {
    expect(parseAll('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseAll('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('accepts a final record without a trailing newline', () => {
    expect(parseAll('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(parseAll('')).toEqual([]);
  });

  it('keeps empty fields, including trailing ones', () => {
    expect(parseAll(',a,\n,,\n')).toEqual([
      ['', 'a', ''],
      ['', '', ''],
    ]);
  });

  it('skips blank lines but keeps a quoted empty field', () => {
    expect(parseAll('a\n\n\nb\n')).toEqual([['a'], ['b']]);
    expect(parseAll('""\n')).toEqual([['']]);
  });

  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseAll('"say ""hi""",2\n')).toEqual([['say "hi"', '2']]);
  });

  it('keeps delimiters, quotes and line breaks inside quoted fields', () => {
    expect(parseAll('"a,b","line1\nline2","x\r\ny"\n')).toEqual([
      ['a,b', 'line1\nline2', 'x\r\ny'],
    ]);
  });

  it('keeps a quote inside an unquoted field as a literal', () => {
    expect(parseAll('5" screen,ok\n')).toEqual([['5" screen', 'ok']]);
  });

  it('treats text after a closing quote as part of the field', () => {
    expect(parseAll('"ab"cd,e\n')).toEqual([['abcd', 'e']]);
  });

  it('supports the other delimiters', () => {
    expect(parseAll('a;b\n1;2\n', ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseAll('a\tb\n', '\t')).toEqual([['a', 'b']]);
    expect(parseAll('a|"b|c"\n', '|')).toEqual([['a', 'b|c']]);
  });

  it('strips a leading byte order mark only at the start of the input', () => {
    expect(parseAll('\uFEFFa,b\n')).toEqual([['a', 'b']]);
    expect(parseAll('a,\uFEFFb\n')).toEqual([['a', '\uFEFFb']]);
  });

  it('treats a lone CR as a line break', () => {
    expect(parseAll('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('splits CRLF and lone CR records, and ends a record at a final lone CR', () => {
    expect(parseAll('a\r\nb\rc\n')).toEqual([['a'], ['b'], ['c']]);
    expect(parseAll('a\r')).toEqual([['a']]);
  });

  it('keeps CRLF and lone CR inside quoted fields', () => {
    expect(parseAll('"x\r\ny",1\r\n"a\rb",2\n')).toEqual([
      ['x\r\ny', '1'],
      ['a\rb', '2'],
    ]);
  });

  it('skips blank CRLF and CR-only lines', () => {
    expect(parseAll('a\r\n\r\n1,"x\r\ny"\r\n')).toEqual([['a'], ['1', 'x\r\ny']]);
    expect(parseAll('a\r\r\nb')).toEqual([['a'], ['b']]);
  });

  it('keeps a CR and LF split across chunks inside a quoted field', () => {
    const parser = createCsvParser({ delimiter: ',' });
    const first = parser.write('"a\r');
    const second = parser.write('\nb"\r\n');
    expect([...first, ...second, ...parser.flush()]).toEqual([['a\r\nb']]);
  });

  it('refuses a file that ends inside a quoted field', () => {
    const parser = createCsvParser({ delimiter: ',' });
    parser.write('a,"unfinished\nmore');
    expect(() => parser.flush()).toThrow(CsvSyntaxError);
  });

  it('accepts a quote that closes on the last character of the input', () => {
    expect(parseAll('a,"b"')).toEqual([['a', 'b']]);
  });

  it('refuses delimiters that are not distinct single characters', () => {
    expect(() => createCsvParser({ delimiter: '' })).toThrow(CsvSyntaxError);
    expect(() => createCsvParser({ delimiter: ',,' })).toThrow(CsvSyntaxError);
    expect(() => createCsvParser({ delimiter: '"', quote: '"' })).toThrow(CsvSyntaxError);
  });

  it.each([1, 2, 3, 5, 7, 64])('gives the same rows when chunked at %i characters', (size) => {
    const text =
      '\uFEFFid,name,note\r\n1,"Ann ""A""","multi\r\nline"\r\n2,,"x,y"\r\n\r\n3,Bob,\n4,"",end';
    expect(parseChunked(text, size)).toEqual(parseAll(text));
  });

  it('splits a CRLF across chunks into one line break', () => {
    const parser = createCsvParser({ delimiter: ',' });
    expect(parser.write('a\r')).toEqual([['a']]);
    expect(parser.write('\nb\n')).toEqual([['b']]);
    expect(parser.flush()).toEqual([]);
  });

  it('keeps a doubled quote split across chunks intact', () => {
    const parser = createCsvParser({ delimiter: ',' });
    const first = parser.write('"a"');
    const second = parser.write('"b",c\n');
    expect([...first, ...second, ...parser.flush()]).toEqual([['a"b', 'c']]);
  });

  it('parses a large input in many chunks without losing records', () => {
    const lines = Array.from({ length: 5000 }, (_, index) => `${index},"v ${index}",x`);
    const text = `${lines.join('\n')}\n`;
    const rows = parseChunked(text, 4096);
    expect(rows).toHaveLength(5000);
    expect(rows[4999]).toEqual(['4999', 'v 4999', 'x']);
  });
});

describe('formatCsvField and formatCsvRow', () => {
  it('leaves plain values unquoted', () => {
    expect(formatCsvField('plain', ',')).toBe('plain');
    expect(formatCsvField('', ',')).toBe('');
  });

  it('quotes values that contain the delimiter, a quote, or a line break', () => {
    expect(formatCsvField('a,b', ',')).toBe('"a,b"');
    expect(formatCsvField('say "hi"', ',')).toBe('"say ""hi"""');
    expect(formatCsvField('line1\nline2', ',')).toBe('"line1\nline2"');
    expect(formatCsvField('x\ry', ',')).toBe('"x\ry"');
  });

  it('quotes on the active delimiter only', () => {
    expect(formatCsvField('a,b', ';')).toBe('a,b');
    expect(formatCsvField('a;b', ';')).toBe('"a;b"');
    expect(formatCsvField('a\tb', '\t')).toBe('"a\tb"');
  });

  it('quotes CRLF and lone CR values', () => {
    expect(formatCsvField('a\r\nb', ',')).toBe('"a\r\nb"');
    expect(formatCsvRow(['a\rb', 'c'], ',')).toBe('"a\rb",c');
  });

  it('joins fields with the delimiter', () => {
    expect(formatCsvRow(['id', 'a,b', 'c'], ',')).toBe('id,"a,b",c');
    expect(formatCsvRow(['1', '2'], '|')).toBe('1|2');
  });

  it('round trips through the parser', () => {
    const values = ['plain', 'a,b', 'say "hi"', 'two\nlines', '', 'x\r\ny', ';semi;'];
    const line = formatCsvRow(values, ',');
    expect(parseAll(`${line}\n`)).toEqual([values]);
  });

  it('round trips CRLF and lone CR values, also when chunked one character at a time', () => {
    const values = ['a\rb', 'c\r\nd', 'e\r', '\r'];
    const text = `${formatCsvRow(values, ',')}\r\n`;
    expect(parseAll(text)).toEqual([values]);
    expect(parseChunked(text, 1)).toEqual([values]);
  });
});
