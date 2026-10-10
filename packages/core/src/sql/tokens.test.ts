import { describe, expect, it } from 'vitest';
import { SqlError } from './ast';
import { scanRaw, tokenize, type Token } from './tokens';

function kinds(text: string): string[] {
  return tokenize(text).map((token) => `${token.kind}:${token.value}`);
}

function failure(text: string): { message: string; start: number; end: number } {
  try {
    tokenize(text);
  } catch (error) {
    if (error instanceof SqlError) {
      return { message: error.message, start: error.span.start, end: error.span.end };
    }
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(text)} to fail`);
}

describe('tokenize', () => {
  it('splits words and keeps their offsets', () => {
    const tokens = tokenize('SELECT name FROM t');
    expect(tokens).toEqual<Token[]>([
      { kind: 'word', text: 'SELECT', value: 'SELECT', start: 0, end: 6 },
      { kind: 'word', text: 'name', value: 'name', start: 7, end: 11 },
      { kind: 'word', text: 'FROM', value: 'FROM', start: 12, end: 16 },
      { kind: 'word', text: 't', value: 't', start: 17, end: 18 },
    ]);
  });

  it('returns no tokens for empty, whitespace and comment-only text', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('  \n\t ')).toEqual([]);
    expect(tokenize('-- nothing here')).toEqual([]);
    expect(tokenize('/* nothing */')).toEqual([]);
  });

  it('unwraps bracketed identifiers and unescapes ]]', () => {
    const tokens = tokenize('[Order Id] [a]]b]');
    expect(tokens).toEqual<Token[]>([
      { kind: 'identifier', text: '[Order Id]', value: 'Order Id', start: 0, end: 10 },
      { kind: 'identifier', text: '[a]]b]', value: 'a]b', start: 11, end: 17 },
    ]);
  });

  it('unwraps double-quoted identifiers and unescapes ""', () => {
    const tokens = tokenize('"name" "say ""hi"""');
    expect(tokens.map((token) => token.value)).toEqual(['name', 'say "hi"']);
    expect(tokens.map((token) => token.kind)).toEqual(['identifier', 'identifier']);
    expect(tokens[1]).toMatchObject({ start: 7, end: 19 });
  });

  it('reads strings and unescapes doubled quotes', () => {
    const tokens = tokenize("'it''s' ''");
    expect(tokens).toEqual<Token[]>([
      { kind: 'string', text: "'it''s'", value: "it's", start: 0, end: 7 },
      { kind: 'string', text: "''", value: '', start: 8, end: 10 },
    ]);
  });

  it('reads N strings as plain strings with the prefix inside the span', () => {
    const tokens = tokenize("N'text' n'x'");
    expect(tokens).toEqual<Token[]>([
      { kind: 'string', text: "N'text'", value: 'text', start: 0, end: 7 },
      { kind: 'string', text: "n'x'", value: 'x', start: 8, end: 12 },
    ]);
  });

  it('does not take a word starting with N for a string prefix', () => {
    expect(kinds("Name = 'x'")).toEqual(['word:Name', 'operator:=', 'string:x']);
  });

  it('reads integer, decimal, leading-dot and exponent numbers', () => {
    expect(kinds('123 1.5 .5 1e3 1.5E-2 7.')).toEqual([
      'number:123',
      'number:1.5',
      'number:.5',
      'number:1e3',
      'number:1.5E-2',
      'number:7.',
    ]);
  });

  it('reads a dot between words as an operator rather than a number', () => {
    expect(kinds('a.b')).toEqual(['word:a', 'operator:.', 'word:b']);
  });

  it('reads every operator and punctuation mark, longest first', () => {
    expect(kinds('= <> != < <= > >= + - * / % ( ) , . ;')).toEqual([
      'operator:=',
      'operator:<>',
      'operator:!=',
      'operator:<',
      'operator:<=',
      'operator:>',
      'operator:>=',
      'operator:+',
      'operator:-',
      'operator:*',
      'operator:/',
      'operator:%',
      'operator:(',
      'operator:)',
      'operator:,',
      'operator:.',
      'operator:;',
    ]);
  });

  it('reads operators without surrounding whitespace', () => {
    expect(kinds('a<>b,c>=1')).toEqual([
      'word:a',
      'operator:<>',
      'word:b',
      'operator:,',
      'word:c',
      'operator:>=',
      'number:1',
    ]);
  });

  it('reads parameters with the @ stripped from the value', () => {
    const tokens = tokenize('@name @@ROWCOUNT');
    expect(tokens).toEqual<Token[]>([
      { kind: 'parameter', text: '@name', value: 'name', start: 0, end: 5 },
      { kind: 'parameter', text: '@@ROWCOUNT', value: '@ROWCOUNT', start: 6, end: 16 },
    ]);
  });

  it('skips line comments up to the newline', () => {
    const tokens = tokenize('a -- comment\nb');
    expect(tokens.map((token) => [token.value, token.start])).toEqual([
      ['a', 0],
      ['b', 13],
    ]);
  });

  it('skips line comments before a Windows line ending', () => {
    const tokens = tokenize('a -- comment\r\nb');
    expect(tokens.map((token) => [token.value, token.start])).toEqual([
      ['a', 0],
      ['b', 14],
    ]);
  });

  it('skips block comments, including nested ones', () => {
    expect(kinds('a /* x /* y */ z */ b')).toEqual(['word:a', 'word:b']);
    expect(kinds('a/*b*/c')).toEqual(['word:a', 'word:c']);
  });

  it('keeps comment markers inside strings and brackets', () => {
    expect(kinds("'--x' [/*y*/]")).toEqual(['string:--x', 'identifier:/*y*/']);
  });

  it('keeps keywords as written so the parser can match them case-insensitively', () => {
    expect(kinds('select Select SELECT')).toEqual(['word:select', 'word:Select', 'word:SELECT']);
  });

  it('accepts unicode letters in words', () => {
    expect(kinds('straße café_1')).toEqual(['word:straße', 'word:café_1']);
  });

  it('adds the offset to every span', () => {
    const tokens = tokenize("a = 'b'", 100);
    expect(tokens.map((token) => [token.start, token.end])).toEqual([
      [100, 101],
      [102, 103],
      [104, 107],
    ]);
  });

  it('throws for an unterminated string at the opening quote', () => {
    expect(failure("SELECT 'abc")).toEqual({ message: 'unterminated string', start: 7, end: 8 });
    expect(failure("x = 'it''")).toEqual({ message: 'unterminated string', start: 4, end: 5 });
  });

  it('throws for an unterminated N string at the prefix and quote', () => {
    expect(failure("SELECT N'abc")).toEqual({ message: 'unterminated string', start: 7, end: 9 });
  });

  it('throws for an unterminated bracket at the opening bracket', () => {
    expect(failure('SELECT [abc')).toEqual({
      message: 'unterminated bracketed identifier',
      start: 7,
      end: 8,
    });
  });

  it('throws for an empty bracketed or quoted identifier at the identifier', () => {
    expect(failure('SELECT [] FROM t')).toEqual({
      message: 'an identifier cannot be empty',
      start: 7,
      end: 9,
    });
    expect(failure('SELECT "" FROM t')).toEqual({
      message: 'an identifier cannot be empty',
      start: 7,
      end: 9,
    });
    expect(failure('SELECT a FROM [] WHERE b = 1')).toEqual({
      message: 'an identifier cannot be empty',
      start: 14,
      end: 16,
    });
  });

  it('keeps a bracketed identifier that holds only whitespace or an escaped bracket', () => {
    expect(tokenize('[ ]').map((token) => token.value)).toEqual([' ']);
    expect(tokenize('[]]]').map((token) => token.value)).toEqual([']']);
  });

  it('throws for an unterminated quoted identifier at the opening quote', () => {
    expect(failure('SELECT "abc')).toEqual({
      message: 'unterminated quoted identifier',
      start: 7,
      end: 8,
    });
  });

  it('throws for an unterminated block comment at the opening marker', () => {
    expect(failure('a /* b')).toEqual({ message: 'unterminated block comment', start: 2, end: 4 });
    expect(failure('a /* b /* c */')).toEqual({
      message: 'unterminated block comment',
      start: 2,
      end: 4,
    });
  });

  it('throws for a character outside the grammar', () => {
    expect(failure('a # b')).toEqual({ message: "unexpected character '#'", start: 2, end: 3 });
    expect(failure('a ! b')).toEqual({ message: "unexpected character '!'", start: 2, end: 3 });
    expect(failure('{')).toEqual({ message: "unexpected character '{'", start: 0, end: 1 });
  });

  it('applies the offset to error spans', () => {
    expect(() => tokenize("'abc", 10)).toThrow(SqlError);
    try {
      tokenize("'abc", 10);
    } catch (error) {
      expect((error as SqlError).span).toEqual({ start: 10, end: 11 });
    }
  });
});

describe('scanRaw', () => {
  it('keeps whitespace and comments as lexemes', () => {
    const raw = scanRaw('a -- c\n b');
    expect(raw.map((token) => token.kind)).toEqual([
      'word',
      'whitespace',
      'comment',
      'whitespace',
      'word',
    ]);
    expect(raw.map((token) => token.text)).toEqual(['a', ' ', '-- c', '\n ', 'b']);
  });

  it('flags unterminated input instead of throwing', () => {
    const raw = scanRaw("a 'b");
    expect(raw[2]).toMatchObject({ kind: 'string', unterminated: true, start: 2, end: 4 });
    expect(scanRaw('/* x')[0]).toMatchObject({ kind: 'comment', unterminated: true });
    expect(scanRaw('[x')[0]).toMatchObject({ kind: 'identifier', unterminated: true });
  });

  it('marks characters outside the grammar as invalid', () => {
    expect(scanRaw('a ^ b')[2]).toMatchObject({ kind: 'invalid', text: '^', unterminated: false });
  });

  it('covers the whole text with adjacent spans', () => {
    const text = "SELECT [a], 'b' -- c\n/* d */ FROM t;";
    const raw = scanRaw(text);
    let position = 0;
    for (const token of raw) {
      expect(token.start).toBe(position);
      expect(text.slice(token.start, token.end)).toBe(token.text);
      position = token.end;
    }
    expect(position).toBe(text.length);
  });
});

describe('regression: temporary table names', () => {
  it('reads #tmp and ##shared as words', () => {
    expect(kinds('#tmp ##shared')).toEqual(['word:#tmp', 'word:##shared']);
    expect(tokenize('FROM #tmp')[1]).toMatchObject({
      kind: 'word',
      text: '#tmp',
      start: 5,
      end: 9,
    });
  });

  it('keeps a hash that no word follows as an unexpected character', () => {
    expect(failure('# tmp')).toEqual({ message: "unexpected character '#'", start: 0, end: 1 });
    expect(failure('###tmp')).toEqual({ message: "unexpected character '#'", start: 0, end: 1 });
    expect(failure('#1')).toEqual({ message: "unexpected character '#'", start: 0, end: 1 });
  });
});
