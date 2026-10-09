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

const IDLE_CONNECTION_PREFIX = 'conn';

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
    const operation = toOperation(row);
    if (operation === undefined || isListingItself(row)) {
      return [];
    }
    if (!includeSystem && isIdleSystemConnection(operation)) {
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

function toOperation(row: unknown): RunningOperation | undefined {
  const opid = readNumber(row, 'opid') ?? readString(row, 'opid');
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

function isIdleSystemConnection(operation: RunningOperation): boolean {
  return !operation.active && (operation.desc ?? '').startsWith(IDLE_CONNECTION_PREFIX);
}
