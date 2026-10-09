import type { z } from 'zod';
import type { AppErrorCodeSchema, AppErrorSchema } from '../schemas/errors';

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
  if (value instanceof AppErrorException) {
    return value.error;
  }
  if (value instanceof Error) {
    return { code: 'INTERNAL', message: value.message };
  }
  return { code: 'INTERNAL', message: String(value) };
}
