import { describe, expect, it } from 'vitest';
import { localConnectionId, mockMasterPassword, stagingConnectionId } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { createAppStore, type AppStore } from './app-store';

async function unlockedStore(): Promise<AppStore> {
  const store = createAppStore(createMockUiApi({ preset: 'unlocked' }));
  await store.getState().refreshVault();
  return store;
}

describe('createAppStore vault', () => {
  it('reads an uninitialised vault and loads no connections', async () => {
    const store = createAppStore(createMockUiApi({ preset: 'fresh' }));
    await store.getState().refreshVault();
    expect(store.getState().vault).toBe('uninitialised');
    expect(store.getState().connections.state).toBe('loading');
  });

  it('loads the connections once the vault is unlocked', async () => {
    const store = await unlockedStore();
    const connections = store.getState().connections;
    expect(store.getState().vault).toBe('unlocked');
    expect(connections.state === 'ready' && connections.data.length).toBe(2);
  });

  it('keeps the vault locked after a wrong password', async () => {
    const store = await unlockedStore();
    await store.getState().lock();
    await expect(store.getState().unlock('wrong password')).rejects.toMatchObject({
      error: { code: 'VAULT_BAD_PASSWORD' },
    });
    expect(store.getState().vault).toBe('locked');
  });

  it('unlocks with the right password and reloads connections', async () => {
    const store = await unlockedStore();
    await store.getState().lock();
    await store.getState().unlock(mockMasterPassword);
    expect(store.getState().vault).toBe('unlocked');
    expect(store.getState().connections.state).toBe('ready');
  });

  it('drops the session when the backend reports vault:locked', async () => {
    const store = await unlockedStore();
    await store.getState().expandConnection(localConnectionId);
    store.getState().applyEvent({ type: 'vault:locked' });
    expect(store.getState().vault).toBe('locked');
    expect(store.getState().expanded).toEqual({});
    expect(store.getState().statuses).toEqual({});
  });

  it('returns to uninitialised after a reset', async () => {
    const store = await unlockedStore();
    await store.getState().reset();
    expect(store.getState().vault).toBe('uninitialised');
  });
});

describe('createAppStore connections', () => {
  it('connects a connection and marks it connected', async () => {
    const store = await unlockedStore();
    await store.getState().connect(localConnectionId);
    expect(store.getState().statuses[localConnectionId]?.state).toBe('connected');
  });

  it('stores the auth error of a connection that fails', async () => {
    const store = await unlockedStore();
    await store.getState().connect(stagingConnectionId);
    expect(store.getState().statuses[stagingConnectionId]).toMatchObject({
      state: 'error',
      error: { code: 'AUTH_FAILED' },
    });
  });

  it('marks a connection disconnected and forgets its cached databases', async () => {
    const store = await unlockedStore();
    await store.getState().expandConnection(localConnectionId);
    await store.getState().loadDatabases(localConnectionId);
    await store.getState().disconnect(localConnectionId);
    expect(store.getState().statuses[localConnectionId]?.state).toBe('disconnected');
    expect(store.getState().databases[localConnectionId]).toBeUndefined();
  });

  it('creates a connection and adds it to the list', async () => {
    const store = await unlockedStore();
    await store.getState().createConnection({ name: 'Scratch', uri: 'mongodb://localhost/' });
    const connections = store.getState().connections;
    expect(connections.state === 'ready' && connections.data.map((item) => item.name)).toEqual([
      'Local dev',
      'Staging',
      'Scratch',
    ]);
  });

  it('removes a connection from the list', async () => {
    const store = await unlockedStore();
    await store.getState().removeConnection(stagingConnectionId);
    const connections = store.getState().connections;
    expect(connections.state === 'ready' && connections.data.map((item) => item.name)).toEqual([
      'Local dev',
    ]);
  });

  it('applies a connection status event', async () => {
    const store = await unlockedStore();
    store.getState().applyEvent({
      type: 'connection:status',
      connectionId: localConnectionId,
      status: { state: 'connecting' },
    });
    expect(store.getState().statuses[localConnectionId]).toEqual({ state: 'connecting' });
  });
});

describe('createAppStore tree loading', () => {
  it('loads three databases once the connection is open', async () => {
    const store = await unlockedStore();
    await store.getState().expandConnection(localConnectionId);
    await store.getState().loadDatabases(localConnectionId);
    const databases = store.getState().databases[localConnectionId];
    expect(databases?.state === 'ready' && databases.data.map((item) => item.name)).toEqual([
      'shop',
      'analytics',
      'logs',
    ]);
  });

  it('records an error when databases are requested while disconnected', async () => {
    const store = await unlockedStore();
    await store.getState().loadDatabases(localConnectionId);
    expect(store.getState().databases[localConnectionId]).toMatchObject({
      state: 'error',
      error: { code: 'NOT_CONNECTED' },
    });
  });

  it('loads the collections of one database with their types', async () => {
    const store = await unlockedStore();
    await store.getState().expandConnection(localConnectionId);
    await store.getState().loadCollections(localConnectionId, 'shop');
    const collections = store.getState().collections[`${localConnectionId}/shop`];
    expect(collections?.state === 'ready' && collections.data.map((item) => item.type)).toEqual([
      'collection',
      'collection',
      'view',
      'timeseries',
    ]);
  });

  it('refreshConnection clears the cached catalog', async () => {
    const store = await unlockedStore();
    await store.getState().expandConnection(localConnectionId);
    await store.getState().loadDatabases(localConnectionId);
    store.getState().refreshConnection(localConnectionId);
    expect(store.getState().databases[localConnectionId]).toBeUndefined();
  });

  it('toggles a node open and closed', () => {
    const store = createAppStore(createMockUiApi({ preset: 'unlocked' }));
    store.getState().setNodeExpanded('conn:x', true);
    expect(store.getState().expanded['conn:x']).toBe(true);
    store.getState().setNodeExpanded('conn:x', false);
    expect(store.getState().expanded['conn:x']).toBe(false);
  });
});
