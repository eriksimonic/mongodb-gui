import { CollectionNameSchema, DatabaseNameSchema } from '@mongo-gui/core';

export type JsonObjectParse =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

const BYTE_UNITS = ['bytes', 'KB', 'MB', 'GB'] as const;
const BYTES_PER_UNIT = 1024;

/** The first message from a failed name check. An empty name gets a plain prompt. */
export function databaseNameError(value: string): string | undefined {
  if (value.length === 0) {
    return 'Enter a database name';
  }
  const result = DatabaseNameSchema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

export function collectionNameError(value: string): string | undefined {
  if (value.length === 0) {
    return 'Enter a collection name';
  }
  const result = CollectionNameSchema.safeParse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

/**
 * Parses text that must be a JSON object. The server parses EJSON and has the final say. This
 * check catches syntax errors before a round trip, and the parser message says where the text breaks.
 */
export function parseJsonObject(text: string): JsonObjectParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, message: `Not valid JSON: ${reason}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'The value must be a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Formats a value the way the editors show it: two-space indent and a trailing newline. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}
