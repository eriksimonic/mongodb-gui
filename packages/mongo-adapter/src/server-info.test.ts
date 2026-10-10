import { describe, expect, it } from 'vitest';
import { detectTopology, toServerInfo } from './server-info';

describe('detectTopology', () => {
  it('reports a standalone server from a writable hello reply', () => {
    expect(detectTopology({ isWritablePrimary: true, maxBsonObjectSize: 16777216 }, false)).toBe(
      'standalone',
    );
  });

  it('reads ismaster when hello is missing from the reply', () => {
    expect(detectTopology({ ismaster: true }, false)).toBe('standalone');
  });

  it('reports a replica set from setName', () => {
    expect(
      detectTopology({ setName: 'rs0', isWritablePrimary: false, hosts: ['a:27017'] }, false),
    ).toBe('replicaSet');
  });

  it('reports a sharded cluster from the isdbgrid message', () => {
    expect(detectTopology({ msg: 'isdbgrid', isWritablePrimary: true }, false)).toBe('sharded');
  });

  it('reports a load balanced deployment from the client option', () => {
    expect(detectTopology({ isWritablePrimary: true }, true)).toBe('loadBalanced');
  });

  it('ignores a serviceId in the reply when the client is not load balanced', () => {
    expect(detectTopology({ serviceId: { $oid: '64b7f0c2a1b2c3d4e5f60718' } }, false)).toBe(
      'unknown',
    );
  });

  it('prefers the load balanced option over the other markers', () => {
    expect(detectTopology({ msg: 'isdbgrid', setName: 'rs0' }, true)).toBe('loadBalanced');
  });

  it('reports unknown for a replica set member that has no set name yet', () => {
    expect(detectTopology({ isreplicaset: true, isWritablePrimary: true }, false)).toBe('unknown');
  });

  it('reports unknown when the reply has no usable markers', () => {
    expect(detectTopology({}, false)).toBe('unknown');
    expect(detectTopology(undefined, false)).toBe('unknown');
  });
});

describe('toServerInfo', () => {
  const hello = { setName: 'rs0', isWritablePrimary: true, hosts: ['a:27017', 'b:27017'] };

  it('marks a direct connection to a replica set member', () => {
    expect(toServerInfo(hello, '7.0.3', { loadBalanced: false, directConnection: true })).toEqual({
      serverVersion: '7.0.3',
      topology: 'replicaSet',
      setName: 'rs0',
      hosts: ['a:27017', 'b:27017'],
      directConnection: true,
    });
  });

  it('leaves the flag out of a connection that follows the set', () => {
    const info = toServerInfo(hello, '7.0.3', { loadBalanced: false, directConnection: false });
    expect(info).not.toHaveProperty('directConnection');
  });
});
