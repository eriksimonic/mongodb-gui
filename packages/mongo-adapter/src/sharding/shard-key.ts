import { BSON } from 'mongodb';
import { parseEjsonDocument } from '../management/ejson';
import { validationError } from '../management/errors';

export type ShardKeyValue = 1 | -1 | 'hashed';
export type ShardKey = Record<string, ShardKeyValue>;

// Parses an Extended JSON shard key such as {"customerId": "hashed"}. Only ranged ascending
// (1), ranged descending (-1) and hashed keys are supported.
export function parseShardKey(keyEjson: string): ShardKey {
  const document = parseEjsonDocument(keyEjson, 'Shard key');
  const fields = Object.entries(document);
  if (fields.length === 0) {
    throw validationError('The shard key needs at least one field');
  }
  const key: ShardKey = {};
  for (const [field, value] of fields) {
    if (field === '' || field.startsWith('$')) {
      throw validationError(`The shard key field name ${JSON.stringify(field)} is not allowed`);
    }
    const parsed = shardKeyValue(value);
    if (parsed === undefined) {
      throw validationError(`The shard key value for ${field} must be 1, -1 or "hashed"`);
    }
    key[field] = parsed;
  }
  if (Object.values(key).filter((value) => value === 'hashed').length > 1) {
    throw validationError('The shard key can contain at most one hashed field.');
  }
  return key;
}

function shardKeyValue(value: unknown): ShardKeyValue | undefined {
  if (value === 'hashed') {
    return 'hashed';
  }
  const numeric = numericValue(value);
  if (numeric === 1) {
    return 1;
  }
  if (numeric === -1) {
    return -1;
  }
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof BSON.Int32 || value instanceof BSON.Double) {
    return value.valueOf();
  }
  if (value instanceof BSON.Long) {
    return value.toNumber();
  }
  return undefined;
}
