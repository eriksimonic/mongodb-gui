import { describe, expect, it } from 'vitest';
import {
  collectionNameError,
  databaseNameError,
  formatBytes,
  formatJson,
  parseJsonObject,
} from './input-rules';
import { cellText, columnsOf, duplicateText, toDocumentRow, topLevelKeys } from './document-rows';

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

describe('document rows', () => {
  const text = '{"_id":{"$oid":"64b7f0f0e4b0a1b2c3d4e5f6"},"sku":"A-1","qty":{"$numberInt":"2"}}';

  it('keeps the _id as EJSON and flattens the other top-level fields', () => {
    const row = toDocumentRow(text);
    expect(row?.idEjson).toBe('{"$oid":"64b7f0f0e4b0a1b2c3d4e5f6"}');
    expect(row?.fields).toEqual({ sku: 'A-1', qty: '{"$numberInt":"2"}' });
  });

  it('returns nothing for a document without an _id or text that is not an object', () => {
    expect(toDocumentRow('{"sku":"A-1"}')).toBeUndefined();
    expect(toDocumentRow('not json')).toBeUndefined();
  });

  it('removes the _id when a document is duplicated', () => {
    const row = toDocumentRow(text);
    expect(row).toBeDefined();
    if (row !== undefined) {
      expect(duplicateText(row)).not.toContain('_id');
      expect(duplicateText(row)).toContain('"sku": "A-1"');
    }
  });

  it('cuts long cell text and lists columns in first-seen order', () => {
    expect(cellText('x'.repeat(100))).toHaveLength(80);
    const rows = [toDocumentRow('{"_id":1,"a":1,"b":2}'), toDocumentRow('{"_id":2,"c":3,"a":4}')];
    const present = rows.filter((row) => row !== undefined);
    expect(columnsOf(present)).toEqual(['a', 'b', 'c']);
    expect(topLevelKeys(['{"_id":1,"z":1}', '{"_id":2,"a":1}'])).toEqual(['a', 'z']);
  });
});
