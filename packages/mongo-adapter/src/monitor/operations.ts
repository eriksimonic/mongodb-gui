import type { MongoClient } from 'mongodb';
import { AppErrorException, type RunningOperation } from '@mongo-gui/core';
import {
  definedEntry,
  readArray,
  readBoolean,
  readField,
  readNumber,
  readRecord,
  readString,
} from '../documents';
import { mapDriverError } from '../errors';

export interface ListOperationsOptions {
  readonly includeIdle?: boolean;
  readonly includeSystem?: boolean;
}

// Client connections are named "conn<n>". Background server threads have other names.
const CLIENT_CONNECTION_PREFIX = 'conn';

export async function listOperations(
  client: MongoClient,
  options: ListOperationsOptions = {},
): Promise<RunningOperation[]> {
  const includeIdle = options.includeIdle === true;
  const includeSystem = options.includeSystem === true;
  let rows: unknown[];
  try {
    rows = await client
      .db('admin')
      .aggregate([
        { $currentOp: { allUsers: true, idleConnections: includeIdle, idleSessions: false } },
      ])
      .toArray();
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
  return rows.flatMap((row) => {
    if (isListingItself(row)) {
      return [];
    }
    const operation = toOperation(row, includeIdle);
    if (operation === undefined) {
      return [];
    }
    if (!includeSystem && isBackgroundThread(row, operation)) {
      return [];
    }
    return [operation];
  });
}

export async function killOperation(client: MongoClient, opid: string | number): Promise<void> {
  try {
    await client.db('admin').command({ killOp: 1, op: opid });
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

// An idle connection row has no opid. It gets a synthetic one when idle rows are requested.
function toOperation(row: unknown, includeIdle: boolean): RunningOperation | undefined {
  const opid =
    readNumber(row, 'opid') ?? readString(row, 'opid') ?? idleConnectionOpid(row, includeIdle);
  if (opid === undefined) {
    return undefined;
  }
  const appName =
    readString(row, 'appName') ??
    readString(readRecord(readRecord(row, 'clientMetadata'), 'application'), 'name');
  return {
    opid,
    active: readBoolean(row, 'active') ?? false,
    op: readString(row, 'op') ?? '',
    ns: readString(row, 'ns') ?? '',
    ...definedEntry('secsRunning', readNumber(row, 'secs_running')),
    ...definedEntry('client', readString(row, 'client')),
    ...definedEntry('appName', appName),
    ...definedEntry('desc', readString(row, 'desc')),
    ...definedEntry('command', readField(row, 'command')),
    ...definedEntry('waitingForLock', readBoolean(row, 'waitingForLock')),
    ...definedEntry('planSummary', readString(row, 'planSummary')),
    ...definedEntry('effectiveUsers', effectiveUsers(row)),
  };
}

function effectiveUsers(row: unknown): string[] | undefined {
  if (readField(row, 'effectiveUsers') === undefined) {
    return undefined;
  }
  return readArray(row, 'effectiveUsers').flatMap((entry) => {
    const user = readString(entry, 'user');
    const db = readString(entry, 'db');
    return user === undefined || db === undefined ? [] : [`${user}@${db}`];
  });
}

// The $currentOp aggregation that listOperations runs shows up in its own output.
function isListingItself(row: unknown): boolean {
  return readArray(readField(row, 'command'), 'pipeline').some(
    (stage) => readField(stage, '$currentOp') !== undefined,
  );
}

function idleConnectionOpid(row: unknown, includeIdle: boolean): string | undefined {
  const connectionId = readNumber(row, 'connectionId');
  if (!includeIdle || connectionId === undefined) {
    return undefined;
  }
  return `conn:${connectionId}`;
}

// Background threads such as Checkpointer or JournalFlusher have no client and no operation,
// or a description that is not a client connection name.
function isBackgroundThread(row: unknown, operation: RunningOperation): boolean {
  const hasClient = readString(row, 'client') !== undefined;
  const noOperation = operation.op === 'none';
  const isClientConnection = (operation.desc ?? '').startsWith(CLIENT_CONNECTION_PREFIX);
  return (!hasClient && noOperation) || !isClientConnection;
}
