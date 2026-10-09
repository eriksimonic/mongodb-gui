import {
  AppErrorException,
  appError,
  newId,
  type ExportRequest,
  type ImportRequest,
  type RpcEvent,
  type TransferKind,
  type TransferProgress,
  type TransferSummary,
} from '@mongo-gui/core';
import { exportCollection, importFile } from '@mongo-gui/mongo-adapter';

/** The two adapter transfers, typed from the adapter so the service cannot drift from them. */
export type ImportFn = typeof importFile;
export type ExportFn = typeof exportCollection;
export type TransferClient = Parameters<ImportFn>[0];
export type TransferHooks = Parameters<ImportFn>[2];

export interface TransferAdapter {
  readonly importFile: ImportFn;
  readonly exportCollection: ExportFn;
}

export const defaultTransferAdapter: TransferAdapter = { importFile, exportCollection };

/** At most this many progress events per transfer each second. The final event is never throttled. */
export const PROGRESS_EVENTS_PER_SECOND = 4;
const PROGRESS_INTERVAL_MS = 1000 / PROGRESS_EVENTS_PER_SECOND;
/** A finished transfer stays readable for this long, then it is forgotten. */
export const FINISHED_RETENTION_MS = 10 * 60_000;

export interface TransferServiceOptions {
  readonly adapter?: TransferAdapter;
  /** Returns the live client, or throws NOT_CONNECTED when the connection has none. */
  readonly getClient: (connectionId: string) => TransferClient;
  readonly emit: (event: RpcEvent) => void;
  readonly progressIntervalMs?: number;
  readonly retentionMs?: number;
}

export interface TransferService {
  startImport(connectionId: string, request: ImportRequest): string;
  startExport(connectionId: string, request: ExportRequest): string;
  cancel(transferId: string): void;
  status(transferId: string): TransferProgress;
  list(): TransferSummary[];
  /** Cancels the running transfers of one connection. */
  cancelConnection(connectionId: string): void;
  /** Cancels every running transfer. Used on lock, on renderer reset and on quit. */
  cancelAll(): void;
  /** True when this session exported a file to the path and the export finished without error. */
  wroteFile(path: string): boolean;
}

interface Entry {
  readonly transferId: string;
  readonly kind: TransferKind;
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly path: string;
  readonly controller: AbortController;
  /** The newest snapshot, whether or not it has been sent. */
  latest: TransferProgress;
  finished: boolean;
  lastSentAt: number | undefined;
  pending: TransferProgress | undefined;
  throttleTimer: ReturnType<typeof setTimeout> | undefined;
  retentionTimer: ReturnType<typeof setTimeout> | undefined;
}

const EMPTY_PROGRESS: TransferProgress = {
  processed: 0,
  inserted: 0,
  updated: 0,
  matched: 0,
  failed: 0,
  elapsedMs: 0,
  done: false,
  errors: [],
  warnings: [],
};

/**
 * Runs imports and exports in the main process and forwards their progress to the window.
 * Each transfer has its own AbortController. Finished transfers stay for ten minutes so the
 * window can read their final progress, then they are removed.
 */
export function createTransferService(options: TransferServiceOptions): TransferService {
  const adapter = options.adapter ?? defaultTransferAdapter;
  const intervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const retentionMs = options.retentionMs ?? FINISHED_RETENTION_MS;
  const entries = new Map<string, Entry>();
  const written = new Set<string>();

  function send(entry: Entry, progress: TransferProgress): void {
    entry.lastSentAt = Date.now();
    options.emit({
      type: 'transfer:progress',
      transferId: entry.transferId,
      kind: entry.kind,
      progress,
    });
  }

  function onProgress(entry: Entry, progress: TransferProgress): void {
    if (entry.finished) {
      return;
    }
    entry.latest = progress;
    if (progress.done) {
      finish(entry, progress);
      return;
    }
    const sentAt = entry.lastSentAt;
    const wait = sentAt === undefined ? 0 : sentAt + intervalMs - Date.now();
    if (wait <= 0) {
      entry.pending = undefined;
      send(entry, progress);
      return;
    }
    // Only the newest snapshot waits. Older ones are replaced, so the window never falls behind.
    entry.pending = progress;
    if (entry.throttleTimer === undefined) {
      entry.throttleTimer = setTimeout(() => {
        entry.throttleTimer = undefined;
        const pending = entry.pending;
        entry.pending = undefined;
        if (pending !== undefined && !entry.finished) {
          send(entry, pending);
        }
      }, wait);
    }
  }

  function clearThrottle(entry: Entry): void {
    if (entry.throttleTimer !== undefined) {
      clearTimeout(entry.throttleTimer);
      entry.throttleTimer = undefined;
    }
    entry.pending = undefined;
  }

  function finish(entry: Entry, progress: TransferProgress): void {
    clearThrottle(entry);
    entry.finished = true;
    entry.latest = progress;
    send(entry, progress);
    if (entry.kind === 'export' && progress.error === undefined) {
      written.add(entry.path);
    }
    entry.retentionTimer = setTimeout(() => {
      entries.delete(entry.transferId);
    }, retentionMs);
    entry.retentionTimer.unref();
  }

  function start(
    kind: TransferKind,
    connectionId: string,
    target: { database: string; collection: string; path: string },
    run: (client: TransferClient, hooks: TransferHooks) => Promise<TransferProgress>,
  ): string {
    // Throws NOT_CONNECTED before anything is registered, so a failed start leaves no entry.
    const client = options.getClient(connectionId);
    const transferId = newId();
    const controller = new AbortController();
    const entry: Entry = {
      transferId,
      kind,
      connectionId,
      ...target,
      controller,
      latest: EMPTY_PROGRESS,
      finished: false,
      lastSentAt: undefined,
      pending: undefined,
      throttleTimer: undefined,
      retentionTimer: undefined,
    };
    entries.set(transferId, entry);
    const hooks: TransferHooks = {
      signal: controller.signal,
      onProgress: (progress) => {
        onProgress(entry, progress);
      },
    };
    // The promise constructor turns a synchronous throw from the adapter into a rejection.
    new Promise<TransferProgress>((resolve) => {
      resolve(run(client, hooks));
    }).then(
      (progress) => {
        finish(entry, progress);
      },
      () => {
        // The raw text can carry document values, so it is not sent to the window.
        finish(entry, {
          ...EMPTY_PROGRESS,
          done: true,
          error: appError('INTERNAL', 'The transfer failed'),
        });
      },
    );
    return transferId;
  }

  function find(transferId: string): Entry {
    const entry = entries.get(transferId);
    if (entry === undefined) {
      throw new AppErrorException(appError('VALIDATION', 'The transfer was not found.'));
    }
    return entry;
  }

  function cancelEntry(entry: Entry): void {
    if (!entry.finished && !entry.controller.signal.aborted) {
      entry.controller.abort();
    }
  }

  return {
    startImport(connectionId, request) {
      return start('import', connectionId, request, (client, hooks) =>
        adapter.importFile(client, request, hooks),
      );
    },
    startExport(connectionId, request) {
      return start('export', connectionId, request, (client, hooks) =>
        adapter.exportCollection(client, request, hooks),
      );
    },
    cancel(transferId) {
      const entry = find(transferId);
      cancelEntry(entry);
    },
    status(transferId) {
      return find(transferId).latest;
    },
    list() {
      return [...entries.values()].map((entry) => ({
        transferId: entry.transferId,
        kind: entry.kind,
        database: entry.database,
        collection: entry.collection,
        path: entry.path,
        progress: entry.latest,
      }));
    },
    cancelConnection(connectionId) {
      for (const entry of entries.values()) {
        if (entry.connectionId === connectionId) {
          cancelEntry(entry);
        }
      }
    },
    cancelAll() {
      for (const entry of entries.values()) {
        cancelEntry(entry);
      }
    },
    wroteFile(path) {
      return written.has(path);
    },
  };
}
