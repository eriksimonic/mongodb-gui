import { formatJson, parseJsonObject } from './input-rules';

/** $jsonSchema bsonType names for the BSON types the schema report names. */
const JSON_SCHEMA_TYPES: Readonly<Record<string, string>> = {
  String: 'string',
  Int32: 'int',
  Long: 'long',
  Double: 'double',
  Decimal128: 'decimal',
  Boolean: 'bool',
  Date: 'date',
  ObjectId: 'objectId',
  Object: 'object',
  Array: 'array',
  Null: 'null',
  Binary: 'binData',
  Timestamp: 'timestamp',
  Regex: 'regex',
  MinKey: 'minKey',
  MaxKey: 'maxKey',
};

export type AddFieldResult =
  | { readonly ok: true; readonly validatorEjson: string }
  | { readonly ok: false; readonly message: string };

interface Segment {
  readonly name: string;
  /** True when the path reads through an array, so the value is an array of this shape. */
  readonly array: boolean;
}

type JsonRecord = Record<string, unknown>;

function segmentsOf(path: string): Segment[] {
  return path
    .split('.')
    .map((part) =>
      part.endsWith('[]') ? { name: part.slice(0, -2), array: true } : { name: part, array: false },
    );
}

/** The bsonType value for a field's types. One type is a string, several are a list. */
function bsonTypeOf(types: readonly string[]): string | string[] | undefined {
  const names = [...new Set(types.map((type) => JSON_SCHEMA_TYPES[type]))]
    .filter((name): name is string => name !== undefined)
    .sort();
  if (names.length === 0) {
    return undefined;
  }
  return names.length === 1 ? names[0] : names;
}

/** Schema of the value of the segment at `index`, with the rule for the field inside it. */
function propertySchema(segments: readonly Segment[], index: number, leaf: JsonRecord): JsonRecord {
  const segment = segments[index];
  const last = index === segments.length - 1;
  const inner = last ? leaf : objectSchema(segments, index + 1, leaf);
  if (segment?.array === true) {
    return { bsonType: 'array', items: inner };
  }
  return inner;
}

/** An object schema that names the segment at `index` as one of its properties. */
function objectSchema(segments: readonly Segment[], index: number, leaf: JsonRecord): JsonRecord {
  const segment = segments[index];
  return {
    bsonType: 'object',
    properties: { [segment?.name ?? '']: propertySchema(segments, index, leaf) },
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Adds the rule for one field to a validator's $jsonSchema. Nested paths get nested objects, and
 * "[]" in a path reads as an array of that shape. A rule the validator already has stays as it is,
 * so the user's own rules are never overwritten.
 */
export function addFieldToValidator(
  validatorEjson: string,
  path: string,
  types: readonly string[],
): AddFieldResult {
  const parsed = parseJsonObject(validatorEjson);
  if (!parsed.ok) {
    return {
      ok: false,
      message: 'The validator is not valid JSON, so the field was not added.',
    };
  }
  const leafType = bsonTypeOf(types);
  if (leafType === undefined) {
    return { ok: false, message: 'This field has no type a validator can name.' };
  }
  const validator: JsonRecord = { ...parsed.value };
  const existing: unknown = validator.$jsonSchema;
  if (existing !== undefined && !isRecord(existing)) {
    return { ok: false, message: 'The validator has no $jsonSchema object to add to.' };
  }
  const jsonSchema: JsonRecord = isRecord(existing) ? { ...existing } : { bsonType: 'object' };
  const snippet = objectSchema(segmentsOf(path), 0, { bsonType: leafType });
  mergeRules(jsonSchema, snippet);
  validator.$jsonSchema = jsonSchema;
  return { ok: true, validatorEjson: formatJson(validator) };
}

function mergeRules(target: JsonRecord, source: JsonRecord): void {
  for (const [key, value] of Object.entries(source)) {
    const current: unknown = target[key];
    if (current === undefined) {
      target[key] = value;
    } else if (isRecord(current) && isRecord(value)) {
      const merged: JsonRecord = { ...current };
      mergeRules(merged, value);
      target[key] = merged;
    }
  }
}
