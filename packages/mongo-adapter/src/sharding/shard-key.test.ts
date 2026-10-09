import { describe, expect, it } from 'vitest';
import { AppErrorException, type AppError } from '@mongo-gui/core';
import { parseShardKey } from './shard-key';

function captureError(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      return error.error;
    }
    throw error;
  }
  throw new Error('expected the parser to throw');
}

describe('parseShardKey', () => {
  it('accepts hashed, ascending and descending fields', () => {
    expect(parseShardKey('{"customerId":"hashed"}')).toEqual({ customerId: 'hashed' });
    expect(parseShardKey('{"region":1,"createdAt":-1}')).toEqual({ region: 1, createdAt: -1 });
  });

  it('accepts numbers written with BSON number wrappers', () => {
    expect(parseShardKey('{"a":{"$numberInt":"1"},"b":{"$numberLong":"-1"}}')).toEqual({
      a: 1,
      b: -1,
    });
  });

  it.each([
    ['an empty document', '{}'],
    ['a text value', '{"name":"text"}'],
    ['a zero direction', '{"name":0}'],
    ['a two direction', '{"name":2}'],
    ['a 2dsphere value', '{"loc":"2dsphere"}'],
    ['a field name with a dollar sign', '{"$name":1}'],
  ])('refuses %s with VALIDATION', (_label, keyEjson) => {
    expect(captureError(() => parseShardKey(keyEjson)).code).toBe('VALIDATION');
  });

  it('refuses text that is not Extended JSON', () => {
    expect(captureError(() => parseShardKey('{"a":')).code).toBe('VALIDATION');
  });
});
