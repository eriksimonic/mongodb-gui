import { Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import {
  coerce,
  CoercionError,
  type ConcreteFieldType,
  type FieldType,
  type TypedValue,
} from '@mongo-gui/core';
import { isPlainObject, type PlainObject } from '../documents';
import { parseEjson } from '../management/ejson';

// Turns a coerced value into the BSON class the driver stores. JSON cells go through the
// canonical EJSON parser, so $oid, $date and $numberLong inside a cell keep their types.
export function toBsonValue(typed: TypedValue): unknown {
  switch (typed.t) {
    case 'null':
      return null;
    case 'string':
      return typed.v;
    case 'int':
      return new Int32(typed.v);
    case 'long':
      return Long.fromString(typed.v);
    case 'double':
      return new Double(typed.v);
    case 'decimal':
      return Decimal128.fromString(typed.v);
    case 'boolean':
      return typed.v;
    case 'date':
      return new Date(typed.v);
    case 'objectId':
      return new ObjectId(typed.v);
    case 'json':
      return parseEjson(typed.v, 'A JSON cell');
  }
}

// Converts one CSV cell to its typed BSON value. The cell is already trimmed if that option is on.
export function cellToBson(cell: string | null, type: ConcreteFieldType): unknown {
  return toBsonValue(coerce(cell, type));
}

// Converts a value that came from a JSON or NDJSON document to the requested type. Auto keeps
// the value as it was parsed. A string, number or boolean is converted through its text, so a
// JSON number mapped to a string becomes "5" and the same text can be read back.
export function jsonValueToBson(value: unknown, type: FieldType): unknown {
  if (type === 'auto' || value === null || value === undefined) {
    return value ?? null;
  }
  // A value that already has the requested BSON class is kept as it is. This is what an NDJSON
  // export read back with canonical EJSON gives, so a round trip keeps Long, Decimal128 and friends.
  if (matchesBsonClass(value, type)) {
    return value;
  }
  // Any object or array is a valid json value, including BSON classes such as Binary.
  if (type === 'json' && typeof value === 'object') {
    return value;
  }
  if (type === 'string' && typeof value === 'string') {
    return value;
  }
  if (type === 'date' && value instanceof Date) {
    return value;
  }
  if (type === 'objectId' && value instanceof ObjectId) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (type === 'null') {
      return null;
    }
    return toBsonValue(coerce(String(value), type));
  }
  throw new CoercionError(`A value of this kind cannot be converted to ${type}`);
}

function matchesBsonClass(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'int':
      return value instanceof Int32;
    case 'long':
      return value instanceof Long;
    case 'double':
      return value instanceof Double;
    case 'decimal':
      return value instanceof Decimal128;
    case 'date':
      return value instanceof Date;
    case 'objectId':
      return value instanceof ObjectId;
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return typeof value === 'object';
    default:
      return false;
  }
}

export function splitPath(path: string): string[] {
  return path.split('.');
}

// Reads a dotted path from a document. Returns undefined when any segment is missing.
export function getPath(source: unknown, segments: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of segments) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

// Writes a value at a dotted path, creating nested documents on the way. Writing through a
// value that is not a document is an error, so that no value is overwritten by accident.
export function setPath(target: PlainObject, segments: readonly string[], value: unknown): void {
  let current: PlainObject = target;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const next = current[segment];
    if (next === undefined) {
      const created: PlainObject = {};
      current[segment] = created;
      current = created;
    } else if (isPlainObject(next)) {
      current = next;
    } else {
      throw new CoercionError(`Field ${segments.slice(0, index + 1).join('.')} is already a value`);
    }
  }
}
