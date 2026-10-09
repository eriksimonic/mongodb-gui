import { describe, expect, it } from 'vitest';
import type { TransferProgress } from '@mongo-gui/core';
import {
  applyTransferProgress,
  emptyProgress,
  listTransfers,
  registerTransfer,
  transferFraction,
  transfersFromList,
  type TransfersState,
} from './transfer-state';

const ID_A = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const ID_B = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';

function progressOf(overrides: Partial<TransferProgress> = {}): TransferProgress {
  return { ...emptyProgress(), ...overrides };
}

describe('transfer state reducers', () => {
  it('registers a started transfer with its target and no progress yet', () => {
    const next = registerTransfer(
      {},
      {
        transferId: ID_A,
        kind: 'import',
        database: 'shop',
        collection: 'orders',
        path: '/data/orders.csv',
      },
    );
    expect(next[ID_A]).toEqual({
      transferId: ID_A,
      kind: 'import',
      database: 'shop',
      collection: 'orders',
      path: '/data/orders.csv',
      progress: emptyProgress(),
    });
  });

  it('keeps progress that arrived before the start call returned', () => {
    const early = applyTransferProgress(
      {},
      {
        transferId: ID_A,
        kind: 'export',
        progress: progressOf({ processed: 40 }),
      },
    );
    const registered = registerTransfer(early, {
      transferId: ID_A,
      kind: 'export',
      database: 'shop',
      collection: 'orders',
      path: '/data/out.ndjson',
    });
    expect(registered[ID_A]?.progress.processed).toBe(40);
    expect(registered[ID_A]?.database).toBe('shop');
  });

  it('replaces the progress of a known transfer and leaves its target alone', () => {
    const started = registerTransfer(
      {},
      {
        transferId: ID_A,
        kind: 'import',
        database: 'shop',
        collection: 'orders',
        path: '/data/orders.csv',
      },
    );
    const next = applyTransferProgress(started, {
      transferId: ID_A,
      kind: 'import',
      progress: progressOf({ processed: 10, inserted: 10 }),
    });
    expect(next[ID_A]?.progress.inserted).toBe(10);
    expect(next[ID_A]?.collection).toBe('orders');
    expect(started[ID_A]?.progress.processed).toBe(0);
  });

  it('builds the state from the backend list', () => {
    const state = transfersFromList([
      {
        transferId: ID_B,
        kind: 'export',
        database: 'shop',
        collection: 'orders',
        path: '/data/out.json',
        progress: progressOf({ processed: 5, done: true }),
      },
    ]);
    expect(Object.keys(state)).toEqual([ID_B]);
    expect(state[ID_B]?.progress.done).toBe(true);
  });

  it('lists running transfers before finished ones and keeps start order inside each group', () => {
    const base = transfersFromList([]);
    const state: TransfersState = [ID_A, ID_B, 'c'].reduce<TransfersState>((acc, id, index) => {
      return applyTransferProgress(acc, {
        transferId: id,
        kind: 'import',
        progress: progressOf({ done: index === 0 }),
      });
    }, base);
    expect(listTransfers(state).map((view) => view.transferId)).toEqual([ID_B, 'c', ID_A]);
  });

  it('gives a fraction only when the byte total is known', () => {
    expect(transferFraction(progressOf())).toBeUndefined();
    expect(transferFraction(progressOf({ bytesRead: 50, bytesTotal: 200 }))).toBe(0.25);
    expect(transferFraction(progressOf({ bytesRead: 300, bytesTotal: 200 }))).toBe(1);
    expect(transferFraction(progressOf({ bytesRead: 10, bytesTotal: 0 }))).toBeUndefined();
  });
});
