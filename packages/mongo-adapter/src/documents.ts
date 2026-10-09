export type PlainObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readField(source: unknown, key: string): unknown {
  return isPlainObject(source) ? source[key] : undefined;
}

export function hasKey(source: unknown, key: string): boolean {
  return readField(source, key) !== undefined;
}

export function readRecord(source: unknown, key: string): PlainObject | undefined {
  const value = readField(source, key);
  return isPlainObject(value) ? value : undefined;
}

export function readString(source: unknown, key: string): string | undefined {
  const value = readField(source, key);
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(source: unknown, key: string): number | undefined {
  const value = readField(source, key);
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(source: unknown, key: string): boolean | undefined {
  const value = readField(source, key);
  return typeof value === 'boolean' ? value : undefined;
}

export function readDate(source: unknown, key: string): Date | undefined {
  const value = readField(source, key);
  return value instanceof Date ? value : undefined;
}

export function readArray(source: unknown, key: string): unknown[] {
  const value = readField(source, key);
  return Array.isArray(value) ? value : [];
}

export function readStringArray(source: unknown, key: string): string[] {
  return readArray(source, key).filter((item): item is string => typeof item === 'string');
}

export function definedEntry<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
