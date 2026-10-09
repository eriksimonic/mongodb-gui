import { describe, expect, it } from 'vitest';
import { groupByShape, shapeKey, type RpcEvent } from '@mongo-gui/core';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { createProfilerStore, type ProfilerStore } from './profiler-store';

const PANEL = 'profiler:local/shop';

async function openStore(api?: UiApi): Promise<{ store: ProfilerStore; api: UiApi }> {
  const backend = api ?? createMockUiApi({ preset: 'unlocked' });
  await backend.rpc.connections.connect({ id: localConnectionId });
  const store = createProfilerStore(backend);
  await store.getState().open(PANEL, localConnectionId, 'shop');
  return { store, api: backend };
}

describe('profiler store', () => {
  it('opens a panel with its entries, shapes and level', async () => {
    const { store } = await openStore();
    const panel = store.getState().panels[PANEL];
    expect(panel?.entries.length).toBeGreaterThan(0);
    expect(panel?.shapes).toEqual(groupByShape(panel?.entries ?? []));
    expect(panel?.level?.level).toBe(1);
  });

  it('stops the tail with a notice when the connection leaves the connected state', async () => {
    const { store } = await openStore();
    await store.getState().setTailEnabled(PANEL, true);
    expect(store.getState().panels[PANEL]?.tailEnabled).toBe(true);

    const event: RpcEvent = {
      type: 'connection:status',
      connectionId: localConnectionId,
      status: { state: 'disconnected' },
    };
    store.getState().applyEvent(event);

    const panel = store.getState().panels[PANEL];
    expect(panel?.tailEnabled).toBe(false);
    expect(panel?.tailError?.message).toBe('The connection closed.');
  });

  it('leaves a tail running when another connection changes state', async () => {
    const { store } = await openStore();
    await store.getState().setTailEnabled(PANEL, true);
    store.getState().applyEvent({
      type: 'connection:status',
      connectionId: '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6',
      status: { state: 'disconnected' },
    });
    expect(store.getState().panels[PANEL]?.tailEnabled).toBe(true);
    await store.getState().setTailEnabled(PANEL, false);
  });

  it('clears a selected row that a shape filter hides', async () => {
    const { store } = await openStore();
    const entries = store.getState().panels[PANEL]?.entries ?? [];
    const first = entries[0];
    const other = entries.find((entry) => shapeKey(entry) !== shapeKey(first ?? entry));
    expect(first).toBeDefined();
    expect(other).toBeDefined();

    store.getState().select(PANEL, first?.id);
    store.getState().setShapeFilter(PANEL, other === undefined ? undefined : shapeKey(other));
    expect(store.getState().panels[PANEL]?.selectedId).toBeUndefined();
  });

  it('keeps a selected row that the shape filter still shows', async () => {
    const { store } = await openStore();
    const entries = store.getState().panels[PANEL]?.entries ?? [];
    const first = entries[0];
    expect(first).toBeDefined();

    store.getState().select(PANEL, first?.id);
    store.getState().setShapeFilter(PANEL, first === undefined ? undefined : shapeKey(first));
    expect(store.getState().panels[PANEL]?.selectedId).toBe(first?.id);
  });

  it('toggles the optional columns and keeps the others', async () => {
    const { store } = await openStore();
    store.getState().setColumn(PANEL, 'client', true);
    expect(store.getState().panels[PANEL]?.columns).toEqual({ client: true, error: false });
    store.getState().setColumn(PANEL, 'client', false);
    expect(store.getState().panels[PANEL]?.columns).toEqual({ client: false, error: false });
  });

  it('forgets the panel when it closes', async () => {
    const { store } = await openStore();
    await store.getState().close(PANEL);
    expect(store.getState().panels[PANEL]).toBeUndefined();
  });
});
