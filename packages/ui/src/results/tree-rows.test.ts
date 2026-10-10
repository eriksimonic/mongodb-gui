import { describe, expect, it } from 'vitest';
import { copyTextOf } from './tree-rows';

describe('copyTextOf', () => {
  it('copies an ObjectId in its mongosh form, in full', () => {
    expect(copyTextOf({ $oid: '65a1b2c3d4e5f60718293a4b' })).toBe(
      'ObjectId("65a1b2c3d4e5f60718293a4b")',
    );
  });

  it('copies a Long in its mongosh form with every digit', () => {
    expect(copyTextOf({ $numberLong: '9007199254740993' })).toBe('Long("9007199254740993")');
  });

  it('copies a document or an array as JSON', () => {
    expect(copyTextOf({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(copyTextOf([1, 2])).toBe('[\n  1,\n  2\n]');
  });

  it('copies a plain string as it is', () => {
    expect(copyTextOf('paid')).toBe('paid');
  });
});
