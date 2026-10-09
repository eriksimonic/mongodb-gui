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
import { FORWARDER_LABEL, discoverMongoContainers } from './discovery';
import { createForwarderManager, forwarderLabelFor, type ForwarderManager } from './forwarder';
import {
  createDockerEngineClient,
  defaultDockerSocket,
  type DockerEngineClient,
} from './engine-client';

const SETUP_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 120_000;
const MONGO_IMAGE = 'mongo:8.0.17';

// No published ports: the only route in is the forwarder on the shared network.
describe('Docker discovery and forwarder against a real engine', () => {
  let network: StartedNetwork;
  let mongo: StartedTestContainer;
  let engine: DockerEngineClient;
  let manager: ForwarderManager;
  let target: DockerMongoContainer;

  beforeAll(async () => {
    network = await new Network().start();
    mongo = await new GenericContainer(MONGO_IMAGE)
      .withNetwork(network)
      .withWaitStrategy(Wait.forLogMessage('Waiting for connections'))
      .withStartupTimeout(SETUP_TIMEOUT_MS)
      .start();
    engine = createDockerEngineClient({
      socketPath: defaultDockerSocket(process.env, process.platform),
    });
    manager = createForwarderManager({ client: engine });
    const found = (await discoverMongoContainers(engine)).find(
      (container) => container.id === mongo.getId(),
    );
    if (found === undefined) {
      throw new Error('The test container was not discovered');
    }
    target = found;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await manager?.cleanupAll();
    await mongo?.stop();
    await network?.stop();
  }, SETUP_TIMEOUT_MS);

  it('discovers the container without a published port on its network', () => {
    expect(target.image).toBe(MONGO_IMAGE);
    expect(target.publishedPort).toBeUndefined();
    expect(target.networks).toEqual([network.getName()]);
  });

  it(
    'forwards a driver connection, then removes the forwarder on release',
    async () => {
      const handle = await manager.ensure(target);
      const mongoClient = new MongoClient(
        `mongodb://127.0.0.1:${handle.hostPort}/?directConnection=true`,
        { serverSelectionTimeoutMS: 10_000 },
      );
      try {
        await mongoClient.connect();
        const reply = await mongoClient.db('admin').command({ ping: 1 });
        expect(reply['ok']).toBe(1);
      } finally {
        await mongoClient.close();
      }

      await manager.release(target.id);

      expect(await engine.listContainersByLabel(forwarderLabelFor(target.id))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reuses one forwarder for repeated ensure calls',
    async () => {
      const first = await manager.ensure(target);
      const second = await manager.ensure(target);

      expect(second).toEqual(first);
      expect(await engine.listContainersByLabel(forwarderLabelFor(target.id))).toHaveLength(1);
      await manager.release(target.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'removes stale forwarders with cleanupAll',
    async () => {
      await manager.ensure(target);
      expect(await engine.listContainersByLabel(FORWARDER_LABEL)).not.toHaveLength(0);

      await manager.cleanupAll();

      expect(await engine.listContainersByLabel(FORWARDER_LABEL)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
