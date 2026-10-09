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

function redactAppError(error: AppError, secrets: readonly string[]): AppError {
  const redact = (text: string): string =>
    secrets.reduce((value, secret) => redactPassword(value, secret), redactPassword(text));
  const redacted: AppError = { code: error.code, message: redact(error.message) };
  if (error.detail !== undefined) {
    redacted.detail = redact(error.detail);
  }
  if (error.cause !== undefined) {
    redacted.cause = redact(error.cause);
  }
  return redacted;
}
