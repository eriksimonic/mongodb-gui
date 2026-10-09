import type { SchemaField } from '@mongo-gui/core';

export interface SchemaSummary {
  fields: SchemaField[];
  sampled: number;
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

// BSON wrapper classes expose their type as _bsontype. Matching on the name works across copies
// of the bson package, where instanceof would not.
const BSON_TYPE_NAMES: Readonly<Record<string, string>> = {
  ObjectId: 'ObjectId',
  ObjectID: 'ObjectId',
  Int32: 'Int32',
  Long: 'Long',
  Double: 'Double',
  Decimal128: 'Decimal128',
  Binary: 'Binary',
  BSONRegExp: 'Regex',
  Timestamp: 'Timestamp',
  MinKey: 'MinKey',
  MaxKey: 'MaxKey',
};

// Walks the sampled documents and reports, for every dot path, the BSON types seen there and the
// fraction of documents that contain the path. Array elements appear under "path[]".
export function summarizeDocuments(documents: readonly unknown[]): SchemaSummary {
  const typesByPath = new Map<string, Set<string>>();
  const documentsByPath = new Map<string, number>();
  for (const document of documents) {
    const pathsInDocument = new Set<string>();
    if (isPlainObject(document)) {
      walkFields(document, '', typesByPath, pathsInDocument);
    }
    for (const path of pathsInDocument) {
      documentsByPath.set(path, (documentsByPath.get(path) ?? 0) + 1);
    }
  }
  const fields = [...typesByPath.keys()].sort().map((path) => ({
    path,
    types: [...(typesByPath.get(path) ?? [])].sort(),
    presence: (documentsByPath.get(path) ?? 0) / documents.length,
  }));
  return { fields, sampled: documents.length };
}

export function bsonTypeName(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'Null';
  }
  switch (typeof value) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'Boolean';
    case 'number':
      return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
        ? 'Int32'
        : 'Double';
    case 'bigint':
      return 'Long';
    case 'object':
      return objectTypeName(value);
    default:
      return 'Other';
  }
}

function objectTypeName(value: object): string {
  if (value instanceof Date) {
    return 'Date';
  }
  if (Array.isArray(value)) {
    return 'Array';
  }
  if (value instanceof RegExp) {
    return 'Regex';
  }
  const tag: unknown = '_bsontype' in value ? value._bsontype : undefined;
  if (typeof tag === 'string') {
    return BSON_TYPE_NAMES[tag] ?? 'Other';
  }
  return isPlainObject(value) ? 'Object' : 'Other';
}

function walkFields(
  object: Record<string, unknown>,
  prefix: string,
  typesByPath: Map<string, Set<string>>,
  pathsInDocument: Set<string>,
): void {
  for (const [key, child] of Object.entries(object)) {
    walkValue(child, prefix === '' ? key : `${prefix}.${key}`, typesByPath, pathsInDocument);
  }
}

function walkValue(
  value: unknown,
  path: string,
  typesByPath: Map<string, Set<string>>,
  pathsInDocument: Set<string>,
): void {
  const typeName = bsonTypeName(value);
  const types = typesByPath.get(path) ?? new Set<string>();
  types.add(typeName);
  typesByPath.set(path, types);
  pathsInDocument.add(path);
  if (typeName === 'Object' && isPlainObject(value)) {
    walkFields(value, path, typesByPath, pathsInDocument);
  } else if (typeName === 'Array' && Array.isArray(value)) {
    for (const element of value) {
      walkValue(element, `${path}[]`, typesByPath, pathsInDocument);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
