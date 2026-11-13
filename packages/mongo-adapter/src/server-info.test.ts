import { MongoOperationTimeoutError, type MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { detectTopology, readServerInfo, toServerInfo } from './server-info';

describe('readServerInfo', () => {
  it('bounds the hello and buildInfo commands, so a server that never answers ends the read', async () => {
    const timeouts: unknown[] = [];
    // A silent server: a call with no timeout never settles, and a call with one times out.
    const client = {
      options: { serverSelectionTimeoutMS: 10_000, loadBalanced: false, directConnection: false },
      db: () => ({
        command: (_document: unknown, options?: { timeoutMS?: number }) => {
          timeouts.push(options?.timeoutMS);
          if (options?.timeoutMS === undefined) {
            return new Promise<never>(() => undefined);
          }
          return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
        },
      }),
    } as unknown as MongoClient;

    await expect(readServerInfo(client)).rejects.toBeInstanceOf(MongoOperationTimeoutError);
    expect(timeouts).toEqual([10_000]);
  });

  it('uses the default bound when the server selection timeout is 0, which means no limit', async () => {
    const timeouts: unknown[] = [];
    const client = {
      options: { serverSelectionTimeoutMS: 0, loadBalanced: false, directConnection: false },
      db: () => ({
        command: (_document: unknown, options?: { timeoutMS?: number }) => {
          timeouts.push(options?.timeoutMS);
          return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
        },
      }),
    } as unknown as MongoClient;

    await expect(readServerInfo(client)).rejects.toBeInstanceOf(MongoOperationTimeoutError);
    expect(timeouts).toEqual([10_000]);
  });
});

describe('readServerInfo: the bound has a floor', () => {
  it('uses 10 s when the server selection timeout is shorter, so a far server is not cut off', async () => {
    const timeouts: unknown[] = [];
    // A profile connect timeout of 500 ms sets a short server selection timeout. Healthy calls on a far
    // or tunnelled server can take longer than that.
    const client = {
      options: { serverSelectionTimeoutMS: 500, loadBalanced: false, directConnection: false },
      db: () => ({
        command: (_document: unknown, options?: { timeoutMS?: number }) => {
          timeouts.push(options?.timeoutMS);
          return Promise.reject(new MongoOperationTimeoutError('Operation timed out'));
        },
      }),
    } as unknown as MongoClient;

    await expect(readServerInfo(client)).rejects.toBeInstanceOf(MongoOperationTimeoutError);
    expect(timeouts).toEqual([10_000]);
  });
});

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
