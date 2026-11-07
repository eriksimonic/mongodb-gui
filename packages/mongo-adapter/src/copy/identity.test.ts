import type { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { serverIdentity } from './identity';

interface StubServer {
  /** The reply to hello. A standalone server replies without hosts. */
  readonly hello?: Record<string, unknown>;
  /** The reply to serverStatus. Undefined means the user may not run it. */
  readonly serverStatus?: Record<string, unknown>;
}

/** A client whose connection targets one endpoint, and whose admin replies come from `server`. */
function stubClient(endpoint: { host: string; port: number }, server: StubServer): MongoClient {
  const admin = {
    command: async (command: Record<string, unknown>) => {
      if ('hello' in command) {
        return server.hello ?? { isWritablePrimary: true };
      }
      if ('serverStatus' in command) {
        if (server.serverStatus === undefined) {
          throw new Error('not authorized on admin to execute command { serverStatus: 1 }');
        }
        return server.serverStatus;
      }
      throw new Error(`unexpected command ${Object.keys(command)[0] ?? ''}`);
    },
  };
  const address = {
    host: endpoint.host,
    port: endpoint.port,
    toString: () => `${endpoint.host}:${endpoint.port}`,
  };
  return {
    options: { hosts: [address] },
    db: () => admin,
  } as unknown as MongoClient;
}

describe('serverIdentity', () => {
  it('names a standalone server by its serverStatus host and the port the client connected to', async () => {
    const client = stubClient(
      { host: 'localhost', port: 27017 },
      { serverStatus: { host: 'f210ce38b5a6' } },
    );

    expect(await serverIdentity(client)).toEqual({ hosts: ['f210ce38b5a6:27017'] });
  });

  it('names a mongos like a standalone server when hello has no hosts', async () => {
    const client = stubClient(
      { host: 'localhost', port: 27017 },
      { hello: { msg: 'isdbgrid' }, serverStatus: { host: 'router-1' } },
    );

    expect(await serverIdentity(client)).toEqual({ hosts: ['router-1:27017'] });
  });

  it('tells two mongod processes on one host name apart by the port', async () => {
    const server = { serverStatus: { host: 'box' } };
    const first = await serverIdentity(stubClient({ host: 'localhost', port: 27017 }, server));
    const second = await serverIdentity(stubClient({ host: 'localhost', port: 27018 }, server));

    expect(first.hosts).toEqual(['box:27017']);
    expect(second.hosts).toEqual(['box:27018']);
    expect(first).not.toEqual(second);
  });

  it('gives two clients to the same server and port equal identities', async () => {
    const server = { serverStatus: { host: 'box' } };
    const first = await serverIdentity(stubClient({ host: 'localhost', port: 27017 }, server));
    const second = await serverIdentity(stubClient({ host: 'localhost', port: 27017 }, server));

    expect(second).toEqual(first);
  });

  it('keeps the member list and set name of a replica set from hello', async () => {
    const client = stubClient(
      { host: 'a.example', port: 27017 },
      {
        hello: { hosts: ['a.example:27017', 'b.example:27017'], setName: 'rs0' },
        serverStatus: { host: 'a' },
      },
    );

    expect(await serverIdentity(client)).toEqual({
      hosts: ['a.example:27017', 'b.example:27017'],
      setName: 'rs0',
    });
  });

  it('falls back to the connection host list when serverStatus is denied', async () => {
    const client = stubClient({ host: 'box', port: 27018 }, {});

    expect(await serverIdentity(client)).toEqual({ hosts: ['box:27018'], setName: undefined });
  });
});
