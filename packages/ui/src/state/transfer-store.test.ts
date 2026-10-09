import { describe, expect, it } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { createAppStore } from './app-store';
import { emptyProgress } from './transfer-state';

const EXPORT = {
  connectionId: localConnectionId,
  database: 'shop',
  collection: 'orders',
  path: '/mock/orders.csv',
  options: { format: 'ndjson' as const, ejsonMode: 'canonical' as const },
};

async function unlockedStore() {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return createAppStore(api, { vault: 'unlocked' });
}

describe('transfer slice of the app store', () => {
  it('records a started export with its target and then follows its progress events', async () => {
    const store = await unlockedStore();
    const transferId = await store.getState().startTransferExport(EXPORT);

    const view = store.getState().transfers[transferId];
    expect(view).toEqual(
      expect.objectContaining({ kind: 'export', database: 'shop', collection: 'orders' }),
    );

    store.getState().applyEvent({
      type: 'transfer:progress',
      transferId,
      kind: 'export',
      progress: { ...emptyProgress(), processed: 12 },
    });
    expect(store.getState().transfers[transferId]?.progress.processed).toBe(12);
    expect(store.getState().transfers[transferId]?.collection).toBe('orders');
  });

  it('ignores progress that arrives after the vault locked', async () => {
    const store = await unlockedStore();
    store.setState({ vault: 'locked' });
    store.getState().applyEvent({
      type: 'transfer:progress',
      transferId: '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10',
      kind: 'import',
      progress: { ...emptyProgress(), processed: 3 },
    });
    expect(store.getState().transfers).toEqual({});
  });

  it('replaces the transfers with the backend list on refresh', async () => {
    const store = await unlockedStore();
    const transferId = await store.getState().startTransferExport(EXPORT);
    store.setState({ transfers: {} });

    await store.getState().refreshTransfers();
    expect(Object.keys(store.getState().transfers)).toEqual([transferId]);
  });

  it('opens and closes the transfer dialog', async () => {
    const store = await unlockedStore();
    store.getState().setTransferDialog({
      kind: 'import',
      connectionId: localConnectionId,
      database: 'shop',
      collection: undefined,
    });
    expect(store.getState().transferDialog.kind).toBe('import');
    store.getState().setTransferDialog({ kind: 'closed' });
    expect(store.getState().transferDialog).toEqual({ kind: 'closed' });
  });
});
