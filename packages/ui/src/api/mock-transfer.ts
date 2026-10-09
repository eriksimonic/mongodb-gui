import {
  appError,
  newId,
  type ExportRequest,
  type ImportPreview,
  type ImportRequest,
  type RpcEvent,
  type TransferKind,
  type TransferProgress,
  type TransferSummary,
} from '@mongo-gui/core';

/** The file the mock open dialog returns, whatever the user would pick. */
export const MOCK_DIALOG_PATH = '/mock/orders.csv';

/** The file the mock save dialog returns for a format: the extension the user's filter names. */
export function mockSavePath(extension: string): string {
  return `/mock/orders.${extension}`;
}

const IMPORT_STEPS = 10;
const IMPORT_STEP_MS = 200;
const IMPORT_ROWS = 240;
const IMPORT_BYTES = 18_240;
const EXPORT_STEPS = 5;
const EXPORT_STEP_MS = 400;
const EXPORT_DEFAULT_ROWS = 120;
const EXPORT_MAX_ROWS = 300;

/**
 * The preview the mock returns for any file. It is a small orders file with one column that
 * needs a rename and a few empty cells, so every part of the mapping step has something to show.
 */
export function mockImportPreview(): ImportPreview {
  return {
    detectedFormat: 'csv',
    csv: {
      delimiter: ',',
      quote: '"',
      hasHeader: true,
      nullValues: ['', 'null', 'NULL'],
      trim: false,
    },
    fields: [
      {
        name: 'order_id',
        inferredType: 'string',
        examples: ['ord-1001', 'ord-1002', 'ord-1003'],
        nullCount: 0,
      },
      {
        name: 'customer',
        inferredType: 'string',
        examples: ['Ana Kern', 'Luka Novak'],
        nullCount: 3,
      },
      {
        name: 'total',
        inferredType: 'double',
        examples: ['19.90', '240', '7.5'],
        nullCount: 2,
      },
      {
        name: 'placed_at',
        inferredType: 'date',
        examples: ['2026-03-01T09:15:00Z', '2026-03-02T17:40:00+01:00'],
        nullCount: 0,
      },
      {
        name: 'status',
        inferredType: 'string',
        examples: ['paid', 'refunded'],
        nullCount: 0,
      },
    ],
    sampleRows: [
      {
        order_id: 'ord-1001',
        customer: 'Ana Kern',
        total: 19.9,
        placed_at: '2026-03-01T09:15:00Z',
        status: 'paid',
      },
      {
        order_id: 'ord-1002',
        customer: 'Luka Novak',
        total: 240,
        placed_at: '2026-03-01T10:02:00Z',
        status: 'paid',
      },
      {
        order_id: 'ord-1003',
        customer: null,
        total: 7.5,
        placed_at: '2026-03-02T17:40:00+01:00',
        status: 'refunded',
      },
    ],
    estimatedRows: IMPORT_ROWS,
    warnings: ['Column 6 has no name and is called column_6'],
  };
}

export interface MockTransfers {
  startImport(connectionId: string, request: ImportRequest): string;
  startExport(connectionId: string, request: ExportRequest): string;
  cancel(transferId: string): void;
  status(transferId: string): TransferProgress | undefined;
  list(): TransferSummary[];
  wroteFile(path: string): boolean;
}

interface MockEntry {
  readonly kind: TransferKind;
  readonly database: string;
  readonly collection: string;
  readonly path: string;
  latest: TransferProgress;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * A scripted transfer. An import walks the preview over about two seconds and reports two row
 * errors at the end. An export writes the collection in five steps. Cancel stops the timer and
 * reports CANCELLED as the final progress.
 */
export function createMockTransfers(
  emit: (event: RpcEvent) => void,
  countOf: (database: string, collection: string) => number | undefined,
): MockTransfers {
  const entries = new Map<string, MockEntry>();
  const written = new Set<string>();

  function send(transferId: string, entry: MockEntry): void {
    emit({ type: 'transfer:progress', transferId, kind: entry.kind, progress: entry.latest });
  }

  function finish(transferId: string, entry: MockEntry, progress: TransferProgress): void {
    entry.timer = undefined;
    entry.latest = progress;
    send(transferId, entry);
    if (entry.kind === 'export' && progress.error === undefined) {
      written.add(entry.path);
    }
  }

  function snapshot(
    overrides: Partial<TransferProgress>,
    previous: TransferProgress,
  ): TransferProgress {
    return { ...previous, ...overrides };
  }

  function runImport(transferId: string, entry: MockEntry): void {
    let step = 0;
    const tick = () => {
      step += 1;
      const processed = Math.round((IMPORT_ROWS * step) / IMPORT_STEPS);
      if (step < IMPORT_STEPS) {
        entry.latest = snapshot(
          {
            processed,
            inserted: processed,
            bytesRead: Math.round((IMPORT_BYTES * step) / IMPORT_STEPS),
            bytesTotal: IMPORT_BYTES,
            elapsedMs: step * IMPORT_STEP_MS,
          },
          entry.latest,
        );
        send(transferId, entry);
        entry.timer = setTimeout(tick, IMPORT_STEP_MS);
        return;
      }
      finish(
        transferId,
        entry,
        snapshot(
          {
            processed: IMPORT_ROWS,
            inserted: IMPORT_ROWS - 2,
            failed: 2,
            bytesRead: IMPORT_BYTES,
            bytesTotal: IMPORT_BYTES,
            elapsedMs: IMPORT_STEPS * IMPORT_STEP_MS,
            done: true,
            errors: [
              { row: 12, message: '"n/a" is not a number' },
              { row: 88, message: '"" is not a 64-bit integer' },
            ],
          },
          entry.latest,
        ),
      );
    };
    entry.timer = setTimeout(tick, IMPORT_STEP_MS);
  }

  function runExport(transferId: string, entry: MockEntry, limit: number | undefined): void {
    const total = Math.min(
      EXPORT_MAX_ROWS,
      limit ?? Number.POSITIVE_INFINITY,
      countOf(entry.database, entry.collection) ?? EXPORT_DEFAULT_ROWS,
    );
    let step = 0;
    const tick = () => {
      step += 1;
      if (step < EXPORT_STEPS) {
        entry.latest = snapshot(
          {
            processed: Math.round((total * step) / EXPORT_STEPS),
            elapsedMs: step * EXPORT_STEP_MS,
          },
          entry.latest,
        );
        send(transferId, entry);
        entry.timer = setTimeout(tick, EXPORT_STEP_MS);
        return;
      }
      finish(
        transferId,
        entry,
        snapshot(
          { processed: total, elapsedMs: EXPORT_STEPS * EXPORT_STEP_MS, done: true },
          entry.latest,
        ),
      );
    };
    entry.timer = setTimeout(tick, EXPORT_STEP_MS);
  }

  function start(
    kind: TransferKind,
    database: string,
    collection: string,
    path: string,
    limit?: number,
  ): string {
    const transferId = newId();
    const entry: MockEntry = {
      kind,
      database,
      collection,
      path,
      latest: {
        processed: 0,
        inserted: 0,
        updated: 0,
        matched: 0,
        failed: 0,
        elapsedMs: 0,
        done: false,
        errors: [],
        warnings: [],
      },
      timer: undefined,
    };
    entries.set(transferId, entry);
    if (kind === 'import') {
      runImport(transferId, entry);
    } else {
      runExport(transferId, entry, limit);
    }
    return transferId;
  }

  return {
    startImport(_connectionId, request) {
      return start('import', request.database, request.collection, request.path);
    },
    startExport(_connectionId, request) {
      return start(
        'export',
        request.database,
        request.collection,
        request.path,
        request.options.limit,
      );
    },
    cancel(transferId) {
      const entry = entries.get(transferId);
      if (entry === undefined || entry.latest.done || entry.timer === undefined) {
        return;
      }
      clearTimeout(entry.timer);
      finish(
        transferId,
        entry,
        snapshot(
          { done: true, error: appError('CANCELLED', 'The transfer was cancelled') },
          entry.latest,
        ),
      );
    },
    status(transferId) {
      return entries.get(transferId)?.latest;
    },
    list() {
      return [...entries.entries()].map(([transferId, entry]) => ({
        transferId,
        kind: entry.kind,
        database: entry.database,
        collection: entry.collection,
        path: entry.path,
        progress: entry.latest,
      }));
    },
    wroteFile(path) {
      return written.has(path);
    },
  };
}
