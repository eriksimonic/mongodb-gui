import { findPanel, dashboardLayoutKey, defaultDashboardLayout } from '@mongo-gui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { DASHBOARD_SAVE_DELAY_MS, RESET_NOTICE } from './dashboard-state';
import { createAppStore, type AppStore } from './app-store';

const KEY = dashboardLayoutKey(localConnectionId);

async function unlockedStore(api: UiApi): Promise<AppStore> {
  const store = createAppStore(api);
  await store.getState().refreshVault();
  return store;
}

function specOf(id: string) {
  const spec = findPanel(id);
  if (spec === undefined) {
    throw new Error(`missing panel ${id}`);
  }
  return spec;
}

describe('dashboard store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the default layout until the saved one is read, and then the saved one', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const store = await unlockedStore(api);
    await api.rpc.layout.set({
      key: KEY,
      value: { version: 1, panels: [{ id: 'memory', w: 2, h: 2 }] },
    });
    expect(store.getState().dashboards[localConnectionId]).toBeUndefined();

    await store.getState().loadDashboard(localConnectionId);

    const view = store.getState().dashboards[localConnectionId];
    expect(view?.loaded).toBe(true);
    expect(view?.layout.panels).toEqual([{ id: 'memory', w: 2, h: 2 }]);
  });

  it('uses the default layout when nothing is stored', async () => {
    const store = await unlockedStore(createMockUiApi({ preset: 'unlocked' }));
    await store.getState().loadDashboard(localConnectionId);
    expect(store.getState().dashboards[localConnectionId]?.layout).toEqual(
      defaultDashboardLayout(),
    );
  });

  it('saves one debounced write after a burst of changes', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const set = vi.spyOn(api.rpc.layout, 'set');
    const store = await unlockedStore(api);
    await store.getState().loadDashboard(localConnectionId);

    store.getState().addDashboardPanel(localConnectionId, specOf('memory'));
    store.getState().resizeDashboardPanel(localConnectionId, 'memory', { w: 2 });
    store.getState().removeDashboardPanel(localConnectionId, 'queues');
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DASHBOARD_SAVE_DELAY_MS + 50);

    expect(set).toHaveBeenCalledTimes(1);
    const call = set.mock.calls[0]?.[0];
    expect(call?.key).toBe(KEY);
    expect(call?.value).toEqual(store.getState().dashboards[localConnectionId]?.layout);
  });

  it('does not save a layout that has not been read yet', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const set = vi.spyOn(api.rpc.layout, 'set');
    const store = await unlockedStore(api);

    store.getState().removeDashboardPanel(localConnectionId, 'queues');
    await vi.advanceTimersByTimeAsync(DASHBOARD_SAVE_DELAY_MS + 50);

    expect(set).not.toHaveBeenCalled();
  });

  it('keeps the edited layout and records the error when a save fails', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    vi.spyOn(api.rpc.layout, 'set').mockRejectedValue(new Error('disk full'));
    const store = await unlockedStore(api);
    await store.getState().loadDashboard(localConnectionId);

    store.getState().removeDashboardPanel(localConnectionId, 'queues');
    await vi.advanceTimersByTimeAsync(DASHBOARD_SAVE_DELAY_MS + 50);

    const view = store.getState().dashboards[localConnectionId];
    expect(view?.error?.message).toBe('disk full');
    expect(view?.layout.panels.map((item) => item.id)).not.toContain('queues');
  });

  it('records a failed read and keeps saves off', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    vi.spyOn(api.rpc.layout, 'get').mockRejectedValue(new Error('read failed'));
    const set = vi.spyOn(api.rpc.layout, 'set');
    const store = await unlockedStore(api);

    await store.getState().loadDashboard(localConnectionId);
    store.getState().resetDashboard(localConnectionId);
    await vi.advanceTimersByTimeAsync(DASHBOARD_SAVE_DELAY_MS + 50);

    const view = store.getState().dashboards[localConnectionId];
    expect(view?.loaded).toBe(false);
    expect(view?.error?.message).toBe('read failed');
    expect(set).not.toHaveBeenCalled();
  });

  it('resets to the default layout and saves it', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const set = vi.spyOn(api.rpc.layout, 'set');
    const store = await unlockedStore(api);
    await store.getState().loadDashboard(localConnectionId);
    store.getState().removeDashboardPanel(localConnectionId, 'queues');
    store.getState().resetDashboard(localConnectionId);
    await vi.advanceTimersByTimeAsync(DASHBOARD_SAVE_DELAY_MS + 50);

    expect(store.getState().dashboards[localConnectionId]?.layout).toEqual(
      defaultDashboardLayout(),
    );
    expect(set).toHaveBeenLastCalledWith({ key: KEY, value: defaultDashboardLayout() });
  });

  it('moves a panel and keeps the layout order in the saved value', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const store = await unlockedStore(api);
    await store.getState().loadDashboard(localConnectionId);
    store.getState().moveDashboardPanel(localConnectionId, 'replication-lag', 'operations-by-type');
    const ids = store
      .getState()
      .dashboards[localConnectionId]?.layout.panels.map((item) => item.id);
    expect(ids?.[0]).toBe('replication-lag');
  });

  it('replays an edit made while the saved layout is still loading on top of that layout', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const stored = {
      version: 1,
      panels: [
        { id: 'memory', w: 2, h: 2 },
        { id: 'queues', w: 1, h: 1 },
      ],
    } as const;
    let resolveRead: (result: { value: unknown }) => void = () => undefined;
    const pendingRead = new Promise<{ value: unknown }>((resolve) => {
      resolveRead = resolve;
    });
    // Other features (the editor tabs) read their own layout keys; only the dashboard read is held.
    const readLayout = api.rpc.layout.get.bind(api.rpc.layout);
    vi.spyOn(api.rpc.layout, 'get').mockImplementation((input) =>
      input.key === dashboardLayoutKey(localConnectionId) ? pendingRead : readLayout(input),
    );
    const store = await unlockedStore(api);

    const loading = store.getState().loadDashboard(localConnectionId);
    store.getState().removeDashboardPanel(localConnectionId, 'connections');
    resolveRead({ value: stored });
    await loading;

    const view = store.getState().dashboards[localConnectionId];
    expect(view?.loaded).toBe(true);
    expect(view?.layout).toEqual(stored);
    expect(view?.notice).toBeUndefined();
  });

  it('resets a stored layout that fails the schema, warns without the value, and says so', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const secret = 'panel-id-that-must-not-be-logged';
    vi.spyOn(api.rpc.layout, 'get').mockResolvedValue({
      value: { version: 1, panels: [{ id: secret, w: 4, h: 1 }] },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await unlockedStore(api);

    await store.getState().loadDashboard(localConnectionId);

    const view = store.getState().dashboards[localConnectionId];
    expect(view?.layout).toEqual(defaultDashboardLayout());
    expect(view?.notice).toBe(RESET_NOTICE);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain(KEY);
    expect(message).toContain('panels.0.w');
    expect(message).not.toContain(secret);
    warn.mockRestore();
  });

  it('clears the reset notice on the next change', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    vi.spyOn(api.rpc.layout, 'get').mockResolvedValue({ value: { version: 9 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await unlockedStore(api);
    await store.getState().loadDashboard(localConnectionId);

    store.getState().removeDashboardPanel(localConnectionId, 'queues');

    expect(store.getState().dashboards[localConnectionId]?.notice).toBeUndefined();
    warn.mockRestore();
  });
});
