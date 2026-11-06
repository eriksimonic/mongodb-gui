import type { CopyItem, CopyOptions, CopyProgress, RpcClient } from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** The part of the RPC client the copy store uses. */
export type CopyClient = RpcClient['copy'];

/** Log lines kept per job. Older lines are dropped. */
export const MAX_COPY_LINES = 500;

/**
 * Where one item stands. `copying` is the collection the service writes now. `cancelled` and
 * `failed` mark the items that did not finish when the job ended.
 */
export type CopyItemStatus = 'queued' | 'copying' | 'done' | 'cancelled' | 'failed';

export interface CopyItemState {
  readonly source: string;
  readonly target: string;
  readonly status: CopyItemStatus;
  /** Documents written for this item. The service reports totals, so this is their difference. */
  readonly documents: number;
  /** Documents skipped for this item. Insert only counts the _id matches here. */
  readonly skipped: number;
}

/** The job totals when the service began writing one target collection. */
export interface CopyItemMark {
  readonly target: string;
  readonly documents: number;
  readonly skipped: number;
}

export interface CopyJob {
  readonly jobId: string;
  /** The items from the start call. Empty when a progress event arrives before that call returns. */
  readonly items: readonly CopyItem[];
  readonly itemStates: readonly CopyItemState[];
  /** One mark per target, in the order the service began them. */
  readonly marks: readonly CopyItemMark[];
  /** The latest progress event. */
  readonly progress: CopyProgress | undefined;
  /** The event that ended the job. Set once, when `done` is true. */
  readonly result: CopyProgress | undefined;
  /** Tool lines from every event so far, newest last. */
  readonly lines: readonly string[];
}

export interface CopyState {
  readonly jobs: Readonly<Record<string, CopyJob>>;
  /** Starts a copy and returns its job id. A refused start throws the server error. */
  start(input: CopyOptions): Promise<string>;
  /** Asks the server to stop a job. The final state arrives as a progress event. */
  cancel(jobId: string): Promise<void>;
  /** Folds one copy:progress event into its job. Called for every event, in order. */
  applyProgress(jobId: string, progress: CopyProgress): void;
}

export type CopyStore = StoreApi<CopyState>;

function emptyJob(jobId: string): CopyJob {
  return {
    jobId,
    items: [],
    itemStates: [],
    marks: [],
    progress: undefined,
    result: undefined,
    lines: [],
  };
}

/** Records the totals when the service names a new target. Each target gets one mark. */
function marksAfter(marks: readonly CopyItemMark[], progress: CopyProgress): CopyItemMark[] {
  const { current } = progress;
  if (current === undefined || marks.some((mark) => mark.target === current)) {
    return [...marks];
  }
  return [
    ...marks,
    { target: current, documents: progress.documents, skipped: progress.skippedDocuments },
  ];
}

/**
 * The documents and skips of one target. They run from its mark to the next mark, or to the
 * latest totals when it is the last target begun.
 */
function countsOf(
  target: string,
  marks: readonly CopyItemMark[],
  progress: CopyProgress | undefined,
): Pick<CopyItemState, 'documents' | 'skipped'> {
  const index = marks.findIndex((mark) => mark.target === target);
  const start = marks[index];
  if (start === undefined || progress === undefined) {
    return { documents: 0, skipped: 0 };
  }
  const end = marks[index + 1] ?? {
    documents: progress.documents,
    skipped: progress.skippedDocuments,
  };
  return {
    documents: end.documents - start.documents,
    skipped: end.skipped - start.skipped,
  };
}

function statusOf(
  index: number,
  item: CopyItem,
  progress: CopyProgress | undefined,
): CopyItemStatus {
  if (progress === undefined) {
    return 'queued';
  }
  if (index < progress.collectionsDone) {
    return 'done';
  }
  if (!progress.done) {
    return progress.current === item.target ? 'copying' : 'queued';
  }
  if (progress.cancelled) {
    return 'cancelled';
  }
  // A failed job stops at the item it was writing. The items after it never started.
  if (progress.error !== undefined && progress.current === item.target) {
    return 'failed';
  }
  return 'queued';
}

function itemStatesOf(
  items: readonly CopyItem[],
  progress: CopyProgress | undefined,
  marks: readonly CopyItemMark[],
): CopyItemState[] {
  return items.map((item, index) => ({
    source: item.source,
    target: item.target,
    status: statusOf(index, item, progress),
    ...countsOf(item.target, marks, progress),
  }));
}

/** Keeps the derived item states in step with the items, the marks and the latest progress. */
function withDerived(job: CopyJob): CopyJob {
  return { ...job, itemStates: itemStatesOf(job.items, job.progress, job.marks) };
}

/**
 * The copy jobs of the app. One store holds every job, keyed by job id. Progress events and the
 * start call can arrive in either order, so each one creates the job when it is missing.
 */
export function createCopyStore(client: CopyClient): CopyStore {
  return createStore<CopyState>()((set, get) => {
    function update(jobId: string, change: (job: CopyJob) => CopyJob): void {
      const current = get().jobs[jobId] ?? emptyJob(jobId);
      set({ jobs: { ...get().jobs, [jobId]: withDerived(change(current)) } });
    }

    return {
      jobs: {},

      async start(input) {
        const { jobId } = await client.start(input);
        update(jobId, (job) => ({ ...job, items: input.items }));
        return jobId;
      },

      async cancel(jobId) {
        await client.cancel({ jobId });
      },

      applyProgress(jobId, progress) {
        update(jobId, (job) => ({
          ...job,
          progress,
          marks: marksAfter(job.marks, progress),
          result: progress.done ? progress : job.result,
          lines: [...job.lines, ...progress.lines].slice(-MAX_COPY_LINES),
        }));
      },
    };
  });
}
