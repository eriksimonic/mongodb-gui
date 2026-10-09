import { createServer } from 'node:net';
import { MongoClient } from 'mongodb';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

// The floating mongo:8.0 tag refuses to start on Linux kernels 6.19 and newer (SERVER-121912).
export const MONGO_IMAGES = ['mongo:4.4', 'mongo:6.0', 'mongo:8.0.17'] as const;
export const CONTAINER_STARTUP_TIMEOUT_MS = 180_000;
export const SEED_DB = 'shop';

const MONGO_PORT = 27017;
const ROOT_USER = 'root';
const ROOT_PASSWORD = 'integration-secret';
const READY_TIMEOUT_MS = 120_000;
const READY_RETRY_DELAY_MS = 500;
const ORDER_COUNT = 50;
const EVENT_COUNT = 10;
export const METRIC_COUNT = 5;

export interface StartedMongo {
  readonly rootUri: string;
  readonly wrongPasswordUri: string;
  stop(): Promise<void>;
}

export async function startMongo(image: string): Promise<StartedMongo> {
  const container: StartedTestContainer = await new GenericContainer(image)
    .withEnvironment({
      MONGO_INITDB_ROOT_USERNAME: ROOT_USER,
      MONGO_INITDB_ROOT_PASSWORD: ROOT_PASSWORD,
    })
    .withExposedPorts(MONGO_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
    .start();
  const hostPort = `${container.getHost()}:${container.getMappedPort(MONGO_PORT)}`;
  await waitUntilReady(hostPort);
  return {
    rootUri: `mongodb://${ROOT_USER}:${ROOT_PASSWORD}@${hostPort}/?authSource=admin`,
    wrongPasswordUri: `mongodb://${ROOT_USER}:wrong-password@${hostPort}/?authSource=admin`,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function findClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export function supportsTimeseries(image: string): boolean {
  const major = Number(image.slice('mongo:'.length).split('.')[0]);
  return major >= 5;
}

export async function seedCatalog(uri: string, withTimeseries: boolean): Promise<void> {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(SEED_DB);
    const orders = db.collection('orders');
    await orders.insertMany(orderDocuments());
    await orders.createIndex({ status: 1, createdAt: -1 });
    await orders.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
    await db.createCollection('events', { capped: true, size: 65536 });
    await db.collection('events').insertMany(eventDocuments());
    await db.createCollection('paidOrders', {
      viewOn: 'orders',
      pipeline: [{ $match: { status: 'paid' } }],
    });
    if (withTimeseries) {
      await db.createCollection('metrics', { timeseries: { timeField: 't', metaField: 'm' } });
      await db.collection('metrics').insertMany(metricDocuments());
    }
  } finally {
    await client.close();
  }
}

function orderDocuments(): Record<string, unknown>[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: ORDER_COUNT }, (_, index) => ({
    orderNumber: index,
    status: index % 2 === 0 ? 'paid' : 'open',
    createdAt: new Date(start + index * 1000),
    expiresAt: new Date(Date.UTC(2030, 0, 1)),
  }));
}

function metricDocuments(): Record<string, unknown>[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: METRIC_COUNT }, (_, index) => ({
    t: new Date(start + index * 60_000),
    m: { sensor: 'a' },
    value: index,
  }));
}

function eventDocuments(): Record<string, unknown>[] {
  return Array.from({ length: EVENT_COUNT }, (_, index) => ({ sequence: index }));
}

async function waitUntilReady(hostPort: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pingOnce(hostPort);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, READY_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function pingOnce(hostPort: string): Promise<void> {
  const client = new MongoClient(`mongodb://${hostPort}/?directConnection=true`, {
    serverSelectionTimeoutMS: 2000,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } finally {
    await client.close();
  }
}
