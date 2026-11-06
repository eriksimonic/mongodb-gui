import type { CopyOptions, CopyProgress, RpcEvent } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { createMockCopy } from './mock';
import { createCopyStore, MAX_COPY_LINES, type CopyClient } from './copy-store';

const JOB = '3f2b8c1e-7a4d-4e9b-8c2f-1d5e6a7b8c9d';
const OTHER_JOB = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const CONNECTION = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

function optionsWith(items: CopyOptions['items']): CopyOptions {
  return {
    sourceConnectionId: CONNECTION,
    targetConnectionId: CONNECTION,
    sourceDatabase: 'shop',
    targetDatabase: 'shop_copy',
    items,
    mode: 'replace',
    acknowledged: [],
  };
}

const TWO_ITEMS = optionsWith([
  { source: 'orders', target: 'orders' },
  { source: 'users', target: 'users' },
]);

function progress(overrides: Partial<CopyProgress> = {}): CopyProgress {
  return {
    phase: 'copying',
    documents: 0,
    collectionsDone: 0,
    collectionsTotal: 2,
    failedDocuments: 0,
    skippedDocuments: 0,
    lines: [],
    elapsedMs: 0,
    done: false,
    cancelled: false,
    ...overrides,
  };
}

function fakeClient(jobId = JOB) {
  const start = vi.fn<CopyClient['start']>().mockResolvedValue({ jobId });
  const cancel = vi.fn<CopyClient['cancel']>().mockResolvedValue(undefined);
  const client: CopyClient = { start, cancel };
  return { client, start, cancel };
}

function statusesOf(store: ReturnType<typeof createCopyStore>, jobId: string): string[] {
  return store.getState().jobs[jobId]?.itemStates.map((item) => item.status) ?? [];
}

describe('copy store start', () => {
  it('starts the job with the client and holds its items as queued', async () => {
    const { client, start } = fakeClient();
    const store = createCopyStore(client);

    const jobId = await store.getState().start(TWO_ITEMS);

    expect(jobId).toBe(JOB);
    expect(start).toHaveBeenCalledWith(TWO_ITEMS);
    const job = store.getState().jobs[JOB];
    expect(job?.items).toEqual(TWO_ITEMS.items);
    expect(job?.itemStates).toEqual([
      { source: 'orders', target: 'orders', status: 'queued', documents: 0, skipped: 0 },
      { source: 'users', target: 'users', status: 'queued', documents: 0, skipped: 0 },
    ]);
    expect(job?.progress).toBeUndefined();
  });

  it('stores nothing when the client refuses the start', async () => {
    const { client, start } = fakeClient();
    start.mockRejectedValue(new Error('Type the target database name'));
    const store = createCopyStore(client);

    await expect(store.getState().start(TWO_ITEMS)).rejects.toThrow(
      'Type the target database name',
    );
    expect(store.getState().jobs).toEqual({});
  });

  it('keeps progress that arrived before the start call returned', async () => {
    const { client } = fakeClient();
    const store = createCopyStore(client);

    store.getState().applyProgress(JOB, progress({ collectionsDone: 1, current: 'users' }));
    await store.getState().start(TWO_ITEMS);

    expect(statusesOf(store, JOB)).toEqual(['done', 'copying']);
  });
});

describe('copy store progress', () => {
  it('moves items from queued to copying to done as the events arrive', async () => {
    const { client } = fakeClient();
    const store = createCopyStore(client);
    await store.getState().start(TWO_ITEMS);

    store.getState().applyProgress(JOB, progress({ current: 'orders', documents: 10 }));
    expect(statusesOf(store, JOB)).toEqual(['copying', 'queued']);

    store
      .getState()
      .applyProgress(JOB, progress({ current: 'users', collectionsDone: 1, documents: 20 }));
    expect(statusesOf(store, JOB)).toEqual(['done', 'copying']);
    expect(store.getState().jobs[JOB]?.progress?.documents).toBe(20);
  });

  it('counts the documents and skips of each item from the totals at its start', async () => {
    const { client } = fakeClient();
    const store = createCopyStore(client);
    await store.getState().start(TWO_ITEMS);

    store.getState().applyProgress(JOB, progress({ current: 'orders', documents: 0 }));
    store
      .getState()
      .applyProgress(JOB, progress({ current: 'orders', documents: 30, skippedDocuments: 4 }));
    store.getState().applyProgress(
      JOB,
      progress({
        current: 'users',
        collectionsDone: 1,
        documents: 40,
        skippedDocuments: 5,
      }),
    );
    store.getState().applyProgress(
      JOB,
      progress({
        current: 'users',
        collectionsDone: 1,
        documents: 52,
        skippedDocuments: 6,
      }),
    );

    expect(store.getState().jobs[JOB]?.itemStates).toEqual([
      { source: 'orders', target: 'orders', status: 'done', documents: 40, skipped: 5 },
      { source: 'users', target: 'users', status: 'copying', documents: 12, skipped: 1 },
    ]);
  });

  it('keeps the final event as the result and marks every item done', async () => {
    const { client } = fakeClient();
    const store = createCopyStore(client);
    await store.getState().start(TWO_ITEMS);

    store
      .getState()
      .applyProgress(JOB, progress({ phase: 'finished', collectionsDone: 2, done: true }));

    const job = store.getState().jobs[JOB];
    expect(job?.result).toMatchObject({ phase: 'finished', done: true, cancelled: false });
    expect(statusesOf(store, JOB)).toEqual(['done', 'done']);
  });

  it('marks the unfinished items cancelled when the job ends cancelled', async () => {
    const { client, cancel } = fakeClient();
    const store = createCopyStore(client);
    await store.getState().start(TWO_ITEMS);
    store.getState().applyProgress(JOB, progress({ current: 'orders' }));

    await store.getState().cancel(JOB);
    expect(cancel).toHaveBeenCalledWith({ jobId: JOB });

    store
      .getState()
      .applyProgress(JOB, progress({ phase: 'finished', done: true, cancelled: true }));
    expect(statusesOf(store, JOB)).toEqual(['cancelled', 'cancelled']);
    expect(store.getState().jobs[JOB]?.result?.cancelled).toBe(true);
  });

  it('marks the item that was writing as failed and leaves the rest queued', async () => {
    const { client } = fakeClient();
    const store = createCopyStore(client);
    await store.getState().start(TWO_ITEMS);

    store.getState().applyProgress(
      JOB,
      progress({
        phase: 'finished',
        current: 'orders',
        done: true,
        error: { code: 'COMMAND_FAILED', message: 'mongorestore failed' },
      }),
    );

    expect(statusesOf(store, JOB)).toEqual(['failed', 'queued']);
  });

  it('appends the tool lines and keeps the newest MAX_COPY_LINES', async () => {
    const { client } = fakeClient();
    const store = createCopyStore(client);
    await store.getState().start(TWO_ITEMS);
    const first = Array.from({ length: 300 }, (_, index) => `first ${index}`);
    const second = Array.from({ length: 300 }, (_, index) => `second ${index}`);

    store.getState().applyProgress(JOB, progress({ lines: first }));
    store.getState().applyProgress(JOB, progress({ lines: second }));

    const lines = store.getState().jobs[JOB]?.lines ?? [];
    expect(lines).toHaveLength(MAX_COPY_LINES);
    expect(lines.at(-1)).toBe('second 299');
    expect(lines[0]).toBe('first 100');
  });

  it('keeps each job separate', async () => {
    const { client, start } = fakeClient();
    start.mockResolvedValueOnce({ jobId: JOB }).mockResolvedValueOnce({ jobId: OTHER_JOB });
    const store = createCopyStore(client);
    await store.getState().start(TWO_ITEMS);
    await store.getState().start(optionsWith([{ source: 'logs', target: 'logs' }]));

    store.getState().applyProgress(JOB, progress());
    store.getState().applyProgress(OTHER_JOB, progress({ current: 'logs', collectionsTotal: 1 }));

    expect(statusesOf(store, JOB)).toEqual(['queued', 'queued']);
    expect(statusesOf(store, OTHER_JOB)).toEqual(['copying']);
  });
});

describe('copy store with the mock copy frames', () => {
  it('gives each item its own documents, and the items add up to the job total', async () => {
    vi.useFakeTimers();
    try {
      const events: RpcEvent[] = [];
      const mock = createMockCopy({
        emit: (event) => events.push(event),
        isProduction: () => false,
      });
      const client: CopyClient = {
        start: (input) =>
          Promise.resolve({
            jobId: mock.start({ ...input, acknowledged: input.acknowledged ?? [] }),
          }),
        cancel: (input) => {
          mock.cancel(input.jobId);
          return Promise.resolve();
        },
      };
      const store = createCopyStore(client);
      const jobId = await store.getState().start(
        optionsWith([
          { source: 'customers', target: 'customers' },
          { source: 'orders', target: 'orders' },
          { source: 'users', target: 'users' },
        ]),
      );
      await vi.runAllTimersAsync();
      for (const event of events) {
        if (event.type === 'copy:progress') {
          store.getState().applyProgress(event.jobId, event.progress);
        }
      }

      const job = store.getState().jobs[jobId];
      const perItem = job?.itemStates.map((item) => item.documents) ?? [];
      expect(perItem).toEqual([750, 750, 750]);
      expect(perItem.reduce((sum, count) => sum + count, 0)).toBe(
        job?.result?.documents ?? Number.NaN,
      );
      expect(job?.result).toMatchObject({ phase: 'finished', done: true, documents: 2250 });
    } finally {
      vi.useRealTimers();
    }
  });
});
