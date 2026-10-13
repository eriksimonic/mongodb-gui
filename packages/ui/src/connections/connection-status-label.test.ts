import { describe, expect, it } from 'vitest';
import { connectionTopologyLabel, connectionTreeMeta } from './connection-status-label';

const base = { state: 'connected' as const, serverVersion: '7.0.3', hosts: ['a:27017'] };

describe('connectionTopologyLabel', () => {
  it('names a direct connection to a replica set member', () => {
    expect(
      connectionTopologyLabel({
        ...base,
        topology: 'replicaSet',
        setName: 'rs0',
        directConnection: true,
      }),
    ).toBe('replica set · rs0 · direct connection to one member');
  });

  it('names a replica set the client follows', () => {
    expect(connectionTopologyLabel({ ...base, topology: 'replicaSet', setName: 'rs0' })).toBe(
      'replica set · rs0',
    );
  });

  it('names a standalone server', () => {
    expect(connectionTopologyLabel({ ...base, topology: 'standalone' })).toBe('standalone server');
  });
});

describe('connectionTreeMeta', () => {
  it('shows the set name and the direct flag', () => {
    expect(
      connectionTreeMeta({
        ...base,
        topology: 'replicaSet',
        setName: 'rs0',
        directConnection: true,
      }),
    ).toBe('rs0 · direct');
  });

  it('shows nothing for a standalone server or a connection that is not open', () => {
    expect(connectionTreeMeta({ ...base, topology: 'standalone' })).toBeUndefined();
    expect(connectionTreeMeta({ state: 'disconnected' })).toBeUndefined();
  });
});
