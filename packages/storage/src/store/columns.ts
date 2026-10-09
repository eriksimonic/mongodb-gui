import { AppErrorException, appError } from '@mongo-gui/core';

type Row = Readonly<Record<string, unknown>>;

/** Reads a TEXT column from a result row. Throws INTERNAL when the column has another type. */
export function textColumn(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') {
    throw new AppErrorException(appError('INTERNAL', `Column ${name} is not text.`));
  }
  return value;
}

/** Reads a BLOB column from a result row. Throws INTERNAL when the column has another type. */
export function blobColumn(row: Row, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) {
    throw new AppErrorException(appError('INTERNAL', `Column ${name} is not a blob.`));
  }
  return value;
}
