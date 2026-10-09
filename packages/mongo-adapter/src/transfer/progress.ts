import {
  AppErrorException,
  appError,
  CsvSyntaxError,
  MAX_REPORTED_ERRORS,
  type AppError,
  type TransferProgress,
  type TransferRowError,
} from '@mongo-gui/core';
import { MongoError } from 'mongodb';
import { mapDriverError } from '../errors';

// Byte counts for progress. Undefined means the count is not known.
export interface Sizes {
  readonly bytesRead?: number | undefined;
  readonly bytesTotal?: number | undefined;
}

export interface TransferHooks {
  readonly onProgress?: (progress: TransferProgress) => void;
  readonly signal?: AbortSignal;
}

// Raised inside a transfer loop when the caller aborts. Never escapes the transfer functions.
export class TransferCancelled extends Error {
  constructor() {
    super('Transfer cancelled');
    this.name = 'TransferCancelled';
  }
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new TransferCancelled();
  }
}

export function cancelledError(): AppError {
  return appError('CANCELLED', 'The transfer was cancelled');
}

// Maps any failure from a transfer to the error reported in the progress event.
export function toFailure(error: unknown): AppError {
  if (error instanceof TransferCancelled) {
    return cancelledError();
  }
  if (error instanceof AppErrorException) {
    return error.error;
  }
  if (error instanceof CsvSyntaxError) {
    return appError('VALIDATION', 'The file is not valid CSV', error.message);
  }
  if (error instanceof MongoError) {
    return mapDriverError(error);
  }
  if (isFileSystemError(error)) {
    return appError('VALIDATION', 'The file could not be read or written', error.code);
  }
  return appError(
    'INTERNAL',
    'The transfer failed',
    error instanceof Error ? error.message : undefined,
  );
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}

// Keeps the counters and the first MAX_REPORTED_ERRORS row errors, and builds progress events.
export class ProgressTracker {
  processed = 0;
  inserted = 0;
  updated = 0;
  failed = 0;
  private readonly rowErrors: TransferRowError[] = [];
  private readonly startedAt = Date.now();

  constructor(private readonly hooks: TransferHooks) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  addRowError(row: number, message: string): void {
    this.failed += 1;
    if (this.rowErrors.length < MAX_REPORTED_ERRORS) {
      this.rowErrors.push({ row, message });
    }
  }

  snapshot(extra: Sizes & { done: boolean; error?: AppError }): TransferProgress {
    return {
      processed: this.processed,
      inserted: this.inserted,
      updated: this.updated,
      failed: this.failed,
      ...(extra.bytesRead === undefined ? {} : { bytesRead: extra.bytesRead }),
      ...(extra.bytesTotal === undefined ? {} : { bytesTotal: extra.bytesTotal }),
      elapsedMs: this.elapsedMs,
      done: extra.done,
      ...(extra.error === undefined ? {} : { error: extra.error }),
      errors: [...this.rowErrors],
    };
  }

  emit(extra: Sizes): void {
    this.hooks.onProgress?.(this.snapshot({ ...extra, done: false }));
  }
}
