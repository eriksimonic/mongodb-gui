import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorException, appError } from '@mongo-gui/core';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { bridgeProfilerExplain } from '../explain/profiler-explain-bridge';
import { fixtureProfileEntries } from '../api/mock-profiler-fixtures';
import { profilerUiEvents } from '../profiler/profiler-events';
import { createAppStore, type AppStore } from './app-store';

const FIND_CODE = `db.orders.find({ status: 'paid' }).sort({ createdAt: -1 })`;

async function connectedStore(api: UiApi = createMockUiApi({ preset: 'unlocked' })) {
  const store: AppStore = createAppStore(api);
  await store.getState().refreshVault();
  await store.getState().connect(localConnectionId);
  return store;
}

describe('openExplain', () => {
  it('opens a panel titled with the collection and runs at executionStats', async () => {
    const store = await connectedStore();
    const id = await store.getState().openExplain({
      connectionId: localConnectionId,
      database: 'shop',
      code: FIND_CODE,
    });
    const panel = store.getState().explainPanels[id];
    expect(panel?.title).toBe('Explain · orders');
    expect(panel?.collection).toBe('orders');
    expect(panel?.request.verbosity).toBe('executionStats');
    expect(panel?.outcome.state).toBe('ready');
  });

  it('focuses the existing panel for the same statement instead of opening another', async () => {
    const store = await connectedStore();
    const request = { connectionId: localConnectionId, database: 'shop', code: FIND_CODE };
    const first = await store.getState().openExplain(request);
    const focusBefore = store.getState().explainFocus?.serial ?? 0;
    const second = await store.getState().openExplain(request);
    expect(second).toBe(first);
    expect(Object.keys(store.getState().explainPanels)).toHaveLength(1);
    expect(store.getState().explainFocus).toEqual({ id: first, serial: focusBefore + 1 });
  });

  it('refuses a statement that is not one collection query without calling the server', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const run = vi.spyOn(api.rpc.explain, 'run');
    const store = await connectedStore(api);
    const id = await store.getState().openExplain({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'db.orders.find().toArray()',
    });
    const panel = store.getState().explainPanels[id];
    expect(panel?.title).toBe('Explain');
    expect(panel?.collection).toBeUndefined();
    expect(panel?.outcome.state).toBe('refused');
    expect(run).not.toHaveBeenCalled();
  });

  it('stores the server error of a run that fails', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    vi.spyOn(api.rpc.explain, 'run').mockRejectedValueOnce(
      new AppErrorException(appError('VALIDATION', 'Explain needs one collection query')),
    );
    const store = await connectedStore(api);
    const id = await store.getState().openExplain({
      connectionId: localConnectionId,
      database: 'shop',
      code: FIND_CODE,
    });
    expect(store.getState().explainPanels[id]?.outcome).toMatchObject({
      state: 'error',
      error: { code: 'VALIDATION', message: 'Explain needs one collection query' },
    });
  });
});

describe('openExplainCommand', () => {
  it('titles the panel with the collection of the first key and runs the command', async () => {
    const store = await connectedStore();
    const commandEjson = JSON.stringify({ find: 'orders', filter: { status: 'paid' } });
    const id = await store.getState().openExplainCommand({
      connectionId: localConnectionId,
      database: 'shop',
      commandEjson,
    });
    const panel = store.getState().explainPanels[id];
    expect(panel?.title).toBe('Explain · orders');
    expect(panel?.request.source).toEqual({ kind: 'command', commandEjson });
    expect(panel?.request.verbosity).toBe('executionStats');
    expect(panel?.outcome.state).toBe('ready');
  });

  it('calls explain.runCommand with the captured command', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const runCommand = vi.spyOn(api.rpc.explain, 'runCommand');
    const store = await connectedStore(api);
    const commandEjson = JSON.stringify({ find: 'orders', filter: {} });
    await store.getState().openExplainCommand({
      connectionId: localConnectionId,
      database: 'shop',
      commandEjson,
    });
    expect(runCommand).toHaveBeenCalledWith({
      connectionId: localConnectionId,
      database: 'shop',
      commandEjson,
      verbosity: 'executionStats',
    });
  });
});

describe('profiler explain bridge', () => {
  let unbridge: (() => void) | undefined;

  afterEach(() => {
    unbridge?.();
    unbridge = undefined;
  });

  it('opens an explain panel when the profiler emits profiler:explain', async () => {
    const store = await connectedStore();
    unbridge = bridgeProfilerExplain(store);
    const entry = fixtureProfileEntries(Date.now())[0];
    if (entry === undefined) {
      throw new Error('no profiler fixture entries');
    }
    profilerUiEvents.emit({
      type: 'profiler:explain',
      ref: {
        connectionId: localConnectionId,
        database: 'shop',
        entry,
        command: { find: 'orders', filter: { status: 'paid' } },
      },
    });
    await vi.waitFor(() => {
      expect(Object.values(store.getState().explainPanels)).toHaveLength(1);
    });
    const [panel] = Object.values(store.getState().explainPanels);
    expect(panel?.title).toBe('Explain · orders');
    await vi.waitFor(() => {
      expect(store.getState().explainPanels[panel?.id ?? '']?.outcome.state).toBe('ready');
    });
  });
});

describe('rerunExplain', () => {
  it('changes the verbosity, keeps the rest of the request, and updates the same panel', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const run = vi.spyOn(api.rpc.explain, 'run');
    const store = await connectedStore(api);
    const id = await store.getState().openExplain({
      connectionId: localConnectionId,
      database: 'shop',
      code: FIND_CODE,
    });
    await store.getState().rerunExplain(id, 'queryPlanner');
    const panel = store.getState().explainPanels[id];
    expect(Object.keys(store.getState().explainPanels)).toEqual([id]);
    expect(panel?.request).toEqual({
      connectionId: localConnectionId,
      database: 'shop',
      source: { kind: 'statement', code: FIND_CODE },
      verbosity: 'queryPlanner',
    });
    expect(run).toHaveBeenLastCalledWith({
      connectionId: localConnectionId,
      database: 'shop',
      code: FIND_CODE,
      verbosity: 'queryPlanner',
    });
    expect(panel?.outcome.state).toBe('ready');
  });

  it('re-runs at the same verbosity when none is given', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const run = vi.spyOn(api.rpc.explain, 'run');
    const store = await connectedStore(api);
    const id = await store.getState().openExplain({
      connectionId: localConnectionId,
      database: 'shop',
      code: FIND_CODE,
    });
    await store.getState().rerunExplain(id);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ verbosity: 'executionStats' }));
  });

  it('does nothing for a panel that is not open', async () => {
    const store = await connectedStore();
    await store.getState().rerunExplain('explain:missing', 'queryPlanner');
    expect(store.getState().explainPanels).toEqual({});
  });
});

describe('closeExplainPanel', () => {
  it('forgets the panel', async () => {
    const store = await connectedStore();
    const id = await store.getState().openExplain({
      connectionId: localConnectionId,
      database: 'shop',
      code: FIND_CODE,
    });
    store.getState().closeExplainPanel(id);
    expect(store.getState().explainPanels).toEqual({});
  });
});
