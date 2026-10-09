// Narrowing helpers for raw explain JSON. Explain output is canonical EJSON, so integers arrive
// as {"$numberInt": "5"}, {"$numberLong": "5"} or {"$numberDouble": "5.0"}. Plain JSON numbers
// are accepted too.

export type RawRecord = Record<string, unknown>;

const EJSON_NUMBER_KEYS = ['$numberInt', '$numberLong', '$numberDouble', '$numberDecimal'];

export function isRawRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): RawRecord | undefined {
  return isRawRecord(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const keys = Object.keys(record);
  const key = keys.length === 1 ? keys[0] : undefined;
  if (key === undefined || !EJSON_NUMBER_KEYS.includes(key)) {
    return undefined;
  }
  const text = asString(record[key]);
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readStringMap(value: unknown): Record<string, string[]> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(record)) {
    const items = asArray(entry);
    result[key] = items === undefined ? [] : items.map((item) => String(item));
  }
  return result;
}

// Field names of a sort or index pattern, in document order.
export function fieldNames(value: unknown): string[] {
  const record = asRecord(value);
  return record === undefined ? [] : Object.keys(record);
}

export type DefinedFields<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

// Copies the fields whose value is defined. Keeps optional fields absent instead of undefined.
export function definedFields<T extends object>(fields: T): DefinedFields<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // Object.entries loses the key-to-type link, so the typed result is asserted once here.
  return result as DefinedFields<T>;
}
