import { randomUUID } from 'node:crypto';
import { MongoClient, type Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  MAX_PROFILE_LIMIT,
  ProfileEntrySchema,
  groupByShape,
  type AppError,
  type ProfileEntry,
  type SetProfilingLevelInput,
} from '@mongo-gui/core';
import {
  getProfilingLevel,
  listProfileEntries,
  profileCollectionInfo,
  setProfilingLevel,
  tailProfileEntries,
} from '../index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';

const SETUP_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS + 60_000;
const TEST_TIMEOUT_MS = 30_000;
const ORDER_COUNT = 10;
const FAST_FINDS = 17;
const SLOW_FINDS = 3;
const UPDATES = 5;
const AGGREGATES = 3;
const PROFILED_OPERATIONS = FAST_FINDS + SLOW_FINDS + UPDATES + AGGREGATES;
const SLOW_THRESHOLD_MS = 50;
const TAIL_POLL_MS = 200;
const TAIL_DELIVERY_BUDGET_MS = 2 * TAIL_POLL_MS + 1000;
const WAIT_STEP_MS = 20;

// Counts of fast query shapes, sorted ascending, observed per server version. 4.4 and 6.0 give
// the aggregates the same queryHash as the finds with the same filter structure, so all 20 fast
// reads share one shape. 8.0 hashes the aggregate on its own, which gives 17 finds and 3 aggregates.
const FAST_SHAPE_COUNTS: Readonly<Record<(typeof MONGO_IMAGES)[number], readonly number[]>> = {
  'mongo:4.4': [20],
  'mongo:6.0': [20],
  'mongo:8.0.17': [3, 17],
};

describe.each(MONGO_IMAGES)('MongoDB %s profiler', (image) => {
  const db = `profiler_${randomUUID().replaceAll('-', '')}`;
  const ns = `${db}.orders`;
  let mongo: StartedMongo;
  let client: MongoClient;

  beforeAll(async () => {
    mongo = await startMongo(image);
    client = new MongoClient(mongo.rootUri, { appName: 'profiler-integration' });
    await client.connect();
    await seedOrders(client.db(db).collection('orders'));
    await setProfilingLevel(client, db, { level: 2, slowMs: 0 });
    await runWorkload(client.db(db).collection('orders'));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await setProfilingLevel(client, db, { level: 0 });
      await client.db(db).dropDatabase();
    } finally {
      await client.close();
      await mongo.stop();
    }
  }, SETUP_TIMEOUT_MS);

  it(
    'reads back the level that was set',
    async () => {
      expect(await getProfilingLevel(client, db)).toMatchObject({ level: 2, slowMs: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'changes the level and the slow threshold and reads them back',
    async () => {
      const changed = await setProfilingLevel(client, db, { level: 1, slowMs: 250 });
      expect(changed).toMatchObject({ level: 1, slowMs: 250 });
      expect(await getProfilingLevel(client, db)).toMatchObject({ level: 1, slowMs: 250 });
      await setProfilingLevel(client, db, { level: 2, slowMs: 0 });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a level outside 0..2 with a validation error',
    async () => {
      const error = await captureAppError(
        setProfilingLevel(client, db, { level: 3 } as unknown as SetProfilingLevelInput),
      );
      expect(error?.code).toBe('VALIDATION');
      expect((await getProfilingLevel(client, db)).level).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a server refusal as COMMAND_FAILED and keeps the previous level',
    async () => {
      const error = await captureAppError(
        setProfilingLevel(client, db, { level: 1, filter: { $bogus: 1 } }),
      );
      expect(error?.code).toBe('COMMAND_FAILED');
      expect((await getProfilingLevel(client, db)).level).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lists every profiled operation and each one passes the entry schema',
    async () => {
      const entries = await listProfileEntries(client, db, { ns, limit: MAX_PROFILE_LIMIT });
      expect(entries).toHaveLength(PROFILED_OPERATIONS);
      for (const entry of entries) {
        expect(ProfileEntrySchema.safeParse(entry).success).toBe(true);
      }
      expect(countByOp(entries)).toEqual({
        query: FAST_FINDS + SLOW_FINDS + AGGREGATES,
        update: UPDATES,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'filters by op',
    async () => {
      const updates = await listProfileEntries(client, db, { ns, op: 'update' });
      expect(updates).toHaveLength(UPDATES);
      for (const update of updates) {
        expect(update).toMatchObject({ op: 'update', nMatched: 1, nModified: 1 });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'returns only the slow operations for minMillis',
    async () => {
      const slow = await listProfileEntries(client, db, { ns, minMillis: SLOW_THRESHOLD_MS });
      expect(slow).toHaveLength(SLOW_FINDS);
      for (const entry of slow) {
        expect(entry.millis).toBeGreaterThanOrEqual(SLOW_THRESHOLD_MS);
        expect(JSON.stringify(entry.command)).toContain('sleep');
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'narrows the listing with a text search on a field name, case-insensitively',
    async () => {
      const touched = await listProfileEntries(client, db, { ns, textSearch: 'touched' });
      expect(touched).toHaveLength(UPDATES);
      expect(touched.every((entry) => entry.op === 'update')).toBe(true);
      const sleeps = await listProfileEntries(client, db, { ns, textSearch: 'SLEEP' });
      expect(sleeps).toHaveLength(SLOW_FINDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'returns the newest entries first and honours the limit',
    async () => {
      const entries = await listProfileEntries(client, db, { ns, limit: 4 });
      expect(entries).toHaveLength(4);
      const times = entries.map((entry) => Date.parse(entry.ts));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      const matched = await listProfileEntries(client, db, { ns, textSearch: 'touched', limit: 2 });
      expect(matched).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'groups the reads by query hash, with the slow $where finds in their own shape',
    async () => {
      const reads = await listProfileEntries(client, db, {
        ns,
        op: 'query',
        limit: MAX_PROFILE_LIMIT,
      });
      expect(reads).toHaveLength(FAST_FINDS + SLOW_FINDS + AGGREGATES);
      expect(reads.every((entry) => entry.queryHash !== undefined)).toBe(true);

      const shapes = groupByShape(reads);
      const hashes = new Set(reads.map((entry) => entry.queryHash));
      expect(shapes.every((shape) => hashes.has(shape.key))).toBe(true);

      const slow = shapes.filter((shape) => shape.maxMillis >= SLOW_THRESHOLD_MS);
      expect(slow).toHaveLength(1);
      expect(slow[0]).toMatchObject({ count: SLOW_FINDS, op: 'query' });
      expect(slow[0]?.p95Millis).toBeGreaterThanOrEqual(SLOW_THRESHOLD_MS);

      const fast = shapes
        .filter((shape) => shape.maxMillis < SLOW_THRESHOLD_MS)
        .map((shape) => shape.count)
        .sort((a, b) => a - b);
      expect(fast).toEqual([...FAST_SHAPE_COUNTS[image]]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tails a new insert within two polls and delivers it once',
    async () => {
      const since = new Date().toISOString();
      const received: ProfileEntry[] = [];
      const errors: AppError[] = [];
      let arrivedAt: number | undefined;
      const tail = tailProfileEntries(client, db, {
        since,
        pollMs: TAIL_POLL_MS,
        filter: { ns },
      });
      tail.onEntries((batch) => {
        received.push(...batch);
        if (arrivedAt === undefined && batch.some((entry) => entry.op === 'insert')) {
          arrivedAt = Date.now();
        }
      });
      tail.onError((error) => errors.push(error));
      try {
        await client.db(db).collection('orders').insertOne({ orderNumber: 100, status: 'open' });
        const insertedAt = Date.now();
        await waitUntil(() => arrivedAt !== undefined, TAIL_DELIVERY_BUDGET_MS);
        expect((arrivedAt ?? 0) - insertedAt).toBeLessThanOrEqual(TAIL_DELIVERY_BUDGET_MS);
      } finally {
        tail.stop();
      }
      await sleep(2 * TAIL_POLL_MS);
      expect(errors).toEqual([]);
      expect(received.filter((entry) => entry.op === 'insert')).toHaveLength(1);
      expect(new Set(received.map((entry) => entry.id)).size).toBe(received.length);
      expect(received.every((entry) => entry.ts >= since)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers nothing after stop',
    async () => {
      const since = new Date().toISOString();
      const received: ProfileEntry[] = [];
      const tail = tailProfileEntries(client, db, {
        since,
        pollMs: TAIL_POLL_MS,
        filter: { ns },
      });
      tail.onEntries((batch) => received.push(...batch));
      tail.stop();
      await client.db(db).collection('orders').insertOne({ orderNumber: 101, status: 'open' });
      await sleep(2 * TAIL_POLL_MS);
      expect(received).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports the size and count of system.profile, and an empty listing for a database that never profiled',
    async () => {
      const info = await profileCollectionInfo(client, db);
      expect(info.exists).toBe(true);
      expect(info.count).toBeGreaterThanOrEqual(PROFILED_OPERATIONS);
      expect(info.sizeBytes).toBeGreaterThan(0);

      const neverProfiled = `${db}_never`;
      expect(await profileCollectionInfo(client, neverProfiled)).toEqual({ exists: false });
      expect(await listProfileEntries(client, neverProfiled, {})).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'records nothing new at level 0',
    async () => {
      const before = await listProfileEntries(client, db, { ns, limit: MAX_PROFILE_LIMIT });
      await setProfilingLevel(client, db, { level: 0 });
      expect(await getProfilingLevel(client, db)).toMatchObject({ level: 0 });
      const orders = client.db(db).collection('orders');
      for (let index = 0; index < 3; index++) {
        await orders.find({ status: 'paid' }).toArray();
      }
      const after = await listProfileEntries(client, db, { ns, limit: MAX_PROFILE_LIMIT });
      expect(after).toHaveLength(before.length);
    },
    TEST_TIMEOUT_MS,
  );
});

async function seedOrders(orders: Collection): Promise<void> {
  await orders.insertMany(
    Array.from({ length: ORDER_COUNT }, (_, index) => ({
      orderNumber: index,
      status: index % 2 === 0 ? 'paid' : 'open',
    })),
  );
}

// Runs with the profiler at level 2, so every operation below is recorded.
async function runWorkload(orders: Collection): Promise<void> {
  for (let index = 0; index < FAST_FINDS; index++) {
    await orders.find({ status: index % 2 === 0 ? 'paid' : 'open' }).toArray();
  }
  for (let index = 0; index < SLOW_FINDS; index++) {
    await orders.find({ status: 'paid', $where: 'sleep(60) || true' }).toArray();
  }
  for (let index = 0; index < UPDATES; index++) {
    await orders.updateOne({ orderNumber: index }, { $set: { touched: true } });
  }
  for (let index = 0; index < AGGREGATES; index++) {
    await orders.aggregate([{ $match: { status: 'paid' } }, { $count: 'n' }]).toArray();
  }
}

function countByOp(entries: readonly ProfileEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.op] = (counts[entry.op] ?? 0) + 1;
  }
  return counts;
}

async function captureAppError(action: Promise<unknown>): Promise<AppError | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error : undefined;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await sleep(WAIT_STEP_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
