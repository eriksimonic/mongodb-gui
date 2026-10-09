import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSON, MongoClient, type Db, type Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { GenericContainer, Wait } from 'testcontainers';
import {
  CONTAINER_STARTUP_TIMEOUT_MS,
  startMongo,
  type StartedMongo,
} from './test/mongo-container';

// Captures raw explain output from real servers into packages/core/src/explain/fixtures.
// Writes only when CAPTURE_EXPLAIN_FIXTURES=1. Otherwise the test asserts that every explain
// command succeeds and writes nothing.

const CAPTURE = process.env['CAPTURE_EXPLAIN_FIXTURES'] === '1';
const DB_NAME = 'fixtures';
const COLLECTION = 'orders';
const ORDER_COUNT = 2000;
const CUSTOMER_COUNT = 100;
const FIXTURE_ROOT = fileURLToPath(new URL('../../core/src/explain/fixtures', import.meta.url));
const VERBOSITIES = ['queryPlanner', 'executionStats', 'allPlansExecution'] as const;
type Verbosity = (typeof VERBOSITIES)[number];

interface ExplainCase {
  readonly name: string;
  readonly command: Document;
  // Minimum server major version. Cases below it are skipped and listed in the fixtures README.
  readonly minMajor: number;
}

const CASES: readonly ExplainCase[] = [
  {
    name: 'collscan',
    command: { find: COLLECTION, filter: { total: { $gt: 5 } } },
    minMajor: 4,
  },
  {
    name: 'ixscan-sort',
    command: { find: COLLECTION, filter: { customerId: 7 }, sort: { createdAt: -1 } },
    minMajor: 4,
  },
  {
    name: 'in-memory-sort',
    command: { find: COLLECTION, filter: { status: 'paid' }, sort: { total: 1 } },
    minMajor: 4,
  },
  {
    name: 'covered',
    command: {
      find: COLLECTION,
      filter: { customerId: 7 },
      projection: { customerId: 1, _id: 0 },
    },
    minMajor: 4,
  },
  {
    name: 'multikey',
    command: { find: COLLECTION, filter: { 'items.sku': 'A1' } },
    minMajor: 4,
  },
  {
    name: 'or',
    command: {
      find: COLLECTION,
      filter: { $or: [{ customerId: 7 }, { status: 'cancelled' }] },
    },
    minMajor: 4,
  },
  {
    name: 'count',
    command: { count: COLLECTION, query: { status: 'paid' } },
    minMajor: 4,
  },
  {
    name: 'distinct',
    command: { distinct: COLLECTION, key: 'customerId', query: { status: 'paid' } },
    minMajor: 4,
  },
  {
    name: 'aggregate-group',
    command: {
      aggregate: COLLECTION,
      pipeline: [
        { $match: { status: 'paid' } },
        { $group: { _id: '$customerId', spent: { $sum: '$total' } } },
        { $sort: { spent: -1 } },
      ],
      cursor: {},
    },
    minMajor: 4,
  },
  {
    name: 'aggregate-lookup',
    command: {
      aggregate: COLLECTION,
      pipeline: [
        { $match: { status: 'cancelled' } },
        { $limit: 5 },
        {
          $lookup: {
            from: COLLECTION,
            localField: 'customerId',
            foreignField: 'customerId',
            as: 'siblings',
          },
        },
      ],
      cursor: {},
    },
    minMajor: 4,
  },
  {
    name: 'update-multi',
    command: {
      update: COLLECTION,
      updates: [{ q: { status: 'open' }, u: { $set: { tags: [] } }, multi: true }],
    },
    minMajor: 4,
  },
  {
    name: 'delete',
    command: {
      delete: COLLECTION,
      deletes: [{ q: { status: 'cancelled' }, limit: 0 }],
    },
    minMajor: 4,
  },
  {
    // Two indexes match: the compound index on customerId and status_1. The loser is a rejected plan.
    name: 'competing',
    command: { find: COLLECTION, filter: { customerId: 7, status: 'paid' } },
    minMajor: 4,
  },
];

// Engine variants run on the same container after changing one runtime parameter.
interface EngineVariant {
  readonly directory: string;
  readonly parameter: Readonly<Record<string, string | boolean>> | undefined;
}

const DEFAULT_VARIANT: EngineVariant = { directory: '', parameter: undefined };
const CLASSIC_VARIANT: EngineVariant = {
  directory: 'classic',
  parameter: { internalQueryFrameworkControl: 'forceClassicEngine' },
};
// On 6.0 the classic engine is forced by default. featureFlagSbeFull (startup) plus this runtime
// switch enables the slot-based engine for find.
const SBE_VARIANT: EngineVariant = {
  directory: '',
  parameter: { internalQueryForceClassicEngine: false },
};

interface Target {
  readonly image: string;
  readonly directory: string;
  // Extra mongod flags. On 6.0, featureFlagSbeFull can only be set at startup.
  readonly startupArgs: readonly string[];
  readonly variants: readonly EngineVariant[];
}

const TARGETS: readonly Target[] = [
  { image: 'mongo:4.4', directory: '4.4', startupArgs: [], variants: [DEFAULT_VARIANT] },
  { image: 'mongo:6.0', directory: '6.0', startupArgs: [], variants: [DEFAULT_VARIANT] },
  {
    image: 'mongo:6.0',
    directory: '6.0-sbe',
    startupArgs: ['--setParameter', 'featureFlagSbeFull=true'],
    variants: [SBE_VARIANT],
  },
  {
    image: 'mongo:8.0.17',
    directory: '8.0.17',
    startupArgs: [],
    variants: [DEFAULT_VARIANT, CLASSIC_VARIANT],
  },
];

const RAW_OPTIONS = { promoteValues: false, promoteLongs: false };

const ROOT_USER = 'root';
const ROOT_PASSWORD = 'integration-secret';
const MONGO_PORT = 27017;
const SERVER_READY_TIMEOUT_MS = 120_000;

// Same contract as startMongo in ./test/mongo-container, plus extra mongod flags.
async function startWithArgs(image: string, args: readonly string[]): Promise<StartedMongo> {
  const container = await new GenericContainer(image)
    .withEnvironment({
      MONGO_INITDB_ROOT_USERNAME: ROOT_USER,
      MONGO_INITDB_ROOT_PASSWORD: ROOT_PASSWORD,
    })
    .withCommand([...args])
    .withExposedPorts(MONGO_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
    .start();
  const hostPort = `${container.getHost()}:${container.getMappedPort(MONGO_PORT)}`;
  const rootUri = `mongodb://${ROOT_USER}:${ROOT_PASSWORD}@${hostPort}/?authSource=admin`;
  await waitForPing(rootUri);
  return {
    rootUri,
    wrongPasswordUri: rootUri.replace(ROOT_PASSWORD, 'wrong-password'),
    stop: async () => {
      await container.stop();
    },
  };
}

async function waitForPing(uri: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  for (;;) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await client.close();
    }
  }
}

function majorOf(image: string): number {
  return Number(image.slice('mongo:'.length).split('.')[0]);
}

function seedOrders(): Document[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: ORDER_COUNT }, (_, index) => ({
    _id: index,
    customerId: (index % CUSTOMER_COUNT) + 1,
    status: ['paid', 'open', 'cancelled'][index % 3],
    total: ((index * 37) % 1000) + 0.5,
    items: Array.from({ length: (index % 3) + 1 }, (_, item) => ({
      sku: `A${((index + item) % 5) + 1}`,
      qty: (item % 4) + 1,
    })),
    createdAt: new Date(start + index * 60_000),
    tags: [`t${index % 7}`, 'x'],
  }));
}

async function seed(uri: string): Promise<void> {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const orders = client.db(DB_NAME).collection(COLLECTION);
    await orders.insertMany(seedOrders());
    await orders.createIndex({ customerId: 1, createdAt: -1 });
    await orders.createIndex({ status: 1 });
    await orders.createIndex({ 'items.sku': 1 });
    await orders.createIndex({ tags: 'text' });
  } finally {
    await client.close();
  }
}

// Raw mode returns the server's ok field as a BSON Double, so it is unwrapped with Number().
function okValue(raw: unknown): number {
  return typeof raw === 'object' && raw !== null && 'ok' in raw ? Number(raw.ok) : Number.NaN;
}

function explainCommand(command: Document, verbosity: Verbosity): Document {
  return { explain: command, verbosity };
}

function serialise(value: unknown): string {
  return `${BSON.EJSON.stringify(value as Document, { relaxed: false }, 2)}\n`;
}

function writeFixture(
  fixtureDirectory: string,
  caseName: string,
  verbosity: Verbosity,
  raw: unknown,
): void {
  const path = join(FIXTURE_ROOT, fixtureDirectory, `${caseName}.${verbosity}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialise(raw));
}

async function runTarget(target: Target): Promise<void> {
  const server =
    target.startupArgs.length === 0
      ? await startMongo(target.image)
      : await startWithArgs(target.image, target.startupArgs);
  try {
    await seed(server.rootUri);
    const client = new MongoClient(server.rootUri);
    try {
      await client.connect();
      const admin = client.db('admin');
      const db = client.db(DB_NAME);
      for (const variant of target.variants) {
        if (variant.parameter !== undefined) {
          await admin.command({ setParameter: 1, ...variant.parameter });
        }
        const directory =
          variant.directory === '' ? target.directory : `${target.directory}-${variant.directory}`;
        await captureCases(db, majorOf(target.image), directory);
      }
    } finally {
      await client.close();
    }
  } finally {
    await server.stop();
  }
}

async function captureCases(db: Db, major: number, directory: string): Promise<void> {
  for (const testCase of CASES) {
    if (major < testCase.minMajor) {
      continue;
    }
    for (const verbosity of VERBOSITIES) {
      const raw: unknown = await db.command(
        explainCommand(testCase.command, verbosity),
        RAW_OPTIONS,
      );
      expect(okValue(raw)).toBe(1);
      if (CAPTURE) {
        writeFixture(directory, testCase.name, verbosity, raw);
      }
    }
  }
}

describe.each(TARGETS)('explain fixtures on $image ($directory)', (target) => {
  it(
    'runs every explain case at every verbosity',
    async () => {
      await runTarget(target);
    },
    CONTAINER_STARTUP_TIMEOUT_MS * 2,
  );
});
