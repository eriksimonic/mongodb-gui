import { BSON, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { AppErrorException, type AppError } from '@mongo-gui/core';
import { parseEjson, parseEjsonDocument, toCanonicalEjson } from './ejson';

function errorOf(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error;
    }
    throw error;
  }
  throw new Error('expected the parse to fail');
}

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

describe('parseEjson', () => {
  it('rejects a date that does not parse', () => {
    const error = errorOf(() => parseEjson('{"d":{"$date":"not-a-date"}}', 'The document'));
    expect(error.code).toBe('VALIDATION');
  });

  it('rejects an invalid date nested in an array', () => {
    const error = errorOf(() => parseEjson('[1, {"d": {"$date": "nope"}}]', 'The document'));
    expect(error.code).toBe('VALIDATION');
  });

  it('keeps valid dates', () => {
    const value = parseEjson('{"d":{"$date":"2020-01-01T00:00:00Z"}}', 'The document');
    expect(value).toEqual({ d: new Date('2020-01-01T00:00:00Z') });
  });

  it('reports only the position for malformed text, never the input', () => {
    const error = errorOf(() =>
      parseEjson('{"secret": "hunter2-secret", "broken": x}', 'The document'),
    );
    expect(error.code).toBe('VALIDATION');
    expect(JSON.stringify(error)).not.toContain('hunter2-secret');
  });
});

describe('parseEjsonDocument', () => {
  it('rejects a value that is not an object', () => {
    expect(errorOf(() => parseEjsonDocument('[1, 2]', 'The document')).code).toBe('VALIDATION');
  });
});

describe('parseEjsonDocument', () => {
  it('rejects text that carries a preview marker, at any depth', () => {
    const error = errorOf(() =>
      parseEjsonDocument('{"a":{"$mgTruncated":{"t":"array","n":3}}}', 'Document'),
    );
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toContain('shortened preview');
    const root = errorOf(() =>
      parseEjsonDocument('{"_id":1,"$mgTruncated":{"chars":9}}', 'Document'),
    );
    expect(root.code).toBe('VALIDATION');
  });

  it('parses a clean document', () => {
    expect(parseEjsonDocument('{"a":{"$numberInt":"3"}}', 'Document')).toEqual({
      a: new BSON.Int32(3),
    });
  });
});
