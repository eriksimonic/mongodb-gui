// @vitest-environment jsdom
import { AppErrorException, appError } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { createMockUiApi } from '../api/mock-rpc-client';
import { localConnectionId } from '../api/mock-fixtures';
import type { UiApi } from '../api/ui-api';
import { createSecurityStore } from './security-store';

const TARGET = { connectionId: localConnectionId, database: 'shop' };

async function loadedStore(api: UiApi) {
  const store = createSecurityStore(TARGET, api.rpc.security);
  await store.getState().load();
  return store;
}

describe('security store', () => {
  it('loads the users, the roles and the built-in roles of the admin database', async () => {
    const store = await loadedStore(await connectedMockApi());
    const state = store.getState();

    expect(state.users?.map((user) => user.user)).toEqual(['reporter']);
    expect(state.roles?.some((role) => role.role === 'analyst' && !role.isBuiltin)).toBe(true);
    expect(state.roleCatalog.some((role) => role.role === 'root' && role.db === 'admin')).toBe(
      true,
    );
    expect(state.roleCatalog.some((role) => role.role === 'analyst' && role.db === 'shop')).toBe(
      true,
    );
    expect(state.capabilities).toEqual({
      canCreateUsers: true,
      canGrantRoles: true,
      canManageRoles: true,
    });
    expect(state.actions?.queryAndWrite).toContain('find');
    expect(state.loadError).toBeUndefined();
  });

  it('creates a user, reloads the list, and keeps the password out of the state', async () => {
    const store = await loadedStore(await connectedMockApi());
    await store.getState().createUser({
      db: 'shop',
      user: 'etl',
      password: 'correct horse battery',
      roles: [{ role: 'readWrite', db: 'shop' }],
      mechanisms: ['SCRAM-SHA-256'],
    });

    const created = store.getState().users?.find((user) => user.user === 'etl');
    expect(created?.roles).toEqual([{ role: 'readWrite', db: 'shop' }]);
    expect(JSON.stringify(store.getState())).not.toContain('correct horse battery');
  });

  it('throws the server message when a user already exists', async () => {
    const store = await loadedStore(await connectedMockApi());
    const attempt = store.getState().createUser({
      db: 'shop',
      user: 'reporter',
      password: 'another password',
      roles: [],
    });

    await expect(attempt).rejects.toBeInstanceOf(AppErrorException);
    await expect(attempt).rejects.toMatchObject({ error: { message: 'User already exists' } });
  });

  it('grants and revokes roles of a user', async () => {
    const store = await loadedStore(await connectedMockApi());
    await store.getState().grantRoles({
      db: 'shop',
      user: 'reporter',
      roles: [{ role: 'readWrite', db: 'shop' }],
    });
    expect(userRoles(store, 'reporter')).toEqual(['analyst@shop', 'readWrite@shop']);

    await store.getState().revokeRoles({
      db: 'shop',
      user: 'reporter',
      roles: [{ role: 'analyst', db: 'shop' }],
    });
    expect(userRoles(store, 'reporter')).toEqual(['readWrite@shop']);
  });

  it('drops a user and removes it from the list', async () => {
    const store = await loadedStore(await connectedMockApi());
    await store.getState().dropUser({ db: 'shop', user: 'reporter' });

    expect(store.getState().users).toEqual([]);
  });

  it('refuses to create or change a built-in role, with the adapter message', async () => {
    const store = await loadedStore(await connectedMockApi());

    await expect(
      store.getState().createRole({ db: 'shop', role: 'read', privileges: [], roles: [] }),
    ).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    await expect(store.getState().dropRole({ db: 'admin', role: 'root' })).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
  });

  it('creates, updates and drops a custom role', async () => {
    const store = await loadedStore(await connectedMockApi());
    await store.getState().createRole({
      db: 'shop',
      role: 'courier',
      privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find'] }],
      roles: [],
    });
    expect(
      store.getState().roles?.find((role) => role.role === 'courier')?.privileges,
    ).toHaveLength(1);

    await store.getState().updateRole({
      db: 'shop',
      role: 'courier',
      privileges: [],
    });
    expect(store.getState().roles?.find((role) => role.role === 'courier')?.privileges).toEqual([]);

    await store.getState().dropRole({ db: 'shop', role: 'courier' });
    expect(store.getState().roles?.some((role) => role.role === 'courier')).toBe(false);
  });

  it('reads the signed-in user, for the self-revoke warning', async () => {
    const store = await loadedStore(await connectedMockApi());

    expect(store.getState().signedIn).toEqual([{ user: 'siteAdmin', db: 'admin' }]);
  });

  it('reads every capability as false for a viewer with no user or role rights', async () => {
    const api = await connectedMockApi();
    const viewer = createMockUiApi({ preset: 'unlocked', security: 'viewer' });
    await viewer.rpc.connections.connect({ id: localConnectionId });
    const store = await loadedStore(viewer);

    expect(store.getState().capabilities).toEqual({
      canCreateUsers: false,
      canGrantRoles: false,
      canManageRoles: false,
    });
    expect(api).toBeDefined();
  });

  it('refuses a role that inherits itself, on create and on update', async () => {
    const store = await loadedStore(await connectedMockApi());

    await expect(
      store.getState().createRole({
        db: 'shop',
        role: 'courier',
        privileges: [],
        roles: [{ role: 'courier', db: 'shop' }],
      }),
    ).rejects.toMatchObject({ error: { message: 'A role cannot inherit itself' } });
    await expect(
      store.getState().updateRole({
        db: 'shop',
        role: 'analyst',
        roles: [{ role: 'analyst', db: 'shop' }],
      }),
    ).rejects.toMatchObject({ error: { message: 'A role cannot inherit itself' } });
  });

  it('keeps the last lists and reports the error when a load fails', async () => {
    const api = await connectedMockApi();
    const store = await loadedStore(api);
    vi.spyOn(api.rpc.security, 'listUsers').mockRejectedValueOnce(
      new AppErrorException(appError('COMMAND_FAILED', 'Not allowed to list users')),
    );

    await store.getState().load();

    expect(store.getState().loadError).toBe('Not allowed to list users');
    expect(store.getState().users?.map((user) => user.user)).toEqual(['reporter']);
  });
});

function userRoles(store: ReturnType<typeof createSecurityStore>, user: string): string[] {
  const found = store.getState().users?.find((item) => item.user === user);
  return (found?.roles ?? []).map((ref) => `${ref.role}@${ref.db}`).sort();
}
