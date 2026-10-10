// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { createDiagnosticsStore, type DiagnosticsClient } from './diagnostics-store';

const TARGET = { connectionId: localConnectionId };
const REPORTER_SESSION = '1f9c2a4e8b7d4c1a9e3f0a6b2d5c8e71';
const SITE_ADMIN_SESSION = '8c3d1f6a0e9b4d2c8a7f5e1b3d6c0a92';
const CLUSTER_SESSION = '2d6f0b8e3a1c4d7f9b2e6a0c8d4f1e35';

async function storeFor(api: UiApi) {
  return createDiagnosticsStore(TARGET, api.rpc.diagnostics);
}

describe('diagnostics store reads', () => {
  it('stores the global log and the startup warnings under their own kinds', async () => {
    const store = await storeFor(await connectedMockApi());
    await store.getState().loadLog('global');
    await store.getState().loadLog('startupWarnings');

    const state = store.getState();
    expect(state.logs.global.data?.lines.length).toBeGreaterThan(200);
    expect(state.logs.startupWarnings.data?.lines.every((line) => line.severity === 'W')).toBe(
      true,
    );
    expect(state.logs.global.error).toBeUndefined();
  });

  it('reads the parameters, the server status, the host and build, top and pools', async () => {
    const store = await storeFor(await connectedMockApi());
    const state = store.getState();
    await Promise.all([
      state.loadParameters(),
      state.loadServerStatus(),
      state.loadHostAndBuild(),
      state.loadTop(),
      state.loadPools(),
    ]);

    const next = store.getState();
    expect(next.parameters.data?.some((parameter) => parameter.name === 'logLevel')).toBe(true);
    expect(next.serverStatus.data?.stripped).toEqual(['tcmalloc', 'metrics.commands']);
    expect(next.hostAndBuild.data?.build.version).toBe('8.0.4');
    expect(next.hostAndBuild.data?.cmdLine.argv[0]).toBe('mongod');
    expect(next.top.data?.[0]?.ns).toBe('shop.orders');
    expect(next.pools.data?.totalInUse).toBeGreaterThanOrEqual(0);
  });

  it('keeps the last answer and stores the error text when a read fails', async () => {
    const api = await connectedMockApi();
    const store = await storeFor(api);
    await store.getState().loadTop();
    const before = store.getState().top.data;

    await api.rpc.connections.disconnect({ id: localConnectionId });
    await store.getState().loadTop();

    expect(store.getState().top.data).toBe(before);
    expect(store.getState().top.error).toBe('Connect to the server first');
    expect(store.getState().top.loading).toBe(false);
  });
});

describe('diagnostics store sessions', () => {
  it('lists this node by default and every user of the cluster when asked', async () => {
    const store = await storeFor(await connectedMockApi());
    await store.getState().loadSessions();
    expect(store.getState().sessions.data?.scope).toBe('local');
    expect(store.getState().sessions.data?.sessions.map((row) => row.id)).not.toContain(
      CLUSTER_SESSION,
    );

    await store.getState().loadSessions(true);
    expect(store.getState().allUsers).toBe(true);
    expect(store.getState().sessions.data?.sessions.map((row) => row.id)).toContain(
      CLUSTER_SESSION,
    );
  });

  it('ticks and unticks session ids', async () => {
    const store = await storeFor(await connectedMockApi());
    store.getState().toggleSelected(REPORTER_SESSION);
    store.getState().toggleSelected(SITE_ADMIN_SESSION);
    store.getState().toggleSelected(REPORTER_SESSION);

    expect(store.getState().selected).toEqual([SITE_ADMIN_SESSION]);
  });

  it('kills the ticked sessions, clears the selection and reloads the list', async () => {
    const store = await storeFor(await connectedMockApi());
    await store.getState().loadSessions();
    store.getState().toggleSelected(REPORTER_SESSION);
    store.getState().toggleSelected(SITE_ADMIN_SESSION);

    await store.getState().killSelected();

    const ids = store.getState().sessions.data?.sessions.map((row) => row.id) ?? [];
    expect(ids).not.toContain(REPORTER_SESSION);
    expect(ids).not.toContain(SITE_ADMIN_SESSION);
    expect(store.getState().selected).toEqual([]);
  });

  it('kills every session of one user and leaves the other users', async () => {
    const store = await storeFor(await connectedMockApi());
    await store.getState().loadSessions();

    await store.getState().killUserSessions({ user: 'siteAdmin', db: 'admin' });

    const rows = store.getState().sessions.data?.sessions ?? [];
    expect(rows.some((row) => row.name === 'siteAdmin')).toBe(false);
    expect(rows.some((row) => row.name === 'reporter')).toBe(true);
  });

  it('throws the server text for a kill on a connection that is not connected', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const store = await storeFor(api);
    store.getState().toggleSelected(REPORTER_SESSION);

    await expect(store.getState().killSelected()).rejects.toThrow('Connect to the server first');
    expect(store.getState().selected).toEqual([REPORTER_SESSION]);
  });
});

describe('diagnostics store log refresh', () => {
  it('appends the new lines on a refresh and keeps the lines already read', async () => {
    let written = 3;
    const client = {
      getLog: async () => {
        const lines = Array.from({ length: written }, (_, index) => ({
          message: `line ${index}`,
          raw: `line ${index}`,
        }));
        return { kind: 'global' as const, total: written, lines };
      },
    } as unknown as DiagnosticsClient;
    const store = createDiagnosticsStore(TARGET, client);

    await store.getState().loadLog('global');
    const first = store.getState().logs.global.data?.lines[0];
    written = 5;
    await store.getState().loadLog('global');

    const lines = store.getState().logs.global.data?.lines ?? [];
    expect(lines.map((item) => item.message)).toEqual([
      'line 0',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ]);
    expect(lines[0]).toBe(first);
  });
});
