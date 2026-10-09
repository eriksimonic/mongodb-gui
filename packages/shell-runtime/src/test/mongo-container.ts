import { MongoClient } from 'mongodb';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

// Minimal copy of the mongo-adapter harness. The adapter does not export it, and the adapter's
// package exports do not expose its test folder.
export const CONTAINER_STARTUP_TIMEOUT_MS = 180_000;
const MONGO_PORT = 27017;
const READY_TIMEOUT_MS = 120_000;
const READY_RETRY_DELAY_MS = 500;

export interface StartedMongo {
  readonly uri: string;
  stop(): Promise<void>;
}

export async function startMongo(image: string): Promise<StartedMongo> {
  const container: StartedTestContainer = await new GenericContainer(image)
    .withExposedPorts(MONGO_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(CONTAINER_STARTUP_TIMEOUT_MS)
    .start();
  const hostPort = `${container.getHost()}:${container.getMappedPort(MONGO_PORT)}`;
  await waitUntilReady(hostPort);
  return {
    uri: `mongodb://${hostPort}/?directConnection=true`,
    stop: async () => {
      await container.stop();
    },
  };
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
