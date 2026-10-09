import { MongoNetworkError, type MongoClient } from 'mongodb';
import {
  AppErrorException,
  appError,
  FreezeInputSchema,
  InitiateInputSchema,
  StepDownInputSchema,
  type FreezeInput,
  type InitiateInput,
  type StepDownOutput,
} from '@mongo-gui/core';
import { parseInput } from '../management/errors';
import { readString } from '../documents';
import { mapDriverError } from '../errors';

const NEW_PRIMARY_TIMEOUT_MS = 30_000;
const NEW_PRIMARY_POLL_MS = 500;
const DEFAULT_PRIORITY = 1;

// Steps the primary down and waits for another member to take over. Returns the new primary's
// name as the set reports it. The server closes client connections on a step-down, so a dropped
// connection on the step-down command itself counts as success.
// The client must connect directly to the primary, because replSetStepDown acts only on the node
// that receives it. Through a set URI the command can reach a secondary and fail.
export async function stepDown(client: MongoClient, input: unknown): Promise<string> {
  const request = parseInput<StepDownOutput>(StepDownInputSchema, input);
  const admin = client.db('admin');
  const previous = await currentPrimary(client);
  const command = {
    replSetStepDown: request.stepDownSeconds,
    ...(request.secondaryCatchUpSeconds === undefined
      ? {}
      : { secondaryCatchUpPeriodSecs: request.secondaryCatchUpSeconds }),
    ...(request.force === true ? { force: true } : {}),
  };
  try {
    await admin.command(command);
  } catch (error) {
    if (!(error instanceof MongoNetworkError)) {
      throw new AppErrorException(mapDriverError(error));
    }
  }
  return awaitNewPrimary(client, previous);
}

// Freezes the member the client is connected to, for the given seconds. A value of 0 unfreezes it.
// The client must connect directly to that member. Through a set URI the driver may send the
// command to another member, and replSetFreeze acts only on the node that receives it.
export async function freeze(client: MongoClient, seconds: number): Promise<void> {
  const parsed = parseInput<FreezeInput>(FreezeInputSchema, { seconds });
  try {
    await client.db('admin').command({ replSetFreeze: parsed.seconds });
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

// Starts a new replica set on a node started with --replSet. The caller polls the status until
// the node reaches PRIMARY, because the election takes a moment after the command returns.
export async function initiate(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<InitiateInput>(InitiateInputSchema, input);
  const config = {
    _id: parsed.setName,
    members: parsed.members.map((member, index) => ({
      _id: index,
      host: member.host,
      priority: member.priority ?? DEFAULT_PRIORITY,
    })),
  };
  try {
    await client.db('admin').command({ replSetInitiate: config });
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

async function currentPrimary(client: MongoClient): Promise<string | undefined> {
  try {
    const hello: unknown = await client.db('admin').command({ hello: 1 });
    return readString(hello, 'primary');
  } catch (error) {
    throw new AppErrorException(mapDriverError(error));
  }
}

async function awaitNewPrimary(client: MongoClient, previous: string | undefined): Promise<string> {
  const deadline = Date.now() + NEW_PRIMARY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const hello: unknown = await client.db('admin').command({ hello: 1 });
      const primary = readString(hello, 'primary');
      if (primary !== undefined && primary !== previous) {
        return primary;
      }
    } catch {
      // The connection is still closed or reconnecting. The next attempt reconnects.
    }
    await sleep(NEW_PRIMARY_POLL_MS);
  }
  throw new AppErrorException(
    appError(
      'CONNECTION_TIMEOUT',
      `No new primary was elected within ${NEW_PRIMARY_TIMEOUT_MS / 1000} seconds`,
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
