import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcEvent } from '@mongo-gui/core';
import { createMockTransfers, MOCK_DIALOG_PATH, mockImportPreview } from './mock-transfer';

const IMPORT = {
  database: 'shop',
  collection: 'orders',
  path: MOCK_DIALOG_PATH,
  options: {
    format: 'csv' as const,
    mode: 'insert' as const,
    upsertKey: '_id',
    batchSize: 500,
    stopOnError: false,
  },
};

function progressEvents(events: readonly RpcEvent[]) {
  return events.flatMap((event) => (event.type === 'transfer:progress' ? [event] : []));
}

describe('mock transfers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('walks the scripted import over about two seconds and ends with two row errors', async () => {
    const events: RpcEvent[] = [];
    const transfers = createMockTransfers(
      (event) => events.push(event),
      () => undefined,
    );
    const transferId = transfers.startImport('conn', IMPORT);

    await vi.advanceTimersByTimeAsync(1000);
    expect(progressEvents(events).length).toBeGreaterThan(0);
    expect(transfers.status(transferId)?.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1500);
    const last = progressEvents(events).at(-1);
    expect(last?.progress.done).toBe(true);
    expect(last?.progress.errors.map((error) => error.row)).toEqual([12, 88]);
    expect(last?.progress.error).toBeUndefined();
  });

  it('stops a running import on cancel and reports CANCELLED', async () => {
    const events: RpcEvent[] = [];
    const transfers = createMockTransfers(
      (event) => events.push(event),
      () => undefined,
    );
    const transferId = transfers.startImport('conn', IMPORT);
    await vi.advanceTimersByTimeAsync(400);

    transfers.cancel(transferId);
    const countAtCancel = progressEvents(events).length;
    await vi.advanceTimersByTimeAsync(5000);

    expect(progressEvents(events)).toHaveLength(countAtCancel);
    expect(transfers.status(transferId)?.error?.code).toBe('CANCELLED');
  });

  it('writes the export and records the file it wrote', async () => {
    const events: RpcEvent[] = [];
    const transfers = createMockTransfers(
      (event) => events.push(event),
      () => 250,
    );
    const transferId = transfers.startExport('conn', {
      database: 'shop',
      collection: 'orders',
      path: '/mock/out.ndjson',
      options: { format: 'ndjson', ejsonMode: 'canonical' },
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(transfers.status(transferId)).toEqual(
      expect.objectContaining({ done: true, processed: 250 }),
    );
    expect(transfers.wroteFile('/mock/out.ndjson')).toBe(true);
    expect(transfers.wroteFile('/mock/other.ndjson')).toBe(false);
  });

  it('ignores a cancel for a transfer that already finished', async () => {
    const transfers = createMockTransfers(
      () => undefined,
      () => undefined,
    );
    const transferId = transfers.startExport('conn', {
      database: 'shop',
      collection: 'orders',
      path: '/mock/out.json',
      options: { format: 'json-array', ejsonMode: 'relaxed' },
    });
    await vi.advanceTimersByTimeAsync(2000);
    transfers.cancel(transferId);
    expect(transfers.status(transferId)?.error).toBeUndefined();
  });

  it('scripts a preview with a rename, a skipped-looking column and empty cells', () => {
    const preview = mockImportPreview();
    expect(preview.fields.map((field) => field.name)).toContain('placed_at');
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.fields.some((field) => field.nullCount > 0)).toBe(true);
  });
});
