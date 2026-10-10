import { BSON, type MongoClient } from 'mongodb';
import {
  AppErrorException,
  normaliseReplicaSetConfig,
  normaliseReplicaSetStatus,
  type EjsonSerialiser,
  type ReplicaSetConfig,
  type ReplicaSetStatus,
} from '@mongo-gui/core';
import { readString } from '../documents';
import { mapDriverError } from '../errors';

const OPLOG_DATABASE = 'local';
const OPLOG_COLLECTION = 'oplog.rs';
const ASCENDING = 1;
const DESCENDING = -1;

// Driver values such as ObjectId become their canonical EJSON form, which core keeps as a string.
const serialise: EjsonSerialiser = (value) => BSON.EJSON.stringify(value, { relaxed: false });

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
    return normaliseReplicaSetStatus({
      status,
      config,
      serialise,
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
    return normaliseReplicaSetConfig(reply, serialise);
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

// The host the connection reached the node by, as the node names itself in its hello reply. A node
// behind a port mapping reports the address it listens on, so this can differ from the URI.
export async function getSelfHost(client: MongoClient): Promise<string | undefined> {
  try {
    const hello: unknown = await client.db('admin').command({ hello: 1 });
    return readString(hello, 'me');
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
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
