import { describe, expect, it } from 'vitest';
import { insertionText, markerRanges } from './editor-events';

describe('insertionText', () => {
  it('adds nothing around code inserted into an empty editor', () => {
    expect(insertionText('', '', 'db.a.find()')).toBe('db.a.find()');
  });

  it('starts a new line when the cursor follows text on its line', () => {
    expect(insertionText('use shop', '', 'db.a.find()')).toBe('\ndb.a.find()');
  });

  it('adds no leading newline after a newline', () => {
    expect(insertionText('use shop\n', '', 'db.a.find()')).toBe('db.a.find()');
  });

  it('ends the line when text follows the cursor on the same line', () => {
    expect(insertionText('', 'db.a.find()', 'db.orders.find({})')).toBe('db.orders.find({})\n');
  });

  it('gives two lines when the cursor is at the start of db.a.find()', () => {
    const inserted = insertionText('', 'db.a.find()', 'db.orders.find({})');
    expect(`${inserted}db.a.find()`.split('\n')).toEqual(['db.orders.find({})', 'db.a.find()']);
  });

  it('adds no trailing newline before a newline', () => {
    expect(insertionText('', '\ndb.a.find()', 'db.orders.find({})')).toBe('db.orders.find({})');
  });
});

describe('markerRanges', () => {
  it('maps offsets on the first line to one-based columns', () => {
    expect(markerRanges('SELECT * FROM orders', [{ start: 7, end: 8, message: 'star' }])).toEqual([
      { startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 9, message: 'star' },
    ]);
  });

  it('maps offsets on later lines', () => {
    const text = 'SELECT *\nFROM orders\nWHERE x';
    expect(markerRanges(text, [{ start: 14, end: 20, message: 'orders' }])).toEqual([
      { startLineNumber: 2, startColumn: 6, endLineNumber: 2, endColumn: 12, message: 'orders' },
    ]);
  });

  it('spans lines', () => {
    const text = 'SELECT *\nFROM orders';
    expect(markerRanges(text, [{ start: 0, end: text.length, message: 'all' }])).toEqual([
      { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 12, message: 'all' },
    ]);
  });

  it('widens an empty span by one character', () => {
    expect(markerRanges('SELECT', [{ start: 2, end: 2, message: 'here' }])).toEqual([
      { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 4, message: 'here' },
    ]);
  });

  it('widens an empty span at the end of the text backwards', () => {
    expect(markerRanges('SELECT', [{ start: 6, end: 6, message: 'end' }])).toEqual([
      { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 7, message: 'end' },
    ]);
  });

  it('clamps offsets past the end of the text', () => {
    expect(markerRanges('SELECT', [{ start: 3, end: 40, message: 'late' }])).toEqual([
      { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 7, message: 'late' },
    ]);
  });

  it('swaps a span whose start follows its end', () => {
    expect(markerRanges('SELECT', [{ start: 4, end: 1, message: 'swap' }])).toEqual([
      { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5, message: 'swap' },
    ]);
  });

  it('gives a one character range for empty text', () => {
    expect(markerRanges('', [{ start: 0, end: 0, message: 'empty' }])).toEqual([
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, message: 'empty' },
    ]);
  });

  it('keeps the order of the markers', () => {
    const ranges = markerRanges('ab cd', [
      { start: 3, end: 5, message: 'second' },
      { start: 0, end: 2, message: 'first' },
    ]);
    expect(ranges.map((range) => range.message)).toEqual(['second', 'first']);
  });

  it('returns nothing for no markers', () => {
    expect(markerRanges('SELECT', [])).toEqual([]);
  });
});
