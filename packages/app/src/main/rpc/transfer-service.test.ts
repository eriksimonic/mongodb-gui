import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  appError,
  type ExportRequest,
  type ImportRequest,
  type RpcEvent,
  type TransferProgress,
} from '@mongo-gui/core';
import {
  createTransferService,
  FINISHED_RETENTION_MS,
  type TransferAdapter,
  type TransferClient,
  type TransferHooks,
  type TransferService,
} from './transfer-service';

const CONNECTION_A = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const CONNECTION_B = '7a1d2e3f-4b5c-4d6e-8f70-1a2b3c4d5e6f';
const CONNECTION_C = '9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const CLIENT = {} as unknown as TransferClient;

const EXPORT_REQUEST: ExportRequest = {
  database: 'shop',
  collection: 'orders',
  path: '/tmp/orders.ndjson',
  options: { format: 'ndjson', ejsonMode: 'canonical' },
};

const IMPORT_REQUEST: ImportRequest = {
  database: 'shop',
  collection: 'orders_copy',
  path: '/tmp/orders.ndjson',
  options: {
    format: 'ndjson',
    mode: 'insert',
    upsertKey: '_id',
    batchSize: 500,
    stopOnError: false,
  },
};

function progress(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return {
    processed: 0,
    inserted: 0,
    updated: 0,
    matched: 0,
    failed: 0,
    elapsedMs: 0,
    done: false,
    errors: [],
    warnings: [],
    ...overrides,
  };
}

function finalOf(result: Partial<TransferProgress>): TransferProgress {
  return progress({ ...result, done: true });
}

/** An export that reports `count` documents and completes, or fails with the given error. */
function completingAdapter(count: number, error?: TransferProgress['error']): TransferAdapter {
  return {
    importFile: async (_client, _request, hooks?: TransferHooks) => {
      hooks?.onProgress?.(progress({ processed: count }));
      return finalOf({
        processed: count,
        inserted: count,
        ...(error === undefined ? {} : { error }),
      });
    },
    exportCollection: async (_client, _request, hooks?: TransferHooks) => {
      hooks?.onProgress?.(progress({ processed: count }));
      return finalOf({ processed: count, ...(error === undefined ? {} : { error }) });
    },
  };
}

/** An adapter whose transfer runs until its signal aborts, then reports CANCELLED. */
function blockingAdapter(): TransferAdapter {
  const run = (_client: TransferClient, _request: unknown, hooks?: TransferHooks) =>
    new Promise<TransferProgress>((resolve) => {
      hooks?.signal?.addEventListener('abort', () => {
        resolve(finalOf({ error: appError('CANCELLED', 'The transfer was cancelled') }));
      });
    });
  return {
    importFile: run,
    exportCollection: run,
  };
}

function setup(adapter: TransferAdapter, options: { throttle?: boolean } = {}) {
  const events: RpcEvent[] = [];
  const service: TransferService = createTransferService({
    adapter,
    getClient: (connectionId) => {
      if (connectionId === CONNECTION_B) {
        throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first'));
      }
      return CLIENT;
    },
    emit: (event) => {
      events.push(event);
    },
    progressIntervalMs: options.throttle === false ? 0 : 250,
    retentionMs: FINISHED_RETENTION_MS,
  });
  return { service, events };
}

function progressEvents(events: readonly RpcEvent[]) {
  return events.flatMap((event) => (event.type === 'transfer:progress' ? [event] : []));
}

/** Waits for the adapter promises and any timers to run. */
async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('transfer service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards the final export progress and records the written file', async () => {
    const { service, events } = setup(completingAdapter(100));
    const transferId = service.startExport(CONNECTION_A, EXPORT_REQUEST);
    await settle();

    const sent = progressEvents(events);
    expect(sent.at(-1)).toEqual({
      type: 'transfer:progress',
      transferId,
      kind: 'export',
      progress: expect.objectContaining({ done: true, processed: 100 }),
    });
    expect(service.status(transferId).done).toBe(true);
    expect(service.wroteFile('/tmp/orders.ndjson')).toBe(true);
  });

  it('does not record a file for an import or for a failed export', async () => {
    const { service } = setup(completingAdapter(3));
    service.startImport(CONNECTION_A, IMPORT_REQUEST);
    await settle();
    expect(service.wroteFile('/tmp/orders.ndjson')).toBe(false);

    const failing = setup(
      completingAdapter(0, appError('VALIDATION', 'The file could not be written')),
    );
    failing.service.startExport(CONNECTION_A, EXPORT_REQUEST);
    await settle();
    expect(failing.service.wroteFile('/tmp/orders.ndjson')).toBe(false);
  });

  it('sends at most one progress event per interval and always sends the final one', async () => {
    let emitTo: TransferHooks | undefined;
    const adapter: TransferAdapter = {
      importFile: (_client, _request, hooks) => {
        emitTo = hooks;
        return new Promise<TransferProgress>((resolve) => {
          hooks?.signal?.addEventListener('abort', () => resolve(finalOf({})));
        });
      },
      exportCollection: async () => finalOf({}),
    };
    const { service, events } = setup(adapter);
    const transferId = service.startImport(CONNECTION_A, IMPORT_REQUEST);
    await settle();

    for (let processed = 1; processed <= 50; processed += 1) {
      emitTo?.onProgress?.(progress({ processed }));
    }
    expect(progressEvents(events)).toHaveLength(1);

    await settle(250);
    const afterInterval = progressEvents(events);
    expect(afterInterval).toHaveLength(2);
    expect(afterInterval[1]?.progress.processed).toBe(50);
    expect(service.status(transferId).processed).toBe(50);

    service.cancel(transferId);
    await settle();
    expect(progressEvents(events).at(-1)?.progress.done).toBe(true);
  });

  it('cancels a running transfer and reports CANCELLED as its final progress', async () => {
    const { service, events } = setup(blockingAdapter());
    const transferId = service.startExport(CONNECTION_A, EXPORT_REQUEST);
    await settle();
    expect(service.status(transferId).done).toBe(false);

    service.cancel(transferId);
    await settle();

    const last = progressEvents(events).at(-1);
    expect(last?.progress.error?.code).toBe('CANCELLED');
    expect(service.status(transferId).done).toBe(true);
  });

  it('cancels only the transfers of the disconnected connection', async () => {
    const { service, events } = setup(blockingAdapter());
    const first = service.startExport(CONNECTION_A, EXPORT_REQUEST);
    const second = service.startImport(CONNECTION_A, IMPORT_REQUEST);
    const other = service.startExport(CONNECTION_C, EXPORT_REQUEST);
    await settle();

    service.cancelConnection(CONNECTION_A);
    await settle();

    const finished = new Set(
      progressEvents(events)
        .filter((event) => event.progress.done)
        .map((event) => event.transferId),
    );
    expect(finished).toEqual(new Set([first, second]));
    expect(service.status(other).done).toBe(false);
  });

  it('cancels every running transfer on cancelAll', async () => {
    const { service, events } = setup(blockingAdapter());
    service.startExport(CONNECTION_A, EXPORT_REQUEST);
    service.startImport(CONNECTION_A, IMPORT_REQUEST);
    await settle();

    service.cancelAll();
    await settle();

    const finals = progressEvents(events).filter((event) => event.progress.done);
    expect(finals).toHaveLength(2);
    expect(finals.every((event) => event.progress.error?.code === 'CANCELLED')).toBe(true);
  });

  it('refuses to start while the connection has no live client and registers nothing', () => {
    const { service } = setup(completingAdapter(1));
    expect(() => service.startExport(CONNECTION_B, EXPORT_REQUEST)).toThrow(AppErrorException);
    expect(service.list()).toEqual([]);
  });

  it('reports an adapter rejection as an INTERNAL error in the final progress', async () => {
    const adapter: TransferAdapter = {
      importFile: async () => {
        throw new Error('driver exploded with a document value');
      },
      exportCollection: async () => finalOf({}),
    };
    const { service, events } = setup(adapter);
    service.startImport(CONNECTION_A, IMPORT_REQUEST);
    await settle();

    const last = progressEvents(events).at(-1);
    expect(last?.progress.error?.code).toBe('INTERNAL');
    expect(last?.progress.error?.message).toBe('The transfer failed');
  });

  it('lists transfers with their kind, target and latest progress', async () => {
    const { service } = setup(blockingAdapter());
    const transferId = service.startExport(CONNECTION_A, EXPORT_REQUEST);
    await settle();

    expect(service.list()).toEqual([
      {
        transferId,
        kind: 'export',
        database: 'shop',
        collection: 'orders',
        path: '/tmp/orders.ndjson',
        progress: expect.objectContaining({ done: false }),
      },
    ]);
  });

  it('forgets a finished transfer after ten minutes', async () => {
    const { service } = setup(completingAdapter(1));
    const transferId = service.startExport(CONNECTION_A, EXPORT_REQUEST);
    await settle();
    expect(service.status(transferId).done).toBe(true);

    await settle(FINISHED_RETENTION_MS - 1);
    expect(service.status(transferId).done).toBe(true);

    await settle(1);
    expect(() => service.status(transferId)).toThrow(AppErrorException);
    expect(service.list()).toEqual([]);
  });

  it('refuses status and cancel for an unknown transfer', () => {
    const { service } = setup(completingAdapter(1));
    expect(() => service.status('00000000-0000-4000-8000-000000000000')).toThrow(AppErrorException);
    expect(() => {
      service.cancel('00000000-0000-4000-8000-000000000000');
    }).toThrow(AppErrorException);
  });

  it('forgets a file a later failed export of the same path has removed', async () => {
    let attempt = 0;
    const adapter: TransferAdapter = {
      importFile: async () => finalOf({}),
      exportCollection: async () => {
        attempt += 1;
        return attempt === 1
          ? finalOf({ processed: 3 })
          : finalOf({ error: appError('COMMAND_FAILED', 'The query failed') });
      },
    };
    const { service } = setup(adapter);
    service.startExport(CONNECTION_A, EXPORT_REQUEST);
    await settle();
    expect(service.wroteFile('/tmp/orders.ndjson')).toBe(true);

    service.startExport(CONNECTION_A, EXPORT_REQUEST);
    await settle();
    expect(service.wroteFile('/tmp/orders.ndjson')).toBe(false);
  });
});
