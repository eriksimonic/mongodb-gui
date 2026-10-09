import {
  SCHEMA_DISTINCT_CAP,
  SCHEMA_EXAMPLE_LIMIT,
  SCHEMA_EXAMPLE_MAX_CHARS,
  type ArrayLengths,
  type DateRange,
  type NumberRange,
  type SchemaField,
} from './types';

export interface SchemaSummary {
  readonly fields: SchemaField[];
  readonly sampled: number;
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const ID_NAME = /(^|_)(id|_id)$|Id$/;
const ID_MIN_UNIQUE_RATIO = 0.95;

// Canonical EJSON wrapper keys and the BSON type each one names.
const WRAPPER_TYPES: Readonly<Record<string, string>> = {
  $oid: 'ObjectId',
  $date: 'Date',
  $numberInt: 'Int32',
  $numberLong: 'Long',
  $numberDouble: 'Double',
  $numberDecimal: 'Decimal128',
  $binary: 'Binary',
  $regularExpression: 'Regex',
  $timestamp: 'Timestamp',
  $minKey: 'MinKey',
  $maxKey: 'MaxKey',
  $undefined: 'undefined',
  $symbol: 'Symbol',
};

// Types whose canonical value holds a number the sample can rank.
const NUMERIC_TYPES: ReadonlySet<string> = new Set(['Int32', 'Long', 'Double', 'Decimal128']);

interface PathStats {
  documents: number;
  typeCounts: Map<string, number>;
  scalarOccurrences: number;
  distinct: Set<string>;
  examples: string[];
  arrayCount: number;
  arrayMin: number;
  arrayMax: number;
  arraySum: number;
  numericMin: number | undefined;
  numericMax: number | undefined;
  dateMin: number | undefined;
  dateMax: number | undefined;
  lengthMin: number | undefined;
  lengthMax: number | undefined;
}

/**
 * Reports, for every dot path, the BSON types seen there, the fraction of documents that contain
 * the path, and value statistics. The input is canonical EJSON, the form the router and the mock
 * both hold, so one walker serves the runtime and the browser mock. Array elements appear under
 * "path[]", and objects inside arrays use the array path as prefix.
 */
export function summarizeCanonicalSample(documents: readonly unknown[]): SchemaSummary {
  const stats = new Map<string, PathStats>();
  for (const document of documents) {
    if (!isPlainObject(document)) {
      continue;
    }
    const pathsInDocument = new Set<string>();
    walkFields(document, '', stats, pathsInDocument);
    for (const path of pathsInDocument) {
      statsFor(stats, path).documents += 1;
    }
  }
  const sampled = documents.length;
  const fields = [...stats.keys()].sort().map((path) => toField(path, stats.get(path), sampled));
  return { fields, sampled };
}

/** The BSON type name of one canonical EJSON value. */
export function canonicalTypeName(value: unknown): string {
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
    case 'object':
      return objectTypeName(value);
    default:
      return 'Other';
  }
}

function objectTypeName(value: object): string {
  if (Array.isArray(value)) {
    return 'Array';
  }
  if (!isPlainObject(value)) {
    return 'Other';
  }
  for (const key of Object.keys(value)) {
    const wrapper = WRAPPER_TYPES[key];
    if (wrapper !== undefined) {
      return wrapper;
    }
  }
  return 'Object';
}

function statsFor(stats: Map<string, PathStats>, path: string): PathStats {
  const existing = stats.get(path);
  if (existing !== undefined) {
    return existing;
  }
  const created: PathStats = {
    documents: 0,
    typeCounts: new Map(),
    scalarOccurrences: 0,
    distinct: new Set(),
    examples: [],
    arrayCount: 0,
    arrayMin: Number.POSITIVE_INFINITY,
    arrayMax: 0,
    arraySum: 0,
    numericMin: undefined,
    numericMax: undefined,
    dateMin: undefined,
    dateMax: undefined,
    lengthMin: undefined,
    lengthMax: undefined,
  };
  stats.set(path, created);
  return created;
}

function walkFields(
  object: Record<string, unknown>,
  prefix: string,
  stats: Map<string, PathStats>,
  pathsInDocument: Set<string>,
): void {
  for (const [key, child] of Object.entries(object)) {
    walkValue(child, prefix === '' ? key : `${prefix}.${key}`, stats, pathsInDocument);
  }
}

function walkValue(
  value: unknown,
  path: string,
  stats: Map<string, PathStats>,
  pathsInDocument: Set<string>,
): void {
  const typeName = canonicalTypeName(value);
  const entry = statsFor(stats, path);
  entry.typeCounts.set(typeName, (entry.typeCounts.get(typeName) ?? 0) + 1);
  pathsInDocument.add(path);
  if (typeName === 'Array' && Array.isArray(value)) {
    recordArray(entry, value.length);
    for (const element of value) {
      walkValue(element, `${path}[]`, stats, pathsInDocument);
    }
    return;
  }
  if (typeName === 'Object' && isPlainObject(value)) {
    walkFields(value, path, stats, pathsInDocument);
    return;
  }
  recordScalar(entry, value, typeName);
}

function recordArray(entry: PathStats, length: number): void {
  entry.arrayCount += 1;
  entry.arrayMin = Math.min(entry.arrayMin, length);
  entry.arrayMax = Math.max(entry.arrayMax, length);
  entry.arraySum += length;
}

function recordScalar(entry: PathStats, value: unknown, typeName: string): void {
  entry.scalarOccurrences += 1;
  const canonical = JSON.stringify(value) ?? 'null';
  if (entry.distinct.size <= SCHEMA_DISTINCT_CAP) {
    entry.distinct.add(canonical);
  }
  if (entry.examples.length < SCHEMA_EXAMPLE_LIMIT && !entry.examples.includes(canonical)) {
    entry.examples.push(truncate(canonical));
  }
  if (NUMERIC_TYPES.has(typeName)) {
    const number = numericValue(value, typeName);
    if (number !== undefined) {
      entry.numericMin = minOf(entry.numericMin, number);
      entry.numericMax = maxOf(entry.numericMax, number);
    }
  }
  if (typeName === 'Date') {
    const time = dateValue(value);
    if (time !== undefined) {
      entry.dateMin = minOf(entry.dateMin, time);
      entry.dateMax = maxOf(entry.dateMax, time);
    }
  }
  if (typeName === 'String' && typeof value === 'string') {
    const length = Array.from(value).length;
    entry.lengthMin = minOf(entry.lengthMin, length);
    entry.lengthMax = maxOf(entry.lengthMax, length);
  }
}

function toField(path: string, entry: PathStats | undefined, sampled: number): SchemaField {
  if (entry === undefined) {
    return { path, types: [], presence: 0 };
  }
  const types = [...entry.typeCounts.keys()].sort();
  const field: SchemaField = {
    path,
    types,
    presence: sampled === 0 ? 0 : entry.documents / sampled,
    typeCounts: Object.fromEntries([...entry.typeCounts.entries()].sort(byKey)),
    examples: entry.examples,
  };
  const arrayLengths = toArrayLengths(entry);
  if (arrayLengths !== undefined) {
    field.arrayLengths = arrayLengths;
  }
  const numeric = toNumberRange(entry.numericMin, entry.numericMax);
  if (numeric !== undefined) {
    field.numeric = numeric;
  }
  const dateRange = toDateRange(entry.dateMin, entry.dateMax);
  if (dateRange !== undefined) {
    field.dateRange = dateRange;
  }
  const lengths = toNumberRange(entry.lengthMin, entry.lengthMax);
  if (lengths !== undefined) {
    field.stringLengths = lengths;
  }
  if (entry.scalarOccurrences > 0) {
    const distinct = Math.min(entry.distinct.size, SCHEMA_DISTINCT_CAP);
    const uniqueRatio = Math.min(1, distinct / entry.scalarOccurrences);
    field.uniqueRatio = uniqueRatio;
    field.isIdLike = isIdLike(path, uniqueRatio);
  }
  return field;
}

function toArrayLengths(entry: PathStats): ArrayLengths | undefined {
  if (entry.arrayCount === 0) {
    return undefined;
  }
  return {
    min: entry.arrayMin,
    max: entry.arrayMax,
    avg: Math.round((entry.arraySum / entry.arrayCount) * 100) / 100,
  };
}

function toNumberRange(min: number | undefined, max: number | undefined): NumberRange | undefined {
  return min === undefined || max === undefined ? undefined : { min, max };
}

function toDateRange(min: number | undefined, max: number | undefined): DateRange | undefined {
  if (min === undefined || max === undefined) {
    return undefined;
  }
  return { min: new Date(min).toISOString(), max: new Date(max).toISOString() };
}

function isIdLike(path: string, uniqueRatio: number): boolean {
  const last = path.split('.').pop() ?? '';
  const name = last.endsWith('[]') ? last.slice(0, -2) : last;
  return ID_NAME.test(name) && uniqueRatio >= ID_MIN_UNIQUE_RATIO;
}

/** Cuts text to the example length, ending with an ellipsis when it is longer. */
export function truncate(text: string): string {
  if (text.length <= SCHEMA_EXAMPLE_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, SCHEMA_EXAMPLE_MAX_CHARS - 1)}…`;
}

function numericValue(value: unknown, typeName: string): number | undefined {
  let number: number | undefined;
  if (typeName === 'Int32' || typeName === 'Double') {
    const text = readWrapper(value, '$numberInt') ?? readWrapper(value, '$numberDouble');
    number = text === undefined ? (typeof value === 'number' ? value : undefined) : Number(text);
  } else {
    const text = readWrapper(value, '$numberLong') ?? readWrapper(value, '$numberDecimal');
    number = text === undefined ? undefined : Number(text);
  }
  return number !== undefined && Number.isFinite(number) ? number : undefined;
}

function dateValue(value: unknown): number | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const inner: unknown = value.$date;
  if (typeof inner === 'string') {
    const time = Date.parse(inner);
    return Number.isNaN(time) ? undefined : time;
  }
  const millis = readWrapper(inner, '$numberLong');
  if (millis !== undefined) {
    const time = Number(millis);
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

function readWrapper(value: unknown, key: string): string | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const inner: unknown = value[key];
  return typeof inner === 'string' ? inner : undefined;
}

function minOf(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.min(current, next);
}

function maxOf(current: number | undefined, next: number): number {
  return current === undefined ? next : Math.max(current, next);
}

function byKey(left: [string, number], right: [string, number]): number {
  return left[0].localeCompare(right[0]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
