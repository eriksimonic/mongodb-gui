import { MongoServerError } from 'mongodb';
import { AppErrorException, appError, type AppError } from '@mongo-gui/core';
import { mapDriverError } from '../errors';
import { redactPassword } from './redact';

const NOT_AUTHORIZED_CODE = 13;
const NOT_AUTHORIZED_MESSAGE = 'The connected user is not allowed to run this operation';

// Maps an error from a security command. The server detail stays, with every secret masked.
export function toSecurityException(
  error: unknown,
  secrets: readonly string[] = [],
): AppErrorException {
  const base = error instanceof AppErrorException ? error.error : mapCommandError(error);
  return new AppErrorException(redactAppError(base, secrets));
}

// Runs a security operation. Validation and driver errors both leave as AppErrorException.
export async function runSecurityCommand<T>(
  secrets: readonly string[],
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toSecurityException(error, secrets);
  }
}

function mapCommandError(error: unknown): AppError {
  const mapped = mapDriverError(error);
  if (error instanceof MongoServerError && error.code === NOT_AUTHORIZED_CODE) {
    return appError('COMMAND_FAILED', NOT_AUTHORIZED_MESSAGE, mapped.detail);
  }
  return mapped;
}

// The message is fixed text written by the adapter, so only the server detail and cause are
// searched for secrets.
function redactAppError(error: AppError, secrets: readonly string[]): AppError {
  const redact = (text: string): string =>
    secrets.reduce((value, secret) => redactPassword(value, secret), redactPassword(text));
  const redacted: AppError = { code: error.code, message: error.message };
  if (error.detail !== undefined) {
    redacted.detail = redact(error.detail);
  }
  if (error.cause !== undefined) {
    redacted.cause = redact(error.cause);
  }
  return redacted;
}

// Checks a record read from the server against its core schema. A reply the schema rejects is
// an adapter or server mismatch, reported as INTERNAL rather than as a connection failure.
export function parseServerRecord<T>(
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppErrorException(
      appError('INTERNAL', 'The server sent a ' + what + ' that the adapter cannot read'),
    );
  }
  return parsed.data;
}
