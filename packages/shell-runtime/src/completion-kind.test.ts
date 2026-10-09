import { describe, expect, it } from 'vitest';
import { classifyCompletion, databaseMemberName } from './completion-kind';

const COLLECTIONS: ReadonlySet<string> = new Set(['items', 'orders']);

describe('classifyCompletion', () => {
  it('marks $-operators as operators', () => {
    expect(classifyCompletion('db.items.aggregate([{$match', COLLECTIONS)).toBe('operator');
    expect(classifyCompletion('db.items.find({ $elemMatch', COLLECTIONS)).toBe('operator');
  });

  it('marks db.<collection> as a collection only when the collection exists', () => {
    expect(classifyCompletion('db.items', COLLECTIONS)).toBe('collection');
    expect(classifyCompletion('db.unknownThing', COLLECTIONS)).toBe('other');
  });

  it('marks shell and JavaScript keywords as keywords', () => {
    expect(classifyCompletion('show', COLLECTIONS)).toBe('keyword');
    expect(classifyCompletion('const', COLLECTIONS)).toBe('keyword');
  });

  it('falls back to other for methods and everything else', () => {
    expect(classifyCompletion('db.items.find', COLLECTIONS)).toBe('other');
    expect(classifyCompletion('SharedArrayBuffer', COLLECTIONS)).toBe('other');
  });
});

describe('databaseMemberName', () => {
  it('returns the name for db.<name> and nothing for deeper paths', () => {
    expect(databaseMemberName('db.items')).toBe('items');
    expect(databaseMemberName('db.items.find')).toBeUndefined();
    expect(databaseMemberName('show')).toBeUndefined();
  });
});
