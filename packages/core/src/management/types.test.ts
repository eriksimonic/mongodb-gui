import { describe, expect, it } from 'vitest';
import {
  CollectionNameSchema,
  CreateCollectionInputSchema,
  CreateIndexInputSchema,
  DeleteByFilterInputSchema,
  DropDatabaseInputSchema,
  RenameCollectionInputSchema,
  SetValidationInputSchema,
  UpdateDocumentFieldsInputSchema,
} from './types';

describe('collection name rules', () => {
  it.each(['orders', 'a', 'with space', 'x'.repeat(255)])('accepts %s', (name) => {
    expect(CollectionNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['dollar sign', 'a$b'],
    ['system prefix', 'system.views'],
    ['null byte', 'a\u0000b'],
    ['too long', 'x'.repeat(256)],
    ['too long in multibyte bytes', 'é'.repeat(128)],
  ])('rejects %s', (_label, name) => {
    expect(CollectionNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('database names', () => {
  it('rejects names with reserved characters', () => {
    expect(DropDatabaseInputSchema.safeParse({ database: 'a.b' }).success).toBe(false);
    expect(DropDatabaseInputSchema.safeParse({ database: 'a b' }).success).toBe(false);
    expect(DropDatabaseInputSchema.safeParse({ database: 'a/b' }).success).toBe(false);
  });

  it('accepts a plain name', () => {
    expect(DropDatabaseInputSchema.safeParse({ database: 'shop' }).success).toBe(true);
  });
});

describe('CreateCollectionInputSchema', () => {
  const base = { database: 'shop', name: 'orders' };

  it('accepts capped and validator options', () => {
    const result = CreateCollectionInputSchema.safeParse({
      ...base,
      capped: { sizeBytes: 65536, maxDocuments: 100 },
      validator: { $jsonSchema: { bsonType: 'object' } },
      validationLevel: 'moderate',
      validationAction: 'warn',
    });
    expect(result.success).toBe(true);
  });

  it('rejects capped combined with timeseries', () => {
    const result = CreateCollectionInputSchema.safeParse({
      ...base,
      capped: { sizeBytes: 4096 },
      timeseries: { timeField: 't' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive capped size', () => {
    expect(
      CreateCollectionInputSchema.safeParse({ ...base, capped: { sizeBytes: 0 } }).success,
    ).toBe(false);
  });

  it('rejects an unknown granularity', () => {
    const result = CreateCollectionInputSchema.safeParse({
      ...base,
      timeseries: { timeField: 't', granularity: 'days' },
    });
    expect(result.success).toBe(false);
  });
});

describe('RenameCollectionInputSchema', () => {
  it('rejects renaming to the same name', () => {
    const result = RenameCollectionInputSchema.safeParse({
      database: 'shop',
      name: 'orders',
      newName: 'orders',
    });
    expect(result.success).toBe(false);
  });

  it('accepts dropTarget', () => {
    const result = RenameCollectionInputSchema.safeParse({
      database: 'shop',
      name: 'orders',
      newName: 'archive',
      dropTarget: true,
    });
    expect(result.success).toBe(true);
  });
});

describe('CreateIndexInputSchema', () => {
  const base = { database: 'shop', collection: 'orders', options: {} };

  it('accepts every key kind', () => {
    const result = CreateIndexInputSchema.safeParse({
      ...base,
      keys: { a: 1, b: -1, c: 'text', d: '2dsphere', e: 'hashed', f: '2d' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty key set', () => {
    expect(CreateIndexInputSchema.safeParse({ ...base, keys: {} }).success).toBe(false);
  });

  it('rejects an unsupported key direction', () => {
    expect(CreateIndexInputSchema.safeParse({ ...base, keys: { a: 2 } }).success).toBe(false);
  });

  it('rejects a non-positive weight', () => {
    const result = CreateIndexInputSchema.safeParse({
      ...base,
      keys: { body: 'text' },
      options: { weights: { body: 0 } },
    });
    expect(result.success).toBe(false);
  });
});

describe('SetValidationInputSchema', () => {
  it('rejects an unknown validation level', () => {
    const result = SetValidationInputSchema.safeParse({
      database: 'shop',
      collection: 'orders',
      rules: { validator: {}, validationLevel: 'loose', validationAction: 'error' },
    });
    expect(result.success).toBe(false);
  });
});

describe('document inputs', () => {
  it('requires set or unset for a field update', () => {
    const result = UpdateDocumentFieldsInputSchema.safeParse({
      database: 'shop',
      collection: 'orders',
      idEjson: '{"$oid":"64b000000000000000000001"}',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an unset-only update', () => {
    const result = UpdateDocumentFieldsInputSchema.safeParse({
      database: 'shop',
      collection: 'orders',
      idEjson: '1',
      unsetPaths: ['note'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative expected count', () => {
    const result = DeleteByFilterInputSchema.safeParse({
      database: 'shop',
      collection: 'orders',
      filterEjson: '{}',
      expectedCount: -1,
    });
    expect(result.success).toBe(false);
  });
});
