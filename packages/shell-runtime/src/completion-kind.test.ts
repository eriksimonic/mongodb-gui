import { describe, expect, it } from 'vitest';
import {
  classifyCompletion,
  collectionMemberItems,
  databaseMemberName,
  hasInvalidDatabaseMember,
  isDatabaseMemberLine,
} from './completion-kind';

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

describe('isDatabaseMemberLine', () => {
  it('is true for a line that ends in db. with an optional identifier prefix', () => {
    expect(isDatabaseMemberLine('db.')).toBe(true);
    expect(isDatabaseMemberLine('x = db.us')).toBe(true);
    expect(isDatabaseMemberLine('(db.')).toBe(true);
  });

  it('is false for deeper paths and for names that merely end in db', () => {
    expect(isDatabaseMemberLine('db.users.')).toBe(false);
    expect(isDatabaseMemberLine('db.users.fi')).toBe(false);
    expect(isDatabaseMemberLine('mydb.')).toBe(false);
  });
});

describe('collectionMemberItems', () => {
  it('returns whole-line collection texts after the line head', () => {
    expect(collectionMemberItems('x = db.', ['users'], new Set())).toEqual([
      { text: 'x = db.users', kind: 'collection' },
    ]);
  });

  it('uses db.getCollection for names that are not identifiers', () => {
    expect(collectionMemberItems('db.', ['my-logs'], new Set())).toEqual([
      { text: 'db.getCollection("my-logs")', kind: 'collection' },
    ]);
  });

  it('skips texts the runtime already returned', () => {
    expect(collectionMemberItems('db.', ['users', 'orders'], new Set(['db.users']))).toEqual([
      { text: 'db.orders', kind: 'collection' },
    ]);
  });

  it('returns nothing for a line that is not a db member', () => {
    expect(collectionMemberItems('db.users.', ['users'], new Set())).toEqual([]);
  });
});

describe('hasInvalidDatabaseMember', () => {
  it('is true when the trailing db member is not a property name', () => {
    expect(hasInvalidDatabaseMember('db.my-coll')).toBe(true);
    expect(hasInvalidDatabaseMember('x = db.2024')).toBe(true);
    expect(hasInvalidDatabaseMember('db.my coll')).toBe(true);
  });

  it('is false for identifiers, method paths and text without a db member', () => {
    expect(hasInvalidDatabaseMember('db.users')).toBe(false);
    expect(hasInvalidDatabaseMember('db.users.find')).toBe(false);
    expect(hasInvalidDatabaseMember('db.my-coll.find')).toBe(false);
    expect(hasInvalidDatabaseMember('mydb-x')).toBe(false);
    expect(hasInvalidDatabaseMember('show')).toBe(false);
  });
});
