import { describe, expect, it } from 'vitest';
import { detectTopology } from './server-info';

describe('detectTopology', () => {
  it('reports a standalone server from a writable hello reply', () => {
    expect(detectTopology({ isWritablePrimary: true, maxBsonObjectSize: 16777216 })).toBe(
      'standalone',
    );
  });

  it('reads ismaster when hello is missing from the reply', () => {
    expect(detectTopology({ ismaster: true })).toBe('standalone');
  });

  it('reports a replica set from setName', () => {
    expect(detectTopology({ setName: 'rs0', isWritablePrimary: false, hosts: ['a:27017'] })).toBe(
      'replicaSet',
    );
  });

  it('reports a sharded cluster from the isdbgrid message', () => {
    expect(detectTopology({ msg: 'isdbgrid', isWritablePrimary: true })).toBe('sharded');
  });

  it('reports a load balanced deployment from serviceId', () => {
    expect(detectTopology({ serviceId: { $oid: '64b7f0c2a1b2c3d4e5f60718' } })).toBe(
      'loadBalanced',
    );
  });

  it('prefers serviceId over the other markers', () => {
    expect(detectTopology({ serviceId: 'x', msg: 'isdbgrid', setName: 'rs0' })).toBe(
      'loadBalanced',
    );
  });

  it('reports unknown for a replica set member that has no set name yet', () => {
    expect(detectTopology({ isreplicaset: true, isWritablePrimary: true })).toBe('unknown');
  });

  it('reports unknown when the reply has no usable markers', () => {
    expect(detectTopology({})).toBe('unknown');
    expect(detectTopology(undefined)).toBe('unknown');
  });
});
