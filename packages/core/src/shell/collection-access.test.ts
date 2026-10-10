import { describe, expect, it } from 'vitest';
import { collectionAccess, quoteShellString } from './collection-access';

describe('collectionAccess', () => {
  it('uses the property form for a plain name', () => {
    expect(collectionAccess('orders')).toBe('db.orders');
    expect(collectionAccess('events_2024')).toBe('db.events_2024');
    expect(collectionAccess('A')).toBe('db.A');
    expect(collectionAccess('camelCase')).toBe('db.camelCase');
  });

  it('uses getCollection for a name with a dot, a dash, a space or a leading digit', () => {
    expect(collectionAccess('order.lines')).toBe("db.getCollection('order.lines')");
    expect(collectionAccess('daily-totals')).toBe("db.getCollection('daily-totals')");
    expect(collectionAccess('my orders')).toBe("db.getCollection('my orders')");
    expect(collectionAccess('2024')).toBe("db.getCollection('2024')");
    expect(collectionAccess('1st')).toBe("db.getCollection('1st')");
  });

  it('uses getCollection for an empty name', () => {
    expect(collectionAccess('')).toBe("db.getCollection('')");
  });

  it('uses getCollection for a name starting with an underscore', () => {
    expect(collectionAccess('_events')).toBe("db.getCollection('_events')");
    expect(collectionAccess('_')).toBe("db.getCollection('_')");
  });

  it('uses getCollection for a name containing a dollar sign', () => {
    expect(collectionAccess('price$')).toBe("db.getCollection('price$')");
    expect(collectionAccess('$cmd')).toBe("db.getCollection('$cmd')");
    expect(collectionAccess('a$b')).toBe("db.getCollection('a$b')");
  });

  it('uses getCollection for a name that matches a member of db', () => {
    expect(collectionAccess('stats')).toBe("db.getCollection('stats')");
    expect(collectionAccess('version')).toBe("db.getCollection('version')");
    expect(collectionAccess('aggregate')).toBe("db.getCollection('aggregate')");
    expect(collectionAccess('getCollection')).toBe("db.getCollection('getCollection')");
    expect(collectionAccess('watch')).toBe("db.getCollection('watch')");
    expect(collectionAccess('help')).toBe("db.getCollection('help')");
  });

  it('uses getCollection for a name inherited from Object.prototype', () => {
    expect(collectionAccess('constructor')).toBe("db.getCollection('constructor')");
    expect(collectionAccess('toString')).toBe("db.getCollection('toString')");
    expect(collectionAccess('hasOwnProperty')).toBe("db.getCollection('hasOwnProperty')");
    expect(collectionAccess('valueOf')).toBe("db.getCollection('valueOf')");
  });

  it('is case sensitive for member names', () => {
    expect(collectionAccess('Stats')).toBe('db.Stats');
    expect(collectionAccess('VERSION')).toBe('db.VERSION');
  });

  it('uses getCollection for unicode names', () => {
    expect(collectionAccess('naročila')).toBe("db.getCollection('naročila')");
    expect(collectionAccess('注文')).toBe("db.getCollection('注文')");
    expect(collectionAccess('émis')).toBe("db.getCollection('émis')");
  });

  it('escapes quotes and backslashes in the name', () => {
    expect(collectionAccess("it's")).toBe("db.getCollection('it\\'s')");
    expect(collectionAccess('a"b\\c')).toBe("db.getCollection('a\"b\\\\c')");
  });

  it('escapes control characters in the name', () => {
    expect(collectionAccess('a\nb')).toBe("db.getCollection('a\\nb')");
    expect(collectionAccess('a\tb')).toBe("db.getCollection('a\\tb')");
    expect(collectionAccess('a\u0000b')).toBe("db.getCollection('a\\u0000b')");
  });
});

describe('quoteShellString', () => {
  it('wraps plain text in single quotes', () => {
    expect(quoteShellString('abc')).toBe("'abc'");
    expect(quoteShellString('')).toBe("''");
  });

  it('leaves double quotes alone', () => {
    expect(quoteShellString('say "hi"')).toBe('\'say "hi"\'');
  });

  it('escapes the single quote and the backslash', () => {
    expect(quoteShellString("it's")).toBe("'it\\'s'");
    expect(quoteShellString('a\\b')).toBe("'a\\\\b'");
    expect(quoteShellString("\\'")).toBe("'\\\\\\''");
  });

  it('uses short escapes for newline, carriage return and tab', () => {
    expect(quoteShellString('a\nb')).toBe("'a\\nb'");
    expect(quoteShellString('a\rb')).toBe("'a\\rb'");
    expect(quoteShellString('a\tb')).toBe("'a\\tb'");
    expect(quoteShellString('\r\n')).toBe("'\\r\\n'");
  });

  it('uses \\uXXXX for other control characters', () => {
    expect(quoteShellString('\u0000')).toBe("'\\u0000'");
    expect(quoteShellString('\u0007')).toBe("'\\u0007'");
    expect(quoteShellString('\u001b[0m')).toBe("'\\u001b[0m'");
    expect(quoteShellString('\u007f')).toBe("'\\u007f'");
  });

  it('escapes the Unicode line separators so the literal stays on one line', () => {
    expect(quoteShellString('a b')).toBe("'a\\u2028b'");
    expect(quoteShellString('a b')).toBe("'a\\u2029b'");
  });

  it('keeps printable unicode and emoji as they are', () => {
    expect(quoteShellString('naročila')).toBe("'naročila'");
    expect(quoteShellString('😀')).toBe("'😀'");
  });
});
