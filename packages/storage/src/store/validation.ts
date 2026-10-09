import { AppErrorException, appError } from '@mongo-gui/core';

/** The part of a zod schema that the storage layer uses. Core schemas satisfy it. */
export interface PayloadSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

/** Validates caller input. Failures throw VALIDATION and never echo the input. */
export function parseInput<T>(schema: PayloadSchema<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppErrorException(appError('VALIDATION', `The ${what} is invalid.`));
  }
  return result.data;
}

/** Validates a value read back from the store. Failures throw INTERNAL. */
export function parseStored<T>(schema: PayloadSchema<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppErrorException(
      appError('INTERNAL', `The stored ${what} does not match its schema.`),
    );
  }
  return result.data;
}
