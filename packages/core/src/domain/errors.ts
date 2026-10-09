import type { z } from 'zod';
import { AppErrorSchema, type AppErrorCodeSchema } from '../schemas/errors';

export type AppErrorCode = z.infer<typeof AppErrorCodeSchema>;
export type AppError = z.infer<typeof AppErrorSchema>;

export class AppErrorException extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(error.message);
    this.name = 'AppErrorException';
    this.error = error;
  }
}

export function appError(code: AppErrorCode, message: string, detail?: string): AppError {
  return detail === undefined ? { code, message } : { code, message, detail };
}

export function toAppError(value: unknown): AppError {
  try {
    return convert(value);
  } catch {
    return { code: 'INTERNAL', message: 'unrepresentable error' };
  }
}

function convert(value: unknown): AppError {
  if (value instanceof AppErrorException) {
    return value.error;
  }
  const parsed = AppErrorSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  if (value instanceof Error) {
    const error: AppError = { code: 'INTERNAL', message: value.message };
    if (value.cause === undefined) {
      return error;
    }
    const cause = value.cause instanceof Error ? value.cause.message : safeString(value.cause);
    return { ...error, cause };
  }
  return { code: 'INTERNAL', message: safeString(value) };
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return 'unrepresentable error';
  }
}
