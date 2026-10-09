import { ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { toCanonicalEjson } from './ejson';

describe('toCanonicalEjson', () => {
  it('writes an ObjectId, a date and a number in canonical extended JSON', () => {
    const id = new ObjectId('64b7f0c2a1b2c3d4e5f60718');
    const millis = Date.parse('2026-10-09T10:00:00.000Z');
    const value = { _id: id, ts: new Date(millis), n: 3 };
    expect(toCanonicalEjson(value)).toEqual({
      _id: { $oid: '64b7f0c2a1b2c3d4e5f60718' },
      ts: { $date: { $numberLong: String(millis) } },
      n: { $numberInt: '3' },
    });
  });

  it('leaves strings and booleans as they are', () => {
    expect(toCanonicalEjson({ find: 'orders', lean: true })).toEqual({
      find: 'orders',
      lean: true,
    });
  });

  it('returns undefined for undefined', () => {
    expect(toCanonicalEjson(undefined)).toBeUndefined();
  });
});
