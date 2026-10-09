import type { FieldType } from './types';

// The concrete types a value can be coerced to. 'auto' is resolved from a sample first.
export type ConcreteFieldType = Exclude<FieldType, 'auto'>;

// A coerced value, tagged with its BSON type. Core never imports bson, so the adapter turns
// each tag into the matching driver class (Int32, Long, Double, Decimal128, ObjectId, Date).
// Long and decimal values stay as text because a JavaScript number cannot hold them exactly.
export type TypedValue =
  | { readonly t: 'null' }
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'int'; readonly v: number }
  | { readonly t: 'long'; readonly v: string }
  | { readonly t: 'double'; readonly v: number }
  | { readonly t: 'decimal'; readonly v: string }
  | { readonly t: 'boolean'; readonly v: boolean }
  | { readonly t: 'date'; readonly v: number }
  | { readonly t: 'objectId'; readonly v: string }
  | { readonly t: 'json'; readonly v: string };

// Thrown when a value cannot be coerced to the requested type. The importer turns it into a row
// error. It is never replaced by a string, so a bad value cannot change a column's type silently.
export class CoercionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoercionError';
  }
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const MAX_DISPLAYED_VALUE = 60;

const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/;
const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/;
const DECIMAL128_PATTERN = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const BOOLEAN_PATTERN = /^(true|false)$/i;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const ISO_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

type Candidate = 'int' | 'long' | 'double' | 'boolean' | 'date' | 'objectId' | 'json';

// Order is the preference order: the first candidate that every value fits wins.
const CANDIDATES: readonly Candidate[] = [
  'int',
  'long',
  'double',
  'boolean',
  'date',
  'objectId',
  'json',
];

// Chooses a column type from the non-null sample values. A column whose values fit no candidate
// is a string, and so is a column that mixes numbers with text. Values with a leading zero
// ("01234") are strings, so zip codes and similar codes survive.
export function inferType(values: readonly (string | null)[]): ConcreteFieldType {
  const alive: Record<Candidate, boolean> = {
    int: true,
    long: true,
    double: true,
    boolean: true,
    date: true,
    objectId: true,
    json: true,
  };
  let sawValue = false;
  for (const value of values) {
    if (value === null) {
      continue;
    }
    sawValue = true;
    const fits = fitsCandidates(value);
    let anyAlive = false;
    for (const candidate of CANDIDATES) {
      alive[candidate] = alive[candidate] && fits[candidate];
      anyAlive = anyAlive || alive[candidate];
    }
    if (!anyAlive) {
      return 'string';
    }
  }
  if (!sawValue) {
    return 'string';
  }
  return CANDIDATES.find((candidate) => alive[candidate]) ?? 'string';
}

function fitsCandidates(value: string): Record<Candidate, boolean> {
  return {
    int: fitsInt(value),
    long: fitsLong(value),
    double: fitsDouble(value),
    boolean: BOOLEAN_PATTERN.test(value),
    date: parseIsoDate(value) !== undefined,
    objectId: OBJECT_ID_PATTERN.test(value),
    json: looksLikeJson(value),
  };
}

// Converts one raw cell to a tagged value. A null cell gives {t:'null'}. The type 'null' gives
// {t:'null'} for any cell. Any other failure throws CoercionError.
export function coerce(value: string | null, type: ConcreteFieldType): TypedValue {
  if (value === null || type === 'null') {
    return { t: 'null' };
  }
  switch (type) {
    case 'string':
      return { t: 'string', v: value };
    case 'int':
      if (!fitsInt(value)) {
        throw invalid(value, 'a 32-bit integer');
      }
      // Adding zero turns -0 into 0, which is the only int32 zero.
      return { t: 'int', v: Number(value) + 0 };
    case 'long':
      if (!fitsLong(value)) {
        throw invalid(value, 'a 64-bit integer');
      }
      return { t: 'long', v: BigInt(value).toString() };
    case 'double': {
      if (!fitsDouble(value)) {
        throw invalid(value, 'a number that is exact as a double');
      }
      return { t: 'double', v: Number(value) };
    }
    case 'decimal':
      if (!DECIMAL128_PATTERN.test(value)) {
        throw invalid(value, 'a decimal number');
      }
      return { t: 'decimal', v: value };
    case 'boolean': {
      if (!BOOLEAN_PATTERN.test(value)) {
        throw invalid(value, 'true or false');
      }
      return { t: 'boolean', v: value.toLowerCase() === 'true' };
    }
    case 'date': {
      const ms = parseIsoDate(value);
      if (ms === undefined) {
        throw invalid(value, 'an ISO 8601 date with at most millisecond precision');
      }
      return { t: 'date', v: ms };
    }
    case 'objectId':
      if (!OBJECT_ID_PATTERN.test(value)) {
        throw invalid(value, 'a 24-character hexadecimal ObjectId');
      }
      return { t: 'objectId', v: value };
    case 'json':
      if (!looksLikeJson(value)) {
        throw invalid(value, 'a JSON object or array');
      }
      return { t: 'json', v: value };
  }
}

function fitsInt(value: string): boolean {
  if (!INTEGER_PATTERN.test(value)) {
    return false;
  }
  const number = Number(value);
  return number >= INT32_MIN && number <= INT32_MAX;
}

function fitsLong(value: string): boolean {
  if (!INTEGER_PATTERN.test(value)) {
    return false;
  }
  const number = BigInt(value);
  return number >= INT64_MIN && number <= INT64_MAX;
}

// A double must represent the text exactly: integers beyond 2^53 are refused, so they become
// long values or strings instead of being rounded.
function fitsDouble(value: string): boolean {
  if (!DECIMAL_PATTERN.test(value)) {
    return false;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return false;
  }
  return INTEGER_PATTERN.test(value) ? Number.isSafeInteger(number) : true;
}

function looksLikeJson(value: string): boolean {
  const text = value.trim();
  const opensObject = text.startsWith('{') && text.endsWith('}');
  const opensArray = text.startsWith('[') && text.endsWith(']');
  if (!opensObject && !opensArray) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Parses an ISO 8601 date or date-time to epoch milliseconds. A date-time with no offset is
// read as UTC, never as the local time of the machine. Fractions finer than a millisecond are
// refused rather than truncated.
export function parseIsoDate(value: string): number | undefined {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const fraction = match[7] ?? '';
  const zone = match[8];
  if (fraction.length > 3 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const millis = Number(fraction.padEnd(3, '0'));
  const base = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(base);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) {
    return undefined;
  }
  const offset = zoneOffsetMinutes(zone);
  if (offset === undefined) {
    return undefined;
  }
  return base - offset * 60_000;
}

function zoneOffsetMinutes(zone: string | undefined): number | undefined {
  if (zone === undefined || zone.toUpperCase() === 'Z') {
    return 0;
  }
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2, 4));
  if (hours > 23 || minutes > 59) {
    return undefined;
  }
  const total = hours * 60 + minutes;
  return zone.startsWith('-') ? -total : total;
}

export function displayValue(value: string): string {
  return value.length > MAX_DISPLAYED_VALUE ? `${value.slice(0, MAX_DISPLAYED_VALUE)}...` : value;
}

function invalid(value: string, expected: string): CoercionError {
  return new CoercionError(`"${displayValue(value)}" is not ${expected}`);
}
