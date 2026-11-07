import type { FieldInfo, RpcClient } from '@mongo-gui/core';
import type { CompletionSource } from '../editor/completion-source';
import { parseJsonObject } from '../kit/input-rules';
import { JSON_SCHEMA_TYPES } from '../management/validation-field';

/** $jsonSchema bsonType name to the BSON type name the schema sample writes. Inverts JSON_SCHEMA_TYPES. */
const BSON_TYPE_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(JSON_SCHEMA_TYPES).map(([bson, jsonSchema]): [string, string] => [
    jsonSchema,
    bson,
  ]),
);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** BSON type names of a bsonType value, which is one name or a list. Names not mapped are left out. */
function bsonNamesOf(bsonType: unknown): string[] {
  const names = Array.isArray(bsonType) ? bsonType : [bsonType];
  const mapped = names.flatMap((name) => {
    const bson = typeof name === 'string' ? BSON_TYPE_NAMES.get(name) : undefined;
    return bson === undefined ? [] : [bson];
  });
  return [...new Set(mapped)].sort();
}

/** Adds the types of a $jsonSchema node, its properties and its items, keyed by dot path. */
function validatorTypes(schema: JsonRecord, path: string, out: Map<string, string[]>): void {
  const names = bsonNamesOf(schema.bsonType);
  if (path !== '' && names.length > 0) {
    out.set(path, names);
  }
  if (isRecord(schema.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (isRecord(child)) {
        validatorTypes(child, path === '' ? key : `${path}.${key}`, out);
      }
    }
  }
  if (isRecord(schema.items)) {
    validatorTypes(schema.items, `${path}[]`, out);
  }
}

/** The $jsonSchema of the validator, or undefined when the call fails or there is none. */
async function validatorOf(
  rpc: RpcClient,
  connectionId: string,
  database: string,
  collection: string,
): Promise<JsonRecord | undefined> {
  try {
    const rules = await rpc.management.getValidation({ connectionId, database, collection });
    const parsed = parseJsonObject(rules.validatorEjson);
    if (!parsed.ok || !isRecord(parsed.value.$jsonSchema)) {
      return undefined;
    }
    return parsed.value.$jsonSchema;
  } catch {
    return undefined;
  }
}

/** The query path of a sample path. The sample names array elements with `[]`, a query does not. */
function queryPath(samplePath: string): string {
  return samplePath.replaceAll('[]', '');
}

/**
 * Sampled fields with the validator types merged in. A validator type replaces a sampled type at
 * the same sample path. Then the sample paths become query paths, and the types of paths that
 * become equal are merged, so `tags[]` and `tags` give one `tags` with both types.
 */
function mergeFields(
  sampled: readonly FieldInfo[],
  validator: ReadonlyMap<string, string[]>,
): FieldInfo[] {
  const bySamplePath = new Map<string, readonly string[]>();
  for (const field of sampled) {
    bySamplePath.set(field.path, field.types);
  }
  for (const [path, types] of validator) {
    bySamplePath.set(path, types);
  }
  const byQueryPath = new Map<string, Set<string>>();
  for (const [samplePath, types] of bySamplePath) {
    const path = queryPath(samplePath);
    const set = byQueryPath.get(path) ?? new Set<string>();
    for (const type of types) {
      set.add(type);
    }
    byQueryPath.set(path, set);
  }
  return [...byQueryPath].map(([path, types]) => ({ path, types: [...types].sort() }));
}

/**
 * The fields of a collection for the builder, with query paths such as `items.sku` and `tags`.
 * The sampled fields come from the editor cache of `source`, and the types of the collection's
 * $jsonSchema validator are merged in. `database` must be the database `source` samples.
 */
export async function getFields(
  source: Pick<CompletionSource, 'fieldsOf'>,
  rpc: RpcClient,
  connectionId: string,
  database: string,
  collection: string,
): Promise<FieldInfo[]> {
  const [sampled, jsonSchema] = await Promise.all([
    source.fieldsOf(collection),
    validatorOf(rpc, connectionId, database, collection),
  ]);
  const validator = new Map<string, string[]>();
  if (jsonSchema !== undefined) {
    validatorTypes(jsonSchema, '', validator);
  }
  return mergeFields(sampled, validator);
}
