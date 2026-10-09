import { MongoClient } from 'mongodb';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppErrorException,
  MonitorSampleSchema,
  RunningOperationSchema,
  type AppError,
  type MonitorSample,
  type RunningOperation,
} from '@mongo-gui/core';
import { killOperation, listOperations, Sampler } from '../index';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  MONGO_IMAGES,
  startMongo,
  type StartedMongo,
} from '../test/mongo-container';

const TEST_DB = 'monitor_test';
const SUITE_TIMEOUT_MS = 60_000;
const INTERVAL_MS = 1000;
const SAMPLE_WAIT_MS = 5000;
const SLOW_FIND_FILTER = { $where: 'sleep(3000) || true' };
const KILL_BUDGET_MS = 2000;
const REPLICA_SET_PORT = 27017;

function samplerConfig() {
  return { intervalMs: INTERVAL_MS, retentionMs: 60_000 };
}

// Resolves with the next sample the sampler emits, or rejects after timeoutMs.
function nextSample(sampler: Sampler, timeoutMs: number): Promise<MonitorSample> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no sample within ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = sampler.onSample((sample) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(sample);
    });
  });
}

function nextError(sampler: Sampler, timeoutMs: number): Promise<AppError> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no error within ${timeoutMs} ms`));
    }, timeoutMs);
    const unsubscribe = sampler.onError((error) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(error);
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isListingItself(operation: RunningOperation): boolean {
  const command = operation.command;
  return (
    typeof command === 'object' &&
    command !== null &&
    'pipeline' in command &&
    Array.isArray(command.pipeline) &&
    command.pipeline.some(
      (stage: unknown) => typeof stage === 'object' && stage !== null && '$currentOp' in stage,
    )
  );
}

describe.each(MONGO_IMAGES)('server monitor on %s', (image) => {
  let mongo: StartedMongo | undefined;
  let client: MongoClient | undefined;

  beforeAll(async () => {
    mongo = await startMongo(image);
    client = new MongoClient(mongo.rootUri, { appName: 'monitor-test' });
    await client.connect();
    await client.db(TEST_DB).collection('hang').insertOne({ n: 1 });
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  function connected(): MongoClient {
    if (client === undefined) {
      throw new Error('client was not started');
    }
    return client;
  }

  it(
    'produces a first sample within the interval with zero rates',
    async () => {
      const sampler = new Sampler({ client: connected(), config: samplerConfig() });
      const started = Date.now();
      const first = nextSample(sampler, SAMPLE_WAIT_MS);
      sampler.start();
      try {
        const sample = await first;
        expect(Date.now() - started).toBeLessThan(INTERVAL_MS);
        expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
        expect(sample.opcounters).toEqual({
          insert: 0,
          query: 0,
          update: 0,
          delete: 0,
          getmore: 0,
          command: 0,
        });
        expect(sample.replication).toBeUndefined();
        expect(sampler.samples()).toHaveLength(1);
      } finally {
        sampler.stop();
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reports insert, query and connection activity on the next sample',
    async () => {
      const sampler = new Sampler({ client: connected(), config: samplerConfig() });
      const first = nextSample(sampler, SAMPLE_WAIT_MS);
      sampler.start();
      try {
        await first;
        const collection = connected().db(TEST_DB).collection('activity');
        await collection.insertMany(
          Array.from({ length: 200 }, (_, index) => ({ index, label: `row-${index}` })),
        );
        for (let index = 0; index < 50; index++) {
          await collection.find({ index }).toArray();
        }
        const second = await nextSample(sampler, SAMPLE_WAIT_MS + INTERVAL_MS);

        expect(MonitorSampleSchema.safeParse(second).success).toBe(true);
        expect(second.opcounters.insert).toBeGreaterThan(0);
        expect(second.opcounters.query).toBeGreaterThan(0);
        expect(second.connections.current).toBeGreaterThanOrEqual(1);
        expect(second.network.requestsPerSec).toBeGreaterThan(0);
        expect(sampler.samples()).toHaveLength(2);
      } finally {
        sampler.stop();
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists a running find and kills it',
    async () => {
      const target = connected();
      const slowFind = target
        .db(TEST_DB)
        .collection('hang')
        .find(SLOW_FIND_FILTER)
        .toArray()
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      let running: RunningOperation | undefined;
      const deadline = Date.now() + SAMPLE_WAIT_MS;
      while (running === undefined && Date.now() < deadline) {
        const operations = await listOperations(target);
        expect(
          operations.every((operation) => RunningOperationSchema.safeParse(operation).success),
        ).toBe(true);
        running = operations.find(
          (operation) => operation.active && operation.ns === `${TEST_DB}.hang`,
        );
        if (running === undefined) {
          await sleep(100);
        }
      }
      expect(running).toBeDefined();
      if (running === undefined) {
        return;
      }
      expect(running.op).toBe('query');
      expect(running.opid).toBeDefined();
      expect((await listOperations(target)).some((operation) => isListingItself(operation))).toBe(
        false,
      );

      const killedAt = Date.now();
      await killOperation(target, running.opid);
      const outcome = await Promise.race([
        slowFind,
        sleep(KILL_BUDGET_MS).then(() => 'timed out' as const),
      ]);
      expect(outcome).not.toBe('timed out');
      expect(Date.now() - killedAt).toBeLessThan(KILL_BUDGET_MS);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome instanceof Error ? outcome.message : '').toMatch(/interrupted/i);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'lists idle connections with synthetic opids only when asked',
    async () => {
      const withIdle = await listOperations(connected(), { includeIdle: true });
      const idleRows = withIdle.filter((operation) => String(operation.opid).startsWith('conn:'));
      expect(idleRows.length).toBeGreaterThanOrEqual(1);
      expect(idleRows.every((operation) => !operation.active)).toBe(true);

      const withoutIdle = await listOperations(connected());
      expect(withoutIdle.some((operation) => String(operation.opid).startsWith('conn:'))).toBe(
        false,
      );
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'hides background server threads unless includeSystem is set',
    async () => {
      const defaults = await listOperations(connected());
      const withSystem = await listOperations(connected(), { includeSystem: true });
      const names = (operations: RunningOperation[]) =>
        operations.map((operation) => operation.desc ?? '');

      expect(names(defaults).filter((name) => !name.startsWith('conn'))).toEqual([]);
      // 4.4 names the checkpoint thread WTCheckpointThread. Later versions use Checkpointer.
      const checkpointThread = ['Checkpointer', 'WTCheckpointThread'];
      expect(names(withSystem)).toEqual(expect.arrayContaining(['JournalFlusher']));
      expect(names(withSystem).some((name) => checkpointThread.includes(name))).toBe(true);
      expect(names(defaults)).not.toContain('Checkpointer');
      expect(names(defaults)).not.toContain('JournalFlusher');
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'reports a failed sample to error listeners and keeps running until stopped',
    async () => {
      const errorClient = new MongoClient(mongo?.rootUri ?? '', { appName: 'monitor-error' });
      await errorClient.connect();
      const sampler = new Sampler({ client: errorClient, config: samplerConfig() });
      const first = nextSample(sampler, SAMPLE_WAIT_MS);
      sampler.start();
      try {
        await first;
        const failure = nextError(sampler, SAMPLE_WAIT_MS + INTERVAL_MS);
        await errorClient.close();

        const error = await failure;
        expect(typeof error.message).toBe('string');
        expect(error.message.length).toBeGreaterThan(0);
        expect(sampler.isRunning()).toBe(true);

        const nextFailure = nextError(sampler, SAMPLE_WAIT_MS + INTERVAL_MS);
        await nextFailure;
        expect(sampler.isRunning()).toBe(true);
      } finally {
        sampler.stop();
      }
      expect(sampler.isRunning()).toBe(false);
    },
    SUITE_TIMEOUT_MS,
  );

  it('rejects an interval outside 1 to 10 seconds', () => {
    const sampler = new Sampler({ client: connected(), config: samplerConfig() });
    expect(() => sampler.setInterval(999)).toThrow(AppErrorException);
    expect(() => sampler.setInterval(10_001)).toThrow(AppErrorException);
    expect(sampler.isRunning()).toBe(false);
  });
});

describe('replica set sampling on mongo:8.0.17', () => {
  const image = 'mongo:8.0.17';
  let container: StartedTestContainer | undefined;
  let client: MongoClient | undefined;

  beforeAll(async () => {
    container = await new GenericContainer(image)
      .withCommand(['--replSet', 'rs0', '--bind_ip_all'])
      .withExposedPorts(REPLICA_SET_PORT)
      .withWaitStrategy(Wait.forListeningPorts())
      .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
      .start();
    const uri = `mongodb://${container.getHost()}:${container.getMappedPort(REPLICA_SET_PORT)}/?directConnection=true`;
    client = new MongoClient(uri, { appName: 'monitor-rs-test', serverSelectionTimeoutMS: 5000 });
    await client.connect();
    await client.db('admin').command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: `localhost:${REPLICA_SET_PORT}` }],
      },
    });
    await waitForPrimary(client);
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  }, CONTAINER_STARTUP_TIMEOUT_MS);

  it(
    'reports the replica set name and the self member',
    async () => {
      if (client === undefined) {
        throw new Error('replica set client was not started');
      }
      const sampler = new Sampler({ client, config: samplerConfig() });
      const first = nextSample(sampler, SUITE_TIMEOUT_MS);
      sampler.start();
      try {
        const sample = await first;
        expect(MonitorSampleSchema.safeParse(sample).success).toBe(true);
        expect(sample.replication?.setName).toBe('rs0');
        const members = sample.replication?.members ?? [];
        expect(members).toHaveLength(1);
        expect(members.filter((member) => member.self)).toHaveLength(1);
        expect(members[0]?.state).toBe('PRIMARY');
        expect(members[0]).not.toHaveProperty('lagSeconds');
        const window = sample.replication?.oplogWindowSeconds;
        expect(typeof window).toBe('number');
        expect(window).toBeGreaterThanOrEqual(0);
      } finally {
        sampler.stop();
      }
    },
    SUITE_TIMEOUT_MS,
  );
});

async function waitForPrimary(client: MongoClient): Promise<void> {
  const deadline = Date.now() + CONTAINER_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hello: unknown = await client.db('admin').command({ hello: 1 });
    if (
      typeof hello === 'object' &&
      hello !== null &&
      'isWritablePrimary' in hello &&
      hello.isWritablePrimary === true
    ) {
      return;
    }
    await sleep(500);
  }
  throw new Error('replica set did not elect a primary');
}
