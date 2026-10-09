import { z } from 'zod';

// Result type names observed from the mongosh runtime. Unknown names fold into "other".
export const ShellResultTypeSchema = z.enum([
  'Document',
  'Cursor',
  'CursorIterationResult',
  'AggregationCursor',
  'Collection',
  'InsertOneResult',
  'InsertManyResult',
  'UpdateResult',
  'DeleteResult',
  'BulkWriteResult',
  'ShowDatabasesResult',
  'ShowCollectionsResult',
  'Help',
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'Error',
  'other',
]);

export type ShellResultType = z.infer<typeof ShellResultTypeSchema>;

// Maps a mongosh result type name to ShellResultType. A null name means the runtime returned a
// plain JavaScript value, so the value's own kind decides the type.
export function toShellResultType(
  typeName: string | null | undefined,
  value: unknown,
): ShellResultType {
  if (typeName === null || typeName === undefined) {
    return fromValue(value);
  }
  const known = ShellResultTypeSchema.safeParse(typeName);
  return known.success ? known.data : 'other';
}

function fromValue(value: unknown): ShellResultType {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (value instanceof Error) {
    return 'Error';
  }
  if (typeof value === 'object') {
    return 'Document';
  }
  return 'other';
}
