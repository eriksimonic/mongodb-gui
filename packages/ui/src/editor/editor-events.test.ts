import { describe, expect, it } from 'vitest';
import { insertionText } from './editor-events';

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
