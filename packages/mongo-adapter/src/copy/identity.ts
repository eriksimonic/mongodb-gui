import type { MongoClient } from 'mongodb';
import type { ServerIdentity } from '@mongo-gui/core';
import { readString, readStringArray } from '../documents';

// Reads hosts and setName from hello. A standalone server and mongos reply without hosts, so
// serverStatus.host (the server hostname and port) is used. The hosts list holds every member of a
// replica set. A standalone server or mongos has one entry: its own address.
export async function serverIdentity(client: MongoClient): Promise<ServerIdentity> {
  const hello: unknown = await client.db('admin').command({ hello: 1 });
  const hosts = readStringArray(hello, 'hosts');
  if (hosts.length > 0) {
    return { hosts, setName: readString(hello, 'setName') };
  }
  const self = await serverStatusHost(client);
  // Weakness: without serverStatus, two connection strings for one server look like two servers.
  const fallback = client.options.hosts.map((host) => host.toString());
  return { hosts: self === undefined ? fallback : [self], setName: undefined };
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
