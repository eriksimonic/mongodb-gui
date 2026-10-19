import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import type { DockerMongoContainer } from '@mongo-gui/core';
import { dialHost, discoverMongoContainers } from './discovery';
import { createForwarderManager, type ForwarderManager, type ForwarderTls } from './forwarder';
import {
  createDockerEngineClient,
  defaultDockerSocket,
  type DockerEngineClient,
} from './engine-client';

const SETUP_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;
const MONGO_IMAGE = 'mongo:8.0.17';
const CUSTOM_PORT = 27018;
const SCOPE = `custom-port-test-${randomUUID()}`;

// mongod listens on CUSTOM_PORT inside the container, so the default 27017 reaches nothing.
function startMongo(network: StartedNetwork, publish: boolean): Promise<StartedTestContainer> {
  const container = new GenericContainer(MONGO_IMAGE)
    .withNetwork(network)
    .withCommand(['mongod', '--port', String(CUSTOM_PORT), '--bind_ip_all'])
    .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
    .withStartupTimeout(SETUP_TIMEOUT_MS);
  return (publish ? container.withExposedPorts(CUSTOM_PORT) : container).start();
}

async function ping(host: string, port: number, tls?: ForwarderTls): Promise<number> {
  const client = new MongoClient(`mongodb://${host}:${port}/?directConnection=true`, {
    serverSelectionTimeoutMS: 10_000,
    ...(tls === undefined
      ? {}
      : { tls: true, ca: tls.caPem, cert: tls.clientPem, key: tls.clientPem }),
  });
  try {
    await client.connect();
    return (await client.db('admin').command({ ping: 1 }))['ok'] as number;
  } finally {
    await client.close();
  }
}

describe('Docker container with mongod on a non-default port', () => {
  let network: StartedNetwork;
  let published: StartedTestContainer;
  let unpublished: StartedTestContainer;
  let engine: DockerEngineClient;
  let manager: ForwarderManager;
  let direct: DockerMongoContainer;
  let proxied: DockerMongoContainer;

  beforeAll(async () => {
    network = await new Network().start();
    [published, unpublished] = await Promise.all([
      startMongo(network, true),
      startMongo(network, false),
    ]);
    engine = createDockerEngineClient({
      socketPath: defaultDockerSocket(process.env, process.platform),
    });
    manager = createForwarderManager({ client: engine, scope: SCOPE });
    const all = await discoverMongoContainers(engine);
    const find = (id: string): DockerMongoContainer => {
      const found = all.find((container) => container.id === id);
      if (found === undefined) {
        throw new Error('The test container was not discovered');
      }
      return found;
    };
    direct = find(published.getId());
    proxied = find(unpublished.getId());
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await manager?.cleanupAll();
    await Promise.all([published?.stop(), unpublished?.stop()]);
    await network?.stop();
  }, SETUP_TIMEOUT_MS);

  it('reads the port from the mongod arguments', () => {
    expect(direct.internalPort).toBe(CUSTOM_PORT);
    expect(proxied.internalPort).toBe(CUSTOM_PORT);
  });

  it(
    'connects directly through the published port',
    async () => {
      if (direct.publishedPort === undefined) {
        throw new Error('The container has no published port');
      }

      expect(await ping(dialHost(direct.publishedPort), direct.publishedPort.hostPort)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'connects through the forwarder container when no port is published',
    async () => {
      expect(proxied.publishedPort).toBeUndefined();
      const handle = await manager.ensure(proxied);

      expect(await ping('127.0.0.1', handle.hostPort, handle.tls)).toBe(1);
      await manager.release(proxied.id);
    },
    TEST_TIMEOUT_MS,
  );
});
