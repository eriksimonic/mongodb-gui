import { MongoClient } from 'mongodb';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export const MONGO_IMAGE = 'mongo:8.0.17';
export const MONGO_ROOT_USER = 'root';
export const MONGO_ROOT_PASSWORD = 'e2e-root-secret';
export const MONGO_URI_ENV = 'E2E_MONGO_URI';

const MONGO_PORT = 27017;
const CONTAINER_STARTUP_TIMEOUT_MS = 180_000;
const SEED_TIMEOUT_MS = 120_000;
const SEED_RETRY_DELAY_MS = 500;

export interface StartedMongo {
  /** Root connection string with authSource=admin, reachable from the host. */
  readonly uri: string;
  stop(): Promise<void>;
}

/**
 * Starts a MongoDB 8.0.17 container with a root user, seeds `shop.orders` with three
 * documents and an index on `status`, and returns the host URI.
 */
export async function startSeededMongo(): Promise<StartedMongo> {
  const container: StartedTestContainer = await new GenericContainer(MONGO_IMAGE)
    .withEnvironment({
      MONGO_INITDB_ROOT_USERNAME: MONGO_ROOT_USER,
      MONGO_INITDB_ROOT_PASSWORD: MONGO_ROOT_PASSWORD,
    })
    .withExposedPorts(MONGO_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
    .start();
  const hostPort = `${container.getHost()}:${container.getMappedPort(MONGO_PORT)}`;
  const uri = `mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@${hostPort}/?authSource=admin`;
  try {
    await seedWhenReady(uri);
  } catch (error) {
    await container.stop();
    throw error;
  }
  return {
    uri,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Reads the URI that the global setup stored for the specs. */
export function mongoUriFromEnv(): string {
  const uri = process.env[MONGO_URI_ENV];
  if (uri === undefined || uri === '') {
    throw new Error(`${MONGO_URI_ENV} is not set. The global setup did not start MongoDB.`);
  }
  return uri;
}

async function seedWhenReady(uri: string): Promise<void> {
  // The entrypoint runs a temporary server before the final one, so the first attempts can fail.
  const deadline = Date.now() + SEED_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await seedShop(uri);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, SEED_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function seedShop(uri: string): Promise<void> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    const orders = client.db('shop').collection('orders');
    await orders.deleteMany({});
    await orders.insertMany([
      { orderNumber: 1, status: 'paid', total: 1200 },
      { orderNumber: 2, status: 'open', total: 450 },
      { orderNumber: 3, status: 'paid', total: 980 },
    ]);
    await orders.createIndex({ status: 1 }, { name: 'status_1' });
  } finally {
    await client.close();
  }
}
