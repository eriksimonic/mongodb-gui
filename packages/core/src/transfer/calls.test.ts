import { describe, expect, it } from 'vitest';
import { rpcContract } from '../rpc/contract';
import { RpcEventSchema } from '../schemas/events';
import {
  DialogResultSchema,
  OpenDialogInputSchema,
  PreviewImportInputSchema,
  SaveDialogInputSchema,
  ShowItemInFolderInputSchema,
  StartExportInputSchema,
  StartImportInputSchema,
  TransferSummarySchema,
} from './calls';

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const TRANSFER_ID = '7a1d2e3f-4b5c-4d6e-8f70-1a2b3c4d5e6f';

describe('transfer call schemas', () => {
  it('requires a connection id and an absolute path for a preview', () => {
    const ok = { connectionId: CONNECTION_ID, path: '/data/orders.csv' };
    expect(PreviewImportInputSchema.safeParse(ok).success).toBe(true);
    expect(PreviewImportInputSchema.safeParse({ ...ok, connectionId: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(PreviewImportInputSchema.safeParse({ ...ok, path: 'orders.csv' }).success).toBe(false);
  });

  it('applies the preview defaults for sampleRows', () => {
    const parsed = PreviewImportInputSchema.parse({
      connectionId: CONNECTION_ID,
      path: '/data/orders.csv',
    });
    expect(parsed.sampleRows).toBe(100);
  });

  it('applies the import defaults for mode, batch size and stopOnError', () => {
    const parsed = StartImportInputSchema.parse({
      connectionId: CONNECTION_ID,
      database: 'shop',
      collection: 'orders',
      path: '/data/orders.ndjson',
      options: { format: 'ndjson' },
    });
    expect(parsed.options).toEqual(
      expect.objectContaining({
        mode: 'insert',
        upsertKey: '_id',
        batchSize: 500,
        stopOnError: false,
      }),
    );
  });

  it('refuses an import batch size above the maximum', () => {
    const result = StartImportInputSchema.safeParse({
      connectionId: CONNECTION_ID,
      database: 'shop',
      collection: 'orders',
      path: '/data/orders.ndjson',
      options: { format: 'ndjson', batchSize: 5001 },
    });
    expect(result.success).toBe(false);
  });

  it('requires an export format and accepts the EJSON mode', () => {
    const base = {
      connectionId: CONNECTION_ID,
      database: 'shop',
      collection: 'orders',
      path: '/data/out.csv',
    };
    expect(
      StartExportInputSchema.safeParse({
        ...base,
        options: { format: 'csv', ejsonMode: 'relaxed' },
      }).success,
    ).toBe(true);
    expect(StartExportInputSchema.safeParse({ ...base, options: { format: 'xml' } }).success).toBe(
      false,
    );
    expect(
      StartExportInputSchema.safeParse({
        ...base,
        options: { format: 'json-array', ejsonMode: 'strict' },
      }).success,
    ).toBe(false);
  });

  it('describes a transfer summary with its progress', () => {
    const summary = {
      transferId: TRANSFER_ID,
      kind: 'export',
      database: 'shop',
      collection: 'orders',
      path: '/data/out.ndjson',
      progress: {
        processed: 100,
        inserted: 0,
        updated: 0,
        matched: 0,
        failed: 0,
        elapsedMs: 12,
        done: true,
        errors: [],
        warnings: [],
      },
    };
    expect(TransferSummarySchema.safeParse(summary).success).toBe(true);
    expect(TransferSummarySchema.safeParse({ ...summary, kind: 'copy' }).success).toBe(false);
  });

  it('accepts a dialog filter with plain extensions only', () => {
    const open = {
      title: 'Choose a file',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    };
    expect(OpenDialogInputSchema.safeParse(open).success).toBe(true);
    expect(
      OpenDialogInputSchema.safeParse({
        ...open,
        filters: [{ name: 'Any', extensions: ['*'] }],
      }).success,
    ).toBe(false);
    expect(
      SaveDialogInputSchema.safeParse({ ...open, defaultPath: '/data/shop.orders.csv' }).success,
    ).toBe(true);
  });

  it('returns only an absolute path from a dialog, and nothing when cancelled', () => {
    expect(DialogResultSchema.safeParse({ path: '/data/orders.csv' }).success).toBe(true);
    expect(DialogResultSchema.safeParse({ path: 'orders.csv' }).success).toBe(false);
    expect(DialogResultSchema.safeParse({}).success).toBe(true);
  });

  it('refuses a relative path to show in its folder', () => {
    expect(ShowItemInFolderInputSchema.safeParse({ path: '../secret' }).success).toBe(false);
  });

  it('declares the transfer namespace and its events in the contract', () => {
    expect(Object.keys(rpcContract.transfer).sort()).toEqual(
      ['cancel', 'list', 'previewImport', 'startExport', 'startImport', 'status'].sort(),
    );
    expect(
      RpcEventSchema.safeParse({
        type: 'transfer:progress',
        transferId: TRANSFER_ID,
        kind: 'import',
        progress: {
          processed: 1,
          inserted: 1,
          updated: 0,
          matched: 0,
          failed: 0,
          elapsedMs: 3,
          done: false,
          errors: [],
          warnings: [],
        },
      }).success,
    ).toBe(true);
  });
});
