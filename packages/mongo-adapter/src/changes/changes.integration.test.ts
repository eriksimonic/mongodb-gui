import { randomUUID } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  type ChangeEvent,
  type ChangeTarget,
  type ChangeWatchOptions,
  type ChangeWatchState,
} from '@mongo-gui/core';
import { CONTAINER_STARTUP_TIMEOUT_MS } from '../test/mongo-container';
import {
  connectTo,
  startMongoNode,
  startReplicaSet,
  waitUntil,
  type MongoNode,
  type ReplicaSetHarness,
} from '../test/replica-set';
import { openChangeWatch, type ChangeWatch } from './watcher';

const IMAGES = ['mongo:8.0.17', 'mongo:6.0'] as const;
const SETUP_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS * 2;
const TEST_TIMEOUT_MS = 90_000;
const WAIT_MS = 20_000;
const CLOSE_BUDGET_MS = 2000;
const STANDALONE_ERROR_BUDGET_MS = 5000;
const PAUSE_BUFFER_LIMIT = 1000;
const BURST_SIZE = 1500;

// Test documents carry numeric ids and free-form fields.
type TestDoc = Record<string, unknown> & { _id?: number };

interface Recorder {
  readonly events: ChangeEvent[];
  readonly states: ChangeWatchState[];
  readonly watch: ChangeWatch;
}

function freshDb(): string {
  return `changes_${randomUUID().replaceAll('-', '')}`;
}

// Opens a watch and waits until the server has answered, so that writes made afterwards are seen.
async function record(
  client: MongoClient,
  target: ChangeTarget,
  options: ChangeWatchOptions = {},
  signal?: AbortSignal,
): Promise<Recorder> {
  const events: ChangeEvent[] = [];
  const states: ChangeWatchState[] = [];
  const watch = openChangeWatch(client, target, options, {
    onEvent: (event) => {
      events.push(event);
    },
    onState: (state) => {
      states.push(state);
    },
    ...(signal === undefined ? {} : { signal }),
  });
  open.push(watch);
  await waitUntil(async () => watch.state().phase !== 'opening', WAIT_MS, 'the watch to answer');
  return { events, states, watch };
}

async function waitForEvents(events: readonly ChangeEvent[], count: number): Promise<void> {
  await waitUntil(async () => events.length >= count, WAIT_MS, `${count} change events`);
}

function sequenceOf(event: ChangeEvent): unknown {
  const document: unknown = parsed(event.fullDocumentEjson);
  return typeof document === 'object' && document !== null && 'sequence' in document
    ? document.sequence
    : undefined;
}

function operationTypes(events: readonly ChangeEvent[]): string[] {
  return events.map((event) => event.operationType);
}

function parsed(text: string | undefined): unknown {
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

// Watches opened by a test. They are closed after each test so that no cursor outlives it.
const open: ChangeWatch[] = [];

describe.each(IMAGES)('change streams on %s', (image) => {
  let set: ReplicaSetHarness;
  let member: MongoNode;
  let standalone: MongoNode;
  let client: MongoClient;
  let standaloneClient: MongoClient;

  beforeAll(async () => {
    [set, standalone] = await Promise.all([
      startReplicaSet(image, 1),
      startMongoNode(image, { replSet: false }),
    ]);
    const [first] = set.nodes;
    if (first === undefined) {
      throw new Error('the replica set has no members');
    }
    member = first;
    client = await connectTo(member.directUri);
    standaloneClient = await connectTo(standalone.directUri);
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await Promise.all(open.splice(0).map((watch) => watch.close()));
  });

  afterAll(async () => {
    try {
      await client?.close();
      await standaloneClient?.close();
    } finally {
      try {
        await set?.stop();
      } finally {
        await standalone?.container.stop();
      }
    }
  });

  describe('collection watch', () => {
    it(
      'delivers insert, update, replace and delete in order with their payloads',
      async () => {
        const db = freshDb();
        const target: ChangeTarget = { kind: 'collection', database: db, collection: 'orders' };
        const { events, watch } = await record(client, target);
        const orders = client.db(db).collection<TestDoc>('orders');

        await orders.insertOne({ _id: 1, status: 'open' });
        await orders.updateOne({ _id: 1 }, { $set: { status: 'paid' } });
        await orders.replaceOne({ _id: 1 }, { status: 'shipped' });
        await orders.deleteOne({ _id: 1 });
        await waitForEvents(events, 4);

        expect(operationTypes(events)).toEqual(['insert', 'update', 'replace', 'delete']);
        expect(events.map((event) => event.id)).toEqual(['1', '2', '3', '4']);
        expect(events[0]?.ns).toEqual({ db, coll: 'orders' });
        expect(parsed(events[0]?.fullDocumentEjson)).toMatchObject({ status: 'open' });
        expect(parsed(events[1]?.updateDescriptionEjson)).toMatchObject({
          updatedFields: { status: 'paid' },
        });
        expect(parsed(events[2]?.fullDocumentEjson)).toMatchObject({ status: 'shipped' });
        expect(watch.state().phase).toBe('live');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'returns the current document on update with fullDocument updateLookup',
      async () => {
        const db = freshDb();
        const { events } = await record(
          client,
          {
            kind: 'collection',
            database: db,
            collection: 'orders',
          },
          { fullDocument: 'updateLookup' },
        );
        const orders = client.db(db).collection<TestDoc>('orders');

        await orders.insertOne({ _id: 1, status: 'open', total: 9 });
        await orders.updateOne({ _id: 1 }, { $set: { status: 'paid' } });
        await waitForEvents(events, 2);

        expect(parsed(events[1]?.fullDocumentEjson)).toMatchObject({
          status: 'paid',
          total: { $numberInt: '9' },
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'returns the pre-image on update and delete when pre- and post-images are enabled',
      async () => {
        const db = freshDb();
        await client.db(db).createCollection('orders', {
          changeStreamPreAndPostImages: { enabled: true },
        });
        const { events } = await record(
          client,
          { kind: 'collection', database: db, collection: 'orders' },
          { fullDocumentBeforeChange: 'whenAvailable' },
        );
        const orders = client.db(db).collection<TestDoc>('orders');

        await orders.insertOne({ _id: 1, status: 'open' });
        await orders.updateOne({ _id: 1 }, { $set: { status: 'paid' } });
        await orders.deleteOne({ _id: 1 });
        await waitForEvents(events, 3);

        expect(parsed(events[1]?.fullDocumentBeforeChangeEjson)).toMatchObject({ status: 'open' });
        expect(parsed(events[2]?.fullDocumentBeforeChangeEjson)).toMatchObject({ status: 'paid' });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'filters events with a $match pipeline',
      async () => {
        const db = freshDb();
        const { events } = await record(
          client,
          { kind: 'collection', database: db, collection: 'orders' },
          { pipelineEjson: '[{"$match":{"operationType":"insert"}}]' },
        );
        const orders = client.db(db).collection<TestDoc>('orders');

        await orders.insertOne({ _id: 1 });
        await orders.updateOne({ _id: 1 }, { $set: { status: 'paid' } });
        await orders.insertOne({ _id: 2 });
        await orders.deleteOne({ _id: 1 });
        await orders.insertOne({ _id: 3 });
        await waitForEvents(events, 3);

        expect(operationTypes(events)).toEqual(['insert', 'insert', 'insert']);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'replays the third and fourth events when resumed after the second event token',
      async () => {
        const db = freshDb();
        const target: ChangeTarget = { kind: 'collection', database: db, collection: 'orders' };
        const first = await record(client, target);
        const orders = client.db(db).collection<TestDoc>('orders');

        await orders.insertOne({ _id: 1 });
        await orders.updateOne({ _id: 1 }, { $set: { status: 'paid' } });
        await orders.replaceOne({ _id: 1 }, { status: 'shipped' });
        await orders.deleteOne({ _id: 1 });
        await waitForEvents(first.events, 4);
        const resumeToken = first.events[1]?.resumeTokenEjson;
        if (resumeToken === undefined) {
          throw new Error('the second event has no resume token');
        }
        await first.watch.close();

        const resumed = await record(client, target, { resumeAfterEjson: resumeToken });
        await waitForEvents(resumed.events, 2);

        expect(operationTypes(resumed.events)).toEqual(['replace', 'delete']);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'holds events while paused and delivers all of them on resume',
      async () => {
        const db = freshDb();
        const { events, watch } = await record(client, {
          kind: 'collection',
          database: db,
          collection: 'orders',
        });
        const orders = client.db(db).collection<TestDoc>('orders');

        watch.pause();
        expect(watch.state().phase).toBe('paused');
        for (let index = 0; index < 5; index += 1) {
          await orders.insertOne({ sequence: index });
        }
        await waitUntil(
          async () => watch.state().eventsSeen === 5,
          WAIT_MS,
          'the paused watch to read five events',
        );
        expect(events).toHaveLength(0);

        watch.resume();

        expect(events.map((event) => event.id)).toEqual(['1', '2', '3', '4', '5']);
        expect(events.map(sequenceOf)).toEqual(
          [0, 1, 2, 3, 4].map((n) => ({ $numberInt: String(n) })),
        );
        expect(watch.state()).toMatchObject({ phase: 'live', eventsDropped: 0, eventsSeen: 5 });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'keeps the newest events of a burst while paused and counts the dropped ones',
      async () => {
        const db = freshDb();
        const { events, watch } = await record(client, {
          kind: 'collection',
          database: db,
          collection: 'orders',
        });
        const orders = client.db(db).collection<TestDoc>('orders');

        watch.pause();
        await orders.insertMany(
          Array.from({ length: BURST_SIZE }, (_, index) => ({ sequence: index })),
        );
        await waitUntil(
          async () => watch.state().eventsSeen === BURST_SIZE,
          WAIT_MS,
          'the paused watch to read the burst',
        );
        watch.resume();

        const dropped = BURST_SIZE - PAUSE_BUFFER_LIMIT;
        expect(events).toHaveLength(PAUSE_BUFFER_LIMIT);
        expect(events[0]?.id).toBe(String(dropped + 1));
        expect(events.at(-1)?.id).toBe(String(BURST_SIZE));
        expect(watch.state()).toMatchObject({ eventsDropped: dropped, eventsSeen: BURST_SIZE });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ends with drop then invalidate and a closed phase when the collection is dropped',
      async () => {
        const db = freshDb();
        const { events, watch } = await record(client, {
          kind: 'collection',
          database: db,
          collection: 'orders',
        });
        const orders = client.db(db).collection<TestDoc>('orders');

        await orders.insertOne({ _id: 1 });
        await orders.drop();
        await waitUntil(
          async () => watch.state().phase === 'closed',
          WAIT_MS,
          'the watch to close',
        );

        expect(operationTypes(events)).toEqual(['insert', 'drop', 'invalidate']);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'maps a server rejection of the pipeline to COMMAND_FAILED',
      async () => {
        const { watch, states } = await record(
          client,
          { kind: 'collection', database: freshDb(), collection: 'orders' },
          { pipelineEjson: '[{"$nope":{}}]' },
        );

        expect(watch.state()).toMatchObject({ phase: 'error', error: { code: 'COMMAND_FAILED' } });
        expect(states.at(-1)?.phase).toBe('error');
      },
      TEST_TIMEOUT_MS,
    );

    it('refuses a pipeline that is not an array before opening anything', () => {
      expect(() =>
        openChangeWatch(
          client,
          { kind: 'collection', database: freshDb(), collection: 'orders' },
          { pipelineEjson: '{"$match":{}}' },
          { onEvent: () => undefined, onState: () => undefined },
        ),
      ).toThrow(AppErrorException);
    });
  });

  describe('database and deployment watch', () => {
    it(
      'sees events from two collections of the database',
      async () => {
        const db = freshDb();
        const { events } = await record(client, { kind: 'database', database: db });
        await client.db(db).collection<TestDoc>('alpha').insertOne({ _id: 1 });
        await client.db(db).collection<TestDoc>('beta').insertOne({ _id: 1 });
        await waitForEvents(events, 2);

        expect(events.map((event) => event.ns?.coll).sort()).toEqual(['alpha', 'beta']);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'sees a dropDatabase on the deployment',
      async () => {
        const db = freshDb();
        const { events } = await record(client, { kind: 'deployment' });
        await client.db(db).collection<TestDoc>('orders').insertOne({ _id: 1 });
        await client.db(db).dropDatabase();
        await waitUntil(
          async () => events.some((event) => event.operationType === 'dropDatabase'),
          WAIT_MS,
          'the dropDatabase event',
        );

        expect(events.find((event) => event.operationType === 'dropDatabase')?.ns).toEqual({
          db,
        });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('lifecycle', () => {
    it(
      'closes within two seconds',
      async () => {
        const { watch } = await record(client, {
          kind: 'collection',
          database: freshDb(),
          collection: 'orders',
        });

        const started = Date.now();
        await watch.close();
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(CLOSE_BUDGET_MS);
        expect(watch.state().phase).toBe('closed');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'closes when the signal is aborted',
      async () => {
        const controller = new AbortController();
        const { watch } = await record(
          client,
          { kind: 'collection', database: freshDb(), collection: 'orders' },
          {},
          controller.signal,
        );

        const started = Date.now();
        controller.abort();
        await waitUntil(
          async () => watch.state().phase === 'closed',
          CLOSE_BUDGET_MS,
          'the watch to close after the abort',
        );

        expect(Date.now() - started).toBeLessThan(CLOSE_BUDGET_MS);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'reports COMMAND_FAILED on a standalone server within five seconds',
      async () => {
        const started = Date.now();
        const { watch } = await record(standaloneClient, {
          kind: 'collection',
          database: freshDb(),
          collection: 'orders',
        });
        await waitUntil(
          async () => watch.state().phase === 'error',
          STANDALONE_ERROR_BUDGET_MS,
          'the standalone error',
        );

        const state = watch.state();
        expect(Date.now() - started).toBeLessThan(STANDALONE_ERROR_BUDGET_MS);
        expect(state.error?.code).toBe('COMMAND_FAILED');
        expect(state.error?.detail).toMatch(/only supported on replica sets/);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
