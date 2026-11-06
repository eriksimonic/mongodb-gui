import {
  newId,
  type CopyItem,
  type CopyOptions,
  type CopyProgress,
  type RpcEvent,
} from '@mongo-gui/core';
import { fail } from '../api/mock-support';

const FRAME_DELAY_MS = 250;
const FRAMES_PER_ITEM = 3;
const DOCUMENTS_PER_FRAME = 250;

export interface MockCopyContext {
  readonly emit: (event: RpcEvent) => void;
  /** True when the connection is marked production. */
  readonly isProduction: (connectionId: string) => boolean;
}

export interface MockCopy {
  /** Refuses a production target without the typed database name. Otherwise starts the job. */
  start(input: CopyOptions): string;
  cancel(jobId: string): void;
}

type Frame = Omit<CopyProgress, 'elapsedMs'>;

interface MockJob {
  readonly frames: readonly Frame[];
  /** Index of the next frame to send. */
  next: number;
  latest: Frame;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly startedAt: number;
}

/** The frames of one job: preparing, three copying frames per item, then finished. */
function framesFor(items: readonly CopyItem[]): Frame[] {
  const collectionsTotal = items.length;
  const totalDocuments = collectionsTotal * FRAMES_PER_ITEM * DOCUMENTS_PER_FRAME;
  const base = { failedDocuments: 0, skippedDocuments: 0, cancelled: false };
  const frames: Frame[] = [
    {
      ...base,
      phase: 'preparing',
      documents: 0,
      totalDocuments,
      collectionsDone: 0,
      collectionsTotal,
      lines: [`Preparing ${collectionsTotal} collections`],
      done: false,
    },
  ];
  items.forEach((item, index) => {
    const before = index * FRAMES_PER_ITEM * DOCUMENTS_PER_FRAME;
    // Step 0 names the item before any of its documents are written, as the service does.
    for (let step = 0; step <= FRAMES_PER_ITEM; step += 1) {
      frames.push({
        ...base,
        phase: 'copying',
        documents: before + step * DOCUMENTS_PER_FRAME,
        totalDocuments,
        collectionsDone: step === FRAMES_PER_ITEM ? index + 1 : index,
        collectionsTotal,
        current: item.target,
        lines: step === 0 ? [`Copying ${item.source} to ${item.target}`] : [],
        done: false,
      });
    }
  });
  frames.push({
    ...base,
    phase: 'finished',
    documents: totalDocuments,
    totalDocuments,
    collectionsDone: collectionsTotal,
    collectionsTotal,
    lines: ['Finished'],
    done: true,
  });
  return frames;
}

/**
 * The copy calls for the mock backend. A job sends its scripted frames on a timer, like the real
 * service sends progress. Cancel stops the timer and sends a final frame with cancelled set.
 */
export function createMockCopy(context: MockCopyContext): MockCopy {
  const { emit, isProduction } = context;
  const jobs = new Map<string, MockJob>();

  function send(jobId: string, job: MockJob, frame: Frame): void {
    job.latest = frame;
    emit({
      type: 'copy:progress',
      jobId,
      progress: { ...frame, elapsedMs: Math.max(0, Date.now() - job.startedAt) },
    });
  }

  function step(jobId: string, job: MockJob): void {
    job.timer = undefined;
    const frame = job.frames[job.next];
    if (frame === undefined) {
      jobs.delete(jobId);
      return;
    }
    job.next += 1;
    send(jobId, job, frame);
    if (frame.done) {
      jobs.delete(jobId);
      return;
    }
    job.timer = setTimeout(() => step(jobId, job), FRAME_DELAY_MS);
  }

  return {
    start(input) {
      if (isProduction(input.targetConnectionId) && input.confirmation !== input.targetDatabase) {
        throw fail(
          'VALIDATION',
          `Type the target database name, ${input.targetDatabase}, to confirm the copy`,
        );
      }
      const jobId = newId();
      const frames = framesFor(input.items);
      const first = frames[0];
      if (first === undefined) {
        throw fail('INTERNAL', 'The copy script is empty');
      }
      const job: MockJob = {
        frames,
        next: 0,
        latest: first,
        timer: undefined,
        startedAt: Date.now(),
      };
      jobs.set(jobId, job);
      job.timer = setTimeout(() => step(jobId, job), FRAME_DELAY_MS);
      return jobId;
    },

    cancel(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return;
      }
      if (job.timer !== undefined) {
        clearTimeout(job.timer);
        job.timer = undefined;
      }
      jobs.delete(jobId);
      send(jobId, job, {
        ...job.latest,
        phase: 'finished',
        cancelled: true,
        done: true,
        lines: ['Cancelled'],
      });
    },
  };
}
