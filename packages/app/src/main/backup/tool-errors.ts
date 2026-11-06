import { appError, AppErrorException, type AppError } from '@mongo-gui/core';
import { mapDriverError, redactPassword } from '@mongo-gui/mongo-adapter';
import { redactText } from '../redact';

/**
 * An AppError for any failure, with every secret masked. A driver failure is mapped as the other
 * calls map it; any other failure is INTERNAL.
 */
export function toAppError(failure: unknown, secrets: readonly string[], driver = false): AppError {
  const error =
    failure instanceof AppErrorException
      ? failure.error
      : driver
        ? mapDriverError(failure)
        : appError('INTERNAL', failure instanceof Error ? failure.message : String(failure));
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  const mask = (text: string): string =>
    sorted.reduce(
      (value, secret) => redactPassword(value, secret),
      redactPassword(redactText(text)),
    );
  const { detail, cause, ...rest } = error;
  return {
    ...rest,
    message: mask(rest.message),
    ...(detail === undefined ? {} : { detail: mask(detail) }),
    ...(cause === undefined ? {} : { cause: mask(cause) }),
  };
}

/** Runs a driver call during a start check or a job. Rethrows its error mapped and masked. */
export async function masked<T>(secrets: readonly string[], action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (failure) {
    throw new AppErrorException(toAppError(failure, secrets, true));
  }
}
