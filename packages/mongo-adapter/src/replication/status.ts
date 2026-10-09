import { BSON, type MongoClient } from 'mongodb';
import {
  AppErrorException,
  normaliseReplicaSetConfig,
  normaliseReplicaSetStatus,
  type ReplicaSetConfig,
  type ReplicaSetStatus,
} from '@mongo-gui/core';
import { readString } from '../documents';
import { mapDriverError } from '../errors';

const OPLOG_DATABASE = 'local';
const OPLOG_COLLECTION = 'oplog.rs';
const ASCENDING = 1;
const DESCENDING = -1;

export async function isReplicaSet(client: MongoClient): Promise<boolean> {
  try {
    const hello: unknown = await client.db('admin').command({ hello: 1 });
    return readString(hello, 'setName') !== undefined;
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

export async function getReplicaSetStatus(client: MongoClient): Promise<ReplicaSetStatus> {
  try {
    const admin = client.db('admin');
    // The configuration supplies the priority, votes, hidden flag, delay and tags of each member,
    // which replSetGetStatus does not report.
    const status: unknown = await admin.command({ replSetGetStatus: 1 });
    const config: unknown = await admin.command({ replSetGetConfig: 1 });
    const [oplogFirst, oplogLast, oplogStats] = await Promise.all([
      readOplogEdge(client, ASCENDING),
      readOplogEdge(client, DESCENDING),
      readOplogStats(client),
    ]);
    const settingsEjson = settingsEjsonOf(config);
    return normaliseReplicaSetStatus({
      status,
      config,
      settingsEjson,
      oplogFirst,
      oplogLast,
      oplogStats,
    });
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

export async function getReplicaSetConfig(client: MongoClient): Promise<ReplicaSetConfig> {
  try {
    const reply: unknown = await client.db('admin').command({ replSetGetConfig: 1 });
    return normaliseReplicaSetConfig(reply, settingsEjsonOf(reply));
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

// The settings document holds driver values such as ObjectId, so it is serialised as canonical
// EJSON. Core keeps the string and the planner passes it back unchanged.
function settingsEjsonOf(reply: unknown): string {
  const config =
    typeof reply === 'object' && reply !== null && 'config' in reply ? reply.config : undefined;
  const settings =
    typeof config === 'object' && config !== null && 'settings' in config
      ? config.settings
      : undefined;
  return BSON.EJSON.stringify(settings ?? {}, { relaxed: false });
}

// A failed oplog read leaves the window out of the status rather than failing the whole read.
async function readOplogEdge(client: MongoClient, direction: 1 | -1): Promise<unknown> {
  try {
    const rows = await client
      .db(OPLOG_DATABASE)
      .collection(OPLOG_COLLECTION)
      .find({}, { projection: { ts: 1 } })
      .sort({ $natural: direction })
      .limit(1)
      .toArray();
    return rows[0];
  } catch {
    return undefined;
  }
}

async function readOplogStats(client: MongoClient): Promise<unknown> {
  try {
    return await client.db(OPLOG_DATABASE).command({ collStats: OPLOG_COLLECTION });
  } catch {
    return undefined;
  }
}
