import { MongoServerError, type MongoClient } from 'mongodb';
import type { ClusterTopology, ConnectionStatus } from '@mongo-gui/core';
import { definedEntry, readBoolean, readString, readStringArray } from './documents';
import { commandTimeoutMs } from './client-options';

export type ServerInfo = Omit<Extract<ConnectionStatus, { state: 'connected' }>, 'state'>;

const COMMAND_NOT_FOUND_CODE = 59;

export async function readServerInfo(client: MongoClient): Promise<ServerInfo> {
  // A server that accepts the socket but never answers would hold these calls forever, so only these
  // two calls get a bound. See commandTimeoutMs.
  const bound = { timeoutMS: commandTimeoutMs(client) };
  const hello = await runHello(client, bound);
  const build: unknown = await client.db('admin').command({ buildInfo: 1 }, bound);
  const serverVersion = readString(build, 'version');
  if (serverVersion === undefined) {
    throw new Error('buildInfo reply has no version');
  }
  return toServerInfo(hello, serverVersion, {
    loadBalanced: client.options.loadBalanced,
    directConnection: client.options.directConnection,
  });
}

export function detectTopology(hello: unknown, loadBalanced: boolean): ClusterTopology {
  if (loadBalanced) {
    return 'loadBalanced';
  }
  if (readString(hello, 'msg') === 'isdbgrid') {
    return 'sharded';
  }
  if (readString(hello, 'setName') !== undefined) {
    return 'replicaSet';
  }
  const writable = readBoolean(hello, 'isWritablePrimary') ?? readBoolean(hello, 'ismaster');
  if (writable === true && readBoolean(hello, 'isreplicaset') !== true) {
    return 'standalone';
  }
  return 'unknown';
}

export async function runHello(
  client: MongoClient,
  options: { timeoutMS?: number } = {},
): Promise<unknown> {
  const admin = client.db('admin');
  try {
    return await admin.command({ hello: 1 }, options);
  } catch (error) {
    if (!isCommandNotFound(error)) {
      throw error;
    }
    return admin.command({ ismaster: 1 }, options);
  }
}

function isCommandNotFound(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === COMMAND_NOT_FOUND_CODE || error.codeName === 'CommandNotFound')
  );
}

interface ClientOptions {
  readonly loadBalanced: boolean;
  readonly directConnection: boolean;
}

/**
 * The connected status from the hello reply and the client options. A direct connection to a
 * replica set member still reports the set name, so the flag tells the UI the client sees only
 * that member.
 */
export function toServerInfo(
  hello: unknown,
  serverVersion: string,
  options: ClientOptions,
): ServerInfo {
  return {
    serverVersion,
    topology: detectTopology(hello, options.loadBalanced),
    hosts: readStringArray(hello, 'hosts'),
    ...definedEntry('setName', readString(hello, 'setName')),
    ...(options.directConnection ? { directConnection: true } : {}),
  };
}
