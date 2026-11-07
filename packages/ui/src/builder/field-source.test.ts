import { describe, expect, it, vi } from 'vitest';
import type { RpcClient, SchemaField } from '@mongo-gui/core';
import type { CompletionSource } from '../editor/completion-source';
import { JSON_SCHEMA_TYPES } from '../management/validation-field';
import { getFields } from './field-source';

const connectionId = '6f1c2b3a-0000-4000-8000-000000000001';

function sampled(path: string, types: string[]): SchemaField {
  return { path, types, presence: 1 };
}

function sourceWith(fields: SchemaField[]): Pick<CompletionSource, 'fieldsOf'> {
  return { fieldsOf: vi.fn(async () => fields) };
}

function rpcWithValidator(jsonSchema: unknown): RpcClient {
  const validatorEjson = JSON.stringify({ $jsonSchema: jsonSchema });
  return {
    management: {
      getValidation: vi.fn(async () => ({
        validatorEjson,
        validationLevel: 'strict',
        validationAction: 'error',
      })),
    },
  } as unknown as RpcClient;
}

function rpcFailing(): RpcClient {
  return {
    management: { getValidation: vi.fn(async () => Promise.reject(new Error('no privilege'))) },
  } as unknown as RpcClient;
}

describe('validator type names', () => {
  // The BSON names the schema sample writes, each with the $jsonSchema name a validator uses.
  it.each([
    ['String', 'string'],
    ['Int32', 'int'],
    ['Long', 'long'],
    ['Double', 'double'],
    ['Decimal128', 'decimal'],
    ['Boolean', 'bool'],
    ['Date', 'date'],
    ['ObjectId', 'objectId'],
    ['Array', 'array'],
    ['Object', 'object'],
    ['Null', 'null'],
  ])('maps the $jsonSchema bsonType "%s" to the sample name "%s"', async (bson, jsonSchema) => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: { f: { bsonType: jsonSchema } },
    });

    const fields = await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

    expect(typesAt(fields, 'f')).toEqual([bson]);
  });

  it('inverts every entry of JSON_SCHEMA_TYPES', async () => {
    for (const [bson, jsonSchema] of Object.entries(JSON_SCHEMA_TYPES)) {
      const rpc = rpcWithValidator({
        bsonType: 'object',
        properties: { f: { bsonType: jsonSchema } },
      });

      const fields = await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

      expect(typesAt(fields, 'f'), bson).toEqual([bson]);
    }
  });

  it('leaves out a bsonType that has no BSON name', async () => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: { f: { bsonType: 'number' } },
    });

    const fields = await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

    expect(typesAt(fields, 'f')).toBeUndefined();
  });
});

function typesAt(fields: readonly { path: string; types: readonly string[] }[], path: string) {
  return fields.find((field) => field.path === path)?.types;
}

describe('getFields', () => {
  it('adds nested paths from the validator with their types', async () => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: {
        a: { bsonType: 'object', properties: { b: { bsonType: 'int' } } },
      },
    });

    const fields = await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

    expect(typesAt(fields, 'a')).toEqual(['Object']);
    expect(typesAt(fields, 'a.b')).toEqual(['Int32']);
  });

  it('names array elements of objects under items with the [] suffix', async () => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: {
        items: {
          bsonType: 'array',
          items: { bsonType: 'object', properties: { sku: { bsonType: 'string' } } },
        },
      },
    });

    const fields = await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

    expect(typesAt(fields, 'items')).toEqual(['Array']);
    expect(typesAt(fields, 'items[]')).toEqual(['Object']);
    expect(typesAt(fields, 'items[].sku')).toEqual(['String']);
  });

  it('names scalar array elements with the [] suffix', async () => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: { tags: { bsonType: 'array', items: { bsonType: 'string' } } },
    });

    const fields = await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

    expect(typesAt(fields, 'tags')).toEqual(['Array']);
    expect(typesAt(fields, 'tags[]')).toEqual(['String']);
  });

  it('replaces a sampled type with the validator type at the same path', async () => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: { qty: { bsonType: 'int' } },
    });

    const fields = await getFields(
      sourceWith([sampled('qty', ['Double', 'String'])]),
      rpc,
      connectionId,
      'shop',
      'orders',
    );

    expect(typesAt(fields, 'qty')).toEqual(['Int32']);
  });

  it('keeps sampled fields and adds validator-only fields', async () => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: { email: { bsonType: 'string' } },
    });

    const fields = await getFields(
      sourceWith([sampled('name', ['String'])]),
      rpc,
      connectionId,
      'shop',
      'users',
    );

    expect(typesAt(fields, 'name')).toEqual(['String']);
    expect(typesAt(fields, 'email')).toEqual(['String']);
  });

  it('maps every type in a bsonType list and sorts them', async () => {
    const rpc = rpcWithValidator({
      bsonType: 'object',
      properties: { code: { bsonType: ['string', 'null'] } },
    });

    const fields = await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

    expect(typesAt(fields, 'code')).toEqual(['Null', 'String']);
  });

  it('reads the validator with the connection, database and collection', async () => {
    const rpc = rpcWithValidator({ bsonType: 'object', properties: {} });

    await getFields(sourceWith([]), rpc, connectionId, 'shop', 'orders');

    expect(rpc.management.getValidation).toHaveBeenCalledWith({
      connectionId,
      database: 'shop',
      collection: 'orders',
    });
  });

  it('returns the sampled fields when the validator call fails', async () => {
    const fields = await getFields(
      sourceWith([sampled('name', ['String'])]),
      rpcFailing(),
      connectionId,
      'shop',
      'users',
    );

    expect(fields).toEqual([{ path: 'name', types: ['String'] }]);
  });

  it('returns the sampled fields when the validator is not valid JSON', async () => {
    const rpc = {
      management: {
        getValidation: vi.fn(async () => ({
          validatorEjson: '{ not json',
          validationLevel: 'strict',
          validationAction: 'error',
        })),
      },
    } as unknown as RpcClient;

    const fields = await getFields(
      sourceWith([sampled('name', ['String'])]),
      rpc,
      connectionId,
      'shop',
      'users',
    );

    expect(fields).toEqual([{ path: 'name', types: ['String'] }]);
  });

  it('returns the sampled fields when the collection has no $jsonSchema', async () => {
    const rpc = {
      management: {
        getValidation: vi.fn(async () => ({
          validatorEjson: '{}',
          validationLevel: 'strict',
          validationAction: 'error',
        })),
      },
    } as unknown as RpcClient;

    const fields = await getFields(
      sourceWith([sampled('name', ['String'])]),
      rpc,
      connectionId,
      'shop',
      'users',
    );

    expect(fields).toEqual([{ path: 'name', types: ['String'] }]);
  });
});
