import { describe, expect, it } from 'vitest';
import { addFieldToValidator } from './validation-field';

function rules(validatorEjson: string): unknown {
  const result = addFieldToValidator(validatorEjson, 'status', ['String']);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return JSON.parse(result.validatorEjson);
}

describe('addFieldToValidator', () => {
  it('creates a $jsonSchema with the field when the validator is empty', () => {
    expect(rules('{}')).toEqual({
      $jsonSchema: {
        bsonType: 'object',
        properties: { status: { bsonType: 'string' } },
      },
    });
  });

  it('adds a top-level field next to the existing properties', () => {
    const validator = JSON.stringify({
      $jsonSchema: {
        bsonType: 'object',
        required: ['status'],
        properties: { status: { bsonType: 'string' } },
      },
    });
    const result = addFieldToValidator(validator, 'qty', ['Int32']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.parse(result.validatorEjson)).toEqual({
        $jsonSchema: {
          bsonType: 'object',
          required: ['status'],
          properties: { status: { bsonType: 'string' }, qty: { bsonType: 'int' } },
        },
      });
    }
  });

  it('nests dotted paths as objects', () => {
    const result = addFieldToValidator('{}', 'customer.address.city', ['String']);
    expect(result.ok && JSON.parse(result.validatorEjson)).toEqual({
      $jsonSchema: {
        bsonType: 'object',
        properties: {
          customer: {
            bsonType: 'object',
            properties: {
              address: {
                bsonType: 'object',
                properties: { city: { bsonType: 'string' } },
              },
            },
          },
        },
      },
    });
  });

  it('reads array markers as arrays of the element shape', () => {
    const result = addFieldToValidator('{}', 'items[].sku', ['String']);
    expect(result.ok && JSON.parse(result.validatorEjson)).toEqual({
      $jsonSchema: {
        bsonType: 'object',
        properties: {
          items: {
            bsonType: 'array',
            items: { bsonType: 'object', properties: { sku: { bsonType: 'string' } } },
          },
        },
      },
    });
  });

  it('lists every type of a mixed field', () => {
    const result = addFieldToValidator('{}', 'amount', ['Double', 'Int32', 'Null']);
    expect(result.ok && JSON.parse(result.validatorEjson)).toMatchObject({
      $jsonSchema: { properties: { amount: { bsonType: ['double', 'int', 'null'] } } },
    });
  });

  it('keeps a rule the validator already has for the field', () => {
    const validator = JSON.stringify({
      $jsonSchema: { bsonType: 'object', properties: { qty: { bsonType: 'long' } } },
    });
    const result = addFieldToValidator(validator, 'qty', ['Int32']);
    expect(result.ok && JSON.parse(result.validatorEjson)).toEqual({
      $jsonSchema: { bsonType: 'object', properties: { qty: { bsonType: 'long' } } },
    });
  });

  it('keeps other validator keys such as $or', () => {
    const result = addFieldToValidator('{"$or":[{"a":1}]}', 'b', ['Boolean']);
    expect(result.ok && JSON.parse(result.validatorEjson)).toMatchObject({
      $or: [{ a: 1 }],
      $jsonSchema: { properties: { b: { bsonType: 'bool' } } },
    });
  });

  it('refuses a validator that is not valid JSON', () => {
    expect(addFieldToValidator('{"$jsonSchema": ', 'a', ['String'])).toEqual({
      ok: false,
      message: 'The validator is not valid JSON, so the field was not added.',
    });
  });

  it('refuses a field whose types a validator cannot name', () => {
    expect(addFieldToValidator('{}', 'a', ['Other'])).toEqual({
      ok: false,
      message: 'This field has no type a validator can name.',
    });
  });
});
