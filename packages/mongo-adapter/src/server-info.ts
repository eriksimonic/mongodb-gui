import { MongoServerError, type MongoClient } from 'mongodb';
import type { ClusterTopology, ConnectionStatus } from '@mongo-gui/core';
import { definedEntry, readBoolean, readString, readStringArray } from './documents';

export type ServerInfo = Omit<Extract<ConnectionStatus, { state: 'connected' }>, 'state'>;

const COMMAND_NOT_FOUND_CODE = 59;

export async function readServerInfo(client: MongoClient): Promise<ServerInfo> {
  const hello = await runHello(client);
  const build: unknown = await client.db('admin').command({ buildInfo: 1 });
  const serverVersion = readString(build, 'version');
  if (serverVersion === undefined) {
    throw new Error('buildInfo reply has no version');
  }
  return toServerInfo(hello, serverVersion, client.options.loadBalanced);
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

export async function runHello(client: MongoClient): Promise<unknown> {
  const admin = client.db('admin');
  try {
    const reply: unknown = await admin.command({ hello: 1 });
    return reply;
  } catch (error) {
    if (!isCommandNotFound(error)) {
      throw error;
    }
    const reply: unknown = await admin.command({ ismaster: 1 });
    return reply;
  }
}

function isCommandNotFound(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === COMMAND_NOT_FOUND_CODE || error.codeName === 'CommandNotFound')
  );
}

function toServerInfo(hello: unknown, serverVersion: string, loadBalanced: boolean): ServerInfo {
  return {
    serverVersion,
    topology: detectTopology(hello, loadBalanced),
    hosts: readStringArray(hello, 'hosts'),
    ...definedEntry('setName', readString(hello, 'setName')),
  };
}
