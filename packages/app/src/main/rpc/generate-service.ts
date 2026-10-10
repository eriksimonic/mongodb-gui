import {
  compileSpec,
  newId,
  type AppError,
  type GenerateProgress,
  type GenerateStartInput,
  type GeneratedDocument,
  type RpcEvent,
} from '@mongo-gui/core';
import { mapDriverError } from '@mongo-gui/mongo-adapter';
import type { TransferClient } from './transfer-service';

/** Progress events per job, at most this often. The final event is never throttled. */
export const GENERATE_PROGRESS_INTERVAL_MS = 250;

export interface GenerateServiceOptions {
  /** Returns the live client, or throws NOT_CONNECTED when the connection has none. */
  readonly getClient: (connectionId: string) => TransferClient;
  readonly emit: (event: RpcEvent) => void;
  /** Turns the hex of an objectId field into the stored value. Defaults to the string. */
  readonly toObjectId?: (hex: string) => unknown;
  readonly progressIntervalMs?: number;
  readonly now?: () => number;
}

export interface GenerateService {
  /** Starts a job and returns its id. The job runs in the background and reports through events. */
  start(input: GenerateStartInput): string;
  /** Stops a job after the batch in progress. An unknown or finished job is ignored. */
  cancel(jobId: string): void;
  cancelConnection(connectionId: string): void;
  cancelAll(): void;
}

interface Job {
  readonly jobId: string;
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly total: number;
  cancelled: boolean;
}

/** The inserted count of a bulk write that stopped with some documents written, or undefined. */
function partialInsertCount(failure: unknown): number | undefined {
  if (
    failure instanceof Error &&
    failure.name === 'MongoBulkWriteError' &&
    'insertedCount' in failure &&
    typeof failure.insertedCount === 'number'
  ) {
    return failure.insertedCount;
  }
  return undefined;
}

/**
 * Generates documents in the main process and inserts them batch by batch. A batch is generated
 * just before it is written, so the full set never sits in memory. Unordered inserts keep going
 * past a rejected document, and the rejected documents are counted as failed.
 */
export function createGenerateService(options: GenerateServiceOptions): GenerateService {
  const jobs = new Map<string, Job>();
  const now = options.now ?? Date.now;
  const interval = options.progressIntervalMs ?? GENERATE_PROGRESS_INTERVAL_MS;
  const toObjectId = options.toObjectId ?? ((hex: string): unknown => hex);

  async function run(job: Job, input: GenerateStartInput, client: TransferClient): Promise<void> {
    const startedAt = now();
    let inserted = 0;
    let failed = 0;
    let lastSentAt = Number.NEGATIVE_INFINITY;
    let error: AppError | undefined;

    const snapshot = (done: boolean): GenerateProgress => {
      const elapsedMs = Math.max(0, now() - startedAt);
      return {
        total: job.total,
        inserted,
        failed,
        elapsedMs,
        ratePerSecond: elapsedMs > 0 ? Math.round((inserted * 1000) / elapsedMs) : 0,
        done,
        cancelled: job.cancelled,
        ...(error === undefined ? {} : { error }),
      };
    };
    const send = (done: boolean): void => {
      options.emit({
        type: 'generate:progress',
        connectionId: job.connectionId,
        jobId: job.jobId,
        progress: snapshot(done),
      });
    };

    try {
      const factory = compileSpec(input.fields, { seed: input.seed, toObjectId });
      const collection = client.db(job.database).collection<GeneratedDocument>(job.collection);
      while (inserted + failed < job.total && !job.cancelled) {
        const size = Math.min(input.batchSize, job.total - inserted - failed);
        const docs: GeneratedDocument[] = [];
        for (let index = 0; index < size; index += 1) {
          docs.push(factory());
        }
        try {
          const result = await collection.insertMany(docs, {
            ordered: false,
            writeConcern: { w: 1 },
          });
          inserted += result.insertedCount;
        } catch (failure) {
          const written = partialInsertCount(failure);
          if (written === undefined) {
            throw failure;
          }
          inserted += written;
          failed += size - written;
        }
        const at = now();
        if (at - lastSentAt >= interval) {
          lastSentAt = at;
          send(false);
        }
      }
    } catch (failure) {
      // The message of a driver error can carry document text, so only the mapped error is kept.
      error = mapDriverError(failure);
    }

    jobs.delete(job.jobId);
    send(true);
    if (inserted > 0) {
      options.emit({
        type: 'catalog:changed',
        connectionId: job.connectionId,
        database: job.database,
        collection: job.collection,
      });
    }
  }

  return {
    start(input) {
      // Throws NOT_CONNECTED before anything is registered, so a failed start leaves no job.
      const client = options.getClient(input.connectionId);
      const jobId = newId();
      const job: Job = {
        jobId,
        connectionId: input.connectionId,
        database: input.database,
        collection: input.collection,
        total: input.count,
        cancelled: false,
      };
      jobs.set(jobId, job);
      void run(job, input, client);
      return jobId;
    },
    cancel(jobId) {
      const job = jobs.get(jobId);
      if (job !== undefined) {
        job.cancelled = true;
      }
    },
    cancelConnection(connectionId) {
      for (const job of jobs.values()) {
        if (job.connectionId === connectionId) {
          job.cancelled = true;
        }
      }
    },
    cancelAll() {
      for (const job of jobs.values()) {
        job.cancelled = true;
      }
    },
  };
}
