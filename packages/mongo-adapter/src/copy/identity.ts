import type { MongoClient } from 'mongodb';
import type { ServerIdentity } from '@mongo-gui/core';
import { readString, readStringArray } from '../documents';

// Reads hosts and setName from hello. A replica set lists every member as host:port. A standalone
// server or mongos replies without hosts, so the identity is serverStatus.host (the hostname, with
// no port) and the port the client connected to. Two mongod processes on one machine share the
// hostname, so the port tells them apart.
export async function serverIdentity(client: MongoClient): Promise<ServerIdentity> {
  const hello: unknown = await client.db('admin').command({ hello: 1 });
  const hosts = readStringArray(hello, 'hosts');
  if (hosts.length > 0) {
    return { hosts, setName: readString(hello, 'setName') };
  }
  const self = await serverStatusHost(client);
  if (self === undefined) {
    // Weakness: without serverStatus, two connection strings for one server look like two servers.
    return { hosts: client.options.hosts.map((host) => host.toString()), setName: undefined };
  }
  const port = client.options.hosts[0]?.port;
  return { hosts: [port === undefined ? self : `${self}:${port}`], setName: undefined };
}

// Returns undefined when the user lacks the serverStatus privilege or the command fails.
async function serverStatusHost(client: MongoClient): Promise<string | undefined> {
  try {
    const status: unknown = await client.db('admin').command({ serverStatus: 1 });
    return readString(status, 'host');
  } catch {
    return undefined;
  }
}
