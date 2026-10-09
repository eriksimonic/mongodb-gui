import type { MongoClient } from 'mongodb';
import type { ClusterTopology } from '@mongo-gui/core';
import { readBoolean, readString } from './fields';

export interface ServerInfo {
  serverVersion: string;
  topology: ClusterTopology;
}

const COMMAND_NOT_FOUND_CODE = 59;

// Reads the version and topology the way mongo-adapter does. The adapter does not export its
// helpers, so the same rules are repeated here.
export async function readServerInfo(client: MongoClient): Promise<ServerInfo> {
  const admin = client.db('admin');
  const build: unknown = await admin.command({ buildInfo: 1 });
  const serverVersion = readString(build, 'version');
  if (serverVersion === undefined) {
    throw new Error('buildInfo reply has no version');
  }
  const hello = await runHello(client);
  return { serverVersion, topology: detectTopology(hello, client.options.loadBalanced) };
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

async function runHello(client: MongoClient): Promise<unknown> {
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
    error instanceof Error &&
    'code' in error &&
    (error.code === COMMAND_NOT_FOUND_CODE || error.name === 'CommandNotFound')
  );
}
