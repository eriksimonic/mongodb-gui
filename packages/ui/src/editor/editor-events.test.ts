import { describe, expect, it } from 'vitest';
import { insertionText } from './editor-events';

describe('insertionText', () => {
  it('adds no newline to an empty editor', () => {
    expect(insertionText('', 'db.a.find()')).toBe('db.a.find()');
  });

  it('adds a newline when the editor text does not end with one', () => {
    expect(insertionText('use shop', 'db.a.find()')).toBe('\ndb.a.find()');
  });

  it('adds no newline when the editor text already ends with one', () => {
    expect(insertionText('use shop\n', 'db.a.find()')).toBe('db.a.find()');
  });
});
