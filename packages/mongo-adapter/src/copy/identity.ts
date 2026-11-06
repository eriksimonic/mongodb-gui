import type { MongoClient } from 'mongodb';
import { readString, readStringArray } from '../documents';

export interface ServerIdentity {
  // Every member of a replica set. A standalone server or mongos has one entry: its own address.
  readonly hosts: readonly string[];
  readonly replicaSet: string | undefined;
}

// Reads hosts and setName from hello. A standalone server and mongos reply without hosts, so
// serverStatus.host (the server hostname and port) is used.
export async function serverIdentity(client: MongoClient): Promise<ServerIdentity> {
  const hello: unknown = await client.db('admin').command({ hello: 1 });
  const hosts = readStringArray(hello, 'hosts');
  if (hosts.length > 0) {
    return { hosts, replicaSet: readString(hello, 'setName') };
  }
  const self = await serverStatusHost(client);
  // Weakness: without serverStatus, two connection strings for one server look like two servers.
  const fallback = client.options.hosts.map((host) => host.toString());
  return { hosts: self === undefined ? fallback : [self], replicaSet: undefined };
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
