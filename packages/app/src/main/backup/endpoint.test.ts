import { describe, expect, it, vi } from 'vitest';
import {
  AppErrorException,
  appError,
  type ConnectionProfile,
  type ConnectionStatus,
} from '@mongo-gui/core';
import { resolveToolsEndpoint, uriPasswords, type ToolsEndpointDeps } from './endpoint';

const ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const CONNECTED: ConnectionStatus = {
  state: 'connected',
  serverVersion: '8.0.17',
  topology: 'replicaSet',
  setName: 'rs0',
  hosts: ['db1:27017'],
};

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: ID,
    name: 'Shop',
    uri: 'mongodb://app:s3cret%2Fpass@db1:27017/shop?replicaSet=rs0',
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
    ...overrides,
  };
}

function deps(overrides: Partial<ToolsEndpointDeps> = {}): ToolsEndpointDeps {
  return {
    status: () => CONNECTED,
    getProfile: () => profile(),
    ...overrides,
  };
}

describe('resolveToolsEndpoint', () => {
  it('refuses a connection that is not connected', async () => {
    const getProfile = vi.fn(() => profile());
    const failure = resolveToolsEndpoint(
      deps({ status: () => ({ state: 'disconnected' }), getProfile }),
      ID,
    );
    await expect(failure).rejects.toMatchObject({ error: { code: 'NOT_CONNECTED' } });
    expect(getProfile).not.toHaveBeenCalled();
  });

  it('passes a store error through', async () => {
    const locked = new AppErrorException(appError('VAULT_LOCKED', 'Locked'));
    const failure = resolveToolsEndpoint(
      deps({
        getProfile: () => {
          throw locked;
        },
      }),
      ID,
    );
    await expect(failure).rejects.toBe(locked);
  });

  it('builds the tools URI and lists every form of the secret', async () => {
    const endpoint = await resolveToolsEndpoint(deps(), ID, { readPreference: 'secondary' });
    expect(endpoint.uri).toBe(
      'mongodb://app:s3cret%2Fpass@db1:27017/?replicaSet=rs0&authSource=shop&readPreference=secondary',
    );
    expect(endpoint.profileName).toBe('Shop');
    expect(endpoint.readPreference).toBe('secondary');
    expect(endpoint.status).toBe(CONNECTED);
    expect(endpoint.secrets).toEqual(
      expect.arrayContaining([profile().uri, endpoint.uri, 's3cret%2Fpass', 's3cret/pass']),
    );
    expect(endpoint.docker).toBeUndefined();
  });

  it('defaults the read preference to the profile, then primary', async () => {
    const fromProfile = await resolveToolsEndpoint(
      deps({ getProfile: () => profile({ readPreference: 'nearest' }) }),
      ID,
    );
    expect(fromProfile.readPreference).toBe('nearest');
    const plain = await resolveToolsEndpoint(deps(), ID);
    expect(plain.readPreference).toBe('primary');
  });

  it('adds the container of a docker profile', async () => {
    const dockerSummary = vi.fn(async () => ({
      containerName: 'mongo-dev',
      image: 'mongo:8.0.17',
    }));
    const endpoint = await resolveToolsEndpoint(
      deps({ getProfile: () => profile({ source: 'docker' }), dockerSummary }),
      ID,
    );
    expect(endpoint.docker).toEqual({ containerName: 'mongo-dev', image: 'mongo:8.0.17' });
  });

  it('skips the container details when Docker fails or the profile is manual', async () => {
    const failing = await resolveToolsEndpoint(
      deps({
        getProfile: () => profile({ source: 'docker' }),
        dockerSummary: () => Promise.reject(new Error('engine gone')),
      }),
      ID,
    );
    expect(failing.docker).toBeUndefined();
    const dockerSummary = vi.fn(async () => ({ containerName: 'x' }));
    await resolveToolsEndpoint(deps({ dockerSummary }), ID);
    expect(dockerSummary).not.toHaveBeenCalled();
  });
});

describe('uriPasswords', () => {
  it('returns the written and decoded password', () => {
    expect(uriPasswords('mongodb://u:p%40ss@h/')).toEqual(['p%40ss', 'p@ss']);
    expect(uriPasswords('mongodb+srv://u:plain@cluster.example.net')).toEqual(['plain']);
  });

  it('returns nothing without a password', () => {
    expect(uriPasswords('mongodb://h:27017')).toEqual([]);
    expect(uriPasswords('mongodb://user@h:27017')).toEqual([]);
    expect(uriPasswords('mongodb://user:@h:27017')).toEqual([]);
  });
});
