import { describe, expect, it } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { createAppStore } from './app-store';

const SETTLE_MS = 5;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

describe('startMonitor race', () => {
  it('does not apply a start whose reply arrives after the connection dropped', async () => {
    const base = createMockUiApi({ preset: 'unlocked' });
    // The server starts the sampler right away, but its reply is held until the test releases it.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api: UiApi = {
      rpc: {
        ...base.rpc,
        monitor: {
          ...base.rpc.monitor,
          start: async (input) => {
            const config = await base.rpc.monitor.start(input);
            await gate;
            return config;
          },
        },
      },
      onEvent: base.onEvent,
    };
    const store = createAppStore(api);
    const unsubscribe = api.onEvent((event) => {
      store.getState().applyEvent(event);
    });
    await base.rpc.connections.connect({ id: localConnectionId });

    const starting = store.getState().startMonitor(localConnectionId, 1000);
    await settle();
    await base.rpc.connections.disconnect({ id: localConnectionId });
    release();
    await starting;

    expect(store.getState().monitors[localConnectionId]?.config).toBeUndefined();
    expect(await base.rpc.monitor.samples({ connectionId: localConnectionId })).toEqual([]);
    unsubscribe();
  });

  it('keeps the interval chosen before a disconnect for the next start', async () => {
    const base = createMockUiApi({ preset: 'unlocked' });
    const store = createAppStore(base);
    const unsubscribe = base.onEvent((event) => {
      store.getState().applyEvent(event);
    });
    await base.rpc.connections.connect({ id: localConnectionId });
    await store.getState().startMonitor(localConnectionId);
    await store.getState().setMonitorInterval(localConnectionId, 5000);
    await base.rpc.connections.disconnect({ id: localConnectionId });

    expect(store.getState().monitors[localConnectionId]?.config).toBeUndefined();
    expect(store.getState().monitors[localConnectionId]?.preferredIntervalMs).toBe(5000);

    await base.rpc.connections.connect({ id: localConnectionId });
    await store.getState().startMonitor(localConnectionId);
    expect(store.getState().monitors[localConnectionId]?.config?.intervalMs).toBe(5000);
    unsubscribe();
    await base.rpc.monitor.stop({ connectionId: localConnectionId });
  });
});
