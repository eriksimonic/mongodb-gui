import { describe, expect, it } from 'vitest';
import { AppErrorException, type AppError } from '@mongo-gui/core';
import { parseEjson, parseEjsonDocument } from './ejson';

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
