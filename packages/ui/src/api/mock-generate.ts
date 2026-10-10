import { compileSpec, newId, type GenerateStartInput, type RpcEvent } from '@mongo-gui/core';

/** Batches the mock generates before it reports. The mock stores nothing, so only the progress is real. */
const MOCK_BATCH_SIZE = 10_000;
const MOCK_BATCH_DELAY_MS = 40;

export interface MockGenerate {
  start(input: GenerateStartInput): string;
  cancel(jobId: string): void;
}

interface MockJob {
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Ends the job with the progress it has. */
  finish: () => void;
}

/**
 * Runs generate-data jobs against the mock. Each batch goes through the core generators, so the
 * documents are the ones a real run would write, but the mock keeps no collection. The progress
 * events, the rate and the cancel behave as the router does.
 */
export function createMockGenerate(emit: (event: RpcEvent) => void): MockGenerate {
  const jobs = new Map<string, MockJob>();

  function start(input: GenerateStartInput): string {
    const jobId = newId();
    const factory = compileSpec(input.fields, { seed: input.seed });
    const job: MockJob = { cancelled: false, timer: undefined, finish: () => undefined };
    const startedAt = Date.now();
    let inserted = 0;

    const send = (done: boolean): void => {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      emit({
        type: 'generate:progress',
        connectionId: input.connectionId,
        jobId,
        progress: {
          total: input.count,
          inserted,
          failed: 0,
          elapsedMs,
          ratePerSecond: elapsedMs > 0 ? Math.round((inserted * 1000) / elapsedMs) : 0,
          done,
          cancelled: job.cancelled,
        },
      });
    };

    const finish = (): void => {
      jobs.delete(jobId);
      send(true);
      if (inserted > 0) {
        emit({
          type: 'catalog:changed',
          connectionId: input.connectionId,
          database: input.database,
          collection: input.collection,
        });
      }
    };

    const step = (): void => {
      job.timer = undefined;
      if (job.cancelled) {
        finish();
        return;
      }
      const size = Math.min(input.batchSize, MOCK_BATCH_SIZE, input.count - inserted);
      for (let index = 0; index < size; index += 1) {
        factory();
      }
      inserted += size;
      if (inserted >= input.count) {
        finish();
        return;
      }
      send(false);
      job.timer = setTimeout(step, MOCK_BATCH_DELAY_MS);
    };

    job.finish = finish;
    jobs.set(jobId, job);
    job.timer = setTimeout(step, 0);
    return jobId;
  }

  return {
    start,
    cancel(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return;
      }
      job.cancelled = true;
      if (job.timer !== undefined) {
        // Nothing is running between batches, so the job ends now.
        clearTimeout(job.timer);
        job.timer = undefined;
        job.finish();
      }
    },
  };
}
