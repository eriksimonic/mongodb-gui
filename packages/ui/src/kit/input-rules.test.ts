import { describe, expect, it } from 'vitest';
import {
  collectionNameError,
  databaseNameError,
  formatBytes,
  formatJson,
  parseJsonObject,
} from './input-rules';
import { topLevelKeys } from '../management';

describe('name rules', () => {
  it('asks for a name when the field is empty', () => {
    expect(databaseNameError('')).toBe('Enter a database name');
    expect(collectionNameError('')).toBe('Enter a collection name');
  });

  it('reuses the core rules for database and collection names', () => {
    expect(databaseNameError('shop/one')).toBe(
      'Database names may not contain / \\ . space " or $',
    );
    expect(databaseNameError('shop')).toBeUndefined();
    expect(collectionNameError('system.views')).toBe('Collection names may not start with system.');
    expect(collectionNameError('orders')).toBeUndefined();
  });
});

describe('parseJsonObject', () => {
  it('accepts a JSON object and returns it', () => {
    expect(parseJsonObject('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reports the parser message for text that is not JSON', () => {
    const result = parseJsonObject('{"a": ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.startsWith('Not valid JSON: ')).toBe(true);
    }
  });

  it('refuses an array and a scalar', () => {
    expect(parseJsonObject('[]')).toEqual({
      ok: false,
      message: 'The value must be a JSON object',
    });
    expect(parseJsonObject('7')).toEqual({ ok: false, message: 'The value must be a JSON object' });
  });
});

describe('formatting', () => {
  it('pretty prints with two spaces and a trailing newline', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('scales byte counts to the largest unit below 1024', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(40_960)).toBe('40.0 KB');
    expect(formatBytes(2_097_152)).toBe('2.0 MB');
  });
});

describe('top level keys', () => {
  it('lists the field names of the documents, sorted, without _id', () => {
    expect(topLevelKeys(['{"_id":1,"z":1}', '{"_id":2,"a":1}'])).toEqual(['a', 'z']);
  });

  it('skips text that is not an object with an _id', () => {
    expect(topLevelKeys(['{"sku":"A-1"}', 'not json'])).toEqual([]);
  });
});
