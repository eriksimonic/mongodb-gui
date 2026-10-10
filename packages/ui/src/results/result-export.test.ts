import { describe, expect, it } from 'vitest';
import { exportText } from './result-export';
import type { JsonObject } from './result-model';

const documents: JsonObject[] = [
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a4b' },
    total: { $numberLong: '9007199254740993' },
    customer: { name: 'Ada, "AB"', city: 'Ljubljana' },
  },
  {
    _id: { $oid: '65a1b2c3d4e5f60718293a4c' },
    tags: ['a', 'b'],
    customer: { name: 'Bo' },
  },
];

describe('exportText', () => {
  it('writes the documents as a canonical EJSON array that keeps every Long digit', () => {
    const json = exportText(documents, 'json');
    expect(JSON.parse(json)).toEqual(documents);
    expect(json).toContain('"$numberLong": "9007199254740993"');
  });

  it('writes one CSV column per flattened path, in first-seen order', () => {
    const lines = exportText(documents, 'csv').trim().split('\n');
    expect(lines[0]).toBe('_id,total,customer.name,customer.city,tags');
  });

  it('writes a row per document with empty cells for missing paths', () => {
    const lines = exportText(documents, 'csv').trim().split('\n');
    expect(lines[1]).toBe('65a1b2c3d4e5f60718293a4b,9007199254740993,"Ada, ""AB""",Ljubljana,');
    expect(lines[2]).toBe('65a1b2c3d4e5f60718293a4c,,Bo,,"[""a"",""b""]"');
  });
});
