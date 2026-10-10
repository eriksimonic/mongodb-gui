import { describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  appError,
  type GenerateStartInput,
  type RpcEvent,
} from '@mongo-gui/core';
import { createGenerateService } from './generate-service';
import type { TransferClient } from './transfer-service';

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';

interface InsertCall {
  readonly database: string;
  readonly collection: string;
  readonly docs: Record<string, unknown>[];
  readonly options: unknown;
}

/** A client whose collections record each insertMany call. The behaviour per call is injected. */
function fakeClient(
  behaviour: (call: InsertCall, index: number) => Promise<{ insertedCount: number }>,
): { client: TransferClient; calls: InsertCall[] } {
  const calls: InsertCall[] = [];
  const client = {
    db: (database: string) => ({
      collection: (collection: string) => ({
        insertMany: async (docs: Record<string, unknown>[], options: unknown) => {
          const call: InsertCall = { database, collection, docs, options };
          calls.push(call);
          return behaviour(call, calls.length - 1);
        },
      }),
    }),
  } as unknown as TransferClient;
  return { client, calls };
}

function input(overrides: Partial<GenerateStartInput> = {}): GenerateStartInput {
  return {
    connectionId: CONNECTION_ID,
    database: 'shop',
    collection: 'orders',
    count: 25_000,
    seed: 11,
    batchSize: 10_000,
    fields: [
      { name: '_id', generator: { type: 'objectId' }, unique: false },
      { name: 'qty', generator: { type: 'integer', min: 1, max: 9 }, unique: false },
    ],
    ...overrides,
  };
}

function setup(client: TransferClient, withEvents = true) {
  const events: RpcEvent[] = [];
  const service = createGenerateService({
    getClient: () => client,
    emit: (event) => {
      if (withEvents) {
        events.push(event);
      }
    },
    progressIntervalMs: 0,
  });
  return { service, events };
}

function progressOf(events: RpcEvent[]) {
  return events.filter((event) => event.type === 'generate:progress');
}

function lastProgress(events: RpcEvent[]) {
  const progress = progressOf(events);
  const last = progress[progress.length - 1];
  if (last === undefined || last.type !== 'generate:progress') {
    throw new Error('no progress event');
  }
  return last;
}

describe('createGenerateService', () => {
  it('inserts the count in unordered batches and reports the finish', async () => {
    const { client, calls } = fakeClient(async (call) => ({ insertedCount: call.docs.length }));
    const { service, events } = setup(client);
    const jobId = service.start(input());

    await vi.waitFor(() => expect(lastProgress(events).progress.done).toBe(true));

    expect(calls.map((call) => call.docs.length)).toEqual([10_000, 10_000, 5_000]);
    expect(calls.every((call) => call.database === 'shop' && call.collection === 'orders')).toBe(
      true,
    );
    expect(calls[0]?.options).toEqual({ ordered: false, writeConcern: { w: 1 } });
    const final = lastProgress(events);
    expect(final.progress).toMatchObject({
      total: 25_000,
      inserted: 25_000,
      failed: 0,
      done: true,
      cancelled: false,
    });
    expect(final.jobId).toBe(jobId);
    expect(events).toContainEqual({
      type: 'catalog:changed',
      connectionId: CONNECTION_ID,
      database: 'shop',
      collection: 'orders',
    });
  });

  it('generates the same documents for the same seed', async () => {
    const first = fakeClient(async (call) => ({ insertedCount: call.docs.length }));
    const second = fakeClient(async (call) => ({ insertedCount: call.docs.length }));
    const a = setup(first.client);
    const b = setup(second.client);
    a.service.start(input({ count: 50 }));
    b.service.start(input({ count: 50 }));
    await vi.waitFor(() => expect(lastProgress(a.events).progress.done).toBe(true));
    await vi.waitFor(() => expect(lastProgress(b.events).progress.done).toBe(true));
    const strip = (docs: Record<string, unknown>[]) =>
      docs.map((doc) => ({ ...doc, _id: undefined }));
    expect(strip(first.calls[0]?.docs ?? [])).toEqual(strip(second.calls[0]?.docs ?? []));
  });

  it('counts the documents a bulk write refused as failed and goes on', async () => {
    const bulk = Object.assign(new Error('duplicate key'), {
      name: 'MongoBulkWriteError',
      insertedCount: 7,
    });
    const { client } = fakeClient(async (call, index) => {
      if (index === 0) {
        throw bulk;
      }
      return { insertedCount: call.docs.length };
    });
    const { service, events } = setup(client);
    service.start(input({ count: 12_000 }));
    await vi.waitFor(() => expect(lastProgress(events).progress.done).toBe(true));
    // The first batch of 10,000 wrote 7, so 9,993 were refused. The second batch wrote its 2,000.
    expect(lastProgress(events).progress).toMatchObject({ inserted: 7 + 2_000, failed: 9_993 });
  });

  it('ends the job with the mapped error when an insert fails outright', async () => {
    const { client } = fakeClient(async () => {
      throw new AppErrorException(appError('NOT_CONNECTED', 'The connection was lost.'));
    });
    const { service, events } = setup(client);
    service.start(input({ count: 100 }));
    await vi.waitFor(() => expect(lastProgress(events).progress.done).toBe(true));
    expect(lastProgress(events).progress.error).toEqual({
      code: 'NOT_CONNECTED',
      message: 'The connection was lost.',
    });
    expect(events.some((event) => event.type === 'catalog:changed')).toBe(false);
  });

  it('stops after the batch in progress when cancelled', async () => {
    // The fake cancels while the first batch is written, so the job stops before the second batch.
    let cancelAll: () => void = () => undefined;
    const { client, calls } = fakeClient(async (call) => {
      cancelAll();
      return { insertedCount: call.docs.length };
    });
    const created = setup(client);
    cancelAll = () => created.service.cancelAll();
    created.service.start(input());
    await vi.waitFor(() => expect(lastProgress(created.events).progress.done).toBe(true));
    expect(calls).toHaveLength(1);
    expect(lastProgress(created.events).progress).toMatchObject({
      inserted: 10_000,
      cancelled: true,
      done: true,
    });
  });

  it('refuses to start while the connection has no client', () => {
    const service = createGenerateService({
      getClient: () => {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Not connected.'));
      },
      emit: () => undefined,
    });
    expect(() => service.start(input())).toThrow(AppErrorException);
  });

  it('cancels every job of a connection', async () => {
    const { client, calls } = fakeClient(
      () => new Promise<{ insertedCount: number }>(() => undefined),
    );
    const { service, events } = setup(client);
    service.start(input({ count: 100 }));
    service.cancelConnection(CONNECTION_ID);
    // The first insert never resolves, so the cancel only marks the job. Nothing else is written.
    expect(calls).toHaveLength(1);
    expect(progressOf(events)).toEqual([]);
  });
});
