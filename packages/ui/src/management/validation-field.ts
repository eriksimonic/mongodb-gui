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
  | {
      readonly ok: true;
      readonly validatorEjson: string;
      /** True when the validator already had a rule at this path. */
      readonly ruleExisted: boolean;
    }
  | { readonly ok: false; readonly message: string };

interface Segment {
  readonly name: string;
  /** Array levels after the name. "tags[][]" has two, so the value is an array of arrays. */
  readonly depth: number;
}

type JsonRecord = Record<string, unknown>;

function segmentsOf(path: string): Segment[] {
  return path.split('.').map((part) => {
    let name = part;
    let depth = 0;
    while (name.endsWith('[]')) {
      name = name.slice(0, -2);
      depth += 1;
    }
    return { name, depth };
  });
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
  let schema = last ? leaf : objectSchema(segments, index + 1, leaf);
  for (let level = 0; level < (segment?.depth ?? 0); level += 1) {
    schema = { bsonType: 'array', items: schema };
  }
  return schema;
}

/** True when the schema already has a rule at the path. Each array level is read through items. */
function hasRule(jsonSchema: JsonRecord, segments: readonly Segment[]): boolean {
  let scope: unknown = jsonSchema;
  for (const [index, segment] of segments.entries()) {
    const properties: unknown = isRecord(scope) ? scope.properties : undefined;
    if (!isRecord(properties)) {
      return false;
    }
    let child: unknown = properties[segment.name];
    for (let level = 0; level < segment.depth; level += 1) {
      child = isRecord(child) ? child.items : undefined;
    }
    if (index === segments.length - 1) {
      return child !== undefined;
    }
    scope = child;
  }
  return false;
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
  const segments = segmentsOf(path);
  const ruleExisted = hasRule(jsonSchema, segments);
  const snippet = objectSchema(segments, 0, { bsonType: leafType });
  mergeRules(jsonSchema, snippet);
  validator.$jsonSchema = jsonSchema;
  return { ok: true, validatorEjson: formatJson(validator), ruleExisted };
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
