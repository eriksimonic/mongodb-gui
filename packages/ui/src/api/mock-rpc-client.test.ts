import { DumpOptionsSchema, RestoreOptionsSchema, type RpcEvent } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { createMockUiApi } from './mock-rpc-client';
import { localConnectionId, mockMasterPassword, stagingConnectionId } from './mock-fixtures';

const connectionInput = {
  name: 'Scratch',
  uri: 'mongodb://localhost:27017/',
};

function collectEvents(api: ReturnType<typeof createMockUiApi>): RpcEvent[] {
  const events: RpcEvent[] = [];
  api.onEvent((event) => events.push(event));
  return events;
}

describe('mock vault', () => {
  it('starts uninitialised with the fresh preset', async () => {
    const api = createMockUiApi();
    expect(await api.rpc.vault.status()).toEqual({ state: 'uninitialised' });
  });

  it('rejects a master password shorter than 4 characters', async () => {
    const api = createMockUiApi();
    await expect(api.rpc.vault.initialise({ password: 'abc' })).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(await api.rpc.vault.status()).toEqual({ state: 'uninitialised' });
  });

  it('initialises and leaves the vault unlocked', async () => {
    const api = createMockUiApi();
    await api.rpc.vault.initialise({ password: 'a long enough password' });
    expect(await api.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
  });

  it('rejects a wrong password on unlock and stays locked', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.vault.lock();
    await expect(api.rpc.vault.unlock({ password: 'not the password' })).rejects.toMatchObject({
      error: { code: 'VAULT_BAD_PASSWORD' },
    });
    expect(await api.rpc.vault.status()).toEqual({ state: 'locked', mode: 'password' });
  });

  it('unlocks with the right password', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.vault.lock();
    await api.rpc.vault.unlock({ password: mockMasterPassword });
    expect(await api.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
  });

  it('refuses connection calls while locked', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.vault.lock();
    await expect(api.rpc.connections.list()).rejects.toMatchObject({
      error: { code: 'VAULT_LOCKED' },
    });
  });

  it('emits vault:locked when the vault locks', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const events = collectEvents(api);
    await api.rpc.vault.lock();
    expect(events).toContainEqual({ type: 'vault:locked' });
  });

  it('changes the password only with the current one', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await expect(
      api.rpc.vault.changePassword({ current: 'wrong password', next: 'another password' }),
    ).rejects.toMatchObject({ error: { code: 'VAULT_BAD_PASSWORD' } });
    await api.rpc.vault.changePassword({
      current: mockMasterPassword,
      next: 'another password',
    });
    await api.rpc.vault.lock();
    await api.rpc.vault.unlock({ password: 'another password' });
    expect(await api.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
  });

  it('reports the mode with each preset', async () => {
    const unlocked = createMockUiApi({ preset: 'unlocked' });
    const device = createMockUiApi({ preset: 'device' });
    const deviceLocked = createMockUiApi({ preset: 'device-locked' });
    expect(await unlocked.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
    expect(await device.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'device' });
    expect(await deviceLocked.rpc.vault.status()).toEqual({ state: 'locked', mode: 'device' });
  });

  it('initialises in device mode when machine encryption is available', async () => {
    const api = createMockUiApi();
    expect(await api.rpc.vault.deviceKeyAvailability()).toEqual({ available: true });
    await api.rpc.vault.initialiseDevice();
    expect(await api.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'device' });
  });

  it('refuses device mode with basic-text and reports the reason', async () => {
    const api = createMockUiApi({ deviceKey: 'basic-text' });
    expect(await api.rpc.vault.deviceKeyAvailability()).toEqual({
      available: false,
      reason: 'basic-text',
    });
    await expect(api.rpc.vault.initialiseDevice()).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
    expect(await api.rpc.vault.status()).toEqual({ state: 'uninitialised' });
  });

  it('unlocks device mode without a password', async () => {
    const api = createMockUiApi({ preset: 'device-locked' });
    await api.rpc.vault.unlockDevice();
    expect(await api.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'device' });
  });

  it('fails device unlock when the mock is set to fail', async () => {
    const api = createMockUiApi({ preset: 'device-locked', deviceUnlock: 'fail' });
    await expect(api.rpc.vault.unlockDevice()).rejects.toMatchObject({
      error: { code: 'INTERNAL', message: 'This machine could not open the vault key.' },
    });
    expect(await api.rpc.vault.status()).toEqual({ state: 'locked', mode: 'device' });
  });

  it('refuses the password unlock in device mode', async () => {
    const api = createMockUiApi({ preset: 'device-locked' });
    await expect(api.rpc.vault.unlock({ password: 'anything' })).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
  });

  it('switches between password and device mode', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await expect(api.rpc.vault.removePassword({ current: 'wrong password' })).rejects.toMatchObject(
      { error: { code: 'VAULT_BAD_PASSWORD' } },
    );
    await api.rpc.vault.removePassword({ current: mockMasterPassword });
    expect(await api.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'device' });
    await api.rpc.vault.setPassword({ password: 'a new password' });
    expect(await api.rpc.vault.status()).toEqual({ state: 'unlocked', mode: 'password' });
  });

  it('returns to uninitialised on reset and drops the data', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.vault.reset({ confirmation: 'DELETE' });
    expect(await api.rpc.vault.status()).toEqual({ state: 'uninitialised' });
  });

  it('requires the literal DELETE to reset', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await expect(api.rpc.vault.reset({ confirmation: 'delete' as 'DELETE' })).rejects.toMatchObject(
      { error: { code: 'VALIDATION' } },
    );
  });
});

describe('mock connections', () => {
  it('lists the two fixture connections with redacted URIs only', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const summaries = await api.rpc.connections.list();
    expect(summaries.map((summary) => summary.name)).toEqual([
      'Local dev',
      'Staging',
      'shop-mongo',
    ]);
    expect(summaries[0]?.uriRedacted).toBe('mongodb://app:***@localhost:27017/?authSource=admin');
    expect(summaries.every((summary) => !('uri' in summary))).toBe(true);
  });

  it('refuses a connection test while the vault is locked', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.vault.lock();
    await expect(api.rpc.connections.test(connectionInput)).rejects.toMatchObject({
      error: { code: 'VAULT_LOCKED' },
    });
  });

  it('creates, updates and removes a connection', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const created = await api.rpc.connections.create(connectionInput);
    const updated = await api.rpc.connections.update({
      id: created.id,
      patch: { name: 'Renamed' },
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.uri).toBe(connectionInput.uri);
    expect(updated.createdAt).toBe(created.createdAt);

    await api.rpc.connections.remove({ id: created.id });
    await expect(api.rpc.connections.get({ id: created.id })).rejects.toMatchObject({
      error: { code: 'CONNECTION_NOT_FOUND' },
    });
  });

  it('clears an optional field when the update sets it to undefined', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const created = await api.rpc.connections.create({
      ...connectionInput,
      tls: { enabled: true },
    });
    const updated = await api.rpc.connections.update({
      id: created.id,
      patch: { ...connectionInput, tls: undefined },
    });
    expect(updated.tls).toBeUndefined();
  });

  it('accepts a test for a localhost URI and fails auth for other hosts', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    expect(await api.rpc.connections.test(connectionInput)).toEqual({
      ok: true,
      serverVersion: '8.0.4',
      topology: 'standalone',
    });
    const remote = await api.rpc.connections.test({
      ...connectionInput,
      uri: 'mongodb://db.example.net/',
    });
    expect(remote.ok).toBe(false);
  });

  it('connects a localhost connection and emits status events', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const events = collectEvents(api);
    const status = await api.rpc.connections.connect({ id: localConnectionId });
    expect(status.state).toBe('connected');
    expect(events.filter((event) => event.type === 'connection:status')).toEqual([
      {
        type: 'connection:status',
        connectionId: localConnectionId,
        status: { state: 'connecting' },
      },
      {
        type: 'connection:status',
        connectionId: localConnectionId,
        status: status,
      },
    ]);
  });

  it('reports an auth error for the remote fixture connection', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const status = await api.rpc.connections.connect({ id: stagingConnectionId });
    expect(status).toMatchObject({ state: 'error', error: { code: 'AUTH_FAILED' } });
  });

  it('disconnects and emits a disconnected status', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const events = collectEvents(api);
    await api.rpc.connections.disconnect({ id: localConnectionId });
    expect(events.filter((event) => event.type === 'connection:status')).toEqual([
      {
        type: 'connection:status',
        connectionId: localConnectionId,
        status: { state: 'disconnected' },
      },
    ]);
  });

  it('rejects a malformed connection id before running the call', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await expect(api.rpc.connections.get({ id: 'abc' })).rejects.toMatchObject({
      error: { code: 'VALIDATION' },
    });
  });
});

describe('mock catalog', () => {
  it('needs a connection before listing databases', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await expect(api.rpc.databases.list({ connectionId: localConnectionId })).rejects.toMatchObject(
      { error: { code: 'NOT_CONNECTED' } },
    );
  });

  it('lists three databases and their collections once connected', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const databases = await api.rpc.databases.list({ connectionId: localConnectionId });
    expect(databases.map((database) => database.name)).toEqual(['shop', 'analytics', 'logs']);

    const collections = await api.rpc.collections.list({
      connectionId: localConnectionId,
      database: 'shop',
    });
    expect(collections.map((collection) => collection.type)).toEqual([
      'collection',
      'collection',
      'view',
      'timeseries',
    ]);
  });

  it('rejects storage stats for a view', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    await expect(
      api.rpc.collections.stats({
        connectionId: localConnectionId,
        database: 'shop',
        collection: 'paid_orders',
      }),
    ).rejects.toMatchObject({ error: { code: 'COMMAND_FAILED' } });
  });

  it('returns collection stats with per-index sizes', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.connections.connect({ id: localConnectionId });
    const stats = await api.rpc.collections.stats({
      connectionId: localConnectionId,
      database: 'shop',
      collection: 'orders',
    });
    expect(stats.ns).toBe('shop.orders');
    expect(Object.keys(stats.indexSizes)).toEqual(['_id_', 'status_1_createdAt_-1']);
  });
});

describe('mock settings, history and favourites', () => {
  it('merges a settings patch into the current settings', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const updated = await api.rpc.settings.update({ theme: 'light' });
    expect(updated.theme).toBe('light');
    expect(updated.idleLockMinutes).toBe(30);
  });

  it('filters history by connection and search text', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const rows = await api.rpc.history.list({ connectionId: localConnectionId, search: 'events' });
    expect(rows.map((row) => row.code)).toEqual(['db.events.countDocuments({})']);
  });

  it('saves and removes a favourite', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const saved = await api.rpc.favourites.save({ name: 'Recent', code: 'db.logs.find()' });
    expect((await api.rpc.favourites.list()).map((item) => item.id)).toContain(saved.id);
    await api.rpc.favourites.remove({ id: saved.id });
    expect((await api.rpc.favourites.list()).map((item) => item.id)).not.toContain(saved.id);
  });

  it('saves, renames and removes a saved backup', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const saved = await api.rpc.savedBackups.save({
      label: 'Nightly',
      connectionId: localConnectionId,
      scope: { kind: 'server' },
      options: DumpOptionsSchema.parse({}),
    });
    await api.rpc.savedBackups.rename({ id: saved.id, label: 'Weekly' });
    expect((await api.rpc.savedBackups.list()).map((item) => item.label)).toEqual(['Weekly']);
    await api.rpc.savedBackups.remove({ id: saved.id });
    expect(await api.rpc.savedBackups.list()).toEqual([]);
  });
});

describe('mock saved restores', () => {
  it('saves, renames, reopens and removes a restore', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const saved = await api.rpc.savedRestores.save({
      name: 'Nightly',
      connectionId: localConnectionId,
      source: '/backups/shop.archive',
      toolsVersion: '100.9.4',
      options: RestoreOptionsSchema.parse({}),
    });
    expect(await api.rpc.savedRestores.list()).toEqual([saved]);
    const renamed = await api.rpc.savedRestores.rename({ id: saved.id, name: 'Weekly' });
    expect(renamed.name).toBe('Weekly');
    expect((await api.rpc.savedRestores.open({ id: saved.id })).path).toBe(saved.source);
    await api.rpc.savedRestores.remove({ id: saved.id });
    expect(await api.rpc.savedRestores.list()).toEqual([]);
    await expect(api.rpc.savedRestores.open({ id: saved.id })).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('mock onEvent', () => {
  it('stops delivering events after unsubscribe', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const events: RpcEvent[] = [];
    const unsubscribe = api.onEvent((event) => events.push(event));
    unsubscribe();
    await api.rpc.vault.lock();
    expect(events).toEqual([]);
  });
});
